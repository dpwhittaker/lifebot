import { useMemo, useState } from 'react';
import type { Thread, ThreadSummary } from '../threads/types';
import { activeUntil } from '../threads/schedule';

type Props = {
  active: Thread | null;
  threads: ThreadSummary[];
  /** thread id of any auto-active scheduled thread, or null */
  scheduledActiveId: string | null;
  /** "until HH:MM" string for the active scheduled thread, if any */
  scheduledActiveUntil: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onEdit: () => void;
};

const RECENT_COUNT = 4;

export function ThreadBar({
  active,
  threads,
  scheduledActiveId,
  scheduledActiveUntil,
  onSelect,
  onCreate,
  onEdit,
}: Props) {
  const [open, setOpen] = useState(false);

  const { recent, byGroup } = useMemo(() => {
    const sorted = threads.slice().sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    const recent = sorted.slice(0, RECENT_COUNT);
    const groups: Record<string, ThreadSummary[]> = {};
    for (const t of threads) {
      const g = (t.group && t.group.trim()) || 'Other';
      (groups[g] ??= []).push(t);
    }
    // Sort groups alphabetically; threads within each group alphabetically.
    const byGroup = Object.entries(groups)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([g, ts]) => [g, ts.slice().sort((a, b) => a.name.localeCompare(b.name))] as const);
    return { recent, byGroup };
  }, [threads]);

  const activeBadge =
    scheduledActiveId === active?.id && scheduledActiveUntil
      ? ` · until ${scheduledActiveUntil}`
      : '';

  return (
    <div className="thread-bar">
      <button
        type="button"
        className="thread-pill"
        onClick={() => setOpen((v) => !v)}
        title="Switch thread"
      >
        {scheduledActiveId === active?.id && <span className="thread-active-dot" />}
        <span className="thread-name">{active?.name ?? '— no thread —'}</span>
        {activeBadge && <span className="thread-active-until">{activeBadge}</span>}
        <span className="thread-caret">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="thread-menu" role="menu">
          {threads.length === 0 && (
            <div className="thread-empty">No threads yet — create your first one.</div>
          )}

          {scheduledActiveId && (
            <ThreadGroupHeading label="🟢 Active by schedule" />
          )}
          {scheduledActiveId &&
            (() => {
              const t = threads.find((x) => x.id === scheduledActiveId);
              if (!t) return null;
              return (
                <ThreadItem
                  thread={t}
                  active={active?.id === t.id}
                  onSelect={() => {
                    setOpen(false);
                    onSelect(t.id);
                  }}
                />
              );
            })()}

          {recent.length > 0 && (
            <>
              <ThreadGroupHeading label="⭐ Recently used" />
              {recent.map((t) => (
                <ThreadItem
                  key={`r-${t.id}`}
                  thread={t}
                  active={active?.id === t.id}
                  onSelect={() => {
                    setOpen(false);
                    onSelect(t.id);
                  }}
                />
              ))}
            </>
          )}

          {byGroup.map(([g, ts]) => (
            <div key={g}>
              <ThreadGroupHeading label={g} />
              {ts.map((t) => (
                <ThreadItem
                  key={`g-${t.id}`}
                  thread={t}
                  active={active?.id === t.id}
                  onSelect={() => {
                    setOpen(false);
                    onSelect(t.id);
                  }}
                />
              ))}
            </div>
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

function ThreadGroupHeading({ label }: { label: string }) {
  return <div className="thread-group-heading">{label}</div>;
}

function ThreadItem({
  thread,
  active,
  onSelect,
}: {
  thread: ThreadSummary;
  active: boolean;
  onSelect: () => void;
}) {
  const sched = thread.schedule?.find((e) => activeUntil(e));
  return (
    <button
      type="button"
      className={`thread-item ${active ? 'thread-item-active' : ''}`}
      onClick={onSelect}
    >
      <span className="thread-item-name">
        {sched && <span className="thread-active-dot" />}
        {thread.name}
      </span>
      <span className="thread-item-meta">
        {thread.commitCount} cued
      </span>
    </button>
  );
}
