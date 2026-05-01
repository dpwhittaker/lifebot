import { useEffect, useState } from 'react';
import type { Thread } from '../threads/types';
import { formatSchedule, parseSchedule } from '../threads/schedule';
import {
  ADHOC_GROUP_ID,
  type Group,
  type GroupSummary,
  type Person,
  deletePerson as apiDeletePerson,
  getGroup,
  saveGroup,
  savePerson,
  slugify,
} from '../threads/groups';

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
      const created = await saveGroup({ id, name: trimmed, people: [] });
      setGroup(created);
      setGroupId(id);
      setCreatingGroup(false);
      setNewGroupName('');
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
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
                <option value="__create__">+ Create new group…</option>
              </select>
            </div>
          ) : (
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
                  }
                }}
                placeholder="New group name (e.g. Work, D&D, Church)"
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
                }}
              >
                Cancel
              </button>
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
                <label className="person-check">
                  <input
                    type="checkbox"
                    checked={roster.includes(p.id)}
                    onChange={() => togglePerson(p.id)}
                  />
                  <span className="person-name">{p.name}</span>
                  {p.role && <span className="person-role">{p.role}</span>}
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
