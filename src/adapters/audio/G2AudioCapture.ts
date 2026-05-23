import { FrameProcessor, Message } from '@ricky0123/vad-web';
import type { FrameProcessorEvent } from '@ricky0123/vad-web/dist/frame-processor';
import type { Model } from '@ricky0123/vad-web/dist/models/common';
import { SileroV5 } from '@ricky0123/vad-web/dist/models/v5';
import { defaultModelFetcher } from '@ricky0123/vad-web/dist/default-model-fetcher';
import * as ort from 'onnxruntime-web/wasm';
import {
  type DeviceStatus,
  type EvenAppBridge,
  type EvenHubEvent,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';

import type { GeminiAudioOrchestrator } from '../../orchestrator/GeminiAudio';
import type { AudioCapture, AudioCaptureCallbacks } from './types';

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 512; // Silero V5 frame size at 16 kHz → 32 ms
const MS_PER_FRAME = (FRAME_SAMPLES / SAMPLE_RATE) * 1000;
const BRIDGE_WAIT_TIMEOUT_MS = 1500;

/**
 * Even-Hub bridge implementation of AudioCapture. Audio comes from the host
 * (Even Hub app / evenhub-simulator) as discrete BLE-PCM events at 16 kHz
 * s16le, ~100 ms per chunk — `getUserMedia` is intentionally unavailable in
 * the WebView, so we can't reuse `WebAudioCapture` here.
 *
 * Pipeline:
 *   bridge.audioPcm event  →  s16le → Float32
 *                          →  orchestrator.sendTurn(pcm)   (ALL audio, always)
 *                          →  also sliced into 512-sample Silero V5 frames
 *                          →  vad-web `FrameProcessor`  →  orchestrator.setSpeaking
 *
 * Every chunk of audio is streamed to the orchestrator unconditionally —
 * silence included — so the model can resolve far-field/sub-threshold speech
 * the VAD can't hear. The VAD's sole job here is *cadence*: speech detected →
 * fast send interval; otherwise the orchestrator falls back to its idle rate.
 */
export class G2AudioCapture implements AudioCapture {
  private bridge: EvenAppBridge | null = null;
  private model: Model | null = null;
  private frameProcessor: FrameProcessor | null = null;
  private unsubscribe: (() => void) | null = null;
  private statusUnsubscribe: (() => void) | null = null;

  private active = false;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  // PCM ingest state. `residual` carries < FRAME_SAMPLES leftover samples
  // between bridge events so frame boundaries don't align with chunk
  // boundaries.
  private residual = new Float32Array(0);
  private pcmQueue: Float32Array[] = [];
  private processingQueue = false;

  // Audio-stream watchdog. When the host stops delivering PCM (BLE
  // hiccup, OS power throttle, wear sensor) the JS side just sees a
  // sudden silence — VAD stops firing, the log goes quiet, the user
  // thinks "it stopped listening". The watchdog catches that and
  // attempts to bounce audioControl to revive the stream.
  //
  // Suppressed while the host has us backgrounded (FG_EXIT) — bouncing
  // there spams the bridge with calls the host has already declined.
  private lastPcmAt = 0;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogBouncing = false;
  private watchdogFailedBounces = 0;
  private suspendedByHost = false;

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
    await this.ensureInitialized();
    if (!this.bridge || !this.frameProcessor) {
      this.cb.onError?.('G2 audio: bridge unavailable');
      return;
    }

    // Probe device state up front. The host returns `false` from audioControl
    // when the glasses aren't actually paired/awake; the bare boolean strips
    // out the reason. Surface it so the user knows what to fix.
    const deviceSummary = await this.describeDevice();
    if (deviceSummary) {
      this.cb.onError?.(`G2 device: ${deviceSummary}`);
    }

    this.frameProcessor.resume();
    this.unsubscribe = this.bridge.onEvenHubEvent((evt) => this.onBridgeEvent(evt));

    // Subscribe to live device status pushes so the orchestrator log shows
    // the wear/charge/connect state in real time. We no longer gate audio on
    // any of these — they're informational only.
    let lastStatusSummary = '';
    this.statusUnsubscribe = this.bridge.onDeviceStatusChanged((status) => {
      const summary = summarizeStatus(status);
      if (summary !== lastStatusSummary) {
        lastStatusSummary = summary;
        this.cb.onError?.(`G2 status: ${summary}`);
      }
    });

    const tryControl = async (): Promise<boolean> => {
      try {
        return await this.bridge!.audioControl(true);
      } catch (e) {
        this.cb.onError?.(
          `audioControl(true) threw: ${e instanceof Error ? e.message : String(e)}`,
        );
        return false;
      }
    };

    let ok = await tryControl();
    if (!ok) {
      // Host returned false (often because the wearing sensor hasn't tripped
      // yet). Don't gate on it — start the audio pipeline anyway and let any
      // audioPcm events that do arrive flow through. The orchestrator will
      // simply see no turns if the mic stays dark.
      const tail = deviceSummary ? ` (${deviceSummary})` : '';
      this.cb.onError?.(
        `audioControl(true) returned false${tail} — starting anyway; expect no audio until host accepts`,
      );
    }
    this.active = true;
    this.cb.onStatusChange?.(true);
    this.lastPcmAt = Date.now();
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => void this.checkPcmStall(), 1500);
  }

  /** Bounce audioControl if the bridge has been silent for too long.
   *  Skipped while the host has us backgrounded — the host won't
   *  re-enable audio there and bouncing just spams the bridge. After
   *  3 consecutive failed bounces the watchdog gives up until either
   *  audio resumes (lastPcmAt updates) or the user explicitly toggles
   *  via stop()/start(). */
  private async checkPcmStall(): Promise<void> {
    if (!this.active || !this.bridge || this.watchdogBouncing) return;
    if (this.suspendedByHost) return; // backgrounded — host won't accept
    if (this.watchdogFailedBounces >= 3) return; // gave up
    const silentMs = Date.now() - this.lastPcmAt;
    if (silentMs < 3000) return;
    this.watchdogBouncing = true;
    this.cb.onError?.(`audio stalled ${silentMs}ms — bouncing audioControl`);
    try {
      await this.bridge.audioControl(false);
      await new Promise((r) => setTimeout(r, 150));
      const ok = await this.bridge.audioControl(true);
      this.cb.onError?.(`audioControl bounce → ${ok}`);
      if (ok) {
        this.watchdogFailedBounces = 0;
      } else {
        this.watchdogFailedBounces++;
        if (this.watchdogFailedBounces >= 3) {
          this.cb.onError?.(
            'watchdog: 3 failed bounces — giving up. Use Stop/Start to retry.',
          );
        }
      }
      this.lastPcmAt = Date.now();
    } catch (e) {
      this.cb.onError?.(
        `audioControl bounce threw: ${e instanceof Error ? e.message : String(e)}`,
      );
      this.watchdogFailedBounces++;
    } finally {
      this.watchdogBouncing = false;
    }
  }

  /** Called by App.tsx on FG_EXIT / FG_ENTER so the watchdog doesn't
   *  fight a host pause. Resets the failure counter on resume so a
   *  legitimate post-resume stall still gets one shot at recovery. */
  setHostSuspended(suspended: boolean): void {
    this.suspendedByHost = suspended;
    if (!suspended) {
      this.watchdogFailedBounces = 0;
      // Don't reset lastPcmAt — let the watchdog's first post-resume tick
      // pick up the real silence duration. PCM frames should resume
      // within a second of FG_ENTER if the host is going to deliver.
    }
  }

  /** Best-effort one-line summary of the paired G2 (or null if the host
   *  doesn't expose it). Used to annotate audioControl failures. */
  private async describeDevice(): Promise<string | null> {
    if (!this.bridge) return null;
    try {
      const info = await this.bridge.getDeviceInfo();
      if (!info) return 'no device paired';
      return `${info.model} ${summarizeStatus(info.status)}`;
    } catch (e) {
      return `getDeviceInfo threw: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.bridge) {
      try {
        await this.bridge.audioControl(false);
      } catch {
        /* fire-and-forget on stop */
      }
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.statusUnsubscribe?.();
    this.statusUnsubscribe = null;
    // Close out any open VAD segment so the next session starts clean.
    if (this.frameProcessor) {
      this.frameProcessor.endSegment((evt) => this.handleVadEvent(evt));
    }
    this.orchestrator.setSpeaking(false);
    this.active = false;
    this.cb.onStatusChange?.(false);
    this.cb.onVadActive?.(false);
    this.orchestrator.close();
    this.residual = new Float32Array(0);
    this.pcmQueue = [];
  }

  async release(): Promise<void> {
    await this.stop();
    if (this.model) {
      try {
        await this.model.release();
      } catch {
        /* ignore */
      }
    }
    this.model = null;
    this.frameProcessor = null;
    this.bridge = null;
    this.initialized = false;
    this.initPromise = null;
  }

  private ensureInitialized(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initialize().finally(() => {
      this.initialized = true;
    });
    return this.initPromise;
  }

  private async initialize(): Promise<void> {
    // Same wasm-path setup as WebAudioCapture: we ship the ORT wasm assets
    // straight from `public/`, so point ort at the document base.
    ort.env.wasm.wasmPaths = new URL('./', document.baseURI).href;

    const bridge = await raceWithTimeout(waitForEvenAppBridge(), BRIDGE_WAIT_TIMEOUT_MS);
    if (!bridge) {
      this.cb.onError?.('Even Hub bridge not found within 1.5 s');
      return;
    }
    this.bridge = bridge;

    const modelURL = new URL('./silero_vad_v5.onnx', document.baseURI).href;
    let model: Model;
    try {
      model = await SileroV5.new(ort, () => defaultModelFetcher(modelURL));
    } catch (e) {
      this.cb.onError?.(
        `Silero V5 load failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    this.model = model;

    this.frameProcessor = new FrameProcessor(
      model.process,
      model.reset_state,
      {
        // Tuned for the G2's narrow-field directional mic, which captures
        // own-voice loud but far-field/quiet voices at much lower SNR.
        // Lowering the speech-positive threshold makes VAD fire on those
        // quieter frames. Trade-off: more false-positive misfires (the
        // orchestrator already filters misfires < minSpeechMs).
        positiveSpeechThreshold: 0.3,
        // Negative threshold isn't aggressively low — we want fast speech
        // -end detection so the merge windows below can fire turns
        // quickly. Quiet trailing-off speech may still get clipped; the
        // mergeMs window will catch the next breath if there is one.
        negativeSpeechThreshold: 0.2,
        redemptionMs: 200,
        preSpeechPadMs: 200,
        minSpeechMs: 150,
        submitUserSpeechOnPause: false,
      },
      MS_PER_FRAME,
    );
  }

  private onBridgeEvent(evt: EvenHubEvent): void {
    if (!this.active) return;
    const raw = evt.audioEvent?.audioPcm;
    if (!raw) return;
    const f32 = decodeAudioPcm(raw);
    if (f32.length === 0) return;
    this.lastPcmAt = Date.now();
    // Stream ALL audio to the orchestrator continuously — silence included —
    // so the model can resolve far-field/sub-threshold speech the VAD misses.
    // VAD no longer gates *which* audio is sent; it only gates cadence (see
    // handleVadEvent → orchestrator.setSpeaking).
    this.orchestrator.sendTurn(float32ToInt16(f32));
    // Feed the same audio to the VAD for speech-detection (cadence) only.
    this.pcmQueue.push(f32);
    if (!this.processingQueue) void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    this.processingQueue = true;
    try {
      while (this.pcmQueue.length > 0) {
        const chunk = this.pcmQueue.shift()!;
        // Stitch residual + new chunk so frame boundaries stay aligned.
        const merged =
          this.residual.length === 0
            ? chunk
            : concatFloat32(this.residual, chunk);

        let i = 0;
        while (merged.length - i >= FRAME_SAMPLES && this.frameProcessor) {
          // FrameProcessor.process may retain the frame reference (it ends up
          // in the SpeechEnd audio buffer), so copy out of the shared `merged`
          // backing store.
          const frame = merged.slice(i, i + FRAME_SAMPLES);
          await this.frameProcessor.process(frame, (evt) => this.handleVadEvent(evt));
          i += FRAME_SAMPLES;
        }
        this.residual = merged.slice(i);
      }
    } finally {
      this.processingQueue = false;
    }
  }

  /** VAD events drive cadence only — audio is already streamed continuously
   *  in onBridgeEvent. SpeechStart → fast cadence; SpeechEnd/misfire → idle
   *  (after the orchestrator's grace linger). */
  private handleVadEvent(event: FrameProcessorEvent): void {
    switch (event.msg) {
      case Message.SpeechStart:
        this.cb.onVadActive?.(true);
        this.cb.onVadEvent?.('speech_start');
        this.orchestrator.setSpeaking(true);
        break;
      case Message.SpeechEnd:
        this.cb.onVadActive?.(false);
        this.cb.onVadEvent?.('speech_end', { samples: event.audio?.length ?? 0 });
        this.orchestrator.setSpeaking(false);
        break;
      case Message.VADMisfire:
        this.cb.onVadActive?.(false);
        this.cb.onVadEvent?.('misfire');
        this.orchestrator.setSpeaking(false);
        break;
      // FrameProcessed / SpeechRealStart / SpeechStop / AudioFrame: not needed
      // — cadence keys off Speech{Start,End} only.
    }
  }
}

