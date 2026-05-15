import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
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
import { ClaudeFlagsSettings } from "./ClaudeFlagsSettings";
import { EnvPanel } from "./EnvPanel";
import { RequiredInputsEditor } from "./RequiredInputsEditor";
import {
  InheritedGlobalsList,
  PinnedPromptsManager,
} from "./PinnedPromptsManager";
import { EMPTY_PINNED_PROMPTS } from "../../../stores/slices/pinnedPromptsSlice";
import {
  normalizeShellScriptInput,
  PLAIN_TEXT_INPUT_PROPS,
} from "../../../utils/textInput";
import styles from "../Settings.module.css";

interface RepoSettingsProps {
  repoId: string;
}

export function RepoSettings({ repoId }: RepoSettingsProps) {
  const { t } = useTranslation("settings");
  const openModal = useAppStore((s) => s.openModal);
  const activeModal = useAppStore((s) => s.activeModal);
  const updateRepo = useAppStore((s) => s.updateRepository);
  const repositories = useAppStore((s) => s.repositories);
  const mcpStatus = useAppStore((s) => s.mcpStatus);
  const setMcpStatus = useAppStore((s) => s.setMcpStatus);

  const repo = repositories.find((r) => r.id === repoId);
  const repoMcpStatus = mcpStatus[repoId];

  const envTarget = useMemo(
    () => ({ kind: "repo" as const, repo_id: repoId }),
    [repoId],
  );

  const [name, setName] = useState(repo?.name ?? "");
  const [icon, setIcon] = useState(repo?.icon ?? "");
  const [setupScript, setSetupScript] = useState(repo?.setup_script ?? "");
  const [archiveScript, setArchiveScript] = useState(repo?.archive_script ?? "");
  const [customInstructions, setCustomInstructions] = useState(
    repo?.custom_instructions ?? ""
  );
  const [branchRenamePreferences, setBranchRenamePreferences] = useState(
    repo?.branch_rename_preferences ?? ""
  );
  const [autoRunSetup, setAutoRunSetup] = useState(repo?.setup_script_auto_run ?? false);
  const [autoRunArchive, setAutoRunArchive] = useState(repo?.archive_script_auto_run ?? false);
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
      setArchiveScript(repo.archive_script ?? "");
      setCustomInstructions(repo.custom_instructions ?? "");
      setBranchRenamePreferences(repo.branch_rename_preferences ?? "");
      setAutoRunSetup(repo.setup_script_auto_run ?? false);
      setAutoRunArchive(repo.archive_script_auto_run ?? false);
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
    loadRepositoryMcps(repoId)
      .then(async (saved) => {
        if (saved.length > 0) {
          setMcpServers(saved);
          return;
        }
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

  const prevModal = useRef(activeModal);
  useEffect(() => {
    if (prevModal.current === "mcpSelection" && activeModal === null) {
      refreshMcpServers();
    }
    prevModal.current = activeModal;
  }, [activeModal, refreshMcpServers]);

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

  const nameRef = useRef(name);
  const iconRef = useRef(icon);
  const setupScriptRef = useRef(setupScript);
  const archiveScriptRef = useRef(archiveScript);
  const customInstructionsRef = useRef(customInstructions);
  const branchRenamePreferencesRef = useRef(branchRenamePreferences);
  const autoRunSetupRef = useRef(autoRunSetup);
  const autoRunArchiveRef = useRef(autoRunArchive);
  const baseBranchRef = useRef(baseBranch);
  const defaultRemoteRef = useRef(defaultRemote);
  nameRef.current = name;
  iconRef.current = icon;
  setupScriptRef.current = setupScript;
  archiveScriptRef.current = archiveScript;
  customInstructionsRef.current = customInstructions;
  branchRenamePreferencesRef.current = branchRenamePreferences;
  autoRunSetupRef.current = autoRunSetup;
  autoRunArchiveRef.current = autoRunArchive;
  baseBranchRef.current = baseBranch;
  defaultRemoteRef.current = defaultRemote;

  const save = useCallback(
    async (updates: {
      name?: string;
      icon?: string | null;
      setup_script?: string | null;
      archive_script?: string | null;
      custom_instructions?: string | null;
      branch_rename_preferences?: string | null;
      setup_script_auto_run?: boolean;
      archive_script_auto_run?: boolean;
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
      const finalArchiveScript =
        updates.archive_script !== undefined
          ? updates.archive_script
          : archiveScriptRef.current.trim() || null;
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
      const finalArchiveAutoRun =
        updates.archive_script_auto_run !== undefined
          ? updates.archive_script_auto_run
          : autoRunArchiveRef.current;
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
          finalArchiveScript,
          finalInstructions,
          finalBranchPrefs,
          finalAutoRun,
          finalArchiveAutoRun,
          finalBaseBranch,
          finalDefaultRemote
        );
        updateRepo(repoId, {
          name: finalName,
          icon: finalIcon,
          setup_script: finalScript,
          archive_script: finalArchiveScript,
          custom_instructions: finalInstructions,
          branch_rename_preferences: finalBranchPrefs,
          setup_script_auto_run: finalAutoRun,
          archive_script_auto_run: finalArchiveAutoRun,
          base_branch: finalBaseBranch,
          default_remote: finalDefaultRemote,
        });
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
        <h2 className={styles.sectionTitle}>{t("repo_not_found")}</h2>
      </div>
    );
  }

  const repoScriptOverrides =
    repoConfig?.has_config_file && repoConfig.setup_script != null;
  const repoArchiveScriptOverrides =
    repoConfig?.has_config_file && repoConfig.archive_script != null;
  const repoInstructionsOverrides =
    repoConfig?.has_config_file && repoConfig.instructions != null;

  return (
    <div>
      <div className={styles.repoHeader}>
        <div className={styles.iconPickerAnchor} ref={iconPopoverRef}>
          <button
            className={styles.repoIconButton}
            onClick={() => setIconPickerOpen(!iconPickerOpen)}
            title={t("repo_change_icon_title")}
            aria-label={t("repo_change_icon_aria")}
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
          aria-label={t("repo_display_name_aria")}
          {...PLAIN_TEXT_INPUT_PROPS}
        />
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("repo_branch_from")}</div>
          <div className={styles.settingDescription}>
            {t("repo_branch_from_desc")}
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
                {t("repo_branch_missing", { branch: baseBranch })}
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
          <div className={styles.settingLabel}>{t("repo_remote_origin")}</div>
          <div className={styles.settingDescription}>
            {t("repo_remote_origin_desc")}
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
                {t("repo_branch_missing", { branch: defaultRemote })}
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
        <div className={styles.fieldLabel}>{t("repo_setup_script")}</div>
        {repoConfig?.parse_error && (
          <div className={styles.error}>{repoConfig.parse_error}</div>
        )}
        {repoScriptOverrides && (
          <div className={styles.overrideNotice}>
            {t("repo_script_override_notice")}
          </div>
        )}
        {repoConfig?.has_config_file && repoConfig.setup_script && (
          <div>
            <div className={styles.overriddenLabel}>
              {t("repo_from_config")}
            </div>
            <pre className={styles.readOnlyPre}>{repoConfig.setup_script}</pre>
          </div>
        )}
        <div className={styles.overriddenLabel}>
          {repoScriptOverrides ? t("repo_personal_script_overridden") : t("repo_personal_script")}
        </div>
        <textarea
          className={`${styles.textarea}${repoScriptOverrides ? ` ${styles.overriddenInput}` : ""}`}
          value={setupScript}
          onChange={(e) =>
            setSetupScript(normalizeShellScriptInput(e.target.value))
          }
          onBlur={() =>
            save({
              setup_script:
                normalizeShellScriptInput(setupScript).trim() || null,
            })
          }
          placeholder={t("repo_setup_script_placeholder")}
          rows={3}
          {...PLAIN_TEXT_INPUT_PROPS}
        />
        <div className={styles.fieldHint}>
          {t("repo_setup_script_hint")}
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
          {t("repo_autorun_label")}
        </label>
      </div>

      <div className={styles.fieldGroup}>
        <div className={styles.fieldLabel}>{t("repo_archive_script")}</div>
        {repoArchiveScriptOverrides && (
          <div className={styles.overrideNotice}>
            {t("repo_archive_script_override_notice")}
          </div>
        )}
        {repoConfig?.has_config_file && repoConfig.archive_script && (
          <div>
            <div className={styles.overriddenLabel}>
              {t("repo_from_config")}
            </div>
            <pre className={styles.readOnlyPre}>{repoConfig.archive_script}</pre>
          </div>
        )}
        <div className={styles.overriddenLabel}>
          {repoArchiveScriptOverrides
            ? t("repo_personal_archive_script_overridden")
            : t("repo_personal_archive_script")}
        </div>
        <textarea
          className={`${styles.textarea}${repoArchiveScriptOverrides ? ` ${styles.overriddenInput}` : ""}`}
          value={archiveScript}
          onChange={(e) =>
            setArchiveScript(normalizeShellScriptInput(e.target.value))
          }
          onBlur={() =>
            save({
              archive_script:
                normalizeShellScriptInput(archiveScript).trim() || null,
            })
          }
          placeholder={t("repo_archive_script_placeholder")}
          rows={3}
          {...PLAIN_TEXT_INPUT_PROPS}
        />
        <div className={styles.fieldHint}>
          {t("repo_archive_script_hint")}
        </div>
        <label className={styles.autoRunLabel}>
          <input
            type="checkbox"
            checked={autoRunArchive}
            onChange={(e) => {
              setAutoRunArchive(e.target.checked);
              save({ archive_script_auto_run: e.target.checked });
            }}
          />
          {t("repo_archive_autorun_label")}
        </label>
      </div>

      <div className={styles.fieldGroup}>
        <div className={styles.fieldLabel}>{t("repo_environment")}</div>
        <EnvPanel target={envTarget} />
      </div>

      <RequiredInputsEditor repoId={repoId} />

      <div className={styles.fieldGroup}>
        <div className={styles.fieldLabel}>{t("repo_custom_instructions")}</div>
        {repoInstructionsOverrides && (
          <div className={styles.overrideNotice}>
            {t("repo_instructions_override_notice")}
          </div>
        )}
        {repoConfig?.has_config_file && repoConfig.instructions && (
          <div>
            <div className={styles.overriddenLabel}>
              {t("repo_from_config")}
            </div>
            <pre className={styles.readOnlyPre}>{repoConfig.instructions}</pre>
          </div>
        )}
        <div className={styles.overriddenLabel}>
          {repoInstructionsOverrides ? t("repo_personal_instructions_overridden") : t("repo_personal_instructions")}
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
          placeholder={t("repo_custom_instructions_placeholder")}
          rows={4}
          {...PLAIN_TEXT_INPUT_PROPS}
        />
        <div className={styles.fieldHint}>
          {t("repo_custom_instructions_hint")}
        </div>
      </div>

      <RepoPinnedPromptsField repoId={repoId} />

      <div className={styles.fieldGroup}>
        <div className={styles.fieldLabel}>{t("claude_flags_repo_label")}</div>
        <div className={`${styles.fieldHint} ${styles.fieldHintSpaced}`}>
          {t("claude_flags_repo_description")}
        </div>
        <ClaudeFlagsSettings scope={{ kind: "repo", repoId }} hideHeader />
      </div>

      <div className={styles.fieldGroup}>
        <div className={styles.fieldLabel}>{t("repo_branch_rename")}</div>
        <div className={`${styles.fieldHint} ${styles.fieldHintSpaced}`}>
          {t("repo_branch_rename_hint")}
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
          placeholder={t("repo_branch_rename_placeholder")}
          rows={3}
          {...PLAIN_TEXT_INPUT_PROPS}
        />
      </div>

      <div className={styles.fieldGroup}>
        <div className={styles.fieldLabel}>{t("repo_mcp_servers")}</div>
        <div className={`${styles.fieldHint} ${styles.fieldHintSpacedWide}`}>
          {t("repo_mcp_servers_hint")}
        </div>
        {mcpServers.length === 0 ? (
          <div className={styles.fieldHint}>
            {t("repo_mcp_no_servers")}
          </div>
        ) : (
          <div className={styles.mcpList}>
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
                              {t("repo_mcp_reconnect")}
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
                            aria-label={server.enabled ? t("repo_mcp_disable_aria", { name: server.name }) : t("repo_mcp_enable_aria", { name: server.name })}
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
            {t("repo_mcp_detect")}
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
              {t("repo_mcp_refresh")}
            </button>
          )}
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("repo_archive_on_merge")}</div>
          <div className={styles.settingDescription}>
            {t("repo_archive_on_merge_desc")}
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
            <option value="inherit">{t("repo_archive_inherit")}</option>
            <option value="true">{t("repo_archive_enabled")}</option>
            <option value="false">{t("repo_archive_disabled")}</option>
          </select>
        </div>
      </div>

      <div className={styles.fieldGroup}>
        <div className={styles.fieldLabel}>{t("repo_worktree_discovery")}</div>
        <div className={`${styles.fieldHint} ${styles.fieldHintSpaced}`}>
          {t("repo_worktree_discovery_hint")}
        </div>
        <button
          className={styles.iconBtn}
          onClick={() => openModal("importWorktrees", { repoId })}
        >
          {t("repo_worktree_discover")}
        </button>
      </div>

      <div className={styles.dangerZone}>
        <div className={styles.dangerLabel}>{t("repo_danger_zone")}</div>
        <button
          className={styles.btnDanger}
          onClick={() =>
            openModal("removeRepo", { repoId, repoName: repo.name })
          }
        >
          {t("repo_remove_repo")}
        </button>
      </div>

      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}

interface RepoPinnedPromptsFieldProps {
  repoId: string;
}

function RepoPinnedPromptsField({ repoId }: RepoPinnedPromptsFieldProps) {
  const { t } = useTranslation("settings");
  // Stable empty fallback — see EMPTY_PINNED_PROMPTS docs for why this matters.
  const repoPrompts = useAppStore(
    (s) => s.repoPinnedPrompts[repoId] ?? EMPTY_PINNED_PROMPTS,
  );
  const globalPrompts = useAppStore((s) => s.globalPinnedPrompts);
  const loadGlobals = useAppStore((s) => s.loadGlobalPinnedPrompts);
  const repoPath = useAppStore((s) => s.repositories.find((r) => r.id === repoId)?.path);

  // Hydrate globals so the inherited list reflects current global state.
  useEffect(() => {
    loadGlobals().catch((e) =>
      console.error("Failed to load global pinned prompts:", e),
    );
  }, [loadGlobals]);

  const repoNames = useMemo(
    () => new Set(repoPrompts.map((p) => p.display_name)),
    [repoPrompts],
  );

  return (
    <div className={styles.fieldGroup}>
      <div className={styles.fieldLabel}>{t("pinned_prompts_repo_label")}</div>
      <div className={`${styles.fieldHint} ${styles.fieldHintSpaced}`}>
        {t("pinned_prompts_repo_description")}
      </div>
      <PinnedPromptsManager scope={{ kind: "repo", repoId }} projectPath={repoPath} />
      <InheritedGlobalsList globals={globalPrompts} repoNames={repoNames} />
    </div>
  );
}
