export type Cue = {
  id: number;
  text: string;
  createdAt: number;
  source: string;
};

type Props = {
  cues: Cue[];
  onDismiss: (id: number) => void;
  onClear: () => void;
};

export function CuePane({ cues, onDismiss, onClear }: Props) {
  return (
    <div className="pane">
      <div className="pane-header">
        <div className="pane-title">Cues</div>
        <button type="button" className="cue-dismiss" onClick={onClear}>
          clear
        </button>
      </div>

      <div className="pane-body">
        {cues.length === 0 ? (
          <div className="pane-empty">
            No cues yet. The orchestrator will surface helpful context as the conversation
            unfolds.
          </div>
        ) : (
          cues.map((c) => (
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
