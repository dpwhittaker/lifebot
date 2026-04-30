import RNFS from 'react-native-fs';

export type ModelSpec = {
  name: string;
  url: string;
  filename: string;
  bytesApprox: number;
};

export const WHISPER_MODEL: ModelSpec = {
  name: 'Whisper tiny.en',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin',
  filename: 'ggml-tiny.en.bin',
  bytesApprox: 77_700_000,
};

export const VAD_MODEL: ModelSpec = {
  name: 'Silero VAD',
  url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin',
  filename: 'ggml-silero-v6.2.0.bin',
  bytesApprox: 2_300_000,
};

const MODELS_DIR = `${RNFS.DocumentDirectoryPath}/models`;

export type ModelStatus =
  | { state: 'pending'; spec: ModelSpec }
  | { state: 'downloading'; spec: ModelSpec; receivedBytes: number; totalBytes: number }
  | { state: 'ready'; spec: ModelSpec; path: string }
  | { state: 'error'; spec: ModelSpec; error: string };

export type BootstrapEvent = {
  whisper: ModelStatus;
  vad: ModelStatus;
};

function localPathFor(spec: ModelSpec): string {
  return `${MODELS_DIR}/${spec.filename}`;
}

export async function isModelReady(spec: ModelSpec): Promise<boolean> {
  return RNFS.exists(localPathFor(spec));
}

async function ensureDir(): Promise<void> {
  if (!(await RNFS.exists(MODELS_DIR))) {
    await RNFS.mkdir(MODELS_DIR);
  }
}

async function ensureModel(
  spec: ModelSpec,
  onStatus: (s: ModelStatus) => void,
): Promise<string> {
  await ensureDir();
  const target = localPathFor(spec);
  if (await RNFS.exists(target)) {
    onStatus({ state: 'ready', spec, path: target });
    return target;
  }

  onStatus({ state: 'downloading', spec, receivedBytes: 0, totalBytes: spec.bytesApprox });
  const tmp = `${target}.part`;
  if (await RNFS.exists(tmp)) await RNFS.unlink(tmp);

  const { promise } = RNFS.downloadFile({
    fromUrl: spec.url,
    toFile: tmp,
    background: true,
    discretionary: true,
    progressInterval: 250,
    progress: (res) => {
      onStatus({
        state: 'downloading',
        spec,
        receivedBytes: res.bytesWritten,
        totalBytes: res.contentLength || spec.bytesApprox,
      });
    },
  });

  try {
    const result = await promise;
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(`HTTP ${result.statusCode} downloading ${spec.url}`);
    }
    await RNFS.moveFile(tmp, target);
    onStatus({ state: 'ready', spec, path: target });
    return target;
  } catch (e) {
    if (await RNFS.exists(tmp)) await RNFS.unlink(tmp).catch(() => {});
    throw e;
  }
}

export async function bootstrapModels(
  onUpdate: (e: BootstrapEvent) => void,
): Promise<{ whisperPath: string; vadPath: string }> {
  const state: BootstrapEvent = {
    whisper: { state: 'pending', spec: WHISPER_MODEL },
    vad: { state: 'pending', spec: VAD_MODEL },
  };
  onUpdate(state);

  const update = (key: 'whisper' | 'vad') => (s: ModelStatus) => {
    state[key] = s;
    onUpdate({ ...state });
  };

  try {
    const [whisperPath, vadPath] = await Promise.all([
      ensureModel(WHISPER_MODEL, update('whisper')),
      ensureModel(VAD_MODEL, update('vad')),
    ]);
    return { whisperPath, vadPath };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (state.whisper.state !== 'ready') {
      state.whisper = { state: 'error', spec: WHISPER_MODEL, error: msg };
    }
    if (state.vad.state !== 'ready') {
      state.vad = { state: 'error', spec: VAD_MODEL, error: msg };
    }
    onUpdate({ ...state });
    throw e;
  }
}
