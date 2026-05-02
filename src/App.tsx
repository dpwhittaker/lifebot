import { useCallback, useEffect, useRef, useState } from 'react';

import { LiveAudioCapture } from './audio/LiveAudioCapture';
import { GeminiAudioOrchestrator } from './orchestrator/GeminiAudio';
import { classifyConversation, type ClassifierResult } from './orchestrator/Classifier';
import { Controls } from './ui/Controls';
import { CuePane, type Cue } from './ui/CuePane';
import { OrchestratorLog, type LogEntry } from './ui/OrchestratorLog';
import { TranscriptPane, type TranscriptChunk } from './ui/TranscriptPane';
import { ThreadBar } from './ui/ThreadBar';
import { ThreadEditor } from './ui/ThreadEditor';
import { ClassifierBanner } from './ui/ClassifierBanner';
import { LogUploader } from './util/LogUploader';
import {
  ADHOC_THREAD_ID,
  appendCommit,
  deleteThread,
  ensureAdhocThread,
  getThread,
  listThreads,
  makeThreadId,
  saveThread,
} from './threads/store';
import { findActiveSchedule, parseSchedule } from './threads/schedule';
import {
  ADHOC_GROUP_ID,
  ensureAdhocGroup,
  fetchVoiceprintBytes,
  getGroup,
  listGroups,
  savePerson,
  slugify,
  uploadVoiceprint,
  type Group,
  type GroupSummary,
} from './threads/groups';
import type { CommitEntry, VoiceReference } from './orchestrator/GeminiAudio';
import { pcm16ToWav } from './util/wav';
import type { Thread, ThreadSummary } from './threads/types';

const API_KEY: string = (import.meta.env.VITE_GEMINI_API_KEY as string | undefined) ?? '';
const MODEL: string =
  (import.meta.env.VITE_GEMINI_MODEL as string | undefined) ?? 'gemini-3.1-flash-lite-preview';

