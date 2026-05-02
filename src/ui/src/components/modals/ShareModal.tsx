import { useEffect, useState } from "react";
import { useAppStore } from "../../stores/useAppStore";
import {
  listShares,
  startShare,
  stopShare,
  type ShareSummary,
} from "../../services/tauri";
import { Modal } from "./Modal";
import shared from "./shared.module.css";

/**
 * Share modal — the canonical entry point for any kind of network sharing
 * from this machine.
 *
 * Each share is a **workspace-scoped authorization grant**: it has its own
 * pairing token, a list of workspace ids it permits access to, and a mode
 * (1:1 remote control or collaborative). Multiple shares can be active at
 * once — useful when the user wants to share work workspaces with one
 * group and OSS workspaces with another, for example.
 *
 * The modal has two views:
 * - **Active shares list** — see what's currently shared, copy a
 *   connection string, or revoke.
 * - **New share form** — pick the workspaces, choose 1:1 or collab, name
 *   the share, mint a pairing token.
 */
export function ShareModal() {
  const closeModal = useAppStore((s) => s.closeModal);
  const workspaces = useAppStore((s) => s.workspaces);
  const repositories = useAppStore((s) => s.repositories);
  const collabDefaultConsensus = useAppStore(
    (s) => s.collabDefaultConsensusRequired,
  );

  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [view, setView] = useState<"list" | "new">("list");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // New-share form state.
  const [label, setLabel] = useState("");
  const [pickedWorkspaceIds, setPickedWorkspaceIds] = useState<Set<string>>(
    new Set(),
  );
  const [collaborative, setCollaborative] = useState(false);
  const [consensusRequired, setConsensusRequired] = useState(
    collabDefaultConsensus,
  );

  // Refresh the active shares list whenever the modal opens or after
  // start/stop. The Rust side is authoritative — we never hold state
  // optimistically that disagrees with the server.
  const refresh = async () => {
    try {
      const next = await listShares();
      setShares(next);
    } catch (e) {
      // listShares fails harmlessly when the server feature is off.
      console.error("listShares:", e);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  // Filter to local workspaces only — shares are minted on the host, so a
  // remote workspace shouldn't appear here (it isn't on this machine).
  const localWorkspaces = workspaces.filter((w) => !w.remote_connection_id);
  // Group workspaces by repository for nicer presentation in the picker.
  const reposById = new Map(repositories.map((r) => [r.id, r]));

  const togglePick = (workspaceId: string) => {
    setPickedWorkspaceIds((prev) => {
      const next = new Set(prev);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  };

  const handleStart = async () => {
    if (pickedWorkspaceIds.size === 0) {
      setError("Pick at least one workspace to share.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await startShare({
        label: label.trim() || null,
        workspaceIds: Array.from(pickedWorkspaceIds),
        collaborative,
        consensusRequired: collaborative && consensusRequired,
      });
      // Reset the form, switch back to list, and pull fresh state.
      setLabel("");
      setPickedWorkspaceIds(new Set());
      setCollaborative(false);
      setConsensusRequired(collabDefaultConsensus);
      setView("list");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async (shareId: string) => {
    setError(null);
    setBusy(true);
    try {
      await stopShare(shareId);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = (s: string) => navigator.clipboard.writeText(s);

  return (
    <Modal title="Share this machine" onClose={closeModal}>
      {view === "list" ? (
        <>
          <div className={shared.smallHint} style={{ marginBottom: 12 }}>
            Each share grants access to a specific set of workspaces.
            Stopping a share immediately revokes its connection string and
            all sessions paired through it.
          </div>

          {shares.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: 24,
                color: "var(--text-dim)",
                fontSize: 13,
              }}
            >
              No active shares.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {shares.map((sh) => (
                <ShareRow
                  key={sh.id}
                  share={sh}
                  workspaces={workspaces}
                  onStop={() => handleStop(sh.id)}
                  onCopy={copy}
                  busy={busy}
                />
              ))}
            </div>
          )}

          {error && <div className={shared.error}>{error}</div>}

          <div className={shared.actions}>
            <button
              className={shared.btnPrimary}
              onClick={() => setView("new")}
            >
              New share
            </button>
            <button className={shared.btn} onClick={closeModal}>
              Done
            </button>
          </div>
        </>
      ) : (
        <>
          <div className={shared.smallHint} style={{ marginBottom: 12 }}>
            Pick which workspaces this share grants access to. The recipient
            will only ever see what you select here.
          </div>

          <div className={shared.field}>
            <label className={shared.label}>Name (optional)</label>
            <input
              className={shared.input}
              type="text"
              placeholder="e.g. Work team"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>

          <div className={shared.field}>
            <label className={shared.label}>Workspaces</label>
            <div
              style={{
                maxHeight: 220,
                overflowY: "auto",
                border: "1px solid var(--divider)",
                borderRadius: 6,
                padding: 4,
              }}
            >
              {localWorkspaces.length === 0 ? (
                <div
                  style={{
                    padding: 12,
                    color: "var(--text-dim)",
                    fontSize: 12,
                  }}
                >
                  No local workspaces.
                </div>
              ) : (
                localWorkspaces.map((ws) => {
                  const repo = reposById.get(ws.repository_id);
                  return (
                    <label
                      key={ws.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "4px 8px",
                        cursor: "pointer",
                        fontSize: 13,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={pickedWorkspaceIds.has(ws.id)}
                        onChange={() => togglePick(ws.id)}
                      />
                      <span>
                        {repo && (
                          <span style={{ color: "var(--text-dim)" }}>
                            {repo.name} /{" "}
                          </span>
                        )}
                        <span>{ws.name}</span>
                      </span>
                    </label>
                  );
                })
              )}
            </div>
          </div>

          <div className={shared.field}>
            <label className={shared.checkboxRow}>
              <input
                type="checkbox"
                checked={collaborative}
                onChange={(e) => setCollaborative(e.target.checked)}
              />
              <span>Collaborative — multiple users can prompt the agent</span>
            </label>
            {collaborative && (
              <label
                className={shared.checkboxRow}
                style={{ marginLeft: 24, marginTop: 4 }}
              >
                <input
                  type="checkbox"
                  checked={consensusRequired}
                  onChange={(e) => setConsensusRequired(e.target.checked)}
                />
                <span>Require unanimous plan approval</span>
              </label>
            )}
          </div>

          {error && <div className={shared.error}>{error}</div>}

          <div className={shared.actions}>
            <button
              className={shared.btn}
              onClick={() => {
                setView("list");
                setError(null);
              }}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              className={shared.btnPrimary}
              onClick={handleStart}
              disabled={busy || pickedWorkspaceIds.size === 0}
            >
              Mint share
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function ShareRow({
  share,
  workspaces,
  onStop,
  onCopy,
  busy,
}: {
  share: ShareSummary;
  workspaces: { id: string; name: string }[];
  onStop: () => void;
  onCopy: (s: string) => void;
  busy: boolean;
}) {
  const wsNames = share.allowed_workspace_ids
    .map((id) => workspaces.find((w) => w.id === id)?.name ?? id)
    .join(", ");
  return (
    <div
      style={{
        border: "1px solid var(--divider)",
        borderRadius: 6,
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong style={{ fontSize: 13 }}>
          {share.label ?? "Untitled share"}
        </strong>
        <span
          style={{
            fontSize: 11,
            padding: "1px 6px",
            borderRadius: 8,
            background: "var(--selected-bg)",
            color: "var(--text-dim)",
          }}
        >
          {share.collaborative ? "collaborative" : "1:1 remote control"}
        </span>
        {share.collaborative && share.consensus_required && (
          <span
            style={{
              fontSize: 11,
              padding: "1px 6px",
              borderRadius: 8,
              background: "var(--selected-bg)",
              color: "var(--text-dim)",
            }}
          >
            consensus
          </span>
        )}
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
          {share.session_count} connected
        </span>
      </div>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
        Workspaces: {wsNames}
      </div>
      <div className={shared.inputRow}>
        <input
          className={shared.input}
          value={share.connection_string}
          readOnly
          onClick={(e) => (e.target as HTMLInputElement).select()}
        />
        <button className={shared.btn} onClick={() => onCopy(share.connection_string)}>
          Copy
        </button>
        <button className={shared.btnDanger} onClick={onStop} disabled={busy}>
          Stop
        </button>
      </div>
    </div>
  );
}
