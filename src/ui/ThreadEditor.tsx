import { useEffect, useState } from 'react';
import type { Thread } from '../threads/types';

type Props = {
  initial: Partial<Thread> | null;
  onSave: (next: { name: string; systemPrompt: string; context: string }) => void;
  onCancel: () => void;
  onDelete?: () => void;
};

export function ThreadEditor({ initial, onSave, onCancel, onDelete }: Props) {
  const [name, setName] = useState(initial?.name ?? '');
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? '');
  const [context, setContext] = useState(initial?.context ?? '');

  useEffect(() => {
    setName(initial?.name ?? '');
    setSystemPrompt(initial?.systemPrompt ?? '');
    setContext(initial?.context ?? '');
  }, [initial]);

  const isNew = !initial?.id;
  const valid = name.trim().length > 0;

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
          Background context (optional)
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder={
              'Reference material that should always be in the model\'s context for this thread — campaign bible, syllabus, etc.'
            }
            className="form-textarea"
            rows={10}
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
            disabled={!valid}
            onClick={() =>
              onSave({
                name: name.trim(),
                systemPrompt: systemPrompt.trim(),
                context: context.trim(),
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
