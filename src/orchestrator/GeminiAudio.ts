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
      at: number;
    }
  | { type: 'error'; error: string; latencyMs: number; at: number }
  | { type: 'soft_commit'; reason: string; bufferMs: number; at: number };

export type AudioResponse = {
  heard: string;
  cue: string | null;
};

export type GeminiAudioOptions = {
  apiKey: string;
  model: string;
  systemInstruction?: string;
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
};

const SAMPLE_RATE = 16000;

const DEFAULT_SYSTEM_INSTRUCTION = `You are a passive session monitor for an in-person conversation (e.g., a tabletop game, study group, meeting).

Each request includes a stretch of audio that may contain multiple speakers, partial words, far-field talk, and silence. Listen carefully — far-field words you can resolve are often the most informative.

Respond with ONLY a JSON object of shape:
{"heard": "<one-line transcript of what was said in the audio>", "cue": "<short helpful summary>" | null}

Rules for "cue":
- Provide one if and only if a speaker mentioned a specific factual claim, D&D rule, definition, name, date, formula, or explicitly requested data.
- Keep cues under 240 characters.
- Otherwise output null. Skip filler / opinions / chit-chat / ambient noise.

Always include "heard" — a clean one-line transcript of everything intelligible. Never output anything other than the JSON object.`;

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };
type GeminiTurn = { role: 'user' | 'model'; parts: GeminiPart[] };

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
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
  private readonly systemInstruction: string;

  /** Committed text-only turns (past cued exchanges). */
  private history: GeminiTurn[] = [];
  /** PCM segments since the last commit. Each item is one VAD turn's PCM. */
  private pendingAudio: Uint8Array[] = [];
  /** Cached total byte length of pendingAudio. */
  private pendingBytes = 0;

  /** How many of pendingAudio's frames are part of the in-flight request. */
  private inflightCount = 0;
  private inflight = false;

  constructor(opts: GeminiAudioOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.maxHistoryTurns = opts.maxHistoryTurns ?? 24;
    this.systemInstruction = opts.systemInstruction ?? DEFAULT_SYSTEM_INSTRUCTION;
    const softCommitSec = opts.softCommitSec ?? 300; // 5 minutes
    this.softCommitBytes = softCommitSec * SAMPLE_RATE * 2; // 16-bit mono
  }

  reset(): void {
    this.history = [];
    this.pendingAudio = [];
    this.pendingBytes = 0;
  }

  sendTurn(pcm: Uint8Array): void {
    this.pendingAudio.push(pcm);
    this.pendingBytes += pcm.byteLength;
    void this.processQueue();
  }

  /** No-op kept for API compatibility. */
  close(): void {}

  private async processQueue(): Promise<void> {
    if (this.inflight) return;
    if (this.pendingAudio.length === 0) return;
    this.inflight = true;
    try {
      while (this.pendingAudio.length > 0) {
        // Snapshot how many frames we're sending in this request.
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
    const contents = [...this.history, userTurn];

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
      return;
    }

    const json = (await res.json()) as GeminiResponse;
    const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '{"heard":"","cue":null}';
    const parsed = parseResponse(rawText);

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
      at: Date.now(),
    });
    this.opts.onResponse?.(parsed);
  }

  /** Drop the in-flight audio frames and push heard+raw response to history. */
  private commit(heard: string, rawText: string): void {
    // Remove the frames that were part of the in-flight request, keep the
    // rest (frames that arrived while we were waiting for the response).
    const dropped = this.pendingAudio.splice(0, this.inflightCount);
    let droppedBytes = 0;
    for (const f of dropped) droppedBytes += f.byteLength;
    this.pendingBytes -= droppedBytes;

    if (heard) {
      this.history.push({ role: 'user', parts: [{ text: heard }] });
      this.history.push({ role: 'model', parts: [{ text: rawText }] });
      this.trimHistory();
    }
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