/**
 * Decode the bridge's `audioPcm` payload to a Float32Array in [-1, 1].
 *
 * Per the SDK contract the field is `Uint8Array` (s16le interleaved mono),
 * but the inline comment warns that hosts may transport it as `number[]` or
 * even a base64 string after JSON round-trips. Normalise all three forms.
 */
function decodeAudioPcm(raw: Uint8Array | number[] | string): Float32Array {
  let bytes: Uint8Array;
  if (raw instanceof Uint8Array) {
    bytes = raw;
  } else if (Array.isArray(raw)) {
    bytes = new Uint8Array(raw);
  } else if (typeof raw === 'string') {
    bytes = base64ToBytes(raw);
  } else {
    return new Float32Array(0);
  }
  const sampleCount = bytes.length >> 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const s = view.getInt16(i * 2, true);
    out[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
  }
  return out;
}

function summarizeStatus(s: DeviceStatus): string {
  const bits = [`connect=${s.connectType}`];
  if (typeof s.isWearing === 'boolean') bits.push(`worn=${s.isWearing}`);
  if (typeof s.isInCase === 'boolean') bits.push(`incase=${s.isInCase}`);
  if (typeof s.isCharging === 'boolean') bits.push(`chg=${s.isCharging}`);
  if (typeof s.batteryLevel === 'number') bits.push(`batt=${s.batteryLevel}%`);
  return bits.join(' ');
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concatFloat32(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
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

function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}
