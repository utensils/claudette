import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Copy, ExternalLink, Globe, LoaderCircle, Power, Radio, Zap } from "lucide-react";
import { useAppStore } from "../../../stores/useAppStore";
import {
  getClaudeRemoteControlStatus,
  openUrl,
  resetAgentSession,
  setAppSetting,
  setClaudeRemoteControl,
  type ClaudeRemoteControlStatus,
} from "../../../services/tauri";
import { shouldDisable1mContext } from "../chatHelpers";
import { isFastSupported } from "../modelCapabilities";
import { useSelectedModelEntry } from "../useSelectedModelEntry";
import styles from "./OverflowMenu.module.css";

interface OverflowMenuProps {
  sessionId: string;
  /** Blocks all menu interaction (trigger + every row). Set while the
   *  workspace environment is preparing. */
  disabled: boolean;
  /** True while a turn is in flight. Session-mutating rows (Fast Mode,
   *  Claude in Chrome) stay disabled. Remote Control deliberately stays
   *  clickable so the user can queue a mid-turn enable. */
  isRunning: boolean;
  isRemote: boolean;
}

const DISABLED_REMOTE_STATUS: ClaudeRemoteControlStatus = {
  state: "disabled",
  sessionUrl: null,
  connectUrl: null,
  environmentId: null,
  detail: null,
  lastError: null,
};

