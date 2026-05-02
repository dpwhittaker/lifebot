import { base64FromUint8 } from '../util/base64';
import { pcm16ToWav } from '../util/wav';

export type AudioOrchestratorTrace =
  | { type: 'sent'; bytes: number; bufferMs: number; at: number }
  | {
      type: 'response';
      heard: string;
      cue: string | null;
      latencyMs: number;
      committed: boolean;
      bufferMsAfter: number;
      usage?: GeminiUsage;
      at: number;
    }
  | { type: 'error'; error: string; latencyMs: number; at: number }
  | { type: 'soft_commit'; reason: string; bufferMs: number; at: number };

/** Token usage breakdown surfaced from Gemini's usageMetadata. */
export type GeminiUsage = {
  promptTokens: number;
  cachedTokens: number;
  responseTokens: number;
  totalTokens: number;
};

/** A reference clip for one person, used to teach the model their voice. */
export type VoiceReference = {
  name: string;
  wav: Uint8Array;
};

export type AudioResponse = {
  heard: string;
  cue: string | null;
};

export type GeminiAudioOptions = {
  apiKey: string;
  model: string;
  systemInstruction?: string;
  /**
   * Brief directory of other thread names so the model can recognise when the
   * user is referencing a different context, without leaking actual content.
   */
  threadDirectory?: string;
  /**
   * Voice reference clips for the people in this thread's roster. The model
   * uses them to identify speakers in transcripts. They form the cacheable
   * prefix of every request, so cost amortises after the first call.
   */
  voiceReferences?: VoiceReference[];
  /** Prior committed exchanges to seed the conversation history with. */
  initialHistory?: Array<{ heard: string; cue: string | null }>;
  /** How many user/model turn pairs of *committed* text history to keep. */
  maxHistoryTurns?: number;
  /**
   * Maximum unflushed audio (in seconds) to carry between cues. If we go
   * this long without a cue, we soft-commit using the latest `heard` and
   * reset the audio buffer so cost doesn't grow unboundedly.
   */
  softCommitSec?: number;
  fetchImpl?: typeof fetch;
  onTrace?: (event: AudioOrchestratorTrace) => void;
  onResponse?: (response: AudioResponse) => void;
  /** Fires every time a turn commits (cue arrives or soft-commit triggers). */
  onCommit?: (entry: { heard: string; cue: string | null }) => void;
};

const SAMPLE_RATE = 16000;

const DEFAULT_SYSTEM_INSTRUCTION = `You are a passive session monitor for an in-person conversation (e.g., a tabletop game, study group, meeting).

Each request includes a stretch of audio that may contain multiple speakers, partial words, far-field talk, and silence. Listen carefully — far-field words you can resolve are often the most informative. The audio may also include parts you've already heard in earlier turns; that's expected.

Respond with ONLY a JSON object of shape:
{"heard": "<one-line transcript of all speech in the audio>", "cue": "<the actual answer or fact>" | null}

Rules for "cue":
- A cue is for the LISTENER (someone watching the screen) — give them the *answer* or *fact*, not a description of what was asked. If a player asks "what's the AC of a beholder?" the cue is "Beholder AC: 18 (natural armor)", NOT "The speaker asked for the beholder's AC".
- Produce a cue only when a speaker stated a specific factual claim worth verifying, asked an answerable factual question, mentioned a D&D rule / definition / name / date / formula, or explicitly requested data.
- Keep cues under 240 characters. Pure information, no narration.
- Otherwise output null. Skip filler / opinions / chit-chat / ambient noise / questions you can't actually answer.

Always include "heard" — a clean one-line transcript of all intelligible speech in the audio. Never output anything other than the JSON object.`;

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };
type GeminiTurn = { role: 'user' | 'model'; parts: GeminiPart[] };

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
};

