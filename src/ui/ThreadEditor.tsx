import { useEffect, useState } from 'react';
import type { Thread } from '../threads/types';
import { formatSchedule, parseSchedule } from '../threads/schedule';
import {
  ADHOC_GROUP_ID,
  buildGroupTree,
  type Group,
  type GroupNode,
  type GroupSummary,
  type Person,
  deletePerson as apiDeletePerson,
  getGroup,
  saveGroup,
  savePerson,
  slugify,
} from '../threads/groups';
import { VoiceprintControl } from './VoiceprintControl';

/** Flatten the group tree into options indented by depth. */
function indentedGroupOptions(groups: GroupSummary[]): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  const walk = (nodes: GroupNode[], depth: number) => {
    for (const n of nodes) {
      out.push({ id: n.id, label: `${'  '.repeat(depth)}${depth > 0 ? '↳ ' : ''}${n.name}` });
      walk(n.children, depth + 1);
    }
  };
  walk(buildGroupTree(groups), 0);
  return out;
}

type SaveForm = {
  name: string;
  groupId: string;
  roster: string[];
  systemPrompt: string;
  context: string;
  summary: string;
  scheduleText: string;
};

type Props = {
  initial: Partial<Thread> | null;
  groups: GroupSummary[];
  onSave: (next: SaveForm) => void;
  onCancel: () => void;
  onDelete?: () => void;
  onGroupsChanged: () => void;
};

