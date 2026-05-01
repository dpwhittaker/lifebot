import { useState } from 'react';
import type { Thread, ThreadSummary } from '../threads/types';

type Props = {
  active: Thread | null;
  threads: ThreadSummary[];
  onSelect: (id: string) => void;
  onCreate: () => void;
  onEdit: () => void;
};

export function ThreadBar({ active, threads, onSelect, onCreate, onEdit }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="thread-bar">
      <button
        type="button"
        className="thread-pill"
        onClick={() => setOpen((v) => !v)}
        title="Switch thread"
      >
        <span className="thread-name">{active?.name ?? '— no thread —'}</span>
        <span className="thread-caret">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="thread-menu" role="menu">
          {threads.length === 0 && (
            <div className="thread-empty">No threads yet — create your first one.</div>
          )}
          {threads.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`thread-item ${active?.id === t.id ? 'thread-item-active' : ''}`}
              onClick={() => {
                setOpen(false);
                onSelect(t.id);
              }}
            >
              <span className="thread-item-name">{t.name}</span>
              <span className="thread-item-meta">{t.commitCount} cued</span>
            </button>
          ))}
          <div className="thread-menu-actions">
            <button
              type="button"
              className="thread-action"
              onClick={() => {
                setOpen(false);
                onCreate();
              }}
            >
              + New thread
            </button>
            {active && (
              <button
                type="button"
                className="thread-action"
                onClick={() => {
                  setOpen(false);
                  onEdit();
                }}
              >
                Edit current
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
