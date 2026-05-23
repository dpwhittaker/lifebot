import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { G2AudioCapture } from './adapters/audio/G2AudioCapture';
import type { AudioCapture } from './adapters/audio/types';
import { WebAudioCapture } from './adapters/audio/WebAudioCapture';
import {
  OsEventTypeList,
  waitForEvenAppBridge,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import { G2HudRenderer, type MenuSpec } from './adapters/display/G2HudRenderer';
import { GeminiAudioOrchestrator } from './orchestrator/GeminiAudio';
import { classifyConversation, type ClassifierResult } from './orchestrator/Classifier';
import { Controls } from './ui/Controls';
import { DomCueRenderer, type Cue } from './adapters/display/DomCueRenderer';
import { G2HudPreview } from './adapters/display/G2HudPreview';
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
  descendantIds,
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

function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

const API_KEY: string = (import.meta.env.VITE_GEMINI_API_KEY as string | undefined) ?? '';

/**
 * Two performance modes. Low-latency favours response speed (cheap model, 1s
 * cadence); high-accuracy favours verbatim recall (stronger model, slower
 * cadence + tap-to-send-now). Both use delta transcripts to hold ~$1/hr.
 * Verse-recall testing eliminated gemini-2.5-flash (fabrications); see plan.
 */
type AudioMode = 'low-latency' | 'high-accuracy';
const MODE_CONFIG: Record<
  AudioMode,
  { label: string; model: string; sendIntervalMs: number; transcriptMode: 'full' | 'delta' }
> = {
  'low-latency': {
    label: 'Low latency',
    model: 'gemini-3.1-flash-lite',
    sendIntervalMs: 1000,
    transcriptMode: 'delta',
  },
  'high-accuracy': {
    label: 'High accuracy',
    model: 'gemini-3.5-flash',
    sendIntervalMs: 8000,
    transcriptMode: 'delta',
  },
};
/** Optional dev pin: VITE_GEMINI_MODEL overrides the mode's model when set. */
const MODEL_OVERRIDE = (import.meta.env.VITE_GEMINI_MODEL as string | undefined) || '';
const MODE_KEY = 'lifebot:mode';

function readSavedMode(): AudioMode {
  try {
    const m = window.localStorage.getItem(MODE_KEY);
    if (m === 'low-latency' || m === 'high-accuracy') return m;
  } catch {
    /* storage disabled */
  }
  return 'low-latency';
}

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

/** Compact catalog of groups (with hierarchy hints) for the model to classify into. */
function composeGroupCatalog(groups: GroupSummary[]): { id: string; label: string }[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  return groups
    .filter((g) => g.id !== ADHOC_GROUP_ID)
    .map((g) => {
      const path: string[] = [g.name];
      let cur = g.parent;
      while (cur && byId.has(cur)) {
        path.unshift(byId.get(cur)!.name);
        cur = byId.get(cur)!.parent;
      }
      return { id: g.id, label: path.join(' › ') };
    });
}

/** Slice a sub-segment out of 16-bit mono PCM by start/end seconds. */
function extractPcmSegment(pcm: Uint8Array, startSec: number, endSec: number): Uint8Array {
  const start = Math.max(0, Math.floor(startSec * SAMPLE_RATE) * BYTES_PER_SAMPLE);
  const end = Math.min(pcm.length, Math.ceil(endSec * SAMPLE_RATE) * BYTES_PER_SAMPLE);
  if (end <= start) return new Uint8Array(0);
  return pcm.slice(start, end);
}

/**
 * Walk the active thread's group subtree (group + all descendants) and pull
 * voiceprints + per-person notes. Cross-session learning: a meeting in any
 * group inherits voiceprints from every sub-team below it. (A BSA/AML standup
 * pulls only BSA/AML people; an FCU PI Planning pulls everyone in FCU's
 * subtree.) Notes ride along on each VoiceReference so Gemini sees them in
 * the priming turn alongside the voice clip.
 */
async function loadVoiceReferences(
  thread: Thread | null,
  groupSummaries: GroupSummary[],
): Promise<VoiceReference[]> {
  if (!thread?.group) return [];
  const ids = descendantIds(groupSummaries, thread.group);
  const out: VoiceReference[] = [];
  for (const gid of ids) {
    let group: Group | null;
    try {
      group = await getGroup(gid);
    } catch {
      continue;
    }
    if (!group) continue;
    for (const p of group.people) {
      if (!p.hasVoiceprint) continue;
      try {
        const bytes = await fetchVoiceprintBytes(gid, p.id);
        if (bytes) out.push({ name: p.name, notes: p.notes, wav: bytes });
      } catch {
        // skip
      }
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

/** Per-session snapshot persisted on Exit and restored on next launch.
 *  Only the bits we can't cheaply re-derive: page, thread id, in-memory
 *  transcript + cue backlog. Everything else (orchestrator, voiceprints,
 *  schedules) rebuilds naturally from activeThread. */
type SavedSession = {
  glassesPage: 'inSession' | 'inSessionMenu';
  threadId: string | null;
  chunks: TranscriptChunk[];
  cues: Cue[];
};

const SAVED_SESSION_KEY = 'lifebot:savedSession';

/** Read-and-clear the saved session. Reading consumes it — a normal app
 *  launch (no prior Exit) returns null and lands on the entrypoint menu. */
function readAndClearSavedSession(): SavedSession | null {
  try {
    const raw = window.localStorage.getItem(SAVED_SESSION_KEY);
    if (!raw) return null;
    window.localStorage.removeItem(SAVED_SESSION_KEY);
    const parsed = JSON.parse(raw) as SavedSession;
    if (
      (parsed.glassesPage === 'inSession' || parsed.glassesPage === 'inSessionMenu') &&
      Array.isArray(parsed.chunks) &&
      Array.isArray(parsed.cues)
    ) {
      return parsed;
    }
  } catch {
    /* malformed or storage disabled */
  }
  return null;
}

export function App() {
  // Read the saved session exactly once per mount, before any useState
  // calls so each lazy initializer can rehydrate from it. Stored on a
  // ref-bag so subsequent renders see the same `saved` value without
  // re-reading localStorage (which was already cleared on first read).
  const savedSessionRef = useRef<SavedSession | null | undefined>(undefined);
  if (savedSessionRef.current === undefined) {
    savedSessionRef.current = readAndClearSavedSession();
  }
  const saved = savedSessionRef.current;

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
  // Rehydrate from saved session if Exit was used last time. Seq refs are
  // bumped past any restored id so new chunks/cues don't collide.
  const [chunks, setChunks] = useState<TranscriptChunk[]>(() => saved?.chunks ?? []);
  const [active, setActive] = useState(false);
  const [vadActive, setVadActive] = useState(false);
  const [mode, setMode] = useState<AudioMode>(() => readSavedMode());

  const [cues, setCues] = useState<Cue[]>(() => saved?.cues ?? []);
  const [pendingCues, setPendingCues] = useState(0);
  const cueSeq = useRef(
    saved ? saved.cues.reduce((m, c) => Math.max(m, c.id), 0) : 0,
  );
  const chunkSeq = useRef(
    saved ? saved.chunks.reduce((m, c) => Math.max(m, c.id), 0) : 0,
  );

  const [log, setLog] = useState<LogEntry[]>([]);
  const logSeq = useRef(0);

  const captureRef = useRef<AudioCapture | null>(null);
  const orchestratorRef = useRef<GeminiAudioOrchestrator | null>(null);
  const hudRendererRef = useRef<G2HudRenderer | null>(null);
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

  // ---- diagnostic heartbeat ----
  // Every 5 s log "alive" + memory usage if the WebView exposes it. When
  // the host kills our JS event loop (sustained-CPU watchdog, OOM, etc.)
  // the heartbeat is the first thing to stop firing — comparing the last
  // heartbeat timestamp to the last VAD/Gemini activity tells us whether
  // JS halted or just the audio bridge went silent.
  useEffect(() => {
    const id = setInterval(() => {
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
      const memText = mem
        ? `mem ${Math.round(mem.usedJSHeapSize / 1024 / 1024)}MB / ${Math.round(mem.jsHeapSizeLimit / 1024 / 1024)}MB`
        : 'mem n/a';
      appendLog({ kind: 'sent', at: Date.now(), text: `heartbeat ${memText}` });
    }, 5000);
    return () => clearInterval(id);
  }, [appendLog]);

  // ---- global error trap ----
  // If the WebView dies from an uncaught exception or rejected promise,
  // this is the only place we can capture it before the log goes silent.
  // The host kill of the JS event loop has been firing without any error
  // surfaced anywhere — this catches anything that flies past handlers.
  useEffect(() => {
    const onError = (ev: ErrorEvent) => {
      appendLog({
        kind: 'error',
        at: Date.now(),
        text: `window.onerror: ${ev.message} @${ev.filename}:${ev.lineno}`,
      });
    };
    const onRejection = (ev: PromiseRejectionEvent) => {
      const r = ev.reason;
      appendLog({
        kind: 'error',
        at: Date.now(),
        text: `unhandledrejection: ${r instanceof Error ? r.message : String(r)}`,
      });
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, [appendLog]);

  // ---- host keep-alive ping ----
  // Some Even-Hub hosts cull WebViews that look idle from a host-RPC
  // standpoint even when the JS is busy. Pinging a cheap bridge method
  // every 20 s signals "still here" without consuming meaningful BLE
  // budget. Best-effort; failures are silent.
  useEffect(() => {
    let cancelled = false;
    const id = setInterval(() => {
      const bridge = bridgeRef.current;
      if (!bridge || cancelled) return;
      bridge.getDeviceInfo().catch(() => {
        /* host transient — try again next tick */
      });
    }, 20_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // ---- G2 bridge renderer (no-op if no Even Hub bridge is present, e.g.
  //      plain browser dev). Lives the whole app lifetime; receives both the
  //      transcript pane and cue list pane via the useEffects below.
  const [hudReady, setHudReady] = useState(false);
  useEffect(() => {
    const renderer = new G2HudRenderer();
    renderer.onDiag = (msg) =>
      appendLog({ kind: 'sent', at: Date.now(), text: `HUD: ${msg}` });
    hudRendererRef.current = renderer;
    void renderer.init().then((ok) => {
      if (ok) {
        appendLog({ kind: 'sent', at: Date.now(), text: 'G2 bridge ready — HUD live' });
        setHudReady(true);
      }
    });
    return () => {
      renderer.destroy();
      hudRendererRef.current = null;
      setHudReady(false);
    };
  }, [appendLog]);

  // ---- Glasses page state machine ----
  // 'entrypoint'     — main menu (Start listening / Name voices / Previous
  //                    sessions). Shown on app launch and after Stop.
  // 'inSession'      — the stacked listening view (transcript + cues).
  // 'inSessionMenu'  — Stop listening / Exit menu, summoned by double-tap
  //                    while in select mode of the listening view.
  type GlassesPage =
    | 'entrypoint'
    | 'threadPick'
    | 'groupPick'
    | 'inSession'
    | 'inSessionMenu';
  // Lazy initial state: read the saved page from localStorage on first
  // mount so glassesPage starts at the restored value rather than
  // defaulting to 'entrypoint' and then re-renderering. Eliminates the
  // "menu fights with screen" flash where the entrypoint paints once
  // before the restored page paints over it.
  const [glassesPage, setGlassesPage] = useState<GlassesPage>(
    () => saved?.glassesPage ?? 'entrypoint',
  );
  // Bumped on FOREGROUND_ENTER to force a re-paint of the current page —
  // the host clears the glasses display when it backgrounds the WebView,
  // so we need to re-issue the show* call when we come back.
  const [renderEpoch, setRenderEpoch] = useState(0);
  const glassesPageRef = useRef(glassesPage);
  useEffect(() => {
    glassesPageRef.current = glassesPage;
  }, [glassesPage]);
  // Refs that mirror state read inside menu callbacks — the callbacks
  // live across renders and would otherwise close over stale values.
  const captureActiveRef = useRef(active);
  useEffect(() => {
    captureActiveRef.current = active;
  }, [active]);
  // Bridge reference shared with menu callbacks (Exit needs to call
  // shutDownPageContainer). Populated in the gesture useEffect below.
  const bridgeRef = useRef<EvenAppBridge | null>(null);
  // onToggle drives audio start/stop; menus call it via this ref so the
  // menu spec stays stable across renders.
  const onToggleRef = useRef<(() => Promise<void>) | null>(null);
  // Set true when the user picks a thread on the glasses; the dispatch
  // effect for glassesPage='inSession' uses it to kick off audio capture
  // once activeThread has propagated into a fresh orchestrator.
  const pendingStartRef = useRef(false);
  // Mirror of `groups` for menu callbacks (which live across renders).
  const groupsRef = useRef<GroupSummary[]>([]);

  // Flip performance mode. Persists the choice and, if a session is live,
  // marks it to auto-resume once the orchestrator rebuilds with the new model.
  const toggleMode = useCallback(() => {
    setMode((m) => {
      const next: AudioMode = m === 'low-latency' ? 'high-accuracy' : 'low-latency';
      try {
        window.localStorage.setItem(MODE_KEY, next);
      } catch {
        /* storage disabled */
      }
      if (captureActiveRef.current) pendingStartRef.current = true;
      return next;
    });
  }, []);

  // Force one immediate evaluate (tap "send now"). No-op if a request is
  // already in flight or there's no buffered audio.
  const sendNow = useCallback(() => {
    orchestratorRef.current?.sendNow();
  }, []);

  // ---- Glasses menus ----
  // Spec objects are stable (useMemo with []-ish deps) so we don't churn
  // rebuildPageContainer just because the parent re-rendered.
  const entrypointMenu = useMemo<MenuSpec>(
    () => ({
      items: ['Start listening', 'Name voices', 'Previous sessions'],
      onSelect: (idx) => {
        if (idx === 0) {
          // Start listening always routes through the thread-pick menu —
          // the user expects to confirm which thread receives this
          // session before audio starts.
          setGlassesPage('threadPick');
        } else if (idx === 1) {
          appendLog({ kind: 'sent', at: Date.now(), text: 'Name voices: not yet implemented' });
        } else if (idx === 2) {
          appendLog({
            kind: 'sent',
            at: Date.now(),
            text: 'Previous sessions: not yet implemented',
          });
        }
      },
      // Double-tap on the entrypoint menu = exit the app entirely.
      onCancel: () => {
        appendLog({ kind: 'sent', at: Date.now(), text: 'exit: entrypointMenu.onCancel' });
        void bridgeRef.current?.shutDownPageContainer(0);
      },
    }),
    [appendLog],
  );

  // Thread-pick menu: active group's threads (recent first) + a trailing
  // "Switch Group" entry. Rebuilt on every dispatch so the items reflect
  // current state of threads / active group.
  const buildThreadPickMenu = useCallback((): MenuSpec => {
    const activeGroupId = activeGroupRef.current?.id;
    const inGroup = threadsRef.current.filter(
      (t) => !activeGroupId || t.group === activeGroupId,
    );
    inGroup.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    const SWITCH = 'Switch Group';
    const items = [...inGroup.map((t) => t.name), SWITCH];
    return {
      items,
      onSelect: (idx, name) => {
        if (name === SWITCH || idx >= inGroup.length) {
          setGlassesPage('groupPick');
          return;
        }
        const picked = inGroup[idx];
        if (!picked) return;
        // Switch thread (this stops capture if it was running) and arm
        // the auto-start effect to kick off audio once the orchestrator
        // rebuilds against the new thread.
        void onSelectThreadRef.current?.(picked.id);
        pendingStartRef.current = true;
        setGlassesPage('inSession');
      },
      onCancel: () => setGlassesPage('entrypoint'),
    };
  }, []);

  // Group-pick menu: every group, alphabetical. Select → setActiveGroup
  // + back to thread pick (which will now reflect the new group).
  const buildGroupPickMenu = useCallback((): MenuSpec => {
    const sorted = groupsRef.current.slice().sort((a, b) => a.name.localeCompare(b.name));
    return {
      items: sorted.map((g) => g.name),
      onSelect: (idx) => {
        const picked = sorted[idx];
        if (!picked) return;
        void (async () => {
          try {
            const full = await getGroup(picked.id);
            setActiveGroup(full);
          } catch (e) {
            appendLog({
              kind: 'error',
              at: Date.now(),
              text: `getGroup: ${e instanceof Error ? e.message : String(e)}`,
            });
          }
        })();
        setGlassesPage('threadPick');
      },
      onCancel: () => setGlassesPage('threadPick'),
    };
  }, [appendLog]);

  // onSelectThread is declared further down; mirror into a ref so the
  // menu callbacks (memoized once at mount) can invoke the current one.
  const onSelectThreadRef = useRef<((id: string) => Promise<void>) | null>(null);
  const inSessionMenu = useMemo<MenuSpec>(
    () => {
      const otherMode: AudioMode = mode === 'low-latency' ? 'high-accuracy' : 'low-latency';
      return {
      items: ['Stop listening', `Mode → ${MODE_CONFIG[otherMode].label}`, 'Exit'],
      onSelect: (idx) => {
        if (idx === 0) {
          if (captureActiveRef.current) void onToggleRef.current?.();
          setGlassesPage('entrypoint');
        } else if (idx === 1) {
          // Switch performance mode; the orchestrator rebuilds and (if a
          // session is live) auto-resumes. Return to the listening view.
          toggleMode();
          setGlassesPage('inSession');
        } else if (idx === 2) {
          // Return to glasses home screen, but persist enough state that
          // re-entering the app lands back on the listening view with the
          // same thread + transcript + cues, with audio auto-restarted.
          appendLog({ kind: 'sent', at: Date.now(), text: 'exit: inSessionMenu.Exit' });
          try {
            const snapshot: SavedSession = {
              glassesPage: 'inSession',
              threadId: activeThreadRef.current?.id ?? null,
              chunks: chunksRef.current,
              cues: cuesRef.current,
            };
            window.localStorage.setItem(SAVED_SESSION_KEY, JSON.stringify(snapshot));
          } catch {
            /* storage disabled — Exit still works, just no resume */
          }
          void bridgeRef.current?.shutDownPageContainer(0);
        }
      },
      onCancel: () => setGlassesPage('inSession'),
      };
    },
    [appendLog, mode, toggleMode],
  );

  // Drive the glasses page whenever (a) the renderer becomes ready or
  // (b) glassesPage changes. The renderer is idempotent on identical
  // show* calls — it always rebuilds, so this just keeps the glasses
  // visually in sync with React state.
  // Stable pages: entrypoint / inSession / inSessionMenu don't read
  // threads/groups so they don't need to re-dispatch when those fill in
  // from the network — keeping them out of deps eliminates flicker on
  // initial data load.
  useEffect(() => {
    if (!hudReady) return;
    const r = hudRendererRef.current;
    if (!r) return;
    appendLog({ kind: 'sent', at: Date.now(), text: `dispatch glassesPage=${glassesPage}` });
    if (glassesPage === 'entrypoint') r.showMenu(entrypointMenu);
    else if (glassesPage === 'inSession') r.showListening();
    else if (glassesPage === 'inSessionMenu') r.showMenu(inSessionMenu);
  }, [hudReady, glassesPage, entrypointMenu, inSessionMenu, appendLog, renderEpoch]);

  // Data-driven pages: re-dispatch when the underlying data changes so a
  // thread added/renamed shows up live while the user is on the picker.
  useEffect(() => {
    if (!hudReady) return;
    const r = hudRendererRef.current;
    if (!r) return;
    if (glassesPage === 'threadPick') r.showMenu(buildThreadPickMenu());
    else if (glassesPage === 'groupPick') r.showMenu(buildGroupPickMenu());
  }, [
    hudReady,
    glassesPage,
    buildThreadPickMenu,
    buildGroupPickMenu,
    threads,
    groups,
    activeGroup,
    renderEpoch,
  ]);

  // (Auto-start is wired into the orchestrator-rebuild effect itself —
  // see the `pendingStartRef.current` check there. A standalone effect
  // here would race the rebuild effect's cleanup, which nulls
  // captureRef.current before this effect could read it.)

  // (No on-every-change persistence — see the Exit handler, which writes
  // the page to localStorage just before shutDownPageContainer so the
  // *next* launch resumes the same view. The lazy initial state above
  // clears the key on read so a normal launch always shows the menu.)

  // Session resume from Exit: if a SavedSession was rehydrated at mount
  // (glassesPage / chunks / cues already restored via lazy state init),
  // also restore the active thread and auto-restart audio capture.
  useEffect(() => {
    if (!saved) return;
    let cancelled = false;
    void (async () => {
      if (saved.threadId) {
        try {
          const t = await getThread(saved.threadId);
          if (cancelled) return;
          if (t) setActiveThread(t);
        } catch {
          /* fall through and start with whatever default thread loaded */
        }
      }
      // Poll for the orchestrator-rebuild effect to land a fresh capture.
      // It does an internal waitForEvenAppBridge() race; with the bridge
      // already established globally, capture is typically ready within
      // a few hundred ms. 30 * 100ms = 3s budget before we give up.
      for (let i = 0; i < 30; i++) {
        if (cancelled) return;
        const cap = captureRef.current;
        if (cap?.isActive) return;
        if (cap) {
          try {
            await cap.start();
            appendLog({ kind: 'sent', at: Date.now(), text: 'resume: audio restarted' });
          } catch (e) {
            appendLog({
              kind: 'error',
              at: Date.now(),
              text: `resume start: ${e instanceof Error ? e.message : String(e)}`,
            });
          }
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      appendLog({ kind: 'error', at: Date.now(), text: 'resume: capture never ready' });
    })();
    return () => {
      cancelled = true;
    };
    // saved is read once at mount and never reassigned; deps lint is OK.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- HUD content derivation ----
  // Transcript pane: the latest "heard" text. Each Gemini call refines the
  // current uncommitted window; we show that one chunk so the HUD mirrors
  // what the user is talking about *now*. Earlier turns live in CuePane and
  // the OrchestratorLog.
  // ---- HUD focus state ----
  // The renderer (G2HudRenderer) owns mode / current-pane / per-pane
  // scroll. App.tsx just forwards raw gestures to onUp/onDown/onClick/
  // onDoubleClick. A double-click that the renderer consumes (exiting
  // active mode back to select) is suppressed; an unconsumed double-click
  // in select mode is treated as the app-exit gesture.

  // Full transcript text — every chunk concatenated. Single newline between
  // chunks; the HUD windows this down further per pane budget.
  const fullTranscriptText = useMemo(
    () => chunks.map((c) => c.text).join('\n'),
    [chunks],
  );
  // Full cue text in chronological order (oldest at top, newest at bottom).
  // App.tsx stores cues newest-first so we reverse here.
  const fullCuesText = useMemo(
    () =>
      cues
        .slice()
        .reverse()
        .map((c) => c.short ?? c.text)
        .filter((s): s is string => !!s)
        .join('\n'),
    [cues],
  );
  // Send the full backlog to the renderer. G2HudRenderer wraps it to
  // lines, windows it to the visible 10-line pane, and pads the top so the
  // newest line sits on the bottom row — auto-tailing unless the user has
  // scrolled up via a ring gesture.
  useEffect(() => {
    hudRendererRef.current?.setTranscript(fullTranscriptText);
  }, [fullTranscriptText]);
  useEffect(() => {
    hudRendererRef.current?.setCues([fullCuesText]);
  }, [fullCuesText]);

  // ---- Bridge gesture subscription ----
  // All routing lives in G2HudRenderer; App.tsx just forwards the raw
  // events. Double-click is the one gesture App.tsx might want to handle
  // itself — when the renderer reports it didn't consume the double-click
  // (i.e. we were in select mode, not exiting active mode), it falls
  // through to shutDownPageContainer as the app-exit gesture.
  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | null = null;
    void (async () => {
      const bridge = await raceWithTimeout(waitForEvenAppBridge(), 1500);
      if (cancelled || !bridge) return;
      bridgeRef.current = bridge;
      unsub = bridge.onEvenHubEvent((evt) => {
        // SDK proto quirk (handle-input docs): zero-valued fields are
        // stripped to undefined. CLICK_EVENT = 0, so a real click arrives
        // as { sysEvent: { ...other fields... } } with eventType missing.
        // Treat "sysEvent exists but eventType missing" as CLICK_EVENT.
        const sysType = evt.sysEvent
          ? evt.sysEvent.eventType ?? OsEventTypeList.CLICK_EVENT
          : null;
        const textType = evt.textEvent ? evt.textEvent.eventType ?? null : null;
        const type = sysType !== null ? sysType : textType;
        // Audio PCM frames arrive through onEvenHubEvent too — every field
        // we care about is null. Don't log/process those as gestures; the
        // audio adapter handles them via its own onAudioData hook.
        const isAudioFrame =
          sysType === null && textType === null && !evt.listEvent;
        if (!isAudioFrame) {
          appendLog({
            kind: 'sent',
            at: Date.now(),
            text: `gesture sys=${sysType} text=${textType} list=${evt.listEvent ? 'y' : '-'} src=${evt.sysEvent?.eventSource ?? '-'}`,
          });
        } else {
          return;
        }
        const renderer = hudRendererRef.current;
        if (type === OsEventTypeList.SCROLL_TOP_EVENT) {
          renderer?.onUp();
          return;
        }
        if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
          renderer?.onDown();
          return;
        }
        if (type === OsEventTypeList.CLICK_EVENT) {
          // A click on a glasses menu selects the item; on the listening view
          // it's "send now" — force an immediate evaluate of buffered audio.
          const consumed = renderer?.onClick() ?? false;
          if (!consumed) orchestratorRef.current?.sendNow();
          return;
        }
        // Host foreground/background transitions. When the host hides our
        // page (e.g. phone screen lock, user switched apps) it stops
        // painting to the glasses. Audio capture may keep running in the
        // headless WebView. On foreground-enter, force a re-paint of the
        // current glassesPage so the glasses display recovers.
        if (sysType === 5 /* FOREGROUND_EXIT_EVENT */) {
          appendLog({
            kind: 'sent',
            at: Date.now(),
            text: 'foreground EXIT — glasses page paused by host',
          });
          // Tell the audio watchdog to stand down while we're backgrounded
          // so it doesn't spam bridge.audioControl with bounces the host
          // refuses (each returns false until FG_ENTER).
          const cap = captureRef.current as { setHostSuspended?: (s: boolean) => void } | null;
          cap?.setHostSuspended?.(true);
          hudRendererRef.current?.stopClock();
          return;
        }
        if (sysType === 4 /* FOREGROUND_ENTER_EVENT */) {
          appendLog({
            kind: 'sent',
            at: Date.now(),
            text: 'foreground ENTER — repainting glasses page',
          });
          const cap = captureRef.current as { setHostSuspended?: (s: boolean) => void } | null;
          cap?.setHostSuspended?.(false);
          hudRendererRef.current?.startClock();
          setRenderEpoch((e) => e + 1);
          return;
        }
        if (sysType === 6 /* ABNORMAL_EXIT_EVENT */ || sysType === 7 /* SYSTEM_EXIT_EVENT */) {
          appendLog({
            kind: 'sent',
            at: Date.now(),
            text: `host exit (sysType=${sysType})`,
          });
          return;
        }
        if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
          const consumed = renderer?.onDoubleClick() ?? false;
          if (consumed) return;
          // Unconsumed double-click: in the listening view (select mode)
          // it summons the in-session menu rather than exiting. Other
          // pages have already handled their own cancel via onCancel.
          if (glassesPageRef.current === 'inSession') {
            appendLog({
              kind: 'sent',
              at: Date.now(),
              text: 'double-click on listening → open inSessionMenu',
            });
            setGlassesPage('inSessionMenu');
          } else {
            appendLog({
              kind: 'sent',
              at: Date.now(),
              text: `double-click ignored (page=${glassesPageRef.current})`,
            });
          }
          return;
        }
      });
    })();
    return () => {
      cancelled = true;
      unsub?.();
      bridgeRef.current = null;
    };
  }, [appendLog]);

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
    groupsRef.current = groups;
  }, [groups]);
  // chunks/cues canonical refs — mutated synchronously by the orchestrator
  // callbacks (alongside setChunks/setCues) so the glasses keep painting
  // even when React's render loop stalls (e.g. phone screen-locked).
  // No useEffect mirror: that would race with synchronous ref writes.
  const chunksRef = useRef<TranscriptChunk[]>(chunks);
  const cuesRef = useRef<Cue[]>(cues);
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
    chunksRef.current = [];
    cuesRef.current = [];
    hudRendererRef.current?.setTranscript('');
    hudRendererRef.current?.setCues(['']);
    setChunks([]);
    setCues([]);
    setClassifier(null);
    classifierFiredRef.current = false;

    const directory = composeThreadDirectory(activeThread, threads);
    // When the active thread is in the Ad-hoc group, give the model a catalog
    // of real groups so it can suggest a better fit via groupHint.
    const groupCatalog =
      activeThread?.group === ADHOC_GROUP_ID
        ? composeGroupCatalog(groups)
        : undefined;

    // Eagerly kick off voiceprint loads for the thread's roster. The orchestrator
    // accepts them via setVoiceReferences once they arrive; in practice they're
    // loaded long before the user finishes their first sentence.
    void (async () => {
      const refs = await loadVoiceReferences(activeThread, groups);
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

    const modeConfig = MODE_CONFIG[mode];
    const activeModel = MODEL_OVERRIDE || modeConfig.model;
    const orchestrator = new GeminiAudioOrchestrator({
      apiKey: API_KEY,
      model: activeModel,
      sendIntervalMs: modeConfig.sendIntervalMs,
      transcriptMode: modeConfig.transcriptMode,
      maxBufferAfterCommitMs: 2000,
      systemInstruction: composeSystemPrompt(activeThread),
      threadDirectory: directory,
      groupCatalog,
      initialHistory: activeThread?.history ?? [],
      onTrace: (event) => {
        switch (event.type) {
          case 'sent':
            // One request just left for Gemini — track it as in-flight.
            // (Cadence is timer-driven now, so this is the source of truth,
            // not the audio-capture layer.)
            setPendingCues((n) => n + 1);
            appendLog({
              kind: 'sent',
              at: event.at,
              text: `→ Gemini (${formatSeconds(event.bufferMs)} of audio, ${(event.bytes / 1024).toFixed(1)} KB)`,
              meta: activeModel,
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
              // Compute the new chunks array from the ref (canonical
              // source of truth) instead of inside a setState updater.
              // React's updater callbacks don't run while the phone is
              // screen-locked / our app is backgrounded, so any code
              // gating glasses paint on those would stall. The ref +
              // direct renderer push works in raw JS, regardless of
              // React's render loop state.
              const prev = chunksRef.current;
              const last = prev[prev.length - 1];
              let next: TranscriptChunk[];
              if (last && !last.committed) {
                next = prev.slice();
                next[next.length - 1] = {
                  ...last,
                  text: event.heard,
                  finalizedAt: event.at,
                  committed: event.committed,
                };
              } else {
                next = [
                  ...prev,
                  {
                    id: ++chunkSeq.current,
                    text: event.heard,
                    finalizedAt: event.at,
                    committed: event.committed,
                  },
                ].slice(-300);
              }
              chunksRef.current = next;
              hudRendererRef.current?.setTranscript(next.map((c) => c.text).join('\n'));
              setChunks(next);
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
            // Failed request never reaches onResponse — balance the counter.
            setPendingCues((n) => Math.max(0, n - 1));
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
          // Same ref-first pattern as the chunks path — see comment there
          // for the screen-lock / React-stall rationale.
          const next = [
            {
              id: ++cueSeq.current,
              text: response.cue!,
              short: response.cueShort,
              createdAt: Date.now(),
              source: response.heard,
            },
            ...cuesRef.current,
          ].slice(0, 50);
          cuesRef.current = next;
          const text = next
            .slice()
            .reverse()
            .map((c) => c.short ?? c.text)
            .filter((s): s is string => !!s)
            .join('\n');
          hudRendererRef.current?.setCues([text]);
          setCues(next);
        }
        setPendingCues((n) => Math.max(0, n - 1));
      },
      onCommit: (entry) => {
        const tid = activeThreadIdRef.current;
        if (!tid) return;
        void appendCommit(tid, {
          heard: entry.heard,
          cue: entry.cue,
          cueShort: entry.cueShort,
        }).catch((e) => {
          appendLog({
            kind: 'error',
            at: Date.now(),
            text: `thread commit failed: ${e instanceof Error ? e.message : String(e)}`,
          });
        });
        void processSpeakerDiscovery(entry);
        void processGroupHint(entry);
      },
    });
    orchestratorRef.current = orchestrator;

    const captureCallbacks = {
      onVadActive: (a: boolean) => setVadActive(a),
      onVadEvent: (
        kind: 'speech_start' | 'speech_end' | 'misfire',
        info?: { samples?: number; bufferMs?: number; reason?: string },
      ) => {
        let text = '';
        let logKind: LogEntry['kind'] = 'sent';
        switch (kind) {
          case 'speech_start':
            text = 'VAD: speech start (fast cadence)';
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
        }
        appendLog({ kind: logKind, at: Date.now(), text });
      },
      onError: (msg: string) => appendLog({ kind: 'error', at: Date.now(), text: msg }),
      onStatusChange: (a: boolean) => setActive(a),
    };

    // Pick the audio adapter based on whether the Even Hub bridge is
    // present. In plain Chrome we use getUserMedia (WebAudioCapture); in
    // the Even Hub WebView / evenhub-simulator we use bridge.audioControl
    // (G2AudioCapture). The bridge race is short-circuited by a 1.5 s
    // timeout — same heuristic G2HudRenderer.init uses.
    void (async () => {
      const bridge = await raceWithTimeout(waitForEvenAppBridge(), 1500);
      if (cancelled) return;
      const capture: AudioCapture = bridge
        ? new G2AudioCapture(orchestrator, captureCallbacks)
        : new WebAudioCapture(orchestrator, captureCallbacks);
      captureRef.current = capture;
      appendLog({
        kind: 'sent',
        at: Date.now(),
        text: bridge
          ? 'audio: G2 bridge mode (audioControl)'
          : 'audio: browser mic mode (getUserMedia)',
      });
      // Glasses-driven auto-start: when the user picked a thread from the
      // thread-pick menu, `pendingStartRef` is set. Fire start now —
      // we're inside the orchestrator-rebuild effect's body, immediately
      // after the new capture is bound, so capture.start() lands on the
      // fully-built instance without racing the standalone auto-start
      // useEffect (which would otherwise see captureRef.current=null
      // because cleanups run before bodies in dep-change ordering).
      if (pendingStartRef.current && !capture.isActive) {
        pendingStartRef.current = false;
        try {
          await capture.start();
          orchestratorRef.current?.start();
        } catch (e) {
          appendLog({
            kind: 'error',
            at: Date.now(),
            text: `auto-start: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      void captureRef.current?.release();
      captureRef.current = null;
      orchestratorRef.current?.close();
      orchestratorRef.current = null;
    };
    // activeGroup is intentionally NOT in the dep list: it isn't read inside
    // this effect, and processSpeakerDiscovery calls setActiveGroup() when
    // it materialises a new person mid-session. With activeGroup as a dep
    // the orchestrator would re-create on every roster update, which clears
    // chunks/cues and blanks both HUD panes for a frame — looks exactly
    // like the simulator just rebooted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThread, mode, appendLog]);

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
            const freshGroups = await listGroups();
            setGroups(freshGroups);
            const refs = await loadVoiceReferences(activeThreadRef.current, freshGroups);
            orchestratorRef.current?.setVoiceReferences(refs);
          }
        } catch {
          // non-fatal
        }
      }
    },
    [appendLog],
  );

  // ---- group inference ----
  const processGroupHint = useCallback(
    async (entry: CommitEntry) => {
      const hint = entry.groupHint;
      const thread = activeThreadRef.current;
      if (!hint || !thread) return;
      // Only auto-switch from Ad-hoc, and only on high-confidence hints.
      if (thread.group !== ADHOC_GROUP_ID) return;
      if (hint.confidence !== 'high') {
        appendLog({
          kind: 'sent',
          at: Date.now(),
          text: `group hint: ${hint.groupId} (${hint.confidence}) — holding`,
        });
        return;
      }
      const newGroup = await getGroup(hint.groupId);
      if (!newGroup) return;
      try {
        const updated: Thread = {
          ...thread,
          group: hint.groupId,
          updatedAt: new Date().toISOString(),
        };
        await saveThread(updated);
        appendLog({
          kind: 'sent',
          at: Date.now(),
          text: `↳ thread group set to ${newGroup.name} (Gemini classified)`,
        });
        setActiveThread(updated);
      } catch (e) {
        appendLog({
          kind: 'error',
          at: Date.now(),
          text: `group switch failed: ${e instanceof Error ? e.message : String(e)}`,
        });
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
          { apiKey: API_KEY, model: MODEL_OVERRIDE || MODE_CONFIG['low-latency'].model },
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
      orchestratorRef.current?.stop();
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
    // Reset the per-session HUD history so the glasses' transcript and cue
    // panes start fresh on each Start Listening tap. Clearing chunks/cues
    // drives fullTranscriptText/fullCuesText to '', which the renderer
    // treats as a reset — both panes snap back to auto-tail.
    chunksRef.current = [];
    cuesRef.current = [];
    hudRendererRef.current?.setTranscript('');
    hudRendererRef.current?.setCues(['']);
    setChunks([]);
    setCues([]);
    setPendingCues(0);
    try {
      await capture.start();
      orchestratorRef.current?.start();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      appendLog({ kind: 'error', at: Date.now(), text: `start: ${msg}` });
    }
  }, [activeThread, appendLog]);

  // Mirror onToggle into a ref so the glasses-menu callbacks (which are
  // memoized once) can always invoke the current closure.
  useEffect(() => {
    onToggleRef.current = onToggle;
  }, [onToggle]);

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

  // Mirror onSelectThread into the ref the glasses thread-pick menu uses.
  useEffect(() => {
    onSelectThreadRef.current = onSelectThread;
  }, [onSelectThread]);

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
        modeLabel={MODE_CONFIG[mode].label}
        onToggleMode={toggleMode}
        onSendNow={sendNow}
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

      <div className="grid-2x2">
        <div className="grid-cell">
          <TranscriptPane chunks={chunks} active={active} vadActive={vadActive} />
        </div>
        <div className="grid-cell">
          <DomCueRenderer cues={cues} onDismiss={onDismissCue} onClear={onClearCues} />
        </div>
        <div className="grid-cell">
          <OrchestratorLog entries={log} />
        </div>
        <div className="grid-cell">
          <G2HudPreview transcript={fullTranscriptText} cues={cues} />
        </div>
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