function formatSeconds(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

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

/** Compact directory of OTHER threads — for cross-thread awareness without bleed.
 *  Includes each thread's optional summary so the model can produce passing
 *  reference cues ("your D&D character Brennan would…") without switching. */
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const MIN_VOICEPRINT_MS = 2_000;

/** Slice a sub-segment out of 16-bit mono PCM by start/end seconds. */
function extractPcmSegment(pcm: Uint8Array, startSec: number, endSec: number): Uint8Array {
  const start = Math.max(0, Math.floor(startSec * SAMPLE_RATE) * BYTES_PER_SAMPLE);
  const end = Math.min(pcm.length, Math.ceil(endSec * SAMPLE_RATE) * BYTES_PER_SAMPLE);
  if (end <= start) return new Uint8Array(0);
  return pcm.slice(start, end);
}

/** Load the WAV bytes for every roster member who has a voiceprint on file. */
async function loadVoiceReferences(
  thread: Thread | null,
  group: Group | null,
): Promise<VoiceReference[]> {
  if (!thread || !group) return [];
  const rosterIds = thread.roster ?? [];
  if (rosterIds.length === 0) return [];
  const rosterPeople = group.people.filter(
    (p) => rosterIds.includes(p.id) && p.hasVoiceprint,
  );
  const out: VoiceReference[] = [];
  for (const p of rosterPeople) {
    try {
      const bytes = await fetchVoiceprintBytes(group.id, p.id);
      if (bytes) out.push({ name: p.name, wav: bytes });
    } catch {
      // skip on fetch failure
    }
  }
  return out;
}

function composeThreadDirectory(
  active: Thread | null,
  all: ThreadSummary[],
): string | undefined {
  const others = all.filter((t) => t.id !== active?.id);
  if (others.length === 0) return undefined;
  return others
    .map((t) => {
      const grp = t.group ? ` [${t.group}]` : '';
      const summary = t.summary?.trim() ? `\n    ${t.summary.trim().replace(/\n+/g, ' ')}` : '';
      return `- ${t.name}${grp}${summary}`;
    })
    .join('\n');
}

type ScheduleNow = { threadId: string; untilMs: number; untilLabel: string } | null;

export function App() {
  // ---- thread state ----
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeThread, setActiveThread] = useState<Thread | null>(null);
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [activeGroup, setActiveGroup] = useState<Group | null>(null);
  const [editorState, setEditorState] = useState<{
    open: boolean;
    mode: 'create' | 'edit';
    prefill?: { name?: string };
  }>({ open: false, mode: 'create' });

  // Schedule auto-activation. `overrideUntilMs` blocks auto-switch during the
  // current scheduled window when the user manually picks a different thread.
  const [scheduleNow, setScheduleNow] = useState<ScheduleNow>(null);
  const overrideUntilMsRef = useRef<number>(0);

  // Classifier banner state. Only one classifier call per session.
  const [classifier, setClassifier] = useState<ClassifierResult | null>(null);
  const classifierFiredRef = useRef(false);

  // ---- pipeline state ----
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
  const activeThreadRef = useRef<Thread | null>(null);
  const activeGroupRef = useRef<Group | null>(null);
  const threadsRef = useRef<ThreadSummary[]>([]);
  /** Per-session map: speaker label as Gemini sees it → personId we created. */
  const sessionSpeakersRef = useRef<
    Map<string, { personId: string; bestMs: number }>
  >(new Map());

  const appendLog = useCallback((entry: Omit<LogEntry, 'id'>) => {
    const full: LogEntry = { ...entry, id: ++logSeq.current };
    setLog((prev) => [...prev, full].slice(-200));
    uploaderRef.current.enqueue(full);
  }, []);

  // ---- log uploader ----
  useEffect(() => {
    const uploader = uploaderRef.current;
    uploader.start();
    return () => uploader.stop();
  }, []);

  // ---- initial load: ensure Ad-hoc group + thread, then load all ----
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await ensureAdhocGroup();
        await ensureAdhocThread();
        const [groupList, threadList] = await Promise.all([listGroups(), listThreads()]);
        if (cancelled) return;
        setGroups(groupList);
        setThreads(threadList);
        threadsRef.current = threadList;
        // Pick: schedule-matching thread > most recently used (excluding Ad-hoc
        // unless it's the only option) > Ad-hoc.
        const scheduled = findActiveSchedule(threadList);
        let pickId: string;
        if (scheduled) {
          pickId = scheduled.threadId;
        } else {
          const nonAdhoc = threadList.filter((t) => t.id !== ADHOC_THREAD_ID);
          pickId = nonAdhoc.length > 0 ? nonAdhoc[0].id : ADHOC_THREAD_ID;
        }
        const t = await getThread(pickId);
        if (!cancelled && t) setActiveThread(t);
      } catch (e) {
        appendLog({
          kind: 'error',
          at: Date.now(),
          text: `failed to load: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appendLog]);

  // Load active thread's group whenever the thread changes (for roster/people).
  useEffect(() => {
    let cancelled = false;
    const gid = activeThread?.group ?? ADHOC_GROUP_ID;
    void (async () => {
      try {
        const g = await getGroup(gid);
        if (!cancelled) setActiveGroup(g);
      } catch {
        if (!cancelled) setActiveGroup(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeThread]);

  // Keep refs in sync.
  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);
  useEffect(() => {
    activeThreadIdRef.current = activeThread?.id ?? null;
    activeThreadRef.current = activeThread;
  }, [activeThread]);
  useEffect(() => {
    activeGroupRef.current = activeGroup;
  }, [activeGroup]);

  // ---- schedule polling ----
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const now = Date.now();
      const sched = findActiveSchedule(threadsRef.current);
      if (sched) {
        const untilMs = sched.until.getTime();
        const untilLabel = sched.until.toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });
        setScheduleNow({ threadId: sched.threadId, untilMs, untilLabel });

        // Auto-switch unless the user has explicitly overridden this window.
        if (
          activeThreadIdRef.current !== sched.threadId &&
          now >= overrideUntilMsRef.current
        ) {
          // Stop any active capture before swapping context.
          void captureRef.current?.stop().then(() => {
            void getThread(sched.threadId).then((t) => {
              if (t) setActiveThread(t);
            });
          });
        }
      } else {
        setScheduleNow(null);
        overrideUntilMsRef.current = 0;
      }
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // ---- (re)build orchestrator + capture on active thread change ----
  useEffect(() => {
    if (!API_KEY) {
      appendLog({
        kind: 'error',
        at: Date.now(),
        text: 'VITE_GEMINI_API_KEY missing — orchestrator inactive',
      });
      return;
    }

    let cancelled = false;
    setChunks([]);
    setCues([]);
    setClassifier(null);
    classifierFiredRef.current = false;

    const directory = composeThreadDirectory(activeThread, threads);

    // Eagerly kick off voiceprint loads for the thread's roster. The orchestrator
    // accepts them via setVoiceReferences once they arrive; in practice they're
    // loaded long before the user finishes their first sentence.
    void (async () => {
      const refs = await loadVoiceReferences(activeThread, activeGroup);
      if (cancelled) return;
      if (refs.length > 0) {
        appendLog({
          kind: 'sent',
          at: Date.now(),
          text: `voiceprints loaded: ${refs.map((r) => r.name).join(', ')}`,
        });
      }
      orchestratorRef.current?.setVoiceReferences(refs);
    })();

    const orchestrator = new GeminiAudioOrchestrator({
      apiKey: API_KEY,
      model: MODEL,
      systemInstruction: composeSystemPrompt(activeThread),
      threadDirectory: directory,
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
              // Auto-classify on first heard text — only when no schedule put
              // us here (we trust the schedule when it applies) and we have at
              // least one alternative thread to potentially switch to.
              if (
                !classifierFiredRef.current &&
                !scheduleNow &&
                threadsRef.current.length > 0
              ) {
                classifierFiredRef.current = true;
                void runClassifier(event.heard);
              }
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
        const tid = activeThreadIdRef.current;
        if (!tid) return;
        void appendCommit(tid, { heard: entry.heard, cue: entry.cue }).catch((e) => {
          appendLog({
            kind: 'error',
            at: Date.now(),
            text: `thread commit failed: ${e instanceof Error ? e.message : String(e)}`,
          });
        });
        void processSpeakerDiscovery(entry);
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
      cancelled = true;
      void captureRef.current?.release();
      captureRef.current = null;
      orchestratorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThread, activeGroup, appendLog]);

  // ---- passive speaker discovery ----
  const processSpeakerDiscovery = useCallback(
    async (entry: CommitEntry) => {
      const group = activeGroupRef.current;
      const thread = activeThreadRef.current;
      if (!group || !thread || !entry.audioPcm) return;
      const segments = entry.segments ?? [];
      if (segments.length === 0) return;

      // Apply rename hints first — sometimes Gemini knows "New Person 1" is
      // really "Bob" before we've materialised the placeholder. Map gets
      // updated either way; the materialisation step picks up the new name.
      const renames = entry.speakerNames ?? {};

      // Speakers to ignore: already-known people in the group, plus "Me".
      const knownNames = new Set(group.people.map((p) => p.name.toLowerCase()));
      knownNames.add('me');

      const labels = Array.from(new Set(segments.map((s) => s.speaker)));
      let groupChanged = false;
      let newRoster = thread.roster ? [...thread.roster] : [];

      for (const label of labels) {
        if (knownNames.has(label.toLowerCase())) continue;

        // Resolve / materialise the person for this label.
        let mapping = sessionSpeakersRef.current.get(label);
        const renameTo = renames[label];
        if (!mapping) {
          // Use the rename hint as the person's name if Gemini already knows it.
          const personName = renameTo ?? label;
          const personId = slugify(personName);
          try {
            await savePerson(group.id, { id: personId, name: personName });
            mapping = { personId, bestMs: 0 };
            sessionSpeakersRef.current.set(label, mapping);
            groupChanged = true;
            if (!newRoster.includes(personId)) newRoster.push(personId);
            appendLog({
              kind: 'sent',
              at: Date.now(),
              text: `+ new speaker: ${personName}`,
            });
          } catch (e) {
            appendLog({
              kind: 'error',
              at: Date.now(),
              text: `failed to add ${personName}: ${e instanceof Error ? e.message : String(e)}`,
            });
            continue;
          }
        } else if (renameTo) {
          // Already materialised, but Gemini just learned a real name for them.
          const existing = group.people.find((p) => p.id === mapping!.personId);
          if (existing && existing.name !== renameTo) {
            try {
              await savePerson(group.id, { ...existing, name: renameTo });
              groupChanged = true;
              appendLog({
                kind: 'sent',
                at: Date.now(),
                text: `↳ renamed ${existing.name} → ${renameTo}`,
              });
            } catch {
              // non-fatal
            }
          }
        }

        // Find this speaker's longest segment in this commit.
        const segs = segments.filter((s) => s.speaker === label);
        let longest = segs[0];
        for (const s of segs) {
          if (s.endSec - s.startSec > longest.endSec - longest.startSec) longest = s;
        }
        const ms = (longest.endSec - longest.startSec) * 1000;
        if (ms < MIN_VOICEPRINT_MS) continue;
        if (ms <= mapping.bestMs) continue;

        const segPcm = extractPcmSegment(entry.audioPcm, longest.startSec, longest.endSec);
        if (segPcm.byteLength === 0) continue;
        const wav = pcm16ToWav(segPcm, SAMPLE_RATE, 1, 16);
        try {
          await uploadVoiceprint(group.id, mapping.personId, wav);
          mapping.bestMs = ms;
          groupChanged = true;
          appendLog({
            kind: 'sent',
            at: Date.now(),
            text: `🎙 voiceprint saved: ${segs[0].speaker} (${(ms / 1000).toFixed(1)}s)`,
          });
        } catch (e) {
          appendLog({
            kind: 'error',
            at: Date.now(),
            text: `voiceprint upload failed: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }

      // Persist the expanded roster onto the thread (so next session picks
      // up the new people automatically).
      if (newRoster.length !== (thread.roster?.length ?? 0)) {
        try {
          const updated: Thread = {
            ...thread,
            roster: newRoster,
            updatedAt: new Date().toISOString(),
          };
          await saveThread(updated);
          activeThreadRef.current = updated;
          setActiveThread(updated);
        } catch {
          // non-fatal
        }
      }

      if (groupChanged) {
        // Refresh the active group + push the new voiceprints into the live
        // orchestrator so subsequent requests can identify these speakers.
        try {
          const fresh = await getGroup(group.id);
          if (fresh) {
            setActiveGroup(fresh);
            const refs = await loadVoiceReferences(activeThreadRef.current, fresh);
            orchestratorRef.current?.setVoiceReferences(refs);
          }
        } catch {
          // non-fatal
        }
      }
    },
    [appendLog],
  );

  // ---- classifier ----
  const runClassifier = useCallback(
    async (heard: string) => {
      const others = threadsRef.current.filter((t) => t.id !== activeThreadIdRef.current);
      if (others.length === 0) return;
      try {
        const result = await classifyConversation(
          { apiKey: API_KEY, model: MODEL },
          others,
          heard,
        );
        if (result.kind === 'match') {
          appendLog({
            kind: 'sent',
            at: Date.now(),
            text: `classifier: match → ${result.threadId} (${result.confidence})`,
          });
          if (result.threadId === activeThreadIdRef.current) return;

          // If the user is on the Ad-hoc default (didn't pick anything), let
          // the classifier silently route to the matched thread — that's the
          // "gemini picks for me" behaviour. medium+ confidence is enough.
          const isAdhoc = activeThreadIdRef.current === ADHOC_THREAD_ID;
          if (isAdhoc && result.confidence !== 'low') {
            const t = await getThread(result.threadId);
            if (t) {
              appendLog({
                kind: 'sent',
                at: Date.now(),
                text: `auto-routed Ad-hoc → ${t.name}`,
              });
              setActiveThread(t);
            }
            return;
          }

          // The user explicitly picked the current thread; only show a switch
          // banner on high confidence and let them decide.
          if (result.confidence !== 'high') return;
          setClassifier(result);
        } else if (result.kind === 'new') {
          appendLog({
            kind: 'sent',
            at: Date.now(),
            text: `classifier: new topic suggested${result.suggestedName ? ` (${result.suggestedName})` : ''}`,
          });
          setClassifier(result);
        }
      } catch (e) {
        appendLog({
          kind: 'error',
          at: Date.now(),
          text: `classifier: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    },
    [appendLog],
  );

  // ---- toggle ----
  const onToggle = useCallback(async () => {
    const capture = captureRef.current;
    if (!capture) return;
    if (capture.isActive) {
      await capture.stop();
      return;
    }
    // If somehow no thread is active (e.g. all threads deleted), recover by
    // re-creating Ad-hoc and selecting it. Should be unreachable in practice.
    if (!activeThread) {
      try {
        const adhoc = await ensureAdhocThread();
        setActiveThread(adhoc);
        return; // re-render will rebuild orchestrator; user can tap again
      } catch (e) {
        appendLog({
          kind: 'error',
          at: Date.now(),
          text: `couldn't ensure default thread: ${e instanceof Error ? e.message : String(e)}`,
        });
        return;
      }
    }
    classifierFiredRef.current = false;
    setClassifier(null);
    sessionSpeakersRef.current.clear();
    try {
      await capture.start();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      appendLog({ kind: 'error', at: Date.now(), text: `start: ${msg}` });
    }
  }, [activeThread, appendLog]);

  // ---- thread selection ----
  const onSelectThread = useCallback(
    async (id: string) => {
      try {
        if (captureRef.current?.isActive) await captureRef.current.stop();
        // If the user is overriding the schedule, remember it for the rest
        // of the scheduled window so polling doesn't yank them back.
        if (scheduleNow && id !== scheduleNow.threadId) {
          overrideUntilMsRef.current = scheduleNow.untilMs;
        }
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
    [appendLog, scheduleNow],
  );

  const refreshThreads = useCallback(async () => {
    try {
      const list = await listThreads();
      setThreads(list);
      threadsRef.current = list;
    } catch (e) {
      appendLog({
        kind: 'error',
        at: Date.now(),
        text: `list threads: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }, [appendLog]);

  const onSaveEditor = useCallback(
    async (form: {
      name: string;
      groupId: string;
      roster: string[];
      systemPrompt: string;
      context: string;
      summary: string;
      scheduleText: string;
    }) => {
      const isNew = editorState.mode === 'create' || !activeThread;
      const id = isNew ? makeThreadId(form.name) : activeThread!.id;
      const { entries: schedule, errors } = parseSchedule(form.scheduleText);
      if (errors.length > 0) {
        appendLog({
          kind: 'error',
          at: Date.now(),
          text: `schedule parse: ${errors.join('; ')}`,
        });
        return;
      }
      const next: Thread = {
        id,
        name: form.name,
        group: form.groupId || ADHOC_GROUP_ID,
        roster: form.roster.length > 0 ? form.roster : undefined,
        systemPrompt: form.systemPrompt,
        context: form.context,
        summary: form.summary || undefined,
        schedule: schedule.length > 0 ? schedule : undefined,
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
      const remaining = await listThreads();
      setThreads(remaining);
      threadsRef.current = remaining;
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

  // ---- classifier banner actions ----
  const onClassifierSwitch = useCallback(async () => {
    if (classifier?.kind !== 'match') return;
    const id = classifier.threadId;
    setClassifier(null);
    await onSelectThread(id);
  }, [classifier, onSelectThread]);

  const onClassifierCreate = useCallback(
    (suggestedName: string) => {
      setClassifier(null);
      setEditorState({ open: true, mode: 'create', prefill: { name: suggestedName } });
    },
    [],
  );

  const onDismissCue = useCallback((id: number) => {
    setCues((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const onClearCues = useCallback(() => setCues([]), []);

  const editorInitial =
    editorState.mode === 'edit'
      ? activeThread
      : editorState.prefill
        ? ({ name: editorState.prefill.name } as Partial<Thread>)
        : null;

  const refreshGroups = useCallback(async () => {
    try {
      setGroups(await listGroups());
    } catch {
      // non-fatal
    }
  }, []);
  void activeGroup; // active group state will be consumed by Phase 2 (voiceprint injection)

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
            scheduledActiveId={scheduleNow?.threadId ?? null}
            scheduledActiveUntil={scheduleNow?.untilLabel ?? null}
            onSelect={onSelectThread}
            onCreate={() => setEditorState({ open: true, mode: 'create' })}
            onEdit={() => setEditorState({ open: true, mode: 'edit' })}
          />
        }
      />

      {classifier && classifier.kind === 'match' && (
        <ClassifierBanner
          kind="match"
          threadName={threads.find((t) => t.id === classifier.threadId)?.name ?? '?'}
          onAccept={onClassifierSwitch}
          onDismiss={() => setClassifier(null)}
        />
      )}
      {classifier && classifier.kind === 'new' && (
        <ClassifierBanner
          kind="new"
          suggestedName={classifier.suggestedName}
          onCreate={onClassifierCreate}
          onDismiss={() => setClassifier(null)}
        />
      )}

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
          initial={editorInitial}
          groups={groups}
          onSave={onSaveEditor}
          onCancel={() => setEditorState({ open: false, mode: 'create' })}
          onDelete={
            editorState.mode === 'edit' && activeThread ? onDeleteCurrentThread : undefined
          }
          onGroupsChanged={refreshGroups}
        />
      )}
    </div>
  );
}
