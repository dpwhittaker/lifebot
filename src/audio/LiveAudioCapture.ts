import { MicVAD } from '@ricky0123/vad-web';
import type { GeminiAudioOrchestrator } from '../orchestrator/GeminiAudio';

export type LiveCaptureCallbacks = {
  onVadActive?: (active: boolean) => void;
  onAudioSent?: (bytes: number, at: number) => void;
  onError?: (msg: string) => void;
  onStatusChange?: (active: boolean) => void;
  /** Per-event VAD trace for debugging. */
  onVadEvent?: (
    kind: 'speech_start' | 'speech_end' | 'misfire' | 'merge' | 'flush',
    info?: { samples?: number; bufferMs?: number; reason?: string },
  ) => void;
};

const SAMPLE_RATE = 16000;
const HARD_CAP_MS = 30_000; // matches Gemini's per-request audio sweet spot
const MERGE_THRESHOLDS = [
  { uptoMs: 3_000, mergeMs: 1_500 }, // short utterances: be patient
  { uptoMs: 6_000, mergeMs: 1_000 }, // medium: somewhat impatient
  { uptoMs: Infinity, mergeMs: 400 }, // long: cut soon
];
const PRE_ROLL_FRAMES = 32; // ~1 second at 32ms/frame (Silero v5)

function mergeMsFor(bufferMs: number): number {
  for (const t of MERGE_THRESHOLDS) {
    if (bufferMs < t.uptoMs) return t.mergeMs;
  }
  return MERGE_THRESHOLDS[MERGE_THRESHOLDS.length - 1].mergeMs;
}

/**
 * Captures mic input via @ricky0123/vad-web (Silero in WASM) and ships each
 * detected utterance to the orchestrator as a single turn.
 *
 * VAD acts as the *trigger* for what counts as a turn, but once a turn is
 * underway we accumulate **every** frame (including the quiet gaps between
 * VAD-detected speech segments) into the buffer that gets sent. That way
 * far-field words the VAD doesn't notice still ride along for Gemini to
 * pick up.
 *
 * vad-web's `redemptionMs` is fixed at construction, so we set it short and
 * stitch consecutive segments together here, with a merge timeout that
 * shrinks as the buffer grows: short utterances get a generous mid-sentence
 * pause budget; long monologues get cut sooner so we don't sit on a turn
 * forever.
 */
export class LiveAudioCapture {
  private vad?: MicVAD;
  private active = false;
  private wakeLock: WakeLockSentinel | null = null;

  // Ring buffer of recent frames captured *before* the current turn began
  // (used as pre-roll once a turn starts).
  private preRoll: Float32Array[] = [];

  // Continuous audio buffer for the current turn — every frame from pre-roll
  // through final flush, including gaps between VAD-detected segments.
  private turnBuffer: Float32Array[] = [];
  private turnBytes = 0;
  private turnActive = false;
  private mergeTimer: ReturnType<typeof setTimeout> | null = null;

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

        // Capture every frame, not just VAD-detected segments. Whether to
        // include it depends on whether a turn is currently active.
        onFrameProcessed: (_probs, frame) => {
          if (this.turnActive) {
            // Append every frame during an active turn — including silence
            // between speech segments.
            this.turnBuffer.push(frame);
            this.turnBytes += frame.length;
            // Hard cap protection (in case nothing ever flushes us).
            const bufferMs = (this.turnBytes / SAMPLE_RATE) * 1000;
            if (bufferMs >= HARD_CAP_MS) this.flushMerge('hard-cap');
          } else {
            // Outside a turn — keep a small rolling pre-roll so the first
            // word isn't truncated when speech_start fires.
            this.preRoll.push(frame);
            if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
          }
        },

        onSpeechStart: () => {
          this.cb.onVadActive?.(true);
          this.cb.onVadEvent?.('speech_start');
          if (!this.turnActive) {
            // New turn — seed it with the pre-roll we've been collecting.
            this.turnActive = true;
            this.turnBuffer = this.preRoll.slice();
            this.turnBytes = this.preRoll.reduce((s, f) => s + f.length, 0);
            this.preRoll = [];
          } else if (this.mergeTimer) {
            // Mid-turn merge — speech resumed before flush fired.
            clearTimeout(this.mergeTimer);
            this.mergeTimer = null;
            this.cb.onVadEvent?.('merge', {
              bufferMs: Math.round((this.turnBytes / SAMPLE_RATE) * 1000),
            });
          }
        },
        onSpeechEnd: (audio) => {
          this.cb.onVadActive?.(false);
          this.cb.onVadEvent?.('speech_end', { samples: audio.length });
          this.scheduleFlush();
        },
        onVADMisfire: () => {
          this.cb.onVadActive?.(false);
          this.cb.onVadEvent?.('misfire');
          // Misfire after a fresh speech_start means that detected blip was
          // too short to be real speech. If we just opened a turn for it,
          // give the merge timer a chance to expire and ship what we have
          // (which might still contain quiet far-field speech). If a turn
          // was already underway, this is harmless noise — leave the turn
          // running and let the merge timer keep scheduling.
          if (this.turnActive) this.scheduleFlush();
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
    this.flushMerge('stop');
    this.active = false;
    this.cb.onStatusChange?.(false);
    this.cb.onVadActive?.(false);
    this.releaseWakeLock();
    this.orchestrator.close();
    this.preRoll = [];
  }

  async release(): Promise<void> {
    await this.stop();
    this.vad?.destroy();
    this.vad = undefined;
  }

  private scheduleFlush() {
    if (this.mergeTimer) clearTimeout(this.mergeTimer);
    if (!this.turnActive || this.turnBytes === 0) return;
    const bufferMs = (this.turnBytes / SAMPLE_RATE) * 1000;
    if (bufferMs >= HARD_CAP_MS) {
      this.flushMerge('hard-cap');
      return;
    }
    const delay = mergeMsFor(bufferMs);
    this.mergeTimer = setTimeout(() => this.flushMerge('idle'), delay);
  }

  private flushMerge(reason: string) {
    if (this.mergeTimer) {
      clearTimeout(this.mergeTimer);
      this.mergeTimer = null;
    }
    if (this.turnBytes === 0) {
      this.turnActive = false;
      return;
    }
    const total = new Float32Array(this.turnBytes);
    let offset = 0;
    for (const frame of this.turnBuffer) {
      total.set(frame, offset);
      offset += frame.length;
    }
    const bufferMs = Math.round((this.turnBytes / SAMPLE_RATE) * 1000);
    this.turnBuffer = [];
    this.turnBytes = 0;
    this.turnActive = false;

    this.cb.onVadEvent?.('flush', { bufferMs, reason });
    const pcm = float32ToInt16(total);
    this.orchestrator.sendTurn(pcm);
    this.cb.onAudioSent?.(pcm.byteLength, Date.now());
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
