import { useEffect, useRef } from 'react';

export type LogEntry = {
  id: number;
  kind: 'sent' | 'cue' | 'null' | 'error';
  at: number;
  text: string;
  meta?: string;
};

type Props = { entries: LogEntry[] };

export function OrchestratorLog({ entries }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (entries.length === 0) return;
    requestAnimationFrame(() => {
      const el = bodyRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [entries.length]);

  return (
    <div className="pane log-pane">
      <div className="pane-header">
        <div className="pane-title">Orchestrator</div>
        <span className="brand-sub">{entries.length} events</span>
      </div>

      <div className="pane-body" ref={bodyRef}>
        {entries.length === 0 ? (
          <div className="pane-empty">Waiting for the first complete utterance to evaluate…</div>
        ) : (
          entries.map((e) => <Row key={`${e.id}-${e.kind}`} entry={e} />)
        )}
      </div>
    </div>
  );
}

function Row({ entry }: { entry: LogEntry }) {
  const colorClass =
    entry.kind === 'cue'
      ? 'color-good'
      : entry.kind === 'error'
        ? 'color-error'
        : entry.kind === 'sent'
          ? 'color-accent'
          : 'color-muted';
  const glyph =
    entry.kind === 'sent' ? '→' : entry.kind === 'cue' ? '✓' : entry.kind === 'null' ? '·' : '✗';
  return (
    <div className="log-row">
      <span className="timestamp">{formatTime(entry.at)}</span>
      <span className={`log-glyph ${colorClass}`}>{glyph}</span>
      <div className="chunk-body">
        <div className={`log-text ${colorClass}`}>{entry.text}</div>
        {entry.meta && <div className="log-meta">{entry.meta}</div>}
      </div>
    </div>
  );
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toTimeString().slice(0, 8);
}
