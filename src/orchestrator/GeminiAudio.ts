import { base64FromUint8 } from '../util/base64';
import { pcm16ToWav } from '../util/wav';

export type AudioOrchestratorTrace =
  | { type: 'sent'; bytes: number; bufferMs: number; at: number }
  | {
      type: 'response';
      heard: string;
      cue: string | null;
      cueShort: string | null;
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
  /** Free-form notes about the person — relationship to the user, role, what
   *  they typically discuss. Surfaced alongside the voice clip so the model
   *  can use context (topic, jargon) to disambiguate similar voices. */
  notes?: string;
  wav: Uint8Array;
};

export type AudioResponse = {
  heard: string;
  cue: string | null;
  /**
   * Glanceable HUD form of the cue (≤80 chars, single line). Same answer,
   * compressed for a heads-up display where the user reads in <2 seconds.
   * Null when cue is null OR when no useful 80-char form exists for that cue.
   */
  cueShort: string | null;
  /**
   * Per-speaker segments within the audio that was sent in this request.
   * Timestamps are seconds from the start of the request's audio.
   */
  segments?: SpeakerSegment[];
  /**
   * Optional rename hints — if Gemini hears an unknown speaker addressed
   * by name in conversation, it can map the auto-label to a real name.
   *   { "New Person 1": "Bob" }
   */
  speakerNames?: Record<string, string>;
  /**
   * Optional group classification hint. Set when the active thread is in a
   * broad group (Ad-hoc, or a high-level group with sub-groups) and Gemini
   * narrows down which sub-group the conversation actually belongs to based
   * on jargon, project names, attendees.
   */
  groupHint?: { groupId: string; confidence: 'low' | 'medium' | 'high' };
};

export type SpeakerSegment = {
  speaker: string;
  startSec: number;
  endSec: number;
};

/** Surfaced on every commit (cue or soft-commit). */
export type CommitEntry = {
  heard: string;
  cue: string | null;
  cueShort: string | null;
  /** Raw 16-bit mono 16kHz PCM bytes that were sent in this request. */
  audioPcm?: Uint8Array;
  segments?: SpeakerSegment[];
  speakerNames?: Record<string, string>;
  groupHint?: { groupId: string; confidence: 'low' | 'medium' | 'high' };
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
  /**
   * If present, the model is asked to narrow the conversation down to one of
   * these candidate groups (id + name + people preview) and surface its guess
   * in the response's groupHint field. Used when the active thread is in a
   * broad / Ad-hoc group and we want the system to figure out the real one.
   */
  groupCatalog?: { id: string; label: string }[];
  /** Prior committed exchanges to seed the conversation history with. */
  initialHistory?: Array<{ heard: string; cue: string | null; cueShort?: string | null }>;
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
  onCommit?: (entry: CommitEntry) => void;
};

const SAMPLE_RATE = 16000;

