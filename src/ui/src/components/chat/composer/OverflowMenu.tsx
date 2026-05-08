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
import styles from "./OverflowMenu.module.css";

interface OverflowMenuProps {
  sessionId: string;
  disabled: boolean;
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

export function OverflowMenu({ sessionId, disabled, isRemote }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  const showFast = isFastSupported(selectedModel);
  const [remoteControlStatus, setRemoteControlStatus] =
    useState<ClaudeRemoteControlStatus>(DISABLED_REMOTE_STATUS);
  const remoteControlActive = remoteControlStatus.state !== "disabled";
  const anyActive = fastMode || chromeEnabled || remoteControlActive;

  useEffect(() => {
    if (isRemote) {
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
  }, [sessionId, isRemote]);

  useEffect(() => {
    if (isRemote) return;
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
  }, [sessionId, isRemote]);

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
  }, [sessionId, chromeEnabled, setChromeEnabled, clearAgentQuestion, clearPlanApproval]);

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
            />
          )}
          <MenuItem
            icon={<Globe size={14} />}
            label="Claude in Chrome"
            active={chromeEnabled}
            meta={chromeEnabled ? "on" : "off"}
            onClick={toggleChrome}
          />
          {!isRemote && (
            <RemoteControlMenuItem
              sessionId={sessionId}
              disabled={disabled}
              status={remoteControlStatus}
              permissionLevel={permissionLevel}
              model={selectedModel}
              backendId={selectedProvider}
              fastMode={fastMode}
              thinkingEnabled={thinkingEnabled}
              planMode={planMode}
              effort={effortLevel}
              chromeEnabled={chromeEnabled}
              disable1mContext={shouldDisable1mContext(selectedModel)}
              onStatus={setRemoteControlStatus}
            />
          )}
        </div>
      )}
    </div>
  );
}

function RemoteControlMenuItem({
  sessionId,
  disabled,
  status,
  permissionLevel,
  model,
  backendId,
  fastMode,
  thinkingEnabled,
  planMode,
  effort,
  chromeEnabled,
  disable1mContext,
  onStatus,
}: {
  sessionId: string;
  disabled: boolean;
  status: ClaudeRemoteControlStatus;
  permissionLevel: string;
  model: string;
  backendId: string;
  fastMode: boolean;
  thinkingEnabled: boolean;
  planMode: boolean;
  effort: string;
  chromeEnabled: boolean;
  disable1mContext: boolean;
  onStatus: (status: ClaudeRemoteControlStatus) => void;
}) {
  const url = remoteControlUrl(status);
  const busy = status.state === "enabling";
  const active = status.state !== "disabled" && status.state !== "error";
  const meta = remoteControlMeta(status);
  const detail = status.lastError ?? status.detail;
  const displayDetail = remoteControlDisplayDetail(status, detail, url);

  const toggle = useCallback(async () => {
    if (busy) return;
    const nextEnabled = !active;
    if (nextEnabled) {
      onStatus({ ...status, state: "enabling", lastError: null });
    }
    try {
      const next = await setClaudeRemoteControl(sessionId, nextEnabled, {
        permissionLevel,
        model,
        backendId,
        fastMode,
        thinkingEnabled,
        planMode,
        effort,
        chromeEnabled,
        disable1mContext,
      });
      onStatus(next);
    } catch (err) {
      const message = formatRemoteControlError(err);
      onStatus({
        state: "error",
        sessionUrl: null,
        connectUrl: null,
        environmentId: null,
        detail: null,
        lastError: message,
      });
    }
  }, [
    active,
    backendId,
    busy,
    chromeEnabled,
    disable1mContext,
    effort,
    fastMode,
    model,
    onStatus,
    permissionLevel,
    planMode,
    sessionId,
    status,
    thinkingEnabled,
  ]);

  return (
    <div
      className={`${styles.remoteGroup} ${active ? styles.remoteGroupActive : ""} ${status.state === "error" ? styles.remoteGroupError : ""}`}
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
          >
            <Copy size={13} />
          </button>
          <button
            type="button"
            className={styles.actionButton}
            onClick={toggle}
            disabled={disabled || busy}
            title="Turn off Remote Control"
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
): string | null {
  if ((status.state === "ready" || status.state === "connected") && !url) {
    return "Waiting for Claude to publish the session link.";
  }
  if (!detail) return null;
  if (detail === "Session creation failed — see debug log") {
    return "Session creation failed. Refresh Claude login, then retry.";
  }
  return detail;
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

function remoteControlMeta(status: ClaudeRemoteControlStatus): string {
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
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  meta: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${styles.item} ${active ? styles.itemActive : ""}`}
      onClick={onClick}
    >
      <span className={styles.itemIcon}>{icon}</span>
      <span className={styles.itemLabel}>{label}</span>
      <span className={styles.itemMeta}>{meta}</span>
    </button>
  );
}