/**
 * REST orchestrator that buffers audio across multiple VAD-triggered turns
 * until Gemini returns a cue. Each request sends the entire un-cued audio
 * window so the model has a chance to resolve far-field/partial speech that
 * a single segment couldn't.
 *
 * On cue: commit. The whole pending window becomes a single text turn in
 * history (replacing the audio bytes), and the audio buffer is cleared.
 * On null: keep the audio in the buffer; next VAD turn appends to it and
 * we re-send the whole thing.
 *
 * To bound cost when cues never come, after `softCommitSec` of pending
 * audio we soft-commit using the latest heard text and reset.
 */
export class GeminiAudioOrchestrator {
  private readonly opts: GeminiAudioOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly maxHistoryTurns: number;
  private readonly softCommitBytes: number;
  /** Recomputed when voice references change. */
  private systemInstruction: string;

  /** Committed text-only turns (past cued exchanges). */
  private history: GeminiTurn[] = [];
  /** PCM segments since the last commit. Each item is one VAD turn's PCM. */
  private pendingAudio: Uint8Array[] = [];
  /** Cached total byte length of pendingAudio. */
  private pendingBytes = 0;

  /** How many of pendingAudio's frames are part of the in-flight request. */
  private inflightCount = 0;
  private inflight = false;
  /**
   * Set true whenever new audio arrives. Cleared at the start of each
   * evaluate(). If nothing new arrives during a request, we don't loop —
   * otherwise a `null` response would immediately re-send the same audio.
   */
  private dirty = false;

  constructor(opts: GeminiAudioOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.maxHistoryTurns = opts.maxHistoryTurns ?? 24;
    this.systemInstruction = this.buildSystemInstruction();
    const softCommitSec = opts.softCommitSec ?? 300; // 5 minutes
    this.softCommitBytes = softCommitSec * SAMPLE_RATE * 2; // 16-bit mono

    // Seed history from a thread's prior commits, if provided.
    if (opts.initialHistory) {
      for (const e of opts.initialHistory) {
        if (!e.heard) continue;
        const responseText = JSON.stringify({ heard: e.heard, cue: e.cue });
        this.history.push({ role: 'user', parts: [{ text: e.heard }] });
        this.history.push({ role: 'model', parts: [{ text: responseText }] });
      }
      this.trimHistory();
    }
  }

  reset(): void {
    this.history = [];
    this.pendingAudio = [];
    this.pendingBytes = 0;
    this.dirty = false;
  }

  /** Update the voice reference clips. Takes effect on the next request. */
  setVoiceReferences(refs: VoiceReference[]): void {
    this.opts.voiceReferences = refs;
    this.systemInstruction = this.buildSystemInstruction();
  }

  private buildSystemInstruction(): string {
    const base = this.opts.systemInstruction ?? DEFAULT_SYSTEM_INSTRUCTION;
    const parts: string[] = [base];
    const dir = this.opts.threadDirectory?.trim();
    if (dir) {
      parts.push(
        `--- other threads in the user's life (for cross-reference) ---\n${dir}\n\nWhen the speaker mentions one of these other threads in passing — by name, by character, by topic — feel free to surface a brief reference cue using the listed summary (e.g. "Your D&D character Brennan recently rescued villagers — could draw a parallel"). Treat these as flavor for the *current* conversation; the active thread is what the user is actually in. Do NOT propose switching threads in your cues; passing references stay passing.`,
      );
    }
    if (this.opts.voiceReferences && this.opts.voiceReferences.length > 0) {
      const names = this.opts.voiceReferences.map((v) => v.name).join(', ');
      parts.push(
        `--- speaker identification ---\nVoice reference clips for the following people are included at the start of this conversation: ${names}.\n\nIn your "heard" field, prefix each utterance with the speaker's name when you can identify them by voice (e.g. "Sarah: where did we leave off? Bob: the migration plan."). Use "Speaker A", "Speaker B" for unrecognised voices. The user (the device owner) is the one most often saying "I/me/my"; label them as "Me" if not in the named roster. Run speakers together on one line in heard text; punctuation only.`,
      );
    }
    return parts.join('\n\n');
  }

