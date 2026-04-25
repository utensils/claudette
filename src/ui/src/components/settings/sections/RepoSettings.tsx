import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useAppStore } from "../../../stores/useAppStore";
import { updateRepositorySettings, getRepoConfig, getAppSetting, setAppSetting, listGitRemotes, listGitRemoteBranches, getDefaultBranch } from "../../../services/tauri";
import {
  loadRepositoryMcps,
  detectMcpServers,
  saveRepositoryMcps,
  reconnectMcpServer,
  setMcpServerEnabled,
  getMcpStatus,
} from "../../../services/mcp";
import type { RepoConfigInfo } from "../../../types/repository";
import type { SavedMcpServer, McpSource } from "../../../types/mcp";
import { MCP_SOURCE_LABELS } from "../../../types/mcp";
import { RepoIcon } from "../../shared/RepoIcon";
import { IconPicker } from "../../modals/IconPicker";
import { EnvPanel } from "./EnvPanel";
import styles from "../Settings.module.css";

interface RepoSettingsProps {
  repoId: string;
}

export function RepoSettings({ repoId }: RepoSettingsProps) {
  const openModal = useAppStore((s) => s.openModal);
  const activeModal = useAppStore((s) => s.activeModal);
  const updateRepo = useAppStore((s) => s.updateRepository);
  const repositories = useAppStore((s) => s.repositories);
  const mcpStatus = useAppStore((s) => s.mcpStatus);
  const setMcpStatus = useAppStore((s) => s.setMcpStatus);

  const repo = repositories.find((r) => r.id === repoId);
  const repoMcpStatus = mcpStatus[repoId];

  // Stable reference for EnvPanel so its effects (keyed on the target
  // object) don't re-fire on every RepoSettings re-render. Only the
  // repoId string matters for resolution.
  const envTarget = useMemo(
    () => ({ kind: "repo" as const, repo_id: repoId }),
    [repoId],
  );

  const [name, setName] = useState(repo?.name ?? "");
  const [icon, setIcon] = useState(repo?.icon ?? "");
  const [setupScript, setSetupScript] = useState(repo?.setup_script ?? "");
  const [customInstructions, setCustomInstructions] = useState(
    repo?.custom_instructions ?? ""
  );
  const [branchRenamePreferences, setBranchRenamePreferences] = useState(
    repo?.branch_rename_preferences ?? ""
  );
  const [autoRunSetup, setAutoRunSetup] = useState(repo?.setup_script_auto_run ?? false);
  const [baseBranch, setBaseBranch] = useState(repo?.base_branch ?? "");
  const [defaultRemote, setDefaultRemote] = useState(repo?.default_remote ?? "");
  const [availableRemotes, setAvailableRemotes] = useState<string[]>([]);
  const [availableBranches, setAvailableBranches] = useState<string[]>([]);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repoConfig, setRepoConfig] = useState<RepoConfigInfo | null>(null);
  const [mcpServers, setMcpServers] = useState<SavedMcpServer[]>([]);
  const [archiveOnMerge, setArchiveOnMerge] = useState<"inherit" | "true" | "false">("inherit");
  const setDefaultBranches = useAppStore((s) => s.setDefaultBranches);
  const iconPopoverRef = useRef<HTMLDivElement>(null);

  // Reset local state only when switching to a different repo
  useEffect(() => {
    if (repo) {
      setName(repo.name);
      setIcon(repo.icon ?? "");
      setSetupScript(repo.setup_script ?? "");
      setCustomInstructions(repo.custom_instructions ?? "");
      setBranchRenamePreferences(repo.branch_rename_preferences ?? "");
      setAutoRunSetup(repo.setup_script_auto_run ?? false);
      setBaseBranch(repo.base_branch ?? "");
      setDefaultRemote(repo.default_remote ?? "");
      setArchiveOnMerge("inherit");
      setError(null);
    }
  }, [repoId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    getRepoConfig(repoId)
      .then(setRepoConfig)
      .catch(() => setRepoConfig(null));
  }, [repoId]);

  useEffect(() => {
    let cancelled = false;
    listGitRemotes(repoId)
      .then((remotes) => { if (!cancelled) setAvailableRemotes(remotes); })
      .catch(() => { if (!cancelled) setAvailableRemotes([]); });
    listGitRemoteBranches(repoId)
      .then((branches) => { if (!cancelled) setAvailableBranches(branches); })
      .catch(() => { if (!cancelled) setAvailableBranches([]); });
    return () => { cancelled = true; };
  }, [repoId]);

  useEffect(() => {
    getAppSetting(`repo:${repoId}:archive_on_merge`)
      .then((val) => {
        if (val === "true") setArchiveOnMerge("true");
        else if (val === "false") setArchiveOnMerge("false");
        else setArchiveOnMerge("inherit");
      })
      .catch(() => setArchiveOnMerge("inherit"));
  }, [repoId]);

  const refreshMcpServers = useCallback(() => {
    loadRepositoryMcps(repoId)
      .then(setMcpServers)
      .catch(() => setMcpServers([]));
  }, [repoId]);

  useEffect(() => {
    // Load saved servers, and auto-detect + save if none exist yet.
    loadRepositoryMcps(repoId)
      .then(async (saved) => {
        if (saved.length > 0) {
          setMcpServers(saved);
          return;
        }
        // No saved servers — auto-detect and save so they appear immediately.
        try {
          const detected = await detectMcpServers(repoId);
          if (detected.length > 0) {
            await saveRepositoryMcps(repoId, detected);
            const updated = await loadRepositoryMcps(repoId);
            setMcpServers(updated);
          }
        } catch {
          // Detection failed — leave empty.
        }
      })
      .catch(() => setMcpServers([]));
  }, [repoId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh MCP list when the selection modal closes (user may have saved new MCPs).
  const prevModal = useRef(activeModal);
  useEffect(() => {
    if (prevModal.current === "mcpSelection" && activeModal === null) {
      refreshMcpServers();
    }
    prevModal.current = activeModal;
  }, [activeModal, refreshMcpServers]);

  // Close icon picker on click outside
  useEffect(() => {
    if (!iconPickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        iconPopoverRef.current &&
        !iconPopoverRef.current.contains(e.target as Node)
      ) {
        setIconPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [iconPickerOpen]);

  // Use refs for current local state so save always reads latest values
  const nameRef = useRef(name);
  const iconRef = useRef(icon);
  const setupScriptRef = useRef(setupScript);
  const customInstructionsRef = useRef(customInstructions);
  const branchRenamePreferencesRef = useRef(branchRenamePreferences);
  const autoRunSetupRef = useRef(autoRunSetup);
  const baseBranchRef = useRef(baseBranch);
  const defaultRemoteRef = useRef(defaultRemote);
  nameRef.current = name;
  iconRef.current = icon;
  setupScriptRef.current = setupScript;
  customInstructionsRef.current = customInstructions;
  branchRenamePreferencesRef.current = branchRenamePreferences;
  autoRunSetupRef.current = autoRunSetup;
  baseBranchRef.current = baseBranch;
  defaultRemoteRef.current = defaultRemote;

  const save = useCallback(
    async (updates: {
      name?: string;
      icon?: string | null;
      setup_script?: string | null;
      custom_instructions?: string | null;
      branch_rename_preferences?: string | null;
      setup_script_auto_run?: boolean;
      base_branch?: string;
      default_remote?: string;
    }) => {
      const finalName = (updates.name ?? nameRef.current).trim();
      if (!finalName) return;
      const finalIcon =
        updates.icon !== undefined
          ? updates.icon
          : iconRef.current.trim() || null;
      const finalScript =
        updates.setup_script !== undefined
          ? updates.setup_script
          : setupScriptRef.current.trim() || null;
      const finalInstructions =
        updates.custom_instructions !== undefined
          ? updates.custom_instructions
          : customInstructionsRef.current.trim() || null;
      const finalBranchPrefs =
        updates.branch_rename_preferences !== undefined
          ? updates.branch_rename_preferences
          : branchRenamePreferencesRef.current.trim() || null;
      const finalAutoRun =
        updates.setup_script_auto_run !== undefined
          ? updates.setup_script_auto_run
          : autoRunSetupRef.current;
      const finalBaseBranch =
        updates.base_branch !== undefined
          ? updates.base_branch
          : baseBranchRef.current;
      const finalDefaultRemote =
        updates.default_remote !== undefined
          ? updates.default_remote
          : defaultRemoteRef.current;

      try {
        setError(null);
        await updateRepositorySettings(
          repoId,
          finalName,
          finalIcon,
          finalScript,
          finalInstructions,
          finalBranchPrefs,
          finalAutoRun,
          finalBaseBranch,
          finalDefaultRemote
        );
        updateRepo(repoId, {
          name: finalName,
          icon: finalIcon,
          setup_script: finalScript,
          custom_instructions: finalInstructions,
          branch_rename_preferences: finalBranchPrefs,
          setup_script_auto_run: finalAutoRun,
          base_branch: finalBaseBranch,
          default_remote: finalDefaultRemote,
        });
        // Refresh the displayed default branch when either override changes.
        if (updates.base_branch !== undefined || updates.default_remote !== undefined) {
          getDefaultBranch(repoId)
            .then((branch) => {
              if (branch) {
                const current = useAppStore.getState().defaultBranches;
                setDefaultBranches({ ...current, [repoId]: branch });
              }
            })
            .catch(() => {});
        }
      } catch (e) {
        setError(String(e));
      }
    },
    [repoId, updateRepo, setDefaultBranches]
  );

  if (!repo) {
    return (
      <div>
        <h2 className={styles.sectionTitle}>Repository not found</h2>
      </div>
    );
  }

  const repoScriptOverrides =
    repoConfig?.has_config_file && repoConfig.setup_script != null;
  const repoInstructionsOverrides =
    repoConfig?.has_config_file && repoConfig.instructions != null;

  return (
    <div>
      <div className={styles.repoHeader}>
        <div className={styles.iconPickerAnchor} ref={iconPopoverRef}>
          <button
            className={styles.repoIconButton}
            onClick={() => setIconPickerOpen(!iconPickerOpen)}
            title="Change icon"
            aria-label="Change repository icon"
          >
            {icon ? (
              <RepoIcon icon={icon} size={20} />
            ) : (
              <span className={styles.iconPlaceholder}>+</span>
            )}
          </button>
          {iconPickerOpen && (
            <div className={styles.iconPopover}>
              <IconPicker
                value={icon}
                onChange={(v) => {
                  setIcon(v);
                  save({ icon: v.trim() || null });
                  setIconPickerOpen(false);
                }}
              />
            </div>
          )}
        </div>
        <input
          className={styles.repoNameInput}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => save({ name })}
          aria-label="Repository display name"
        />
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Branch new workspaces from</div>
          <div className={styles.settingDescription}>
            Each workspace is an isolated copy of your codebase.
          </div>
        </div>
        <div className={styles.settingControl}>
          <select
            className={styles.select}
            value={baseBranch}
            onChange={(e) => {
              const val = e.target.value;
              setBaseBranch(val);
              save({ base_branch: val });
            }}
          >
            {baseBranch && !availableBranches.includes(baseBranch) && (
              <option key={baseBranch} value={baseBranch}>
                {baseBranch} (missing)
              </option>
            )}
            {availableBranches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Remote origin</div>
          <div className={styles.settingDescription}>
            Where should we push, pull, and create PRs?
          </div>
        </div>
        <div className={styles.settingControl}>
          <select
            className={styles.select}
            value={defaultRemote}
            onChange={(e) => {
              const val = e.target.value;
              setDefaultRemote(val);
              save({ default_remote: val });
            }}
          >
            {defaultRemote && !availableRemotes.includes(defaultRemote) && (
              <option key={defaultRemote} value={defaultRemote}>
                {defaultRemote} (missing)
              </option>
            )}
            {availableRemotes.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className={styles.fieldGroup}>
        <div className={styles.fieldLabel}>Setup script</div>
        {repoConfig?.parse_error && (
          <div className={styles.error}>{repoConfig.parse_error}</div>
        )}
        {repoScriptOverrides && (
          <div className={styles.overrideNotice}>
            This repo includes a <code>.claudette.json</code> that defines a
            setup script. Repo-level scripts take precedence over your personal
            setup script.
          </div>
        )}
        {repoConfig?.has_config_file && repoConfig.setup_script && (
          <div>
            <div className={styles.overriddenLabel}>
              From .claudette.json (read-only):
            </div>
            <pre className={styles.readOnlyPre}>{repoConfig.setup_script}</pre>
          </div>
        )}
        <div className={styles.overriddenLabel}>
          Personal setup script{repoScriptOverrides ? " (overridden)" : ""}:
        </div>
        <textarea
          className={`${styles.textarea}${repoScriptOverrides ? ` ${styles.overriddenInput}` : ""}`}
          value={setupScript}
          onChange={(e) => setSetupScript(e.target.value)}
          onBlur={() => save({ setup_script: setupScript.trim() || null })}
          placeholder="e.g. mise trust && mise install"
          rows={3}
        />
        <div className={styles.fieldHint}>
          Runs automatically when a new workspace is created.
        </div>
        <label className={styles.autoRunLabel}>
          <input
            type="checkbox"
            checked={autoRunSetup}
            onChange={(e) => {
              setAutoRunSetup(e.target.checked);
              save({ setup_script_auto_run: e.target.checked });
            }}
          />
          Skip confirmation when running setup scripts
        </label>
      </div>

      <div className={styles.fieldGroup}>
        <div className={styles.fieldLabel}>Environment</div>
        <EnvPanel target={envTarget} />
      </div>

      <div className={styles.fieldGroup}>
        <div className={styles.fieldLabel}>Custom instructions</div>
        {repoInstructionsOverrides && (
          <div className={styles.overrideNotice}>
            This repo includes a <code>.claudette.json</code> that defines
            custom instructions. Repo-level instructions take precedence over
            your personal instructions.
          </div>
        )}
        {repoConfig?.has_config_file && repoConfig.instructions && (
          <div>
            <div className={styles.overriddenLabel}>
              From .claudette.json (read-only):
            </div>
            <pre className={styles.readOnlyPre}>{repoConfig.instructions}</pre>
          </div>
        )}
        <div className={styles.overriddenLabel}>
          Personal instructions
          {repoInstructionsOverrides ? " (overridden)" : ""}:
        </div>
        <textarea
          className={`${styles.textarea}${repoInstructionsOverrides ? ` ${styles.overriddenInput}` : ""}`}
          value={customInstructions}
          onChange={(e) => setCustomInstructions(e.target.value)}
          onBlur={() =>
            save({
              custom_instructions: customInstructions.trim() || null,
            })
          }
          placeholder="e.g. Always use TypeScript. Prefer functional components."
          rows={4}
        />
        <div className={styles.fieldHint}>
          Appended to the agent's system prompt at the start of every chat.
        </div>
      </div>

      <div className={styles.fieldGroup}>
        <div className={styles.fieldLabel}>Branch rename preferences</div>
        <div className={`${styles.fieldHint} ${styles.fieldHintSpaced}`}>
          Custom instructions sent to the agent along with your first message in
          a workspace where the branch hasn't already been renamed.
        </div>
        <textarea
          className={styles.textarea}
          value={branchRenamePreferences}
          onChange={(e) => setBranchRenamePreferences(e.target.value)}
          onBlur={() =>
            save({
              branch_rename_preferences:
                branchRenamePreferences.trim() || null,
            })
          }
          placeholder="Add your preferences here. The agent will be told to prioritize these instructions over its default instructions."
          rows={3}
        />
      </div>

      <div className={styles.fieldGroup}>
        <div className={styles.fieldLabel}>MCP servers</div>
        <div className={`${styles.fieldHint} ${styles.fieldHintSpacedWide}`}>
          Servers injected into agent sessions. Toggle to enable or disable for
          this repository.
        </div>
        {mcpServers.length === 0 ? (
          <div className={styles.fieldHint}>
            No MCP servers detected for this repository.
          </div>
        ) : (
          <div className={styles.mcpList}>
            {/* Group servers by source */}
            {(() => {
              const groups = new Map<string, typeof mcpServers>();
              for (const server of mcpServers) {
                const key = server.source;
                const list = groups.get(key) ?? [];
                list.push(server);
                groups.set(key, list);
              }
              return [...groups.entries()].map(([source, servers]) => (
                <div key={source}>
                  <div className={styles.mcpGroupLabel}>
                    {MCP_SOURCE_LABELS[source as McpSource] ?? source}
                  </div>
                  {servers.map((server) => {
                    let transport = "unknown";
                    try {
                      const cfg = JSON.parse(server.config_json);
                      if (cfg.command) transport = "stdio";
                      else if (cfg.url) transport = "http";
                      if (cfg.type) transport = cfg.type;
                    } catch {
                      /* ignore */
                    }
                    const serverStatus = repoMcpStatus?.servers.find(
                      (s) => s.name === server.name,
                    );
                    const stateColor =
                      serverStatus?.state === "connected"
                        ? "var(--status-running)"
                        : serverStatus?.state === "failed"
                          ? "var(--status-stopped)"
                          : serverStatus?.state === "disabled"
                            ? "var(--text-faint)"
                            : "var(--status-idle)";
                    return (
                      <div key={server.id} className={styles.mcpRow}>
                        <div className={styles.mcpInfo}>
                          <span
                            className={styles.mcpStatusDot}
                            style={{ background: stateColor }}
                            title={serverStatus?.state ?? "pending"}
                          />
                          <span
                            className={`${styles.mcpName} ${!server.enabled ? styles.mcpNameDisabled : ""}`}
                          >
                            {server.name}
                          </span>
                          <span className={styles.mcpBadge}>{transport}</span>
                          {serverStatus?.last_error && (
                            <span
                              className={styles.mcpError}
                              title={serverStatus.last_error}
                            >
                              {serverStatus.last_error.slice(0, 40)}
                            </span>
                          )}
                        </div>
                        <div className={styles.mcpActions}>
                          {serverStatus?.state === "failed" && (
                            <button
                              className={styles.mcpReconnectBtn}
                              onClick={async () => {
                                try {
                                  await reconnectMcpServer(repoId, server.name);
                                  const snap = await getMcpStatus(repoId);
                                  if (snap) setMcpStatus(repoId, snap);
                                } catch (e) {
                                  setError(String(e));
                                }
                              }}
                            >
                              Reconnect
                            </button>
                          )}
                          <button
                            className={`${styles.mcpToggle} ${server.enabled ? styles.mcpToggleOn : ""}`}
                            onClick={async () => {
                              try {
                                await setMcpServerEnabled(
                                  server.id,
                                  repoId,
                                  server.name,
                                  !server.enabled,
                                );
                                refreshMcpServers();
                                const snap = await getMcpStatus(repoId);
                                if (snap) setMcpStatus(repoId, snap);
                              } catch (err) {
                                setError(String(err));
                              }
                            }}
                            role="switch"
                            aria-checked={server.enabled}
                            aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
                          >
                            <span className={styles.mcpToggleKnob} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ));
            })()}
          </div>
        )}
        <div className={styles.buttonRow}>
          <button
            className={styles.iconBtn}
            onClick={() => openModal("mcpSelection", { repoId })}
          >
            Re-detect &amp; add servers
          </button>
          {mcpServers.length > 0 && (
            <button
              className={styles.iconBtn}
              onClick={async () => {
                try {
                  const snap = await getMcpStatus(repoId);
                  if (snap) setMcpStatus(repoId, snap);
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              Refresh status
            </button>
          )}
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Archive on merge</div>
          <div className={styles.settingDescription}>
            Automatically archive workspaces when their PR is merged. Overrides
            the global setting for this repository.
          </div>
        </div>
        <div className={styles.settingControl}>
          <select
            className={styles.select}
            value={archiveOnMerge}
            onChange={async (e) => {
              const val = e.target.value as "inherit" | "true" | "false";
              const prev = archiveOnMerge;
              setArchiveOnMerge(val);
              try {
                setError(null);
                await setAppSetting(
                  `repo:${repoId}:archive_on_merge`,
                  val === "inherit" ? "" : val,
                );
              } catch (err) {
                setArchiveOnMerge(prev);
                setError(String(err));
              }
            }}
          >
            <option value="inherit">Use global default</option>
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </div>
      </div>

      <div className={styles.fieldGroup}>
        <div className={styles.fieldLabel}>Worktree discovery</div>
        <div className={`${styles.fieldHint} ${styles.fieldHintSpaced}`}>
          Scan for existing git worktrees (e.g. from Conductor) and import them
          as workspaces.
        </div>
        <button
          className={styles.iconBtn}
          onClick={() => openModal("importWorktrees", { repoId })}
        >
          Discover worktrees
        </button>
      </div>

      <div className={styles.dangerZone}>
        <div className={styles.dangerLabel}>Danger Zone</div>
        <button
          className={styles.btnDanger}
          onClick={() =>
            openModal("removeRepo", { repoId, repoName: repo.name })
          }
        >
          Remove Repository
        </button>
      </div>

      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}
