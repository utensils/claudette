export function MainContent() {
  return (
    <div className="main-area">
      <header className="main-header">
        <span className="main-header-title">No workspace selected</span>
      </header>

      <div className="main-content">
        <div className="empty-state">
          <div className="empty-state-title">Welcome to Claudette</div>
          <div className="empty-state-hint">
            Create a workspace to start an agent &middot;{" "}
            <kbd>Ctrl+Shift+N</kbd>
          </div>
        </div>
      </div>
    </div>
  );
}
