type Props = {
  active: boolean;
  geminiConfigured: boolean;
  pendingCues: number;
  onToggle: () => void;
};

export function Controls({ active, geminiConfigured, pendingCues, onToggle }: Props) {
  return (
    <div className="controls">
      <div>
        <div className="brand-text">LifeBot</div>
        <div className="brand-sub">passive session monitor</div>
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
