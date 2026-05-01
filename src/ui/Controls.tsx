import type { ReactNode } from 'react';

type Props = {
  active: boolean;
  geminiConfigured: boolean;
  pendingCues: number;
  onToggle: () => void;
  threadBar?: ReactNode;
};

export function Controls({
  active,
  geminiConfigured,
  pendingCues,
  onToggle,
  threadBar,
}: Props) {
  return (
    <div className="controls">
      <div className="brand-block">
        <div className="brand-text">LifeBot</div>
        {threadBar}
      </div>

      <div className="center-status">
        {!geminiConfigured && (
          <div className="status-warn">⚠ VITE_GEMINI_API_KEY not set — cues disabled</div>
        )}
        {pendingCues > 0 && (
          <div className="status-pending">
            {pendingCues} request{pendingCues === 1 ? '' : 's'} in flight…
          </div>
        )}
      </div>

      <div className="btn-row">
        <button
          type="button"
          className={`btn ${active ? 'btn-active' : ''}`}
          onClick={onToggle}
        >
          {active ? 'Stop Listening' : 'Start Listening'}
        </button>
      </div>
    </div>
  );
}
