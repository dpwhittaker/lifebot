import { pcm16ToWav } from './wav';

/**
 * Mic recorder for voiceprint reference clips. Captures raw Float32 audio
 * via the Web Audio API and produces a WAV blob on stop. We deliberately
 * disable browser DSP (echoCancellation/noiseSuppression/autoGainControl) so
 * the voiceprint reflects the speaker's true voice, not the AGC-warped one.
 */
export class VoiceRecorder {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];
  private inputSampleRate = 48000;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    // Try to land at 16kHz directly. Chrome respects this for new contexts.
    this.context = new AudioContext({ sampleRate: 16000 });
    this.inputSampleRate = this.context.sampleRate;
    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      // Copy into our own buffer — the supplied Float32 is reused per callback.
      this.chunks.push(new Float32Array(data));
    };
    this.source.connect(this.processor);
    this.processor.connect(this.context.destination);
  }

  isRecording(): boolean {
    return this.processor !== null;
  }

  /** Total elapsed seconds of audio captured so far. */
  elapsedSec(): number {
    if (!this.context) return 0;
    const samples = this.chunks.reduce((s, c) => s + c.length, 0);
    return samples / this.inputSampleRate;
  }

  async stop(): Promise<Uint8Array> {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    const ctx = this.context;
    this.context = null;
    this.processor = null;
    this.source = null;
    this.stream = null;

    const totalLen = this.chunks.reduce((s, c) => s + c.length, 0);
    const combined = new Float32Array(totalLen);
    let offset = 0;
    for (const c of this.chunks) {
      combined.set(c, offset);
      offset += c.length;
    }
    this.chunks = [];

    // If the browser gave us something other than 16kHz, downsample crudely
    // (linear). Voiceprints don't need surgical fidelity, just a clean voice.
    let pcm: Float32Array;
    let sampleRate = this.inputSampleRate;
    if (this.inputSampleRate === 16000) {
      pcm = combined;
    } else {
      pcm = downsampleLinear(combined, this.inputSampleRate, 16000);
      sampleRate = 16000;
    }

    await ctx?.close();

    const int16 = float32ToInt16(pcm);
    return pcm16ToWav(int16, sampleRate, 1, 16);
  }

  /** Abort recording without producing audio. */
  abort(): void {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.context?.close();
    this.context = null;
    this.processor = null;
    this.source = null;
    this.stream = null;
    this.chunks = [];
  }
}

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

function downsampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcF = i * ratio;
    const srcI = Math.floor(srcF);
    const frac = srcF - srcI;
    const a = input[srcI] ?? 0;
    const b = input[srcI + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}