export function ThreadEditor({
  initial,
  groups,
  onSave,
  onCancel,
  onDelete,
  onGroupsChanged,
}: Props) {
  const [name, setName] = useState(initial?.name ?? '');
  const [groupId, setGroupId] = useState(initial?.group ?? ADHOC_GROUP_ID);
  const [roster, setRoster] = useState<string[]>(initial?.roster ?? []);
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? '');
  const [context, setContext] = useState(initial?.context ?? '');
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [scheduleText, setScheduleText] = useState(formatSchedule(initial?.schedule));

  // Loaded group with its people roster.
  const [group, setGroup] = useState<Group | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupParent, setNewGroupParent] = useState<string>('');
  const [addingPerson, setAddingPerson] = useState(false);
  const [newPersonName, setNewPersonName] = useState('');

  useEffect(() => {
    setName(initial?.name ?? '');
    setGroupId(initial?.group ?? ADHOC_GROUP_ID);
    setRoster(initial?.roster ?? []);
    setSystemPrompt(initial?.systemPrompt ?? '');
    setContext(initial?.context ?? '');
    setSummary(initial?.summary ?? '');
    setScheduleText(formatSchedule(initial?.schedule));
  }, [initial]);

  // Load the selected group's people whenever group changes.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const g = await getGroup(groupId);
      if (!cancelled) setGroup(g);
    })();
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  const isNew = !initial?.id;
  const valid = name.trim().length > 0;
  const scheduleErrors = scheduleText.trim() ? parseSchedule(scheduleText).errors : [];

  const togglePerson = (id: string) => {
    setRoster((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleCreateGroup = async () => {
    const trimmed = newGroupName.trim();
    if (!trimmed) return;
    const id = slugify(trimmed);
    try {
      const created = await saveGroup({
        id,
        name: trimmed,
        parent: newGroupParent || undefined,
        people: [],
      });
      setGroup(created);
      setGroupId(id);
      setCreatingGroup(false);
      setNewGroupName('');
      setNewGroupParent('');
      onGroupsChanged();
    } catch (e) {
      alert(`Couldn't create group: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleAddPerson = async () => {
    const trimmed = newPersonName.trim();
    if (!trimmed) return;
    const id = slugify(trimmed);
    try {
      const newPerson: Person = { id, name: trimmed };
      await savePerson(groupId, newPerson);
      setGroup((g) =>
        g
          ? {
              ...g,
              people: g.people.some((p) => p.id === id)
                ? g.people.map((p) => (p.id === id ? newPerson : p))
                : [...g.people, newPerson],
            }
          : g,
      );
      // Auto-include new people in this thread's roster.
      setRoster((prev) => (prev.includes(id) ? prev : [...prev, id]));
      setAddingPerson(false);
      setNewPersonName('');
    } catch (e) {
      alert(`Couldn't add person: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleSetNotes = async (person: Person, notes: string) => {
    const trimmed = notes.trim();
    const next = trimmed ? trimmed : undefined;
    if (next === (person.notes ?? undefined)) return;
    try {
      const updated: Person = { ...person, notes: next };
      await savePerson(groupId, updated);
      setGroup((g) =>
        g
          ? { ...g, people: g.people.map((p) => (p.id === person.id ? updated : p)) }
          : g,
      );
    } catch (e) {
      alert(`Couldn't update notes: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleRemovePerson = async (personId: string) => {
    if (!confirm(`Remove this person from the group?\nThey'll be removed from every thread in this group.`)) return;
    try {
      await apiDeletePerson(groupId, personId);
      setGroup((g) => (g ? { ...g, people: g.people.filter((p) => p.id !== personId) } : g));
      setRoster((prev) => prev.filter((x) => x !== personId));
    } catch (e) {
      alert(`Couldn't remove person: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{isNew ? 'New thread' : 'Edit thread'}</h2>

        <label className="form-label">
          Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. D&D Campaign — The Verdant Crown"
            className="form-input"
            autoFocus
          />
        </label>

        <label className="form-label">
          Group
          {!creatingGroup ? (
            <div className="row-tight">
              <select
                value={groupId}
                onChange={(e) => {
                  if (e.target.value === '__create__') {
                    setCreatingGroup(true);
                  } else {
                    setGroupId(e.target.value);
                    setRoster([]);
                  }
                }}
                className="form-input"
              >
                {!groups.some((g) => g.id === ADHOC_GROUP_ID) && (
                  <option value={ADHOC_GROUP_ID}>Ad-hoc (default)</option>
                )}
                {indentedGroupOptions(groups).map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
                <option value="__create__">+ Create new group…</option>
              </select>
            </div>
          ) : (
            <div className="create-group-form">
              <div className="row-tight">
                <input
                  type="text"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleCreateGroup();
                    if (e.key === 'Escape') {
                      setCreatingGroup(false);
                      setNewGroupName('');
                      setNewGroupParent('');
                    }
                  }}
                  placeholder="New group name (e.g. BSA/AML Devs)"
                  className="form-input"
                  autoFocus
                />
                <button type="button" className="btn-primary btn-small" onClick={handleCreateGroup}>
                  Create
                </button>
                <button
                  type="button"
                  className="btn-ghost-modal btn-small"
                  onClick={() => {
                    setCreatingGroup(false);
                    setNewGroupName('');
                    setNewGroupParent('');
                  }}
                >
                  Cancel
                </button>
              </div>
              <div className="row-tight">
                <span className="form-sublabel">Parent (optional):</span>
                <select
                  value={newGroupParent}
                  onChange={(e) => setNewGroupParent(e.target.value)}
                  className="form-input"
                >
                  <option value="">— root —</option>
                  {indentedGroupOptions(groups).map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </label>

        <div className="form-label">
          People in {group?.name ?? '…'}
          <div className="people-list">
            {group?.people.length === 0 && (
              <div className="people-empty">No people in this group yet.</div>
            )}
            {group?.people.map((p) => (
              <div key={p.id} className="person-row">
                <div className="person-main">
                  <label className="person-check">
                    <input
                      type="checkbox"
                      checked={roster.includes(p.id)}
                      onChange={() => togglePerson(p.id)}
                    />
                    <span className="person-name">{p.name}</span>
                  </label>
                  <button
                    type="button"
                    className="person-remove"
                    onClick={() => handleRemovePerson(p.id)}
                    title="Remove from group"
                  >
                    ×
                  </button>
                </div>
                <VoiceprintControl
                  groupId={groupId}
                  person={p}
                  onChange={async () => {
                    const fresh = await getGroup(groupId);
                    if (fresh) setGroup(fresh);
                  }}
                />
                <textarea
                  defaultValue={p.notes ?? ''}
                  onBlur={(e) => void handleSetNotes(p, e.target.value)}
                  placeholder="Notes (relationship, role, ongoing context — Gemini sees these)"
                  className="person-notes-input"
                  rows={2}
                />
              </div>
            ))}
            {addingPerson ? (
              <div className="row-tight">
                <input
                  type="text"
                  value={newPersonName}
                  onChange={(e) => setNewPersonName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleAddPerson();
                    if (e.key === 'Escape') {
                      setAddingPerson(false);
                      setNewPersonName('');
                    }
                  }}
                  placeholder="Person's name"
                  className="form-input"
                  autoFocus
                />
                <button type="button" className="btn-primary btn-small" onClick={handleAddPerson}>
                  Add
                </button>
                <button
                  type="button"
                  className="btn-ghost-modal btn-small"
                  onClick={() => {
                    setAddingPerson(false);
                    setNewPersonName('');
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="person-add"
                onClick={() => setAddingPerson(true)}
              >
                + Add person to {group?.name ?? 'group'}
              </button>
            )}
          </div>
        </div>

        <label className="form-label">
          Schedule (optional)
          <textarea
            value={scheduleText}
            onChange={(e) => setScheduleText(e.target.value)}
            placeholder={
              'One per line.\n' +
              'Sun 16:00-21:00          weekly\n' +
              'Mon,Wed,Fri 09:00-10:00  multiple days\n' +
              '2026-05-04 15:00-16:00   one-shot date'
            }
            className="form-textarea form-textarea-mono"
            rows={4}
            spellCheck={false}
          />
          {scheduleErrors.length > 0 && (
            <div className="form-errors">
              {scheduleErrors.map((e, i) => (
                <div key={i}>⚠ {e}</div>
              ))}
            </div>
          )}
        </label>

        <label className="form-label">
          Cross-thread summary (optional)
          <textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder={
              'Short paragraph other threads can see — character names, recent events, project status. ' +
              'Lets the AI mention this thread\'s context in passing without leaking the full background.'
            }
            className="form-textarea"
            rows={3}
          />
        </label>

        <label className="form-label">
          System prompt
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder={
              'How should the AI listen? Leave blank to use the default.'
            }
            className="form-textarea"
            rows={5}
          />
        </label>

        <label className="form-label">
          Background context (optional)
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder={
              'Reference material that should always be in the model\'s context for this thread.'
            }
            className="form-textarea"
            rows={6}
          />
        </label>

        <div className="modal-actions">
          {!isNew && onDelete && (
            <button type="button" className="btn-danger" onClick={onDelete}>
              Delete thread
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn-ghost-modal" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!valid || scheduleErrors.length > 0}
            onClick={() =>
              onSave({
                name: name.trim(),
                groupId,
                roster,
                systemPrompt: systemPrompt.trim(),
                context: context.trim(),
                summary: summary.trim(),
                scheduleText: scheduleText.trim(),
              })
            }
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
