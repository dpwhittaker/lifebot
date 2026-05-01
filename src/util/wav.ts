/**
 * Wrap a chunk of 16-bit little-endian mono PCM into a WAV container.
 * Gemini's generateContent endpoint accepts audio/wav (and a few other real
 * containers) but not bare audio/pcm — that's Live-API-only.
 */
export function pcm16ToWav(
  pcm: Uint8Array,
  sampleRate = 16000,
  channels = 1,
  bitsPerSample = 16,
): Uint8Array {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.byteLength;
  const fileSize = 36 + dataSize; // 36 = (RIFF header without data) + (fmt chunk) - 8

  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);
  let p = 0;

  // "RIFF"
  view.setUint8(p++, 0x52);
  view.setUint8(p++, 0x49);
  view.setUint8(p++, 0x46);
  view.setUint8(p++, 0x46);
  view.setUint32(p, fileSize, true); p += 4;
  // "WAVE"
  view.setUint8(p++, 0x57);
  view.setUint8(p++, 0x41);
  view.setUint8(p++, 0x56);
  view.setUint8(p++, 0x45);
  // "fmt "
  view.setUint8(p++, 0x66);
  view.setUint8(p++, 0x6d);
  view.setUint8(p++, 0x74);
  view.setUint8(p++, 0x20);
  view.setUint32(p, 16, true); p += 4;             // fmt chunk size
  view.setUint16(p, 1, true); p += 2;              // format = PCM
  view.setUint16(p, channels, true); p += 2;
  view.setUint32(p, sampleRate, true); p += 4;
  view.setUint32(p, byteRate, true); p += 4;
  view.setUint16(p, blockAlign, true); p += 2;
  view.setUint16(p, bitsPerSample, true); p += 2;
  // "data"
  view.setUint8(p++, 0x64);
  view.setUint8(p++, 0x61);
  view.setUint8(p++, 0x74);
  view.setUint8(p++, 0x61);
  view.setUint32(p, dataSize, true); p += 4;

  out.set(pcm, p);
  return out;
}
