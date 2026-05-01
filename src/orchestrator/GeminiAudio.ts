import { base64FromUint8 } from '../util/base64';

export type AudioOrchestratorTrace =
  | { type: 'sent'; bytes: number; at: number }
  | {
      type: 'response';
      heard: string;
      cue: string | null;
      latencyMs: number;
      at: number;
    }
  | { type: 'error'; error: string; latencyMs: number; at: number };

export type AudioResponse = {
  heard: string;
  cue: string | null;
};

export type GeminiAudioOptions = {
  apiKey: string;
  model: string;
  systemInstruction?: string;
  /** How many user/model turn pairs of context to keep in history. */
  maxHistoryTurns?: number;
  fetchImpl?: typeof fetch;
  onTrace?: (event: AudioOrchestratorTrace) => void;
  onResponse?: (response: AudioResponse) => void;
};

const DEFAULT_SYSTEM_INSTRUCTION = `You are a passive session monitor for an in-person conversation (e.g., a tabletop game, study group, meeting).
For each audio utterance, respond with ONLY a JSON object of shape:
{"heard": "<one-line transcript of what was said>", "cue": "<short helpful summary>" | null}

Rules for "cue":
- Provide one if and only if the speaker mentioned a specific factual claim, D&D rule, definition, name, date, formula, or explicitly requested data.
- Keep cues under 240 characters.
- Otherwise output null. Skip filler / opinions / chit-chat / ambient noise.

Always include "heard" — a clean one-line transcript. Never output anything other than the JSON object.`;

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };
type GeminiTurn = { role: 'user' | 'model'; parts: GeminiPart[] };

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
};

/**
 * One REST call per utterance. Audio in (inlineData), JSON {heard, cue} out.
 * Maintains a stateful conversation history but rewrites past audio turns to
 * just their transcribed text, so token cost stays flat over a long session.
 */
export class GeminiAudioOrchestrator {
  private readonly opts: GeminiAudioOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly maxHistoryTurns: number;
  private readonly systemInstruction: string;

  private history: GeminiTurn[] = [];
  private inflight = false;
  private queue: Uint8Array[] = [];

  constructor(opts: GeminiAudioOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.maxHistoryTurns = opts.maxHistoryTurns ?? 24;
    this.systemInstruction = opts.systemInstruction ?? DEFAULT_SYSTEM_INSTRUCTION;
  }

  reset(): void {
    this.history = [];
    this.queue = [];
  }

  sendTurn(pcm: Uint8Array): void {
    this.queue.push(pcm);
    void this.processQueue();
  }

  /** No-op kept for callers that previously held a WebSocket lifecycle. */
  close(): void {
    this.queue = [];
  }

  private async processQueue(): Promise<void> {
    if (this.inflight) return;
    this.inflight = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        await this.evaluate(next);
      }
    } finally {
      this.inflight = false;
    }
  }

  private async evaluate(pcm: Uint8Array): Promise<void> {
    const startedAt = Date.now();
    this.opts.onTrace?.({ type: 'sent', bytes: pcm.byteLength, at: startedAt });

    const audioPart: GeminiPart = {
      inlineData: {
        mimeType: 'audio/pcm;rate=16000',
        data: base64FromUint8(pcm),
      },
    };
    const userTurn: GeminiTurn = { role: 'user', parts: [audioPart] };
    const contents = [...this.history, userTurn];

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${this.opts.model}:generateContent` +
      `?key=${encodeURIComponent(this.opts.apiKey)}`;
    const body = {
      systemInstruction: { parts: [{ text: this.systemInstruction }] },
      contents,
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
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

    // Replace this turn's audio with text so future requests stay cheap.
    if (parsed.heard) {
      this.history.push({ role: 'user', parts: [{ text: parsed.heard }] });
      this.history.push({ role: 'model', parts: [{ text: rawText }] });
      this.trimHistory();
    }

    this.opts.onTrace?.({
      type: 'response',
      heard: parsed.heard,
      cue: parsed.cue,
      latencyMs: Date.now() - startedAt,
      at: Date.now(),
    });
    this.opts.onResponse?.(parsed);
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
