import { useState, useEffect, useRef, useCallback } from "react";
import { useAppStore } from "../../../stores/useAppStore";
import { updateRepositorySettings, getRepoConfig } from "../../../services/tauri";
import {
  loadRepositoryMcps,
  deleteRepositoryMcp,
} from "../../../services/mcp";
import type { RepoConfigInfo } from "../../../types/repository";
import type { SavedMcpServer } from "../../../types/mcp";
import { RepoIcon } from "../../shared/RepoIcon";
import { IconPicker } from "../../modals/IconPicker";
import styles from "../Settings.module.css";

interface RepoSettingsProps {
  repoId: string;
}

export function RepoSettings({ repoId }: RepoSettingsProps) {
  const openModal = useAppStore((s) => s.openModal);
  const activeModal = useAppStore((s) => s.activeModal);
  const updateRepo = useAppStore((s) => s.updateRepository);
  const repositories = useAppStore((s) => s.repositories);

  const repo = repositories.find((r) => r.id === repoId);

  const [name, setName] = useState(repo?.name ?? "");
  const [icon, setIcon] = useState(repo?.icon ?? "");
  const [setupScript, setSetupScript] = useState(repo?.setup_script ?? "");
  const [customInstructions, setCustomInstructions] = useState(
    repo?.custom_instructions ?? ""
  );
  const [branchRenamePreferences, setBranchRenamePreferences] = useState(
    repo?.branch_rename_preferences ?? ""
  );
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repoConfig, setRepoConfig] = useState<RepoConfigInfo | null>(null);
  const [mcpServers, setMcpServers] = useState<SavedMcpServer[]>([]);
  const iconPopoverRef = useRef<HTMLDivElement>(null);

  // Reset local state only when switching to a different repo
  useEffect(() => {
    if (repo) {
      setName(repo.name);
      setIcon(repo.icon ?? "");
      setSetupScript(repo.setup_script ?? "");
      setCustomInstructions(repo.custom_instructions ?? "");
      setBranchRenamePreferences(repo.branch_rename_preferences ?? "");
      setError(null);
    }
  }, [repoId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    getRepoConfig(repoId)
      .then(setRepoConfig)
      .catch(() => setRepoConfig(null));
  }, [repoId]);

  const refreshMcpServers = useCallback(() => {
    loadRepositoryMcps(repoId)
      .then(setMcpServers)
      .catch(() => setMcpServers([]));
  }, [repoId]);

  useEffect(() => {
    refreshMcpServers();
  }, [refreshMcpServers]);

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
  nameRef.current = name;
  iconRef.current = icon;
  setupScriptRef.current = setupScript;
  customInstructionsRef.current = customInstructions;
  branchRenamePreferencesRef.current = branchRenamePreferences;

  const save = useCallback(
    async (updates: {
      name?: string;
      icon?: string | null;
      setup_script?: string | null;
      custom_instructions?: string | null;
      branch_rename_preferences?: string | null;
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

      try {
        setError(null);
        await updateRepositorySettings(
          repoId,
          finalName,
          finalIcon,
          finalScript,
          finalInstructions,
          finalBranchPrefs
        );
        updateRepo(repoId, {
          name: finalName,
          icon: finalIcon,
          setup_script: finalScript,
          custom_instructions: finalInstructions,
          branch_rename_preferences: finalBranchPrefs,
        });
      } catch (e) {
        setError(String(e));
      }
    },
    [repoId, updateRepo]
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
        <div style={{ position: "relative" }} ref={iconPopoverRef}>
          <button
            className={styles.repoIconButton}
            onClick={() => setIconPickerOpen(!iconPickerOpen)}
            title="Change icon"
            aria-label="Change repository icon"
          >
            {icon ? (
              <RepoIcon icon={icon} size={20} />
            ) : (
              <span style={{ fontSize: 16, opacity: 0.4 }}>+</span>
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
          className={styles.textarea}
          value={setupScript}
          onChange={(e) => setSetupScript(e.target.value)}
          onBlur={() => save({ setup_script: setupScript.trim() || null })}
          placeholder="e.g. mise trust && mise install"
          rows={3}
          style={{ opacity: repoScriptOverrides ? 0.5 : 1 }}
        />
        <div className={styles.fieldHint}>
          Runs automatically when a new workspace is created.
        </div>
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
          className={styles.textarea}
          value={customInstructions}
          onChange={(e) => setCustomInstructions(e.target.value)}
          onBlur={() =>
            save({
              custom_instructions: customInstructions.trim() || null,
            })
          }
          placeholder="e.g. Always use TypeScript. Prefer functional components."
          rows={4}
          style={{ opacity: repoInstructionsOverrides ? 0.5 : 1 }}
        />
        <div className={styles.fieldHint}>
          Appended to the agent's system prompt at the start of every chat.
        </div>
      </div>

      <div className={styles.fieldGroup}>
        <div className={styles.fieldLabel}>Branch rename preferences</div>
        <div className={styles.fieldHint} style={{ marginBottom: 8 }}>
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
        <div className={styles.fieldHint} style={{ marginBottom: 12 }}>
          Non-portable MCP servers injected into agent sessions via{" "}
          <code>--mcp-config</code>. These are servers from your user config or
          gitignored repo config that aren't automatically available in
          worktrees.
        </div>
        {mcpServers.length === 0 ? (
          <div className={styles.fieldHint}>
            No MCP servers configured for this repository.
          </div>
        ) : (
          <div className={styles.mcpList}>
            {mcpServers.map((server) => {
              let transport = "unknown";
              try {
                const cfg = JSON.parse(server.config_json);
                if (cfg.command) transport = "stdio";
                else if (cfg.url) transport = "http";
                if (cfg.type) transport = cfg.type;
              } catch {
                /* ignore parse errors */
              }
              const sourceLabel =
                server.source === "user_project_config"
                  ? "~/.claude.json"
                  : server.source === "repo_local_config"
                    ? ".claude.json"
                    : server.source;
              return (
                <div key={server.id} className={styles.mcpRow}>
                  <div className={styles.mcpInfo}>
                    <span className={styles.mcpName}>{server.name}</span>
                    <span className={styles.mcpBadge}>{transport}</span>
                    <span className={styles.mcpSource}>{sourceLabel}</span>
                  </div>
                  <button
                    className={styles.mcpRemoveBtn}
                    title="Remove this MCP server"
                    aria-label={`Remove MCP server ${server.name}`}
                    onClick={async () => {
                      try {
                        await deleteRepositoryMcp(server.id);
                        refreshMcpServers();
                      } catch (e) {
                        setError(String(e));
                      }
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <div style={{ marginTop: 8 }}>
          <button
            className={styles.iconBtn}
            onClick={() => openModal("mcpSelection", { repoId })}
          >
            Re-detect &amp; add servers
          </button>
        </div>
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
