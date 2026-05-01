type Props =
  | {
      kind: 'match';
      threadName: string;
      onAccept: () => void;
      onDismiss: () => void;
    }
  | {
      kind: 'new';
      suggestedName?: string;
      onCreate: (name: string) => void;
      onDismiss: () => void;
    };

export function ClassifierBanner(props: Props) {
  if (props.kind === 'match') {
    return (
      <div className="classifier-banner">
        <span className="classifier-icon">🎯</span>
        <span className="classifier-text">
          This sounds like <strong>{props.threadName}</strong>
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="classifier-accept" onClick={props.onAccept}>
          Switch
        </button>
        <button type="button" className="classifier-dismiss" onClick={props.onDismiss}>
          ×
        </button>
      </div>
    );
  }
  return (
    <div className="classifier-banner classifier-banner-new">
      <span className="classifier-icon">✨</span>
      <span className="classifier-text">
        New topic detected{props.suggestedName ? ` — "${props.suggestedName}"` : ''}
      </span>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        className="classifier-accept"
        onClick={() => props.onCreate(props.suggestedName ?? '')}
      >
        Create thread
      </button>
      <button type="button" className="classifier-dismiss" onClick={props.onDismiss}>
        ×
      </button>
    </div>
  );
}