const DEFAULT_SYSTEM_INSTRUCTION = `You are a passive session monitor for an in-person conversation (e.g., a tabletop game, study group, meeting).

Each request includes a stretch of audio that may contain multiple speakers, partial words, far-field talk, and silence. Listen carefully — far-field words you can resolve are often the most informative. The audio may also include parts you've already heard in earlier turns; that's expected.

Respond with ONLY a JSON object of shape:
{
  "heard":    "<one-line transcript of all speech, prefixed by speaker (Sarah: hi. Me: hey.)>",
  "cue":      "<the actual answer or fact, ≤240 chars>" | null,
  "cueShort": "<same answer compressed for a heads-up display, ≤80 chars, single line>" | null,
  "segments": [
    {"speaker": "Sarah",        "startSec": 0.0, "endSec": 3.5},
    {"speaker": "New Person 1", "startSec": 3.5, "endSec": 7.2}
  ],
  "speakerNames": { "New Person 1": "Bob" }   // optional rename hints
}

Rules for "cue":
- A cue is for the LISTENER (someone watching the screen) — give them the *answer* or *fact*, not a description of what was asked. If a player asks "what's the AC of a beholder?" the cue is "Beholder AC: 18 (natural armor)", NOT "The speaker asked for the beholder's AC".
- Produce a cue only when a speaker stated a specific factual claim worth verifying, asked an answerable factual question, mentioned a D&D rule / definition / name / date / formula, or explicitly requested data.
- Keep cues under 240 characters. Pure information, no narration.
- Otherwise output null. Skip filler / opinions / chit-chat / ambient noise / questions you can't actually answer.

Rules for "cueShort":
- The same cue, compressed for a smart-glasses HUD: ≤80 chars, single line, no second sentence, no parentheticals unless they're load-bearing. Read in under 2 seconds at a glance.
- Drop framing words ("The", "It is", "Note that"); keep the core fact. "Beholder AC: 18" not "A beholder has AC 18 (natural armor)".
- Symbols and abbreviations are fine if they preserve meaning ("→", "≥", "K" for thousand). The HUD font is monospace-ish green text on a transparent display, so visual density matters.
- If "cue" is null, "cueShort" must also be null.
- If "cue" is non-null but no useful ≤80-char form exists (e.g., the answer genuinely needs the full 240 chars to be safe / correct / unambiguous), set "cueShort" to null. Better to skip the HUD than show a misleading truncation.
- When in doubt, prefer brevity over completeness — the user can glance at the phone for the full cue.

Rules for "segments":
- One entry per contiguous span of single-speaker audio. Order by time.
- Use the speaker's known name where possible. For unrecognised voices, use "New Person 1", "New Person 2", etc., consistently within the conversation. The user (device owner) is "Me".
- Timestamps are seconds from the start of the audio in this request.

Rules for "speakerNames":
- Optional. If you hear an unknown speaker addressed by name in the conversation ("hey Bob, what do you think?") and you can map "New Person N" to a real name with reasonable confidence, include it.
- Omit the field entirely if you have no rename to suggest.

Always include "heard", "segments", and both cue fields (use null when not applicable). Never output anything other than the JSON object.`;

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
        const responseText = JSON.stringify({
          heard: e.heard,
          cue: e.cue,
          cueShort: e.cueShort ?? null,
        });
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
        `--- known voice references ---\nVoice reference clips and notes for the following people are included at the start of this conversation: ${names}. When you hear a voice that matches one of them, use that person's name in "heard" and "segments". Use each person's notes — relationship to the user, role, what they typically discuss — as context to disambiguate similar voices (lean on topic, jargon, in-jokes when audio alone is ambiguous). For voices that don't match any reference, use "New Person 1", "New Person 2", etc. — keep the same label for the same voice across the whole conversation.`,
      );
    }
    if (this.opts.groupCatalog && this.opts.groupCatalog.length > 0) {
      const list = this.opts.groupCatalog.map((g) => `  - id="${g.id}"  ${g.label}`).join('\n');
      parts.push(
        `--- group classification ---\nThe active thread isn't tied to a specific sub-group yet. Help narrow it down. Listen for project names, jargon, attendee names, organisational cues; pick the most likely group from this list and emit it as groupHint:\n${list}\n\nReturn groupHint with confidence "low" (just a hunch), "medium" (probable), or "high" (clear evidence). Only emit the field when you can make a meaningful guess; omit it otherwise.`,
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
      this.commit(parsed.heard, rawText, combined, parsed);
      committed = true;
    } else if (this.pendingBytes >= this.softCommitBytes) {
      this.opts.onTrace?.({
        type: 'soft_commit',
        reason: `pending audio exceeded ${Math.round(this.softCommitBytes / 2 / SAMPLE_RATE)}s`,
        bufferMs: Math.round((this.pendingBytes / 2 / SAMPLE_RATE) * 1000),
        at: Date.now(),
      });
      this.commit(parsed.heard, rawText, combined, parsed);
      committed = true;
    }
    // else: keep all pending audio (including frames that were just sent),
    // it'll roll into the next request.

    this.opts.onTrace?.({
      type: 'response',
      heard: parsed.heard,
      cue: parsed.cue,
      cueShort: parsed.cueShort,
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
      { text: 'Voice reference clips and notes for speakers in this conversation:' },
    ];
    for (const r of refs) {
      const label = r.notes ? `${r.name} — notes: ${r.notes}` : r.name;
      parts.push({ text: `${label}:` });
      parts.push({
        inlineData: {
          mimeType: 'audio/wav',
          data: base64FromUint8(r.wav),
        },
      });
    }
    parts.push({
      text: 'Use these to identify speakers by name in the "heard" field of your replies. The notes describe each person\'s relationship to the user — use them as context when audio alone makes a voice hard to place.',
    });
    return [
      { role: 'user', parts },
      { role: 'model', parts: [{ text: 'Acknowledged. I will identify these speakers by voice.' }] },
    ];
  }

  /** Drop the in-flight audio frames and push heard+raw response to history. */
  private commit(
    heard: string,
    rawText: string,
    audioPcm: Uint8Array,
    parsed: AudioResponse,
  ): void {
    this.dropInflight();
    if (!heard) return;
    this.history.push({ role: 'user', parts: [{ text: heard }] });
    this.history.push({ role: 'model', parts: [{ text: rawText }] });
    this.trimHistory();
    this.opts.onCommit?.({
      heard,
      cue: parsed.cue,
      cueShort: parsed.cueShort,
      audioPcm,
      segments: parsed.segments,
      speakerNames: parsed.speakerNames,
      groupHint: parsed.groupHint,
    });
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
    const cue =
      typeof parsed.cue === 'string'
        ? parsed.cue.trim() || null
        : parsed.cue === null
          ? null
          : null;
    const cueShortRaw =
      typeof parsed.cueShort === 'string' ? parsed.cueShort.trim() || null : null;
    // Force the contract: cueShort must be null when cue is null, regardless
    // of what the model emitted. (Cheaper than retraining the prompt.)
    const cueShort = cue ? cueShortRaw : null;
    return {
      heard: typeof parsed.heard === 'string' ? parsed.heard.trim() : '',
      cue,
      cueShort,
      segments: Array.isArray(parsed.segments)
        ? parsed.segments
            .filter(
              (s): s is SpeakerSegment =>
                !!s &&
                typeof s.speaker === 'string' &&
                typeof s.startSec === 'number' &&
                typeof s.endSec === 'number' &&
                s.endSec > s.startSec,
            )
            .map((s) => ({
              speaker: s.speaker.trim(),
              startSec: s.startSec,
              endSec: s.endSec,
            }))
        : undefined,
      speakerNames:
        parsed.speakerNames && typeof parsed.speakerNames === 'object'
          ? Object.fromEntries(
              Object.entries(parsed.speakerNames).filter(
                ([k, v]) => typeof k === 'string' && typeof v === 'string' && k && v,
              ),
            )
          : undefined,
      groupHint:
        parsed.groupHint &&
        typeof parsed.groupHint === 'object' &&
        typeof parsed.groupHint.groupId === 'string' &&
        ['low', 'medium', 'high'].includes(parsed.groupHint.confidence as string)
          ? {
              groupId: parsed.groupHint.groupId,
              confidence: parsed.groupHint.confidence as 'low' | 'medium' | 'high',
            }
          : undefined,
    };
  } catch {
    return { heard: stripped, cue: null, cueShort: null };
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
