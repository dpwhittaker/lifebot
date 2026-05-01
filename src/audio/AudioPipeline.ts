import { PermissionsAndroid, Platform } from 'react-native';
import {
  initWhisper,
  initWhisperVad,
  type WhisperContext,
  type WhisperVadContext,
} from 'whisper.rn';
// whisper.rn's package.json exports field has a malformed "react-native" condition
// (value missing leading "./"), so Metro can't resolve deep paths under it. Disabling
// package exports in metro.config.js falls back to legacy field-based resolution and
// these subpath imports work fine via the `react-native: src/index` main field.
import { RealtimeTranscriber } from 'whisper.rn/src/realtime-transcription';
import { AudioPcmStreamAdapter } from 'whisper.rn/src/realtime-transcription/adapters/AudioPcmStreamAdapter';
import type {
  RealtimeTranscribeEvent,
  RealtimeVadEvent,
} from 'whisper.rn/src/realtime-transcription';

export type TranscriptChunk = {
  id: number;
  text: string;
  startedAt: number;
  finalizedAt: number;
  // Optional diagnostics — only present in whisper-mode chunks.
  eventType?: 'transcribe' | 'end' | 'live';
  isCapturing?: boolean;
  sliceIndex?: number;
  recordingTimeMs?: number;
  processTimeMs?: number;
};

export type PipelineCallbacks = {
  onChunk: (chunk: TranscriptChunk) => void;
  onSentence: (sentence: string) => void;
  onVad?: (event: RealtimeVadEvent) => void;
  onError?: (msg: string) => void;
  onStatusChange?: (active: boolean) => void;
};

