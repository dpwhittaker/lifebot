import { useEffect, useState } from 'react';
import type { Thread } from '../threads/types';
import { formatSchedule, parseSchedule } from '../threads/schedule';

type Props = {
  initial: Partial<Thread> | null;
  knownGroups: string[];
  onSave: (next: {
    name: string;
    group: string;
    systemPrompt: string;
    context: string;
    summary: string;
    scheduleText: string;
  }) => void;
  onCancel: () => void;
  onDelete?: () => void;
};

export function ThreadEditor({
  initial,
  knownGroups,
  onSave,
  onCancel,
  onDelete,
}: Props) {
  const [name, setName] = useState(initial?.name ?? '');
  const [group, setGroup] = useState(initial?.group ?? '');
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? '');
  const [context, setContext] = useState(initial?.context ?? '');
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [scheduleText, setScheduleText] = useState(formatSchedule(initial?.schedule));

  useEffect(() => {
    setName(initial?.name ?? '');
    setGroup(initial?.group ?? '');
    setSystemPrompt(initial?.systemPrompt ?? '');
    setContext(initial?.context ?? '');
    setSummary(initial?.summary ?? '');
    setScheduleText(formatSchedule(initial?.schedule));
  }, [initial]);

  const isNew = !initial?.id;
  const valid = name.trim().length > 0;
  const scheduleErrors = scheduleText.trim() ? parseSchedule(scheduleText).errors : [];

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
          <input
            type="text"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            placeholder="Work / Church / Personal — pick anything; threads with the same group cluster together"
            list="known-groups"
            className="form-input"
          />
          <datalist id="known-groups">
            {knownGroups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </label>

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
          System prompt
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder={
              'How should the AI listen? E.g. "You are a D&D rules reference. Cue rule clarifications when players ask." Leave blank to use the default.'
            }
            className="form-textarea"
            rows={6}
          />
        </label>

        <label className="form-label">
          Cross-thread summary (optional)
          <textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder={
              'A short paragraph other threads can see — character names, recent events, project status. ' +
              'Lets the AI mention this thread\'s context in passing without leaking the full background.'
            }
            className="form-textarea"
            rows={3}
          />
        </label>

        <label className="form-label">
          Background context (optional)
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder={
              'Reference material that should always be in the model\'s context for this thread — campaign bible, syllabus, etc.'
            }
            className="form-textarea"
            rows={8}
          />
        </label>

        <div className="modal-actions">
          {!isNew && onDelete && (
            <button type="button" className="btn-danger" onClick={onDelete}>
              Delete
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
                group: group.trim(),
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
