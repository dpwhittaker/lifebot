import { PermissionsAndroid, Platform } from 'react-native';
import { initWhisperVad, type WhisperVadContext } from 'whisper.rn';
import { AudioPcmStreamAdapter } from 'whisper.rn/src/realtime-transcription/adapters/AudioPcmStreamAdapter';
import type { AudioStreamData } from 'whisper.rn/src/realtime-transcription';
import { base64FromUint8 } from '../util/base64';
import type { GeminiLiveOrchestrator } from '../orchestrator/GeminiLive';

export type LiveCaptureCallbacks = {
  onVadActive?: (active: boolean) => void;
  onAudioSent?: (bytes: number, at: number) => void;
  onError?: (msg: string) => void;
  onStatusChange?: (active: boolean) => void;
};

export async function requestMicPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const granted = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    {
      title: 'LifeBot needs your microphone',
      message: 'LifeBot listens to ambient conversation to surface contextual cues.',
      buttonPositive: 'Allow',
    },
  );
  return granted === PermissionsAndroid.RESULTS.GRANTED;
}

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const VAD_WINDOW_MS = 500;
const VAD_WINDOW_BYTES = (VAD_WINDOW_MS / 1000) * SAMPLE_RATE * BYTES_PER_SAMPLE;
// Pre-roll: send the last ~250ms of audio when speech starts so we don't
// chop off the beginning of the first word.
const PRE_ROLL_WINDOWS = 1;
// Send N silence windows after speech ends (trailing capture).
const TAIL_WINDOWS = 2;

export class LiveAudioCapture {
  private vad?: WhisperVadContext;
  private audioStream?: AudioPcmStreamAdapter;
  private isCapturing = false;
  private vadInferring = false;
  private speechActive = false;
  private silenceCount = 0;

  // Accumulator until we have a full VAD window.
  private accum: Uint8Array[] = [];
  private accumBytes = 0;

  // Ring buffer for pre-roll (audio just before VAD said yes).
  private preRoll: Uint8Array[] = [];

  // Per-utterance buffer: every window during a speech segment + pre-roll +
  // tail. Flushed as one clientContent turn on speech end.
  private utterance: Uint8Array[] = [];
  private utteranceBytes = 0;
  private static readonly MAX_UTTERANCE_BYTES =
    30 * SAMPLE_RATE * BYTES_PER_SAMPLE; // 30s safety cap

  constructor(
    private readonly vadModelPath: string,
    private readonly orchestrator: GeminiLiveOrchestrator,
    private readonly cb: LiveCaptureCallbacks,
  ) {}

  get isActive() {
    return this.isCapturing;
  }

  async init(): Promise<void> {
    if (this.vad && this.audioStream) return;

    this.vad = await initWhisperVad({
      filePath: this.vadModelPath,
      useGpu: true,
    });

    this.audioStream = new AudioPcmStreamAdapter();
    this.audioStream.onData((data) => this.handleAudioData(data));
    this.audioStream.onStatusChange((active) => {
      this.isCapturing = active;
      this.cb.onStatusChange?.(active);
    });
    this.audioStream.onError((err) => this.cb.onError?.(err));
  }

  async start(): Promise<void> {
    if (!this.audioStream) await this.init();
    await this.orchestrator.connect();
    await this.audioStream!.initialize({
      sampleRate: SAMPLE_RATE,
      channels: 1,
      bitsPerSample: 16,
      // UNPROCESSED — raw mic, no AGC/noise gating, for ambient capture.
      audioSource: 9,
      bufferSize: 16 * 1024,
    });
    await this.audioStream!.start();
  }

  async stop(): Promise<void> {
    await this.audioStream?.stop();
    this.orchestrator.close();
    this.resetState();
  }

  async release(): Promise<void> {
    await this.stop();
    await this.audioStream?.release();
    await this.vad?.release();
    this.audioStream = undefined;
    this.vad = undefined;
  }

  private resetState() {
    this.accum = [];
    this.accumBytes = 0;
    this.preRoll = [];
    this.utterance = [];
    this.utteranceBytes = 0;
    this.speechActive = false;
    this.silenceCount = 0;
  }

  private handleAudioData(data: AudioStreamData) {
    this.accum.push(data.data);
    this.accumBytes += data.data.length;
    if (this.accumBytes < VAD_WINDOW_BYTES) return;

    const window = this.flushAccum();
    void this.processWindow(window);
  }

  private flushAccum(): Uint8Array {
    const out = new Uint8Array(this.accumBytes);
    let offset = 0;
    for (const c of this.accum) {
      out.set(c, offset);
      offset += c.length;
    }
    this.accum = [];
    this.accumBytes = 0;
    return out;
  }

  private async processWindow(window: Uint8Array) {
    // If a previous VAD inference is still in flight, just attribute this
    // window to the current speech state (don't drop it on the floor —
    // continue/end the current segment).
    if (this.vadInferring) {
      if (this.speechActive) this.appendUtterance(window);
      this.pushPreRoll(window);
      return;
    }
    this.vadInferring = true;

    let hasSpeech = false;
    try {
      const segments = await this.vad!.detectSpeechData(
        base64FromUint8(window) as any,
        {
          threshold: 0.3,
          minSpeechDurationMs: 150,
          minSilenceDurationMs: 200,
          maxSpeechDurationS: 30,
          speechPadMs: 30,
          samplesOverlap: 0.1,
        },
      );
      hasSpeech = Array.isArray(segments) && segments.length > 0;
    } catch (e) {
      this.cb.onError?.(`VAD: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.vadInferring = false;
    }

    if (hasSpeech) {
      if (!this.speechActive) {
        this.speechActive = true;
        this.cb.onVadActive?.(true);
        for (const chunk of this.preRoll) {
          this.appendUtterance(chunk);
        }
      }
      this.silenceCount = 0;
      this.appendUtterance(window);
    } else if (this.speechActive) {
      this.silenceCount += 1;
      if (this.silenceCount <= TAIL_WINDOWS) {
        this.appendUtterance(window);
      } else {
        this.flushUtterance();
        this.speechActive = false;
        this.cb.onVadActive?.(false);
      }
    }

    if (this.utteranceBytes >= LiveAudioCapture.MAX_UTTERANCE_BYTES) {
      // Safety cap — long monologues get sliced at 30s and flushed as a turn.
      this.flushUtterance();
      this.speechActive = false;
      this.cb.onVadActive?.(false);
    }

    this.pushPreRoll(window);
  }

  private pushPreRoll(window: Uint8Array) {
    this.preRoll.push(window);
    if (this.preRoll.length > PRE_ROLL_WINDOWS) this.preRoll.shift();
  }

  private appendUtterance(chunk: Uint8Array) {
    this.utterance.push(chunk);
    this.utteranceBytes += chunk.length;
  }

  private flushUtterance() {
    if (this.utteranceBytes === 0) return;
    const out = new Uint8Array(this.utteranceBytes);
    let offset = 0;
    for (const c of this.utterance) {
      out.set(c, offset);
      offset += c.length;
    }
    this.utterance = [];
    this.utteranceBytes = 0;
    this.orchestrator.sendTurn(out);
    this.cb.onAudioSent?.(out.length, Date.now());
  }
}
