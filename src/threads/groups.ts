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
  /** Free-form notes about the relationship to the user — sent to Gemini in
   *  the priming turn so it can use context to disambiguate similar voices.
   *  e.g. "DM of our Verdant Crown D&D campaign; runs sessions Sunday nights."
   */
  notes?: string;
  /** Set true once a voiceprint .wav has been uploaded for this person. */
  hasVoiceprint?: boolean;
};

export type Group = {
  id: string;
  name: string;
  /** Group id of the parent in the hierarchy. Undefined for roots. */
  parent?: string;
  people: Person[];
  updatedAt?: string;
};

export type GroupSummary = {
  id: string;
  name: string;
  parent?: string;
  peopleCount: number;
  updatedAt: string | null;
};

/** Subtree node. */
export type GroupNode = {
  id: string;
  name: string;
  parent?: string;
  children: GroupNode[];
};

/** Build the forest of group nodes from a flat list. */
export function buildGroupTree(groups: GroupSummary[]): GroupNode[] {
  const byId = new Map<string, GroupNode>();
  for (const g of groups) {
    byId.set(g.id, { id: g.id, name: g.name, parent: g.parent, children: [] });
  }
  const roots: GroupNode[] = [];
  for (const node of byId.values()) {
    if (node.parent && byId.has(node.parent)) {
      byId.get(node.parent)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  // Sort each level alphabetically.
  const sortRecursive = (nodes: GroupNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of nodes) sortRecursive(n.children);
  };
  sortRecursive(roots);
  return roots;
}

/** Return the ids of `rootId` and all its descendants. */
export function descendantIds(groups: GroupSummary[], rootId: string): string[] {
  const childrenOf: Record<string, string[]> = {};
  for (const g of groups) {
    if (g.parent) (childrenOf[g.parent] ??= []).push(g.id);
  }
  const out: string[] = [];
  const walk = (id: string) => {
    out.push(id);
    for (const c of childrenOf[id] ?? []) walk(c);
  };
  walk(rootId);
  return out;
}

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

export function voiceprintUrl(groupId: string, personId: string): string {
  return `${BASE}/${encodeURIComponent(groupId)}/people/${encodeURIComponent(personId)}/voiceprint`;
}

export async function uploadVoiceprint(
  groupId: string,
  personId: string,
  wav: Uint8Array,
): Promise<void> {
  const res = await fetch(voiceprintUrl(groupId, personId), {
    method: 'PUT',
    headers: { 'content-type': 'audio/wav' },
    body: new Blob([wav as BlobPart], { type: 'audio/wav' }),
  });
  if (!res.ok) throw new Error(`uploadVoiceprint: HTTP ${res.status}`);
}

export async function deleteVoiceprint(groupId: string, personId: string): Promise<void> {
  const res = await fetch(voiceprintUrl(groupId, personId), { method: 'DELETE' });
  if (!res.ok && res.status !== 204) throw new Error(`deleteVoiceprint: HTTP ${res.status}`);
}

export async function fetchVoiceprintBytes(
  groupId: string,
  personId: string,
): Promise<Uint8Array | null> {
  const res = await fetch(voiceprintUrl(groupId, personId));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetchVoiceprint: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Ensure the Ad-hoc default group exists; idempotent. */
export async function ensureAdhocGroup(): Promise<Group> {
  const existing = await getGroup(ADHOC_GROUP_ID);
  if (existing) return existing;
  return saveGroup({ id: ADHOC_GROUP_ID, name: ADHOC_GROUP_NAME, people: [] });
}