  sendTurn(pcm: Uint8Array): void {
    this.pendingAudio.push(pcm);
    this.pendingBytes += pcm.byteLength;
    this.dirty = true;
    void this.processQueue();
  }

  /** No-op kept for API compatibility. */
  close(): void {}

  private async processQueue(): Promise<void> {
    if (this.inflight) return;
    if (!this.dirty || this.pendingAudio.length === 0) return;
    this.inflight = true;
    try {
      // Loop only while *new* audio keeps arriving. If a request returns
      // without a cue and no new audio came in, we stop — otherwise we'd
      // immediately re-send the same payload and burn money in a tight loop.
      // sendTurn() will set dirty=true and re-trigger processQueue when the
      // next utterance arrives.
      while (this.dirty && this.pendingAudio.length > 0) {
        this.dirty = false;
        this.inflightCount = this.pendingAudio.length;
        await this.evaluate();
        this.inflightCount = 0;
      }
    } finally {
      this.inflight = false;
    }
  }

  private async evaluate(): Promise<void> {
    const startedAt = Date.now();
    // Concatenate all pending frames currently snapshotted as in-flight.
    const slice = this.pendingAudio.slice(0, this.inflightCount);
    const totalBytes = slice.reduce((s, f) => s + f.byteLength, 0);
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const f of slice) {
      combined.set(f, offset);
      offset += f.byteLength;
    }
    const bufferMs = Math.round((totalBytes / 2 / SAMPLE_RATE) * 1000);
    this.opts.onTrace?.({ type: 'sent', bytes: totalBytes, bufferMs, at: startedAt });

