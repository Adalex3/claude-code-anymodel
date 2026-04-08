interface Props {
  isExpanded:     boolean;
  onToggleExpand: () => void;
  onClose:        () => void;
}

export default function Header({ isExpanded, onToggleExpand, onClose }: Props): JSX.Element {
  return (
    <header className="header">
      <div className="header-brand">
        <span className="header-gem">◆</span>
        <span className="header-title">Claude Code</span>
      </div>
      <div className="header-actions">
        <button
          className="btn-icon"
          onClick={onToggleExpand}
          title={isExpanded ? 'Collapse window' : 'Expand window'}
        >
          {isExpanded ? '⊟' : '⊞'}
        </button>
        <button
          className="btn-icon btn-close"
          onClick={onClose}
          title="Hide (stays in menu bar)"
        >
          ×
        </button>
      </div>
    </header>
  );
}
