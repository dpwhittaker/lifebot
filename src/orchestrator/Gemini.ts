export type GeminiRole = 'user' | 'model';

export type GeminiTurn = {
  role: GeminiRole;
  parts: { text: string }[];
};

export type CueResponse = { cue: string | null };

const SYSTEM_INSTRUCTION = `You are a passive session monitor for an in-person conversation (e.g., a tabletop game, study group, meeting).
Read the running transcript. If the user mentions a specific factual claim, D&D rule, definition, name, date, formula, or explicitly requests data, output a brief helpful summary.
Otherwise output null.
Respond ONLY with JSON of shape {"cue": "..."} or {"cue": null}. Keep cues under 240 characters and skip filler / opinions / chit-chat.`;

export type OrchestratorTrace =
  | { type: 'sent'; id: number; sentence: string; at: number }
  | { type: 'response'; id: number; cue: string | null; latencyMs: number; rawText: string; at: number }
  | { type: 'error'; id: number; error: string; latencyMs: number; at: number };

export type GeminiOrchestratorOptions = {
  apiKey: string;
  model?: string;
  maxHistoryTurns?: number;
  fetchImpl?: typeof fetch;
  onTrace?: (event: OrchestratorTrace) => void;
};

export class GeminiOrchestrator {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxHistoryTurns: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onTrace?: (event: OrchestratorTrace) => void;
  private history: GeminiTurn[] = [];
  private inflight: Promise<CueResponse> | null = null;
  private queue: string[] = [];
  private traceSeq = 0;

  constructor(opts: GeminiOrchestratorOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'gemini-2.5-flash';
    this.maxHistoryTurns = opts.maxHistoryTurns ?? 24;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onTrace = opts.onTrace;
  }

  reset() {
    this.history = [];
    this.queue = [];
  }

  async submit(sentence: string): Promise<CueResponse | null> {
    const clean = sentence.trim();
    if (!clean) return null;

    if (this.inflight) {
      this.queue.push(clean);
      return null;
    }

    this.inflight = this.evaluate(clean);
    try {
      const result = await this.inflight;
      return result;
    } finally {
      this.inflight = null;
      if (this.queue.length) {
        const merged = this.queue.join(' ');
        this.queue = [];
        void this.submit(merged);
      }
    }
  }

  private async evaluate(sentence: string): Promise<CueResponse> {
    const id = ++this.traceSeq;
    const startedAt = Date.now();
    this.onTrace?.({ type: 'sent', id, sentence, at: startedAt });

    const turn: GeminiTurn = { role: 'user', parts: [{ text: sentence }] };
    const contents = [...this.history, turn];

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
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
      const error = e instanceof Error ? e.message : String(e);
      this.onTrace?.({
        type: 'error',
        id,
        error: `network: ${error}`,
        latencyMs: Date.now() - startedAt,
        at: Date.now(),
      });
      throw e;
    }

    if (!res.ok) {
      const detail = await safeText(res);
      const error = `Gemini ${res.status}: ${detail.slice(0, 400)}`;
      this.onTrace?.({
        type: 'error',
        id,
        error,
        latencyMs: Date.now() - startedAt,
        at: Date.now(),
      });
      throw new Error(error);
    }

    const json = (await res.json()) as GeminiResponse;
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '{"cue":null}';
    const parsed = parseCue(text);

    this.onTrace?.({
      type: 'response',
      id,
      cue: parsed.cue,
      latencyMs: Date.now() - startedAt,
      rawText: text,
      at: Date.now(),
    });

    this.history.push(turn);
    this.history.push({
      role: 'model',
      parts: [{ text: JSON.stringify(parsed) }],
    });
    this.trimHistory();

    return parsed;
  }

  private trimHistory() {
    const max = this.maxHistoryTurns * 2;
    if (this.history.length > max) {
      this.history.splice(0, this.history.length - max);
    }
  }
}

function parseCue(raw: string): CueResponse {
  try {
    const parsed = JSON.parse(raw) as Partial<CueResponse>;
    if (parsed && typeof parsed === 'object' && 'cue' in parsed) {
      const value = parsed.cue;
      if (value === null) return { cue: null };
      if (typeof value === 'string') {
        const trimmed = value.trim();
        return { cue: trimmed.length ? trimmed : null };
      }
    }
  } catch {
    // fall through
  }
  return { cue: null };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
};
