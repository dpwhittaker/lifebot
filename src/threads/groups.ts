/**
 * Groups are first-class entities that own people. Threads belong to a group;
 * people belong to a group; voiceprints (phase 2) live with people.
 *
 * Group "ad-hoc" is auto-created and used as the default for unscheduled
 * one-shot conversations. Its semantic is "temporary, move me out."
 */

const BASE = '/lifebot/groups';

export type Person = {
  id: string;
  name: string;
  role?: string;
  /** Phase 2: relative URL to a voiceprint .wav, if recorded. */
  voiceprintPath?: string;
};

export type Group = {
  id: string;
  name: string;
  people: Person[];
  updatedAt?: string;
};

export type GroupSummary = {
  id: string;
  name: string;
  peopleCount: number;
  updatedAt: string | null;
};

export const ADHOC_GROUP_ID = 'ad-hoc';
export const ADHOC_GROUP_NAME = 'Ad-hoc';

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || `group-${Math.random().toString(36).slice(2, 8)}`;
}

export async function listGroups(): Promise<GroupSummary[]> {
  const res = await fetch(BASE);
  if (!res.ok) throw new Error(`listGroups: HTTP ${res.status}`);
  const json = (await res.json()) as { groups: GroupSummary[] };
  return json.groups;
}

export async function getGroup(id: string): Promise<Group | null> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getGroup: HTTP ${res.status}`);
  return (await res.json()) as Group;
}

export async function saveGroup(group: Group): Promise<Group> {
  const res = await fetch(`${BASE}/${encodeURIComponent(group.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(group),
  });
  if (!res.ok) throw new Error(`saveGroup: HTTP ${res.status}`);
  return (await res.json()) as Group;
}

export async function deleteGroup(id: string): Promise<void> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) throw new Error(`deleteGroup: HTTP ${res.status}`);
}

export async function savePerson(groupId: string, person: Person): Promise<Person> {
  const res = await fetch(
    `${BASE}/${encodeURIComponent(groupId)}/people/${encodeURIComponent(person.id)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(person),
    },
  );
  if (!res.ok) throw new Error(`savePerson: HTTP ${res.status}`);
  return (await res.json()) as Person;
}

export async function deletePerson(groupId: string, personId: string): Promise<void> {
  const res = await fetch(
    `${BASE}/${encodeURIComponent(groupId)}/people/${encodeURIComponent(personId)}`,
    { method: 'DELETE' },
  );
  if (!res.ok && res.status !== 204) throw new Error(`deletePerson: HTTP ${res.status}`);
}

/** Ensure the Ad-hoc default group exists; idempotent. */
export async function ensureAdhocGroup(): Promise<Group> {
  const existing = await getGroup(ADHOC_GROUP_ID);
  if (existing) return existing;
  return saveGroup({ id: ADHOC_GROUP_ID, name: ADHOC_GROUP_NAME, people: [] });
}
