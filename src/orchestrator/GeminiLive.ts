import { base64FromUint8 } from '../util/base64';

export type LiveTrace =
  | { type: 'connecting'; at: number }
  | { type: 'connected'; at: number }
  | { type: 'setup_sent'; at: number }
  | { type: 'setup_complete'; at: number }
  | { type: 'sent_audio'; bytes: number; at: number }
  | { type: 'input_transcript_partial'; text: string; at: number }
  | { type: 'output_transcript_partial'; text: string; at: number }
  | { type: 'response_text'; text: string; at: number }
  | { type: 'turn_complete'; heard: string; said: string; at: number }
  | { type: 'error'; error: string; at: number }
  | { type: 'closed'; code?: number; reason?: string; at: number };

export type LiveResponse = {
  heard: string;
  cue: string | null;
};

export type GeminiLiveOptions = {
  apiKey: string;
  model: string;
  systemInstruction?: string;
  onTrace?: (event: LiveTrace) => void;
  onResponse?: (response: LiveResponse) => void;
};

// gemini-3.1-flash-live-preview is an audio-output model. We request AUDIO
// modality (the only one it supports), enable input + output transcription so
// we can read both sides as text, and ignore the model's audio bytes.
// The system prompt asks for terse output so we don't pay for long audio
// generations we'll never play.
const DEFAULT_SYSTEM_INSTRUCTION = `You are a passive session monitor for an in-person conversation (e.g., a tabletop game, study group, meeting).
After each user turn, respond with EXACTLY ONE of these two outputs and nothing else:
1. A brief cue (under 30 words) — if and only if the user mentioned a specific factual claim, D&D rule, definition, name, date, formula, or explicitly requested data.
2. The single word "null" — for everything else (chit-chat, opinions, filler, ambient noise).
Do not greet, do not narrate, do not ask questions. One short utterance, then stop.`;

export class GeminiLiveOrchestrator {
  private ws: WebSocket | null = null;
  private setupComplete = false;
  private pendingMessages: string[] = [];
  // Per-turn buffers for streaming transcriptions
  private inputBuffer = '';
  private outputBuffer = '';
  private readonly opts: GeminiLiveOptions;

  constructor(opts: GeminiLiveOptions) {
    this.opts = opts;
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    if (this.ws) return;

    this.opts.onTrace?.({ type: 'connecting', at: Date.now() });

    const url =
      `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent` +
      `?key=${encodeURIComponent(this.opts.apiKey)}`;

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.opts.onTrace?.({ type: 'connected', at: Date.now() });
      this.sendSetup();
    };

    ws.onmessage = (event) => {
      void this.receiveFrame(event.data);
    };

    ws.onerror = (event: any) => {
      const message = event?.message ?? 'WebSocket error';
      this.opts.onTrace?.({ type: 'error', error: message, at: Date.now() });
    };