export function OverflowMenu({ sessionId, disabled, isRunning, isRemote }: OverflowMenuProps) {
  // Rows that would tear down or reconfigure the live persistent session
  // (Fast Mode is per-session; Claude in Chrome calls `resetAgentSession`)
  // stay locked mid-turn. Remote Control opts out: its row remains
  // clickable, and the click queues a pending enable instead of firing
  // immediately. The pending state + deferred-fire effect live up here
  // (not inside `RemoteControlMenuItem`) so they survive the dropdown
  // unmount that fires whenever the menu closes — clicking outside the
  // menu would otherwise discard the queued intent before the turn ends.
  const mutationDisabled = disabled || isRunning;
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const addToast = useAppStore((s) => s.addToast);

  const selectedModel = useAppStore((s) => s.selectedModel[sessionId] ?? "opus");
  const selectedProvider = useAppStore((s) => s.selectedModelProvider[sessionId] ?? "anthropic");
  const permissionLevel = useAppStore((s) => s.permissionLevel[sessionId] ?? "full");
  const fastMode = useAppStore((s) => s.fastMode[sessionId] ?? false);
  const thinkingEnabled = useAppStore((s) => s.thinkingEnabled[sessionId] ?? false);
  const planMode = useAppStore((s) => s.planMode[sessionId] ?? false);
  const effortLevel = useAppStore((s) => s.effortLevel[sessionId] ?? "auto");
  const chromeEnabled = useAppStore((s) => s.chromeEnabled[sessionId] ?? false);
  const setFastMode = useAppStore((s) => s.setFastMode);
  const setChromeEnabled = useAppStore((s) => s.setChromeEnabled);
  const clearAgentQuestion = useAppStore((s) => s.clearAgentQuestion);
  const clearPlanApproval = useAppStore((s) => s.clearPlanApproval);
  const clearAgentApproval = useAppStore((s) => s.clearAgentApproval);

  const currentModel = useSelectedModelEntry(sessionId);
  const showFast = currentModel?.supportsFastMode ?? isFastSupported(selectedModel);
  const [remoteControlStatus, setRemoteControlStatus] =
    useState<ClaudeRemoteControlStatus>(DISABLED_REMOTE_STATUS);
  const showRemoteControl = !isRemote;
  const remoteControlActive = showRemoteControl && remoteControlStatus.state !== "disabled";
  const anyActive = fastMode || chromeEnabled || remoteControlActive;

  // Frontend-only "queued enable" intent. Stored as the sessionId the
  // pending belongs to (or null) — not a plain boolean — so a sessionId
  // prop change in the same render pass cannot accidentally fire the
  // deferred enable against the new session before the cleanup effect
  // wipes the flag. Kept local rather than in the backend
  // `ClaudeRemoteControlStatus` so the existing lifecycle enum, the
  // persistent-session monitor, and the `claude-remote-control-status`
  // event flow remain untouched. Trade-off: a window reload mid-turn or
  // an unmount of `ChatInputArea` (file/diff open) drops the queued
  // intent — acceptable corner cases; promoting to the store would
  // cover them.
  const [pendingEnableForSession, setPendingEnableForSession] = useState<
    string | null
  >(null);
  const pendingEnable = pendingEnableForSession === sessionId;

  // Hygiene: when the user switches chats, wipe any stale queued intent
  // belonging to the previous session.
  useEffect(() => {
    setPendingEnableForSession((prev) => (prev === sessionId ? prev : null));
  }, [sessionId]);

  // Also wipe the queued intent when Remote Control becomes unavailable
  // (the experimental gate flipped off, or this is a remote transport
  // where Remote Control isn't supported). Without this, a pending
  // intent queued before the gate was turned off would silently fire
  // the enable RPC on the next turn end, even though the row is hidden.
  useEffect(() => {
    if (showRemoteControl) return;
    setPendingEnableForSession(null);
  }, [showRemoteControl]);

  // `runImmediate` is the actual enable/disable RPC body. Hoisted out of
  // `RemoteControlMenuItem` so the deferred-fire effect below can reuse
  // it even when the dropdown (and thus the row component) is unmounted.
  // Status writes use the functional setter so we don't stale-close over
  // an old `remoteControlStatus` value.
  const runImmediate = useCallback(
    async (nextEnabled: boolean) => {
      if (nextEnabled) {
        setRemoteControlStatus((prev) => ({
          ...prev,
          state: "enabling",
          lastError: null,
        }));
      }
      try {
        const next = await setClaudeRemoteControl(sessionId, nextEnabled, {
          permissionLevel,
          model: selectedModel,
          backendId: selectedProvider,
          fastMode,
          thinkingEnabled,
          planMode,
          effort: effortLevel,
          chromeEnabled,
          disable1mContext: shouldDisable1mContext(selectedModel),
        });
        setRemoteControlStatus(next);
      } catch (err) {
        const message = formatRemoteControlError(err);
        setRemoteControlStatus({
          state: "error",
          sessionUrl: null,
          connectUrl: null,
          environmentId: null,
          detail: null,
          lastError: message,
        });
      }
    },
    [
      chromeEnabled,
      effortLevel,
      fastMode,
      permissionLevel,
      planMode,
      selectedModel,
      selectedProvider,
      sessionId,
      thinkingEnabled,
    ],
  );

  // Deferred-fire effect: the moment the turn ends (`isRunning` flips
  // from true → false) and a pending enable is queued *for this exact
  // sessionId*, fire the real enable. Piggybacks on the `agent_status`
  // transition that `useAgentStream.ts` already pushes into the store
  // on every turn result — no new Tauri event, no backend hook. Also
  // fires for the "Stopped" path (user-cancelled turn), since
  // "stopped" still means the persistent session is no longer
  // mid-flight.
  //
  // Lives in `OverflowMenu` (not `RemoteControlMenuItem`) because the
  // dropdown subtree unmounts whenever the menu closes; if this effect
  // lived there, a click-outside would discard the pending intent
  // before the turn ended.
  //
  // No-op-message safety net: the backend's cold-enable defer
  // (`should_defer_enable_until_first_turn` in `remote_control.rs`)
  // can return `state: "enabling"` with detail "Send your first
  // message to start Claude Remote Control." when called on a chat
  // with `turn_count == 0`. The mid-turn-pending path here cannot
  // reach that branch — queuing the pending intent requires
  // `isRunning === true`, which in turn requires a turn to be
  // running, which requires `turn_count >= 1` and a live persistent
  // session.
  useEffect(() => {
    if (pendingEnableForSession !== sessionId) return;
    if (isRunning) return;
    // Don't fire if Remote Control is no longer available (experimental
    // gate off, remote transport) or while the workspace environment is
    // still preparing. The session-switch / showRemoteControl cleanup
    // effects already clear the intent in those cases; this is the
    // belt-and-suspenders check at the fire site.
    if (!showRemoteControl) return;
    if (disabled) return;
    setPendingEnableForSession(null);
    void runImmediate(true);
  }, [
    disabled,
    isRunning,
    pendingEnableForSession,
    runImmediate,
    sessionId,
    showRemoteControl,
  ]);

  const queuePendingEnable = useCallback(() => {
    setPendingEnableForSession(sessionId);
    addToast("Remote Control will enable when the current turn finishes.");
  }, [addToast, sessionId]);

  const cancelPendingEnable = useCallback(() => {
    setPendingEnableForSession(null);
    addToast("Remote Control enable cancelled.");
  }, [addToast]);

  useEffect(() => {
    if (!showRemoteControl) {
      setRemoteControlStatus(DISABLED_REMOTE_STATUS);
      return;
    }
    let cancelled = false;
    void getClaudeRemoteControlStatus(sessionId)
      .then((status) => {
        if (!cancelled) setRemoteControlStatus(status);
      })
      .catch(() => {
        if (!cancelled) setRemoteControlStatus(DISABLED_REMOTE_STATUS);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, showRemoteControl]);

  useEffect(() => {
    if (!showRemoteControl) return;
    let active = true;
    const unlisten = listen<{
      workspaceId: string;
      chatSessionId: string;
      status: ClaudeRemoteControlStatus;
    }>("claude-remote-control-status", (event) => {
      if (!active || event.payload.chatSessionId !== sessionId) return;
      setRemoteControlStatus(event.payload.status);
    });
    return () => {
      active = false;
      unlisten.then((fn) => fn());
    };
  }, [sessionId, showRemoteControl]);

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const toggleFast = useCallback(async () => {
    const next = !fastMode;
    setFastMode(sessionId, next);
    await setAppSetting(`fast_mode:${sessionId}`, String(next));
  }, [sessionId, fastMode, setFastMode]);

  const toggleChrome = useCallback(async () => {
    const next = !chromeEnabled;
    setChromeEnabled(sessionId, next);
    await setAppSetting(`chrome_enabled:${sessionId}`, String(next));
    await resetAgentSession(sessionId);
    clearAgentQuestion(sessionId);
    clearPlanApproval(sessionId);
    clearAgentApproval(sessionId);
  }, [sessionId, chromeEnabled, setChromeEnabled, clearAgentQuestion, clearPlanApproval, clearAgentApproval]);

  return (
    <div ref={containerRef} className={styles.wrap}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-label="More options"
        aria-expanded={open}
      >
        <span className={styles.dot} />
        <span className={styles.dot} />
        <span className={styles.dot} />
        {anyActive && <span className={styles.badge} />}
      </button>

      {open && (
        <div className={styles.dropdown}>
          {showFast && (
            <MenuItem
              icon={<Zap size={14} />}
              label="Fast mode"
              active={fastMode}
              meta={fastMode ? "on" : "off"}
              onClick={toggleFast}
              disabled={mutationDisabled}
            />
          )}
          <MenuItem
            icon={<Globe size={14} />}
            label="Claude in Chrome"
            active={chromeEnabled}
            meta={chromeEnabled ? "on" : "off"}
            onClick={toggleChrome}
            disabled={mutationDisabled}
          />
          {showRemoteControl && (
            <RemoteControlMenuItem
              disabled={disabled}
              isRunning={isRunning}
              status={remoteControlStatus}
              pendingEnable={pendingEnable}
              onRunImmediate={runImmediate}
              onQueuePending={queuePendingEnable}
              onCancelPending={cancelPendingEnable}
            />
          )}
        </div>
      )}
    </div>
  );
}

function RemoteControlMenuItem({
  disabled,
  isRunning,
  status,
  pendingEnable,
  onRunImmediate,
  onQueuePending,
  onCancelPending,
}: {
  /** True while the workspace environment is preparing — hard-blocks
   *  every interaction (firing OR queuing the toggle). */
  disabled: boolean;
  /** True while a turn is in flight. Enable clicks during this window
   *  queue a pending enable; the deferred-fire effect (owned by the
   *  parent `OverflowMenu`, so it survives dropdown unmount) applies
   *  it the moment the turn ends. */
  isRunning: boolean;
  status: ClaudeRemoteControlStatus;
  pendingEnable: boolean;
  onRunImmediate: (nextEnabled: boolean) => Promise<void> | void;
  onQueuePending: () => void;
  onCancelPending: () => void;
}) {
  const url = remoteControlUrl(status);
  const pendingFirstTurn = isPendingFirstTurnRemoteControl(status);
  const busy = status.state === "enabling" && !pendingFirstTurn;
  const active = status.state !== "disabled" && status.state !== "error";

  // The four branches below decide what each click means:
  //   1. `busy` (real "enabling" state, not the "pending" intent) —
  //      ignore the click. Matches pre-refactor behavior.
  //   2. Re-click while a pending enable is queued — cancel it.
  //   3. Enable while a turn is running — queue the pending intent
  //      via the parent. The deferred-fire effect there applies it
  //      the moment `isRunning` flips false.
  //   4. Idle, or any disable click — fire immediately. Disable
  //      mid-turn is allowed to fire without waiting because tearing
  //      down a bridge doesn't need turn quiescence.
  const toggle = useCallback(() => {
    if (busy) return;
    if (pendingEnable) {
      onCancelPending();
      return;
    }
    if (!active && isRunning) {
      onQueuePending();
      return;
    }
    void onRunImmediate(!active);
  }, [
    active,
    busy,
    isRunning,
    onCancelPending,
    onQueuePending,
    onRunImmediate,
    pendingEnable,
  ]);

  const meta = remoteControlMeta(status, pendingEnable);
  const detail = status.lastError ?? status.detail;
  const displayDetail = remoteControlDisplayDetail(
    status,
    detail,
    url,
    pendingEnable,
  );

  return (
    <div
      className={`${styles.remoteGroup} ${active ? styles.remoteGroupActive : ""} ${status.state === "error" ? styles.remoteGroupError : ""} ${pendingEnable ? styles.remoteGroupPending : ""}`}
    >
      <button
        type="button"
        className={styles.remoteSummary}
        onClick={active ? undefined : toggle}
        disabled={disabled || busy}
        aria-disabled={active}
        title={detail ?? "Claude Remote Control"}
      >
        <span className={styles.itemIcon}>
          {busy ? <LoaderCircle size={14} className={styles.spin} /> : <Radio size={14} />}
        </span>
        <span className={styles.itemText}>
          <span className={styles.itemLabel}>Claude Remote Control</span>
          {displayDetail && <span className={styles.itemDetail}>{displayDetail}</span>}
        </span>
        <span className={styles.itemMeta}>{meta}</span>
      </button>
      {active && (
        <div className={styles.remoteActions}>
          <button
            type="button"
            className={styles.actionButton}
            onClick={() => {
              if (url) void openUrl(url).catch(() => {});
            }}
            disabled={!url}
            title="Open Remote Control"
            aria-label="Open Remote Control"
          >
            <ExternalLink size={13} />
          </button>
          <button
            type="button"
            className={styles.actionButton}
            onClick={() => {
              if (url) void writeText(url).catch(() => {});
            }}
            disabled={!url}
            title="Copy Remote Control link"
            aria-label="Copy Remote Control link"
          >
            <Copy size={13} />
          </button>
          <button
            type="button"
            className={styles.actionButton}
            onClick={toggle}
            disabled={disabled || busy}
            title="Turn off Remote Control"
            aria-label="Turn off Remote Control"
          >
            <Power size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

function remoteControlUrl(status: ClaudeRemoteControlStatus): string | null {
  if (status.connectUrl && !hasEmptyBridgeQuery(status.connectUrl)) return status.connectUrl;
  if (status.sessionUrl && status.sessionUrl.trim()) return status.sessionUrl;
  return null;
}

function hasEmptyBridgeQuery(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      (url.searchParams.has("bridge") && !url.searchParams.get("bridge")) ||
      (url.searchParams.has("environment") && !url.searchParams.get("environment"))
    );
  } catch {
    return false;
  }
}

function remoteControlDisplayDetail(
  status: ClaudeRemoteControlStatus,
  detail: string | null,
  url: string | null,
  pendingEnable: boolean,
): string | null {
  if (pendingEnable) {
    return "Pending — will enable when the current turn finishes.";
  }
  if ((status.state === "ready" || status.state === "connected") && !url) {
    return "Waiting for Claude to publish the session link.";
  }
  if (!detail) return null;
  if (detail === "Session creation failed — see debug log") {
    return "Session creation failed. Refresh Claude login, then retry.";
  }
  return detail;
}

function isPendingFirstTurnRemoteControl(status: ClaudeRemoteControlStatus): boolean {
  return (
    status.state === "enabling" &&
    status.detail === "Send your first message to start Claude Remote Control."
  );
}

function formatRemoteControlError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    for (const key of ["message", "error", "detail"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err || "Claude Remote Control failed");
}

function remoteControlMeta(
  status: ClaudeRemoteControlStatus,
  pendingEnable: boolean,
): string {
  if (pendingEnable) return "pending";
  if (isPendingFirstTurnRemoteControl(status)) return "armed";
  switch (status.state) {
    case "disabled":
      return "off";
    case "enabling":
      return "starting";
    case "ready":
      return "ready";
    case "connected":
      return "live";
    case "reconnecting":
      return "retrying";
    case "error":
      return "error";
  }
}

function MenuItem({
  icon,
  label,
  active,
  meta,
  onClick,
  disabled = false,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  meta: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`${styles.item} ${active ? styles.itemActive : ""}`}
      onClick={onClick}
      disabled={disabled}
    >
      <span className={styles.itemIcon}>{icon}</span>
      <span className={styles.itemLabel}>{label}</span>
      <span className={styles.itemMeta}>{meta}</span>
    </button>
  );
}
