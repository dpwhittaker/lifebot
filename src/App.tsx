import { useCallback, useEffect, useRef, useState } from 'react';

import { LiveAudioCapture } from './audio/LiveAudioCapture';
import { GeminiLiveOrchestrator } from './orchestrator/GeminiLive';
import { Controls } from './ui/Controls';
import { CuePane, type Cue } from './ui/CuePane';
import { OrchestratorLog, type LogEntry } from './ui/OrchestratorLog';
import { TranscriptPane, type TranscriptChunk } from './ui/TranscriptPane';
import { LogUploader } from './util/LogUploader';

const API_KEY: string = (import.meta.env.VITE_GEMINI_API_KEY as string | undefined) ?? '';
const LIVE_MODEL: string =
  (import.meta.env.VITE_GEMINI_LIVE_MODEL as string | undefined) ??
  'gemini-3.1-flash-live-preview';

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
  const orchestratorRef = useRef<GeminiLiveOrchestrator | null>(null);
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

    const orchestrator = new GeminiLiveOrchestrator({
      apiKey: API_KEY,
      model: LIVE_MODEL,
      onTrace: (event) => {
        switch (event.type) {
          case 'connecting':
            appendLog({ kind: 'sent', at: event.at, text: 'connecting…', meta: LIVE_MODEL });
            break;
          case 'connected':
            appendLog({ kind: 'sent', at: event.at, text: 'WebSocket open' });
            break;
          case 'setup_sent':
            appendLog({ kind: 'sent', at: event.at, text: 'setup sent' });
            break;
          case 'setup_complete':
            appendLog({ kind: 'sent', at: event.at, text: 'setup complete (server)' });
            break;
          case 'sent_audio':
          case 'input_transcript_partial':
          case 'output_transcript_partial':
          case 'response_text':
            break;
          case 'turn_complete':
            appendLog({
              kind: 'sent',
              at: event.at,
              text: `turn: heard "${event.heard.slice(0, 80)}", said "${event.said.slice(0, 80)}"`,
            });
            break;
          case 'error':
            appendLog({ kind: 'error', at: event.at, text: event.error });
            break;
          case 'closed':
            appendLog({
              kind: 'error',
              at: event.at,
              text: 'connection closed',
              meta: event.reason || `code ${event.code ?? '?'}`,
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
          appendLog({
            kind: 'cue',
            at: Date.now(),
            text: response.cue,
            meta: response.heard || undefined,
          });
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
        } else {
          appendLog({
            kind: 'null',
            at: Date.now(),
            text: '(no cue)',
            meta: response.heard || undefined,
          });
        }
        setPendingCues(0);
      },
    });
    orchestratorRef.current = orchestrator;

    const capture = new LiveAudioCapture(orchestrator, {
      onVadActive: (a) => setVadActive(a),
      onAudioSent: (bytes) => {
        setPendingCues(1);
        void bytes;
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
