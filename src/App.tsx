import { useCallback, useEffect, useRef, useState } from 'react';

import { LiveAudioCapture } from './audio/LiveAudioCapture';
import { GeminiAudioOrchestrator } from './orchestrator/GeminiAudio';
import { Controls } from './ui/Controls';
import { CuePane, type Cue } from './ui/CuePane';
import { OrchestratorLog, type LogEntry } from './ui/OrchestratorLog';
import { TranscriptPane, type TranscriptChunk } from './ui/TranscriptPane';
import { ThreadBar } from './ui/ThreadBar';
import { ThreadEditor } from './ui/ThreadEditor';
import { LogUploader } from './util/LogUploader';
import {
  appendCommit,
  deleteThread,
  getThread,
  listThreads,
  makeThreadId,
  saveThread,
} from './threads/store';
import type { Thread, ThreadSummary } from './threads/types';

const API_KEY: string = (import.meta.env.VITE_GEMINI_API_KEY as string | undefined) ?? '';
const MODEL: string =
  (import.meta.env.VITE_GEMINI_MODEL as string | undefined) ?? 'gemini-3.1-flash-lite-preview';

function formatSeconds(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Build the system instruction by combining the thread's prompt with its
 *  optional background context. Falls back to defaults when nothing is set. */
function composeSystemPrompt(thread: Thread | null): string | undefined {
  if (!thread) return undefined;
  const parts: string[] = [];
  if (thread.systemPrompt.trim()) parts.push(thread.systemPrompt.trim());
  if (thread.context && thread.context.trim()) {
    parts.push('--- background context for this thread ---');
    parts.push(thread.context.trim());
  }
  return parts.length ? parts.join('\n\n') : undefined;
}

export function App() {
  // Thread state
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeThread, setActiveThread] = useState<Thread | null>(null);
  const [editorState, setEditorState] = useState<{ open: boolean; mode: 'create' | 'edit' }>({
    open: false,
    mode: 'create',
  });

  // Pipeline state
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
  const activeThreadIdRef = useRef<string | null>(null);

  const appendLog = useCallback((entry: Omit<LogEntry, 'id'>) => {
    const full: LogEntry = { ...entry, id: ++logSeq.current };
    setLog((prev) => [...prev, full].slice(-200));
    uploaderRef.current.enqueue(full);
  }, []);

  // Periodic log uploader.
  useEffect(() => {
    const uploader = uploaderRef.current;
    uploader.start();
    return () => uploader.stop();
  }, []);

  // Initial thread load.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listThreads();
        if (cancelled) return;
        setThreads(list);
        if (list.length > 0) {
          const top = await getThread(list[0].id);
          if (!cancelled && top) setActiveThread(top);
        }
      } catch (e) {
        appendLog({
          kind: 'error',
          at: Date.now(),
          text: `failed to load threads: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appendLog]);

  // (Re)build orchestrator + capture whenever the active thread changes.
  useEffect(() => {
    if (!API_KEY) {
      appendLog({
        kind: 'error',
        at: Date.now(),
        text: 'VITE_GEMINI_API_KEY missing — orchestrator inactive',
      });
      return;
    }

    activeThreadIdRef.current = activeThread?.id ?? null;
    setChunks([]);
    setCues([]);

    const orchestrator = new GeminiAudioOrchestrator({
      apiKey: API_KEY,
      model: MODEL,
      systemInstruction: composeSystemPrompt(activeThread),
      initialHistory: activeThread?.history ?? [],
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
            const usage = event.usage;
            const cacheTag = usage
              ? ` · ${usage.promptTokens} in (${usage.cachedTokens} cached) / ${usage.responseTokens} out`
              : '';
            appendLog({
              kind: event.cue ? 'cue' : 'null',
              at: event.at,
              text: event.cue ?? '(no cue)',
              meta: `${event.latencyMs}ms · heard "${event.heard.slice(0, 80)}"${tail}${cacheTag}`,
            });
            if (event.heard) {
              setChunks((prev) => {
                const last = prev[prev.length - 1];
                if (last && !last.committed) {
                  const next = prev.slice();
                  next[next.length - 1] = {
                    ...last,
                    text: event.heard,
                    finalizedAt: event.at,
                    committed: event.committed,
                  };
                  return next;
                }
                return [
                  ...prev,
                  {
                    id: ++chunkSeq.current,
                    text: event.heard,
                    finalizedAt: event.at,
                    committed: event.committed,
                  },
                ].slice(-300);
              });
            }
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
      onCommit: (entry) => {
        // Persist commits to the thread's history server-side. Non-blocking;
        // if the server is unreachable, the next session won't see this turn
        // but the in-memory orchestrator still has it.
        const tid = activeThreadIdRef.current;
        if (!tid) return;
        void appendCommit(tid, entry).catch((e) => {
          appendLog({
            kind: 'error',
            at: Date.now(),
            text: `thread commit failed: ${e instanceof Error ? e.message : String(e)}`,
          });
        });
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
  }, [activeThread, appendLog]);

  const onToggle = useCallback(async () => {
    const capture = captureRef.current;
    if (!capture) return;
    if (capture.isActive) {
      await capture.stop();
      return;
    }
    if (!activeThread) {
      appendLog({
        kind: 'error',
        at: Date.now(),
        text: 'pick or create a thread before listening',
      });
      return;
    }
    try {
      await capture.start();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      appendLog({ kind: 'error', at: Date.now(), text: `start: ${msg}` });
    }
  }, [activeThread, appendLog]);

  const onSelectThread = useCallback(
    async (id: string) => {
      try {
        // Stop any in-flight session before swapping context.
        if (captureRef.current?.isActive) await captureRef.current.stop();
        const t = await getThread(id);
        if (t) setActiveThread(t);
      } catch (e) {
        appendLog({
          kind: 'error',
          at: Date.now(),
          text: `load thread: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    },
    [appendLog],
  );

  const refreshThreads = useCallback(async () => {
    try {
      setThreads(await listThreads());
    } catch (e) {
      appendLog({
        kind: 'error',
        at: Date.now(),
        text: `list threads: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }, [appendLog]);

  const onSaveEditor = useCallback(
    async (form: { name: string; systemPrompt: string; context: string }) => {
      const isNew = editorState.mode === 'create' || !activeThread;
      const id = isNew ? makeThreadId(form.name) : activeThread!.id;
      const next: Thread = {
        id,
        name: form.name,
        systemPrompt: form.systemPrompt,
        context: form.context,
        history: isNew ? [] : (activeThread?.history ?? []),
        updatedAt: new Date().toISOString(),
      };
      try {
        const saved = await saveThread(next);
        setEditorState({ open: false, mode: 'create' });
        await refreshThreads();
        if (captureRef.current?.isActive) await captureRef.current.stop();
        setActiveThread(saved);
      } catch (e) {
        appendLog({
          kind: 'error',
          at: Date.now(),
          text: `save thread: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    },
    [activeThread, editorState.mode, refreshThreads, appendLog],
  );

  const onDeleteCurrentThread = useCallback(async () => {
    if (!activeThread) return;
    if (!confirm(`Delete thread "${activeThread.name}"? Its history is gone for good.`)) return;
    try {
      if (captureRef.current?.isActive) await captureRef.current.stop();
      await deleteThread(activeThread.id);
      setEditorState({ open: false, mode: 'create' });
      const remaining = (await listThreads());
      setThreads(remaining);
      if (remaining.length > 0) {
        const next = await getThread(remaining[0].id);
        setActiveThread(next);
      } else {
        setActiveThread(null);
      }
    } catch (e) {
      appendLog({
        kind: 'error',
        at: Date.now(),
        text: `delete thread: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }, [activeThread, appendLog]);

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
        threadBar={
          <ThreadBar
            active={activeThread}
            threads={threads}
            onSelect={onSelectThread}
            onCreate={() => setEditorState({ open: true, mode: 'create' })}
            onEdit={() => setEditorState({ open: true, mode: 'edit' })}
          />
        }
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

      {editorState.open && (
        <ThreadEditor
          initial={editorState.mode === 'edit' ? activeThread : null}
          onSave={onSaveEditor}
          onCancel={() => setEditorState({ open: false, mode: 'create' })}
          onDelete={
            editorState.mode === 'edit' && activeThread ? onDeleteCurrentThread : undefined
          }
        />
      )}
    </div>
  );
}
