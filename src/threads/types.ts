/**
 * A Thread is a recurring conversation about the same thing — a D&D campaign,
 * a class series, a meeting series, a project. Each thread has its own system
 * prompt, optional background context, and persistent history across sessions.
 *
 * Threads live on the server (one JSON file per thread) so they survive page
 * reloads and can be reached from any client on the tailnet.
 */
export type Thread = {
  id: string;
  name: string;
  /**
   * Group id (slug) — references an entity in /lifebot/groups/. The Ad-hoc
   * group is the default for unscheduled, uncategorised conversations.
   */
  group?: string;
  /** Person ids within the thread's group. Used for diarization. */
  roster?: string[];
  systemPrompt: string;
  /** Optional free-text background context — paste rulebooks, syllabi, etc. */
  context?: string;
  /**
   * Compact one-paragraph summary of the thread's current state — character
   * names, recent events, project status. This summary is shared into other
   * threads' system prompts as "background awareness," so the model can
   * produce passing-reference cues without leaking the full context.
   */
  summary?: string;
  /** When this thread should auto-activate. Empty for manual-only threads. */
  schedule?: ScheduleEntry[];
  /** Committed exchanges across all sessions in this thread, oldest first. */
  history: ThreadCommit[];
  updatedAt: string;
};

/**
 * Schedule entries come in two shapes:
 *   recurring: weekly on specified days at a fixed time-of-day window
 *   one-shot:  a single specific date/time window (auto-archives after)
 */
export type ScheduleEntry =
  | {
      kind: 'recurring';
      /** 0=Sun .. 6=Sat */
      days: number[];
      /** "HH:MM" 24h, local time */
      start: string;
      end: string;
    }
  | {
      kind: 'one-shot';
      /** ISO 8601 datetime, local interpretation. */
      start: string;
      end: string;
    };

export type ThreadCommit = {
  heard: string;
  cue: string | null;
  at: string;
};

export type ThreadSummary = {
  id: string;
  name: string;
  group?: string;
  roster?: string[];
  schedule?: ScheduleEntry[];
  /** Editable thread summary (character names, recent events, etc.). */
  summary?: string;
  updatedAt: string | null;
  systemPromptPreview: string;
  commitCount: number;
};
