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
};

export type PipelineCallbacks = {
  onPartial: (text: string) => void;
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
  private chunkSeq = 0;
  private active = false;

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
        audioSliceSec: 25,
        audioMinSec: 1,
        maxSlicesInMemory: 3,
        autoSliceOnSpeechEnd: true,
        vadOptions: {
          threshold: 0.5,
          minSpeechDurationMs: 300,
          minSilenceDurationMs: 600,
          maxSpeechDurationS: 30,
          speechPadMs: 50,
          samplesOverlap: 0.1,
        },
        transcribeOptions: {
          language: 'en',
          maxLen: 1,
          tokenTimestamps: false,
        },
        promptPreviousSlices: true,
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
    const text = event.data?.result?.trim();
    if (!text) return;

    if (event.type === 'transcribe' && event.isCapturing) {
      this.cb.onPartial(text);
      return;
    }

    if (event.type === 'end' || (event.type === 'transcribe' && !event.isCapturing)) {
      const chunk: TranscriptChunk = {
        id: ++this.chunkSeq,
        text,
        startedAt: Date.now() - event.recordingTime,
        finalizedAt: Date.now(),
      };
      this.cb.onChunk(chunk);
      this.appendToBuffer(text);
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
