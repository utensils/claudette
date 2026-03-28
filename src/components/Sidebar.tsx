interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  return (
    <aside className={`sidebar${collapsed ? " collapsed" : ""}`}>
      <div className="sidebar-header">
        <h1>Claudette</h1>
        <button
          className="btn-icon"
          onClick={onToggle}
          title="Toggle sidebar (Ctrl+B)"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="2" y="2" width="12" height="12" rx="2" />
            <line x1="6" y1="2" x2="6" y2="14" />
          </svg>
        </button>
      </div>

      <div className="sidebar-content">
        <div className="sidebar-section-label">Workspaces</div>
        <div className="sidebar-empty">
          No workspaces yet.
          <br />
          Add a repository to get started.
        </div>
      </div>

      <div className="sidebar-footer">
        <button className="btn btn-primary" style={{ width: "100%" }}>
          + New Workspace
        </button>
      </div>
    </aside>
  );
}
