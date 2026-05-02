import type { Thread, ThreadCommit, ThreadSummary } from './types';
import { ADHOC_GROUP_ID } from './groups';

const BASE =
  (import.meta.env.VITE_LIFEBOT_THREADS_URL as string | undefined) ?? '/lifebot/threads';

/**
 * The Ad-hoc thread is the auto-default for unscheduled / unpicked listening.
 * It's a real thread (so its history is queryable) but its semantic is
 * "temporary catch-all; the classifier will move you somewhere real."
 */
export const ADHOC_THREAD_ID = 'ad-hoc';

export async function listThreads(): Promise<ThreadSummary[]> {
  const res = await fetch(BASE);
  if (!res.ok) throw new Error(`listThreads: HTTP ${res.status}`);
  const json = (await res.json()) as { threads: ThreadSummary[] };
  return json.threads;
}

export async function getThread(id: string): Promise<Thread | null> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getThread: HTTP ${res.status}`);
  return (await res.json()) as Thread;
}

export async function saveThread(thread: Thread): Promise<Thread> {
  const res = await fetch(`${BASE}/${encodeURIComponent(thread.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(thread),
  });
  if (!res.ok) throw new Error(`saveThread: HTTP ${res.status}`);
  return (await res.json()) as Thread;
}

export async function deleteThread(id: string): Promise<void> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) throw new Error(`deleteThread: HTTP ${res.status}`);
}

export async function appendCommit(
  threadId: string,
  commit: Omit<ThreadCommit, 'at'> & { at?: string },
): Promise<void> {
  const res = await fetch(`${BASE}/${encodeURIComponent(threadId)}/commits`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(commit),
  });
  if (!res.ok) throw new Error(`appendCommit: HTTP ${res.status}`);
}

/** Ensure the Ad-hoc default thread exists. Idempotent. */
export async function ensureAdhocThread(): Promise<Thread> {
  const existing = await getThread(ADHOC_THREAD_ID);
  if (existing) return existing;
  return saveThread({
    id: ADHOC_THREAD_ID,
    name: 'Ad-hoc',
    group: ADHOC_GROUP_ID,
    systemPrompt: '',
    history: [],
    updatedAt: new Date().toISOString(),
  });
}

/** Generate a URL-safe id from a name, with a short random suffix for uniqueness. */
export function makeThreadId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'thread';
  const rand = Math.random().toString(36).slice(2, 8);
  return `${base}-${rand}`;
}