    ws.onclose = (event) => {
      this.opts.onTrace?.({
        type: 'closed',
        code: event.code,
        reason: event.reason,
        at: Date.now(),
      });
      this.ws = null;
      this.setupComplete = false;
      this.pendingMessages = [];
    };
  }

  private sendSetup() {
    const setup = {
      setup: {
        model: `models/${this.opts.model}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          temperature: 0.2,
        },
        systemInstruction: {
          parts: [{ text: this.opts.systemInstruction ?? DEFAULT_SYSTEM_INSTRUCTION }],
        },
        // Give us text of what the user said.
        inputAudioTranscription: {},
        // Give us text of what the model said (so we don't have to play audio).
        outputAudioTranscription: {},
      },
    };
    try {
      this.ws?.send(JSON.stringify(setup));
      this.opts.onTrace?.({ type: 'setup_sent', at: Date.now() });
    } catch (e) {
      this.opts.onTrace?.({
        type: 'error',
        error: `Failed to send setup: ${stringifyError(e)}`,
        at: Date.now(),
      });
    }
  }

  private async receiveFrame(data: unknown): Promise<void> {
    let text: string;
    if (typeof data === 'string') {
      text = data;
    } else if (data && typeof (data as { text?: () => Promise<string> }).text === 'function') {
      // RN WebSocket delivers binary frames as Blob by default. The Live API
      // wraps its JSON messages in binary frames, so unwrap to text.
      try {
        text = await (data as { text: () => Promise<string> }).text();
      } catch (e) {
        this.opts.onTrace?.({
          type: 'error',
          error: `Blob.text() failed: ${stringifyError(e)}`,
          at: Date.now(),
        });
        return;
      }
    } else {
      this.opts.onTrace?.({
        type: 'error',
        error: `Unsupported frame type: ${typeof data}`,
        at: Date.now(),
      });
      return;
    }
    this.handleMessage(text);
  }

  private handleMessage(data: string) {
    if (!data) return;

    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      this.opts.onTrace?.({
        type: 'error',
        error: `Bad server JSON: ${data.slice(0, 200)}`,
        at: Date.now(),
      });
      return;
    }

    if (parsed.setupComplete) {
      this.setupComplete = true;
      this.opts.onTrace?.({ type: 'setup_complete', at: Date.now() });
      this.flushPending();
      return;
    }

    const sc = parsed.serverContent;
    if (!sc) return;

    if (sc.inputTranscription?.text) {
      this.inputBuffer += sc.inputTranscription.text;
      this.opts.onTrace?.({
        type: 'input_transcript_partial',
        text: sc.inputTranscription.text,
        at: Date.now(),
      });
    }

    if (sc.outputTranscription?.text) {
      this.outputBuffer += sc.outputTranscription.text;
      this.opts.onTrace?.({
        type: 'output_transcript_partial',
        text: sc.outputTranscription.text,
        at: Date.now(),
      });
    }

    // We deliberately ignore sc.modelTurn.parts[].inlineData (the audio bytes)
    // — we asked for audio output but won't play it. Token cost is paid either
    // way; we only care about the transcribed text.

    if (sc.turnComplete) {
      const heard = this.inputBuffer.trim();
      const said = this.outputBuffer.trim();
      this.inputBuffer = '';
      this.outputBuffer = '';
      this.opts.onTrace?.({ type: 'turn_complete', heard, said, at: Date.now() });
      if (said) {
        this.opts.onTrace?.({ type: 'response_text', text: said, at: Date.now() });
      }
      this.opts.onResponse?.({
        heard,
        cue: extractCue(said),
      });
    }
  }

  private flushPending() {
    for (const msg of this.pendingMessages) {
      try {
        this.ws?.send(msg);
      } catch (e) {
        this.opts.onTrace?.({
          type: 'error',
          error: `Failed to flush pending: ${stringifyError(e)}`,
          at: Date.now(),
        });
      }
    }
    this.pendingMessages = [];
  }

  /**
   * Send a complete utterance as one client turn with turnComplete=true.
   * The server responds immediately rather than waiting on its own VAD —
   * which matters because we VAD-gate on the device and don't stream silence,
   * so the server's automatic activity detection would otherwise stall.
   */
  sendTurn(pcm: Uint8Array): void {
    if (!this.ws) return;
    const b64 = base64FromUint8(pcm);
    const payload = JSON.stringify({
      clientContent: {
        turns: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: 'audio/pcm;rate=16000',
                  data: b64,
                },
              },
            ],
          },
        ],
        turnComplete: true,
      },
    });
    if (!this.setupComplete) {
      this.pendingMessages.push(payload);
      return;
    }
    try {
      this.ws.send(payload);
      this.opts.onTrace?.({ type: 'sent_audio', bytes: pcm.byteLength, at: Date.now() });
    } catch (e) {
      this.opts.onTrace?.({
        type: 'error',
        error: `Send failed: ${stringifyError(e)}`,
        at: Date.now(),
      });
    }
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
    this.setupComplete = false;
    this.pendingMessages = [];
    this.inputBuffer = '';
    this.outputBuffer = '';
  }
}

function extractCue(said: string): string | null {
  const trimmed = said.trim();
  if (!trimmed) return null;
  // Accept "null" / "Null" / "NULL" / "null." / etc. as the no-cue signal.
  const normalized = trimmed.toLowerCase().replace(/[.!?,;:]+$/g, '').trim();
  if (normalized === 'null' || normalized === 'no cue' || normalized === 'none') {
    return null;
  }
  return trimmed;
}

function stringifyError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
