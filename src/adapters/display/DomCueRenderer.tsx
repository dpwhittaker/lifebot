import { useMemo, useRef } from 'react';

import { useStickyScrollBottom } from '../../util/useStickyScrollBottom';

export type Cue = {
  id: number;
  text: string;
  /**
   * Glanceable HUD form (≤80 chars). Shown beneath the full cue with a "G2"
   * tag during Phase 2-prep so we can A/B against the long form in real
   * sessions. Null when the model couldn't produce a useful short version.
   */
  short: string | null;
  createdAt: number;
  source: string;
};

type Props = {
  cues: Cue[];
  onDismiss: (id: number) => void;
  onClear: () => void;
};

export function DomCueRenderer({ cues, onDismiss, onClear }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  // App.tsx stores cues newest-first (prepend on commit). For chronological
  // top-to-bottom display we render in reverse — the original ordering stays
  // unchanged so other consumers (HUD, persistence) still see "newest first".
  const ordered = useMemo(() => cues.slice().reverse(), [cues]);
  useStickyScrollBottom(bodyRef, ordered.length);

  return (
    <div className="pane">
      <div className="pane-header">
        <div className="pane-title">Cues</div>
        <button type="button" className="cue-dismiss" onClick={onClear}>
          clear
        </button>
      </div>

      <div className="pane-body" ref={bodyRef}>
        {ordered.length === 0 ? (
          <div className="pane-empty">
            No cues yet. The orchestrator will surface helpful context as the conversation
            unfolds.
          </div>
        ) : (
          ordered.map((c) => (
            <div className="cue-card" key={c.id}>
              <div className="cue-head">
                <span className="cue-time">{formatTime(c.createdAt)}</span>
                <button
                  type="button"
                  className="cue-dismiss"
                  onClick={() => onDismiss(c.id)}
                >
                  dismiss
                </button>
              </div>
              <div className="cue-body">{c.text}</div>
              {c.short ? (
                <div className="cue-short">
                  <span className="cue-short-tag">G2</span>
                  <span>{c.short}</span>
                  <span className="cue-short-len">{c.short.length}c</span>
                </div>
              ) : (
                <div className="cue-short cue-short-empty">
                  <span className="cue-short-tag">G2</span>
                  <span>— no short form available</span>
                </div>
              )}
              <div className="cue-source">↳ {c.source}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toTimeString().slice(0, 5);
}