    // generateContent wants a real container format (audio/wav), not bare
    // audio/pcm. Wrap our 16-bit mono 16kHz PCM in a WAV header.
    const wav = pcm16ToWav(combined, SAMPLE_RATE, 1, 16);
    const audioPart: GeminiPart = {
      inlineData: { mimeType: 'audio/wav', data: base64FromUint8(wav) },
    };
    const userTurn: GeminiTurn = { role: 'user', parts: [audioPart] };
    const contents = [...this.referenceTurns(), ...this.history, userTurn];

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${this.opts.model}:generateContent` +
      `?key=${encodeURIComponent(this.opts.apiKey)}`;
    const body = {
      systemInstruction: { parts: [{ text: this.systemInstruction }] },
      contents,
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
    };

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      this.opts.onTrace?.({
        type: 'error',
        error: `network: ${stringifyError(e)}`,
        latencyMs: Date.now() - startedAt,
        at: Date.now(),
      });
      // Drop the in-flight audio so we don't infinite-retry the same payload
      // when the network is dead. The user will keep talking; subsequent
      // utterances start a fresh attempt.
      this.dropInflight();
      return;
    }

    if (!res.ok) {
      const detail = await safeText(res);
      this.opts.onTrace?.({
        type: 'error',
        error: `HTTP ${res.status}: ${detail.slice(0, 400)}`,
        latencyMs: Date.now() - startedAt,
        at: Date.now(),
      });
      // Drop the in-flight audio. For 4xx the request is broken regardless
      // (wrong model, bad payload, auth) — retrying will just hammer the API.
      // For 5xx it's also better to discard one window of audio than to loop.
      this.dropInflight();
      return;
    }

    const json = (await res.json()) as GeminiResponse;
    const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '{"heard":"","cue":null}';
    const parsed = parseResponse(rawText);
    const usage: GeminiUsage | undefined = json.usageMetadata
      ? {
          promptTokens: json.usageMetadata.promptTokenCount ?? 0,
          cachedTokens: json.usageMetadata.cachedContentTokenCount ?? 0,
          responseTokens: json.usageMetadata.candidatesTokenCount ?? 0,
          totalTokens: json.usageMetadata.totalTokenCount ?? 0,
        }
      : undefined;

    let committed = false;
    if (parsed.cue) {
      // Cue arrived — commit the in-flight slice as text. Frames added to
      // pendingAudio while we were in flight stay queued for the next request.
      this.commit(parsed.heard, rawText);
      committed = true;
    } else if (this.pendingBytes >= this.softCommitBytes) {
      // No cue, but pending audio has grown too large — force commit using
      // the latest heard text so cost doesn't keep growing.
      this.opts.onTrace?.({
        type: 'soft_commit',
        reason: `pending audio exceeded ${Math.round(this.softCommitBytes / 2 / SAMPLE_RATE)}s`,
        bufferMs: Math.round((this.pendingBytes / 2 / SAMPLE_RATE) * 1000),
        at: Date.now(),
      });
      this.commit(parsed.heard, rawText);
      committed = true;
    }
    // else: keep all pending audio (including frames that were just sent),
    // it'll roll into the next request.

    this.opts.onTrace?.({
      type: 'response',
      heard: parsed.heard,
      cue: parsed.cue,
      latencyMs: Date.now() - startedAt,
      committed,
      bufferMsAfter: Math.round((this.pendingBytes / 2 / SAMPLE_RATE) * 1000),
      usage,
      at: Date.now(),
    });
    this.opts.onResponse?.(parsed);
  }

  /**
   * Build the synthetic "voice references" turn pair that anchors the start
   * of every request. Stable across the session, so it forms the cacheable
   * prefix and only pays full token cost on the first request.
   */
  private referenceTurns(): GeminiTurn[] {
    const refs = this.opts.voiceReferences;
    if (!refs || refs.length === 0) return [];
    const parts: GeminiPart[] = [
      { text: 'Voice reference clips for speakers in this conversation:' },
    ];
    for (const r of refs) {
      parts.push({ text: `${r.name}:` });
      parts.push({
        inlineData: {
          mimeType: 'audio/wav',
          data: base64FromUint8(r.wav),
        },
      });
    }
    parts.push({
      text: 'Use these to identify speakers by name in the "heard" field of your replies.',
    });
    return [
      { role: 'user', parts },
      { role: 'model', parts: [{ text: 'Acknowledged. I will identify these speakers by voice.' }] },
    ];
  }

  /** Drop the in-flight audio frames and push heard+raw response to history. */
  private commit(heard: string, rawText: string): void {
    this.dropInflight();
    if (heard) {
      this.history.push({ role: 'user', parts: [{ text: heard }] });
      this.history.push({ role: 'model', parts: [{ text: rawText }] });
      this.trimHistory();
      // Surface the commit so the App can persist it to the active thread.
      try {
        const parsed = JSON.parse(rawText) as { heard?: string; cue?: string | null };
        this.opts.onCommit?.({
          heard,
          cue: typeof parsed.cue === 'string' ? parsed.cue : null,
        });
      } catch {
        this.opts.onCommit?.({ heard, cue: null });
      }
    }
  }

  /**
   * Remove the frames that were part of the in-flight request, keep the rest
   * (frames that arrived while we were waiting for the response).
   */
  private dropInflight(): void {
    const dropped = this.pendingAudio.splice(0, this.inflightCount);
    let droppedBytes = 0;
    for (const f of dropped) droppedBytes += f.byteLength;
    this.pendingBytes -= droppedBytes;
    this.inflightCount = 0;
  }

  private trimHistory(): void {
    const max = this.maxHistoryTurns * 2;
    if (this.history.length > max) {
      this.history.splice(0, this.history.length - max);
    }
  }
}

function parseResponse(raw: string): AudioResponse {
  const stripped = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');
  try {
    const parsed = JSON.parse(stripped) as Partial<AudioResponse>;
    return {
      heard: typeof parsed.heard === 'string' ? parsed.heard.trim() : '',
      cue:
        typeof parsed.cue === 'string'
          ? parsed.cue.trim() || null
          : parsed.cue === null
            ? null
            : null,
    };
  } catch {
    return { heard: stripped, cue: null };
  }
}

function stringifyError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
