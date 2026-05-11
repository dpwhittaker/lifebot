export type AudioCaptureCallbacks = {
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

/**
 * Mic source + turn shaping. Implementations own where PCM comes from
 * (browser getUserMedia, Even Hub bridge, etc.) and feed completed turns to
 * the orchestrator. The orchestrator dependency is supplied at construction
 * time, not via this interface — different adapters may have different
 * construction shapes.
 */
export interface AudioCapture {
  readonly isActive: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  release(): Promise<void>;
}
