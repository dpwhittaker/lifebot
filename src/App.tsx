import { useCallback, useEffect, useRef, useState } from 'react';

import { LiveAudioCapture } from './audio/LiveAudioCapture';
import { GeminiAudioOrchestrator } from './orchestrator/GeminiAudio';
import { Controls } from './ui/Controls';
import { CuePane, type Cue } from './ui/CuePane';
import { OrchestratorLog, type LogEntry } from './ui/OrchestratorLog';
import { TranscriptPane, type TranscriptChunk } from './ui/TranscriptPane';
import { LogUploader } from './util/LogUploader';

const API_KEY: string = (import.meta.env.VITE_GEMINI_API_KEY as string | undefined) ?? '';
const MODEL: string =
  (import.meta.env.VITE_GEMINI_MODEL as string | undefined) ?? 'gemini-2.5-flash';

function formatSeconds(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function App() {
  const [chunks, setChunks] = useState<TranscriptChunk[]>([]);
  const [active, setActive] = useState(false);
  const [vadActive, setVadActive] = useState(false);

  const [cues, setCues] = useState<Cue[]>([]);
  const [pendingCues, setPendingCues] = useState(0);
  const cueSeq = useRef(0);
  const chunkSeq = useRef(0);

  const [log, setLog] = useState<LogEntry[]>([]);
  const logSeq = useRef(0);

  const captureRef = useRef<LiveAudioCapture | null>(null);
  const orchestratorRef = useRef<GeminiAudioOrchestrator | null>(null);
  const uploaderRef = useRef<LogUploader>(new LogUploader());

  const appendLog = useCallback((entry: Omit<LogEntry, 'id'>) => {
    const full: LogEntry = { ...entry, id: ++logSeq.current };
    setLog((prev) => [...prev, full].slice(-200));
    uploaderRef.current.enqueue(full);
  }, []);

  useEffect(() => {
    const uploader = uploaderRef.current;
    uploader.start();
    return () => uploader.stop();
  }, []);

  useEffect(() => {
    if (!API_KEY) {
      appendLog({
        kind: 'error',
        at: Date.now(),
        text: 'VITE_GEMINI_API_KEY missing — orchestrator inactive',
      });
      return;
    }

    const orchestrator = new GeminiAudioOrchestrator({
      apiKey: API_KEY,
      model: MODEL,
      onTrace: (event) => {
        switch (event.type) {
          case 'sent':
            appendLog({
              kind: 'sent',
              at: event.at,
              text: `→ Gemini (${formatSeconds(event.bufferMs)} of audio, ${(event.bytes / 1024).toFixed(1)} KB)`,
              meta: MODEL,
            });
            break;
          case 'response': {
            const tail = event.committed
              ? ' · committed'
              : ` · holding ${formatSeconds(event.bufferMsAfter)} buffered`;
            appendLog({
              kind: event.cue ? 'cue' : 'null',
              at: event.at,
              text: event.cue ?? '(no cue)',
              meta: `${event.latencyMs}ms · heard "${event.heard.slice(0, 80)}"${tail}`,
            });
            break;
          }
          case 'soft_commit':
            appendLog({
              kind: 'null',
              at: event.at,
              text: `soft-commit (${event.reason})`,
              meta: `flushed ${formatSeconds(event.bufferMs)} from buffer`,
            });
            break;
          case 'error':
            appendLog({
              kind: 'error',
              at: event.at,
              text: event.error,
              meta: `${event.latencyMs}ms`,
            });
            break;
        }
      },
      onResponse: (response) => {
        if (response.heard) {
          setChunks((prev) =>
            [
              ...prev,
              {
                id: ++chunkSeq.current,
                text: response.heard,
                finalizedAt: Date.now(),
              },
            ].slice(-300),
          );
        }
        if (response.cue) {
          setCues((prev) =>
            [
              {
                id: ++cueSeq.current,
                text: response.cue!,
                createdAt: Date.now(),
                source: response.heard,
              },
              ...prev,
            ].slice(0, 50),
          );
        }
        setPendingCues((n) => Math.max(0, n - 1));
      },
    });
    orchestratorRef.current = orchestrator;

    const capture = new LiveAudioCapture(orchestrator, {
      onVadActive: (a) => setVadActive(a),
      onVadEvent: (kind, info) => {
        let text = '';
        let logKind: LogEntry['kind'] = 'sent';
        switch (kind) {
          case 'speech_start':
            text = 'VAD: speech start';
            break;
          case 'speech_end': {
            const ms = info?.samples ? Math.round((info.samples / 16000) * 1000) : 0;
            text = `VAD: speech end (${ms}ms segment)`;
            break;
          }
          case 'misfire':
            text = 'VAD: misfire (too short)';
            logKind = 'null';
            break;
          case 'merge':
            text = `merge: continuing turn (buffer ${info?.bufferMs ?? 0}ms)`;
            logKind = 'null';
            break;
          case 'flush':
            text = `flush: ${info?.bufferMs ?? 0}ms turn (${info?.reason ?? 'idle'})`;
            break;
        }
        appendLog({ kind: logKind, at: Date.now(), text });
      },
      onAudioSent: () => {
        setPendingCues((n) => n + 1);
      },
      onError: (msg) => appendLog({ kind: 'error', at: Date.now(), text: msg }),
      onStatusChange: (a) => setActive(a),
    });
    captureRef.current = capture;

    return () => {
      void captureRef.current?.release();
      captureRef.current = null;
      orchestratorRef.current = null;
    };
  }, [appendLog]);

  const onToggle = useCallback(async () => {
    const capture = captureRef.current;
    if (!capture) return;
    if (capture.isActive) {
      await capture.stop();
      return;
    }
    try {
      await capture.start();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      appendLog({ kind: 'error', at: Date.now(), text: `start: ${msg}` });
    }
  }, [appendLog]);

  const onDismissCue = useCallback((id: number) => {
    setCues((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const onClearCues = useCallback(() => setCues([]), []);

  return (
    <div className="app">
      <Controls
        active={active}
        geminiConfigured={!!API_KEY}
        pendingCues={pendingCues}
        onToggle={onToggle}
      />
      <div className="split">
        <div className="left-col">
          <div className="transcript-wrap">
            <TranscriptPane chunks={chunks} active={active} vadActive={vadActive} />
          </div>
          <div className="log-wrap">
            <OrchestratorLog entries={log} />
          </div>
        </div>
        <CuePane cues={cues} onDismiss={onDismissCue} onClear={onClearCues} />
      </div>
    </div>
  );
}
