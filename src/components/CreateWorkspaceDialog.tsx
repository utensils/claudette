import { useState } from "react";
import { useApp } from "../contexts/AppContext";
import { generateWorkspaceName } from "../utils/nameGenerator";

interface Props {
  onClose: () => void;
}

function toBranchName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function CreateWorkspaceDialog({ onClose }: Props) {
  const { repositories, createWorkspace } = useApp();
  const [repoId, setRepoId] = useState(repositories[0]?.id ?? "");
  const [name, setName] = useState(generateWorkspaceName);
  const [branch, setBranch] = useState(() => toBranchName(name));
  const [branchEdited, setBranchEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const selectedRepo = repositories.find((r) => r.id === repoId);

  function handleNameChange(value: string) {
    setName(value);
    if (!branchEdited) {
      setBranch(toBranchName(value));
    }
  }

  function handleRegenerate() {
    const newName = generateWorkspaceName();
    setName(newName);
    if (!branchEdited) {
      setBranch(toBranchName(newName));
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!repoId || !name.trim() || !branch.trim()) return;

    setLoading(true);
    setError(null);
    try {
      await createWorkspace({
        repository_id: repoId,
        name: name.trim(),
        branch: branch.trim(),
        base_branch: selectedRepo?.default_branch,
      });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>New Workspace</h2>
          <button className="btn-icon" onClick={onClose}>
            &times;
          </button>
        </div>
        <form className="modal-body" onSubmit={handleCreate}>
          <label className="form-label">
            Repository
            <select
              className="form-input"
              value={repoId}
              onChange={(e) => setRepoId(e.target.value)}
            >
              {repositories.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>

          <label className="form-label">
            Workspace Name
            <div className="form-input-with-action">
              <input
                className="form-input"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="wild-clover-hopping"
                autoFocus
              />
              <button
                type="button"
                className="btn-icon"
                onClick={handleRegenerate}
                title="Generate new name"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M2 8a6 6 0 0 1 10.3-4.2" />
                  <path d="M14 8a6 6 0 0 1-10.3 4.2" />
                  <polyline points="12 2 12.5 4.5 10 5" />
                  <polyline points="4 11 3.5 13.5 6 13" />
                </svg>
              </button>
            </div>
          </label>

          <label className="form-label">
            Branch Name
            <input
              className="form-input"
              value={branch}
              onChange={(e) => {
                setBranch(e.target.value);
                setBranchEdited(true);
              }}
              placeholder="fix-auth-bug"
            />
            <span className="form-hint">
              Will be prefixed with <code>claudette/</code>
            </span>
          </label>

          {error && <div className="modal-error">{error}</div>}

          <button
            className="btn btn-primary"
            type="submit"
            disabled={loading || !name.trim() || !branch.trim()}
            style={{ width: "100%" }}
          >
            {loading ? "Creating..." : "Create Workspace"}
          </button>
        </form>
      </div>
    </div>
  );
}
