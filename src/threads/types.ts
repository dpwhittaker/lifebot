/**
 * A Thread is a recurring conversation about the same thing — a D&D campaign,
 * a class, a meeting series. Each thread has its own system prompt, its own
 * accumulated context, and its own history of cued exchanges across many
 * sessions.
 *
 * Threads live on the server (one JSON file per thread) so they survive page
 * reloads and can be reached from any client on the tailnet.
 */
export type Thread = {
  id: string;
  name: string;
  systemPrompt: string;
  /** Optional free-text background context — paste rulebooks, syllabi, etc. */
  context?: string;
  /** Committed exchanges across all sessions in this thread, oldest first. */
  history: ThreadCommit[];
  updatedAt: string;
};

export type ThreadCommit = {
  heard: string;
  cue: string | null;
  at: string;
};

export type ThreadSummary = {
  id: string;
  name: string;
  updatedAt: string | null;
  systemPromptPreview: string;
  commitCount: number;
};
