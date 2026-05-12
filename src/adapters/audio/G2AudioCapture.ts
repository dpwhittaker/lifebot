import { FrameProcessor, Message } from '@ricky0123/vad-web';
import type { FrameProcessorEvent } from '@ricky0123/vad-web/dist/frame-processor';
import type { Model } from '@ricky0123/vad-web/dist/models/common';
import { SileroV5 } from '@ricky0123/vad-web/dist/models/v5';
import { defaultModelFetcher } from '@ricky0123/vad-web/dist/default-model-fetcher';
import * as ort from 'onnxruntime-web/wasm';
import {
  type EvenAppBridge,
  type EvenHubEvent,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';

import type { GeminiAudioOrchestrator } from '../../orchestrator/GeminiAudio';
import type { AudioCapture, AudioCaptureCallbacks } from './types';

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 512; // Silero V5 frame size at 16 kHz → 32 ms
const MS_PER_FRAME = (FRAME_SAMPLES / SAMPLE_RATE) * 1000;
const HARD_CAP_MS = 30_000;
const MERGE_THRESHOLDS = [
  { uptoMs: 3_000, mergeMs: 1_500 },
  { uptoMs: 6_000, mergeMs: 1_000 },
  { uptoMs: Infinity, mergeMs: 400 },
];
const PRE_ROLL_FRAMES = 32; // ~1 s of 32 ms frames
const BRIDGE_WAIT_TIMEOUT_MS = 1500;

function mergeMsFor(bufferMs: number): number {
  for (const t of MERGE_THRESHOLDS) {
    if (bufferMs < t.uptoMs) return t.mergeMs;
  }
  return MERGE_THRESHOLDS[MERGE_THRESHOLDS.length - 1].mergeMs;
}

/**
 * Even-Hub bridge implementation of AudioCapture. Audio comes from the host
 * (Even Hub app / evenhub-simulator) as discrete BLE-PCM events at 16 kHz
 * s16le, ~100 ms per chunk — `getUserMedia` is intentionally unavailable in
 * the WebView, so we can't reuse `WebAudioCapture` here.
 *
 * Pipeline:
 *   bridge.audioPcm event  →  s16le → Float32
 *                          →  slice into 512-sample Silero V5 frames
 *                          →  vad-web `FrameProcessor`
 *                          →  same turn-shaping logic as WebAudioCapture
 *                          →  orchestrator.sendTurn(pcm)
 *
 * The merge / pre-roll behaviour mirrors WebAudioCapture deliberately: every
 * frame inside an active turn rides along (not just VAD-detected ones), so
 * quiet far-field words still reach Gemini. The two adapters are siblings;
 * either could be selected per build target.
 */
export class G2AudioCapture implements AudioCapture {
  private bridge: EvenAppBridge | null = null;
  private model: Model | null = null;
  private frameProcessor: FrameProcessor | null = null;
  private unsubscribe: (() => void) | null = null;

  private active = false;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  // PCM ingest state. `residual` carries < FRAME_SAMPLES leftover samples
  // between bridge events so frame boundaries don't align with chunk
  // boundaries.
  private residual = new Float32Array(0);
  private pcmQueue: Float32Array[] = [];
  private processingQueue = false;

  // Turn shaping (identical to WebAudioCapture).
  private preRoll: Float32Array[] = [];
  private turnBuffer: Float32Array[] = [];
  private turnBytes = 0;
  private turnActive = false;
  private mergeTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.frameProcessor.resume();
    this.unsubscribe = this.bridge.onEvenHubEvent((evt) => this.onBridgeEvent(evt));
    let ok = false;
    try {
      ok = await this.bridge.audioControl(true);
    } catch (e) {
      this.cb.onError?.(
        `audioControl(true) threw: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!ok) {
      this.cb.onError?.('audioControl(true) returned false');
      this.unsubscribe?.();
      this.unsubscribe = null;
      return;
    }
    this.active = true;
    this.cb.onStatusChange?.(true);
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    if (this.bridge) {
      try {
        await this.bridge.audioControl(false);
      } catch {
        /* fire-and-forget on stop */
      }
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    // Drain any in-flight VAD segment, then flush whatever the merge logic
    // has buffered.
    if (this.frameProcessor) {
      this.frameProcessor.endSegment((evt) => this.handleVadEvent(evt));
    }
    this.flushMerge('stop');
    this.active = false;
    this.cb.onStatusChange?.(false);
    this.cb.onVadActive?.(false);
    this.orchestrator.close();
    this.preRoll = [];
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
        positiveSpeechThreshold: 0.45,
        negativeSpeechThreshold: 0.2,
        redemptionMs: 350,
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

  private handleVadEvent(event: FrameProcessorEvent): void {
    switch (event.msg) {
      case Message.FrameProcessed: {
        const frame = event.frame;
        if (!frame) return;
        if (this.turnActive) {
          this.turnBuffer.push(frame);
          this.turnBytes += frame.length;
          const bufferMs = (this.turnBytes / SAMPLE_RATE) * 1000;
          if (bufferMs >= HARD_CAP_MS) this.flushMerge('hard-cap');
        } else {
          this.preRoll.push(frame);
          if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
        }
        break;
      }
      case Message.SpeechStart:
        this.cb.onVadActive?.(true);
        this.cb.onVadEvent?.('speech_start');
        if (!this.turnActive) {
          this.turnActive = true;
          this.turnBuffer = this.preRoll.slice();
          this.turnBytes = this.preRoll.reduce((s, f) => s + f.length, 0);
          this.preRoll = [];
        } else if (this.mergeTimer) {
          clearTimeout(this.mergeTimer);
          this.mergeTimer = null;
          this.cb.onVadEvent?.('merge', {
            bufferMs: Math.round((this.turnBytes / SAMPLE_RATE) * 1000),
          });
        }
        break;
      case Message.SpeechEnd:
        this.cb.onVadActive?.(false);
        this.cb.onVadEvent?.('speech_end', { samples: event.audio?.length ?? 0 });
        this.scheduleFlush();
        break;
      case Message.VADMisfire:
        this.cb.onVadActive?.(false);
        this.cb.onVadEvent?.('misfire');
        if (this.turnActive) this.scheduleFlush();
        break;
      // SpeechRealStart / SpeechStop / AudioFrame: not needed for turn shaping.
    }
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
