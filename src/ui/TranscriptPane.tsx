import { useRef } from 'react';

import { useStickyScrollBottom } from '../util/useStickyScrollBottom';

export type TranscriptChunk = {
  id: number;
  text: string;
  finalizedAt: number;
  /** True once the orchestrator committed this turn (cue arrived or soft-commit). */
  committed?: boolean;
};

type Props = {
  chunks: TranscriptChunk[];
  active: boolean;
  vadActive: boolean;
};

export function TranscriptPane({ chunks, active, vadActive }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // Stick to bottom while the user hasn't scrolled away. Trigger on
  // chunks.length (new turn) and the latest text mutation (a "live" chunk
  // refining its text as more audio arrives within the same window).
  const latestText = chunks[chunks.length - 1]?.text ?? '';
  useStickyScrollBottom(bodyRef, `${chunks.length}|${latestText.length}`);

  return (
    <div className="pane">
      <div className="pane-header">
        <div className="pane-title">Transcript</div>
        <div className="status-row">
          <span className={`pill ${active ? 'pill-good' : 'pill-muted'}`}>
            {active ? 'LISTENING' : 'OFF'}
          </span>
          <span className={`pill ${vadActive ? 'pill-accent' : 'pill-muted'}`}>
            {vadActive ? 'VOICE' : 'silence'}
          </span>
        </div>
      </div>

      <div className="pane-body" ref={bodyRef}>
        {chunks.length === 0 ? (
          <div className="pane-empty">
            {active
              ? 'Listening for speech…'
              : 'Tap “Start Listening” to begin transcribing the room.'}
          </div>
        ) : (
          chunks.map((c) => (
            <div className="chunk-row" key={c.id}>
              <div className="timestamp">{formatTime(c.finalizedAt)}</div>
              <div className="chunk-body">
                <div className={`chunk-text ${c.committed ? '' : 'chunk-pending'}`}>{c.text}</div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toTimeString().slice(0, 8);
}
