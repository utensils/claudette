import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("modals");
  const closeModal = useAppStore((s) => s.closeModal);
  const workspaces = useAppStore((s) => s.workspaces);
  const repositories = useAppStore((s) => s.repositories);
  const collabDefaultConsensus = useAppStore(
    (s) => s.collabDefaultConsensusRequired,
  );
  // Mirror the active-shares count into the store so ShareButton (and
  // any other consumer) can show "active vs idle" styling that reflects
  // the real workspace-scoped share state, not the legacy
  // `localServerRunning` flag.
  const setActiveSharesCount = useAppStore((s) => s.setActiveSharesCount);

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
      setActiveSharesCount(next.length);
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
      setError(t("share_form_validation_pick_workspace"));
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

  const copy = async (s: string) => {
    try {
      await navigator.clipboard.writeText(s);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Modal title={t("share_title")} onClose={closeModal}>
      {view === "list" ? (
        <>
          <div className={shared.smallHint} style={{ marginBottom: 12 }}>
            {t("share_list_hint")}
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
              {t("share_no_active")}
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
              {t("share_button_new")}
            </button>
            <button className={shared.btn} onClick={closeModal}>
              {t("share_button_done")}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className={shared.smallHint} style={{ marginBottom: 12 }}>
            {t("share_form_hint")}
          </div>

          <div className={shared.field}>
            <label className={shared.label}>{t("share_form_name_label")}</label>
            <input
              className={shared.input}
              type="text"
              placeholder={t("share_form_name_placeholder")}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>

          <div className={shared.field}>
            <label className={shared.label}>{t("share_form_workspaces_label")}</label>
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
                  {t("share_form_no_local_workspaces")}
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
              <span>{t("share_form_collaborative")}</span>
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
                <span>{t("share_form_consensus")}</span>
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
              {t("share_form_button_cancel")}
            </button>
            <button
              className={shared.btnPrimary}
              onClick={handleStart}
              disabled={busy || pickedWorkspaceIds.size === 0}
            >
              {t("share_form_button_mint")}
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
  onCopy: (s: string) => void | Promise<void>;
  busy: boolean;
}) {
  const { t } = useTranslation("modals");
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
          {share.label ?? t("share_row_untitled")}
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
          {share.collaborative
            ? t("share_row_mode_collaborative")
            : t("share_row_mode_one_to_one")}
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
            {t("share_row_consensus_badge")}
          </span>
        )}
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
          {t("share_row_connected_count", { count: share.session_count })}
        </span>
      </div>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
        {t("share_row_workspaces_label", { names: wsNames })}
      </div>
      <div className={shared.inputRow}>
        <input
          className={shared.input}
          value={share.connection_string}
          readOnly
          onClick={(e) => (e.target as HTMLInputElement).select()}
        />
        <button className={shared.btn} onClick={() => onCopy(share.connection_string)}>
          {t("share_row_button_copy")}
        </button>
        <button className={shared.btnDanger} onClick={onStop} disabled={busy}>
          {t("share_row_button_stop")}
        </button>
      </div>
    </div>
  );
}
