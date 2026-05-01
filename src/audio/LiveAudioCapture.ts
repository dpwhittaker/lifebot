import { MicVAD } from '@ricky0123/vad-web';
import type { GeminiAudioOrchestrator } from '../orchestrator/GeminiAudio';

export type LiveCaptureCallbacks = {
  onVadActive?: (active: boolean) => void;
  onAudioSent?: (bytes: number, at: number) => void;
  onError?: (msg: string) => void;
  onStatusChange?: (active: boolean) => void;
  /** Per-event VAD trace for debugging (start / end / misfire). */
  onVadEvent?: (kind: 'speech_start' | 'speech_end' | 'misfire', samples?: number) => void;
};

/**
 * Captures mic input via @ricky0123/vad-web (Silero in WASM), gates uploads
 * locally so we never stream silence to the orchestrator, and ships each
 * detected utterance as one turn via the orchestrator's sendTurn.
 */
export class LiveAudioCapture {
  private vad?: MicVAD;
  private active = false;
  private wakeLock: WakeLockSentinel | null = null;

  private readonly orchestrator: GeminiAudioOrchestrator;
  private readonly cb: LiveCaptureCallbacks;

  constructor(orchestrator: GeminiAudioOrchestrator, cb: LiveCaptureCallbacks) {
    this.orchestrator = orchestrator;
    this.cb = cb;
  }

  get isActive() {
    return this.active;
  }

  async start(): Promise<void> {
    if (this.active) return;

    if (!this.vad) {
      this.vad = await MicVAD.new({
        // Silero v5 is the modern default; "legacy" is more permissive on
        // far-field. Try v5 first; if it misses ambient table conversation,
        // swap to "legacy".
        model: 'v5',
        // ONNX Runtime defaults to fetching its wasm files from a path
        // relative to the bundled JS (which Vite puts under /assets/), but
        // we ship them at the document base. Point ort at the right place.
        ortConfig: (ort) => {
          ort.env.wasm.wasmPaths = new URL('./', document.baseURI).href;
        },
        // VAD thresholds — tuned aggressively for ambient room voice. The
        // negative threshold has to be low enough that background noise
        // doesn't keep the probability above it forever (which would prevent
        // onSpeechEnd from ever firing). 0.15 is well below typical
        // background-noise probabilities (~0.2) but well above clear speech
        // (~0.7+), so silence gets recognised.
        positiveSpeechThreshold: 0.45,
        negativeSpeechThreshold: 0.2,
        minSpeechMs: 150,
        redemptionMs: 600, // tail before we consider speech ended
        preSpeechPadMs: 200, // pre-roll baked into the audio buffer
        onSpeechStart: () => {
          this.cb.onVadActive?.(true);
          this.cb.onVadEvent?.('speech_start');
        },
        onSpeechEnd: (audio) => {
          this.cb.onVadActive?.(false);
          this.cb.onVadEvent?.('speech_end', audio.length);
          const pcm = float32ToInt16(audio);
          this.orchestrator.sendTurn(pcm);
          this.cb.onAudioSent?.(pcm.byteLength, Date.now());
        },
        onVADMisfire: () => {
          this.cb.onVadActive?.(false);
          this.cb.onVadEvent?.('misfire');
        },
      });
    }

    this.vad.start();
    this.active = true;
    this.cb.onStatusChange?.(true);
    await this.requestWakeLock();
  }

  async stop(): Promise<void> {
    this.vad?.pause();
    this.active = false;
    this.cb.onStatusChange?.(false);
    this.cb.onVadActive?.(false);
    this.releaseWakeLock();
    this.orchestrator.close();
  }

  async release(): Promise<void> {
    await this.stop();
    this.vad?.destroy();
    this.vad = undefined;
  }

  private async requestWakeLock() {
    if (typeof navigator === 'undefined') return;
    const wl: WakeLock | undefined = (navigator as { wakeLock?: WakeLock }).wakeLock;
    if (!wl) return;
    try {
      this.wakeLock = await wl.request('screen');
    } catch (e) {
      this.cb.onError?.(`wake lock: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private releaseWakeLock() {
    void this.wakeLock?.release();
    this.wakeLock = null;
  }
}

/** Convert a Float32 mono PCM frame (-1..1) to little-endian Int16 bytes. */
function float32ToInt16(input: Float32Array): Uint8Array {
  const out = new Uint8Array(input.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < input.length; i++) {
    let s = input[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

// Minimal Wake Lock typings — TS lib doesn't always include them.
interface WakeLock {
  request(type: 'screen'): Promise<WakeLockSentinel>;
}
interface WakeLockSentinel {
  release(): Promise<void>;
}