const TERMINAL_PUNCT = /[.!?](["')\]]*)\s*$/;
const ABBREVIATION_GUARD = /\b(?:Mr|Mrs|Ms|Dr|Sr|Jr|St|Mt|vs|etc|e\.g|i\.e)\.\s*$/i;

function endsWithSentence(buf: string): boolean {
  const trimmed = buf.trimEnd();
  if (!TERMINAL_PUNCT.test(trimmed)) return false;
  if (ABBREVIATION_GUARD.test(trimmed)) return false;
  return true;
}

function extractCompleteSentences(buf: string): { complete: string; remainder: string } {
  const trimmed = buf.trimEnd();
  if (!endsWithSentence(trimmed)) return { complete: '', remainder: buf };
  return { complete: trimmed, remainder: '' };
}

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

export class AudioPipeline {
  private whisper?: WhisperContext;
  private vad?: WhisperVadContext;
  private transcriber?: RealtimeTranscriber;
  private buffer = '';
  private active = false;
  private chunkSeq = 0;
  // Slice settling: each slice can fire many transcribe events as VAD
  // re-enqueues. We track the most recent text per slice and flush to the
  // orchestrator either when a new slice starts or after a quiet window.
  private currentSliceIndex = -1;
  private currentSliceText = '';
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SLICE_SETTLE_MS = 1500;

  constructor(
    private readonly whisperModelPath: string,
    private readonly vadModelPath: string,
    private readonly cb: PipelineCallbacks,
  ) {}

  get isActive() {
    return this.active;
  }

  async init(): Promise<void> {
    if (this.whisper && this.vad && this.transcriber) return;

    this.whisper = await initWhisper({
      filePath: this.whisperModelPath,
      useGpu: true,
    });
    this.vad = await initWhisperVad({
      filePath: this.vadModelPath,
      useGpu: true,
    });

    const audioStream = new AudioPcmStreamAdapter();

    this.transcriber = new RealtimeTranscriber(
      {
        whisperContext: this.whisper,
        vadContext: this.vad,
        audioStream,
      },
      {
        // Short slices so each utterance gets its own slice index. Whisper.rn
        // re-enqueues transcription on every VAD speech_start/continue/end on
        // the *current* slice, so we additionally dedup by sliceIndex below.
        audioSliceSec: 8,
        audioMinSec: 1,
        maxSlicesInMemory: 3,
        autoSliceOnSpeechEnd: true,
        autoSliceThreshold: 0.2,
        // audioSource 9 = MediaRecorder.AudioSource.UNPROCESSED — raw mic
        // input with no DSP gating, gain control, or noise suppression.
        // VOICE_RECOGNITION (default 6) is tuned for close-talk and actively
        // suppresses far-field audio, which is wrong for ambient table
        // capture. Falls back gracefully on devices that don't support it.
        audioStreamConfig: { audioSource: 9 },
        vadOptions: {
          // Sensitive preset, tuned for ambient room audio rather than
          // close-talk. Lower threshold = lower amplitude floor for "speech".
          threshold: 0.3,
          minSpeechDurationMs: 200,
          minSilenceDurationMs: 600,
          maxSpeechDurationS: 8,
          speechPadMs: 100,
          samplesOverlap: 0.15,
        },
        transcribeOptions: {
          language: 'en',
          maxLen: 1,
          tokenTimestamps: false,
        },
        // See note on duplication: prompt-from-previous-slice causes Whisper
        // to hallucinate prior text into silent windows.
        promptPreviousSlices: false,
      },
      {
        onTranscribe: (event) => this.handleTranscribe(event),
        onVad: (event) => this.cb.onVad?.(event),
        onStatusChange: (isActive) => {
          this.active = isActive;
          this.cb.onStatusChange?.(isActive);
        },
        onError: (err) => this.cb.onError?.(err),
      },
    );
  }

  async start(): Promise<void> {
    if (!this.transcriber) await this.init();
    await this.transcriber!.start();
  }

  async stop(): Promise<void> {
    await this.transcriber?.stop();
    this.flushSettledSlice();
    this.flushBuffer(true);
  }

  async release(): Promise<void> {
    await this.stop();
    this.transcriber = undefined;
    await this.whisper?.release();
    await this.vad?.release();
    this.whisper = undefined;
    this.vad = undefined;
  }

  private handleTranscribe(event: RealtimeTranscribeEvent) {
    if (event.type === 'error') {
      this.cb.onError?.('transcribe error');
      return;
    }
    if (event.type !== 'transcribe' && event.type !== 'end') return;

    const text = event.data?.result?.trim();
    if (!text) return;

    const chunk: TranscriptChunk = {
      id: ++this.chunkSeq,
      text,
      startedAt: Date.now() - event.recordingTime,
      finalizedAt: Date.now(),
      eventType: event.type,
      isCapturing: event.isCapturing,
      sliceIndex: event.sliceIndex,
      recordingTimeMs: Math.round(event.recordingTime),
      processTimeMs: Math.round(event.processTime),
    };
    this.cb.onChunk(chunk);

    // If this is a new slice, the previous one has settled — flush it.
    if (event.sliceIndex !== this.currentSliceIndex) {
      this.flushSettledSlice();
      this.currentSliceIndex = event.sliceIndex;
    }
    this.currentSliceText = text;

    // Reset the settle timer; if no new chunk for this slice arrives within
    // SLICE_SETTLE_MS, treat it as final and flush.
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(
      () => this.flushSettledSlice(),
      AudioPipeline.SLICE_SETTLE_MS,
    );
  }

  private flushSettledSlice() {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.currentSliceText) {
      this.appendToBuffer(this.currentSliceText);
      this.currentSliceText = '';
    }
  }

  private appendToBuffer(text: string) {
    this.buffer = (this.buffer + ' ' + text).replace(/\s+/g, ' ').trim();
    this.flushBuffer(false);
  }

  private flushBuffer(force: boolean) {
    if (!this.buffer) return;
    const { complete, remainder } = extractCompleteSentences(this.buffer);
    if (complete) {
      this.buffer = remainder;
      this.cb.onSentence(complete);
      return;
    }
    if (force) {
      const tail = this.buffer.trim();
      this.buffer = '';
      if (tail) this.cb.onSentence(tail);
    }
  }
}
