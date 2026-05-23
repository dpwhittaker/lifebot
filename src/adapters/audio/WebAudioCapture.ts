import { MicVAD } from '@ricky0123/vad-web';
import type { GeminiAudioOrchestrator } from '../../orchestrator/GeminiAudio';
import type { AudioCapture, AudioCaptureCallbacks } from './types';

/**
 * Browser-mic implementation of AudioCapture. Captures via @ricky0123/vad-web
 * (Silero in WASM).
 *
 * Every frame is streamed to the orchestrator continuously — silence included
 * — so far-field/sub-threshold speech the VAD can't hear still reaches Gemini.
 * The VAD's only role is *cadence*: speech detected → fast send interval;
 * otherwise the orchestrator falls back to its idle rate.
 */
export class WebAudioCapture implements AudioCapture {
  private vad?: MicVAD;
  private active = false;
  private wakeLock: WakeLockSentinel | null = null;

  private readonly orchestrator: GeminiAudioOrchestrator;
  private readonly cb: AudioCaptureCallbacks;

  constructor(orchestrator: GeminiAudioOrchestrator, cb: AudioCaptureCallbacks) {
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
        // VAD thresholds tuned for ambient room voice. Negative threshold
        // has to be low enough that background noise doesn't keep the
        // probability above it forever.
        positiveSpeechThreshold: 0.45,
        negativeSpeechThreshold: 0.2,
        minSpeechMs: 150,
        // Short redemption: vad-web fires speech_end on tiny pauses. The
        // merge logic below decides when to actually commit a turn.
        redemptionMs: 350,
        preSpeechPadMs: 200,

        // Stream every frame to the orchestrator continuously — silence and
        // all — so far-field/sub-threshold speech rides along for Gemini.
        onFrameProcessed: (_probs, frame) => {
          this.orchestrator.sendTurn(float32ToInt16(frame));
        },

        // Speech{Start,End} drive cadence only (orchestrator.setSpeaking).
        onSpeechStart: () => {
          this.cb.onVadActive?.(true);
          this.cb.onVadEvent?.('speech_start');
          this.orchestrator.setSpeaking(true);
        },
        onSpeechEnd: (audio) => {
          this.cb.onVadActive?.(false);
          this.cb.onVadEvent?.('speech_end', { samples: audio.length });
          this.orchestrator.setSpeaking(false);
        },
        onVADMisfire: () => {
          this.cb.onVadActive?.(false);
          this.cb.onVadEvent?.('misfire');
          this.orchestrator.setSpeaking(false);
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
    this.orchestrator.setSpeaking(false);
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
