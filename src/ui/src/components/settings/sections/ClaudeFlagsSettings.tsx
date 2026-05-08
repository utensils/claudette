import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../stores/useAppStore";
import {
  type ClaudeFlagDef,
  type FlagScope,
  type FlagStateResponse,
  clearClaudeFlagRepoOverride,
  getClaudeFlagState,
  listClaudeFlags,
  refreshClaudeFlags,
  setClaudeFlagState,
} from "../../../services/claudeFlags";
import { ClaudeFlagRow } from "./ClaudeFlagRow";
import type { FlagRowVariant } from "./claudeFlagRowLogic";
import {
  type FlagFilterMode,
  filterFlags,
  partitionFlags,
  rowStateFor,
} from "./claudeFlagsLogic";
import { isStillLoading } from "../../../services/claudeFlagsLogic";
import styles from "../Settings.module.css";

export interface ClaudeFlagsSettingsProps {
  scope: FlagScope;
  /// When mounted inside another section (e.g. RepoSettings) the parent
  /// already provides a heading; suppress this section's own h2 to avoid
  /// a duplicate title.
  hideHeader?: boolean;
}

export function ClaudeFlagsSettings({
  scope,
  hideHeader,
}: ClaudeFlagsSettingsProps) {
  const { t } = useTranslation("settings");
  const cachedDefs = useAppStore((s) => s.claudeFlagDefs);
  const setCachedDefs = useAppStore((s) => s.setClaudeFlagDefs);
  const invalidateAllWorkspaceClaudeFlags = useAppStore(
    (s) => s.invalidateAllWorkspaceClaudeFlags,
  );
  const invalidateClaudeFlagsForRepo = useAppStore(
    (s) => s.invalidateClaudeFlagsForRepo,
  );

  const [defsError, setDefsError] = useState<string | null>(null);
  const [defsLoading, setDefsLoading] = useState(false);
  const [state, setState] = useState<FlagStateResponse | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterMode, setFilterMode] = useState<FlagFilterMode>("all");
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadDefs = useCallback(async () => {
    setDefsLoading(true);
    setDefsError(null);
    try {
      const defs = await listClaudeFlags();
      setCachedDefs(defs);
      setDefsLoading(false);
    } catch (e) {
      if (isStillLoading(e)) {
        // Don't surface a Retry banner during the boot-time discovery
        // window — re-poll until discovery resolves to Ok or a real error.
        // Crucially, keep `defsLoading` true through the poll: a `finally`
        // clear here would leave the user staring at a blank section
        // between re-polls (no loading hint, no defs, no error).
        if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
        pollTimerRef.current = setTimeout(() => {
          if (useAppStore.getState().claudeFlagDefs === null) {
            void loadDefs();
          }
        }, 500);
        return;
      }
      setDefsError(String(e));
      setDefsLoading(false);
    }
  }, [setCachedDefs]);

  const loadState = useCallback(async () => {
    setStateError(null);
    try {
      const next = await getClaudeFlagState(scope);
      setState(next);
    } catch (e) {
      setStateError(String(e));
    }
  }, [scope]);

  useEffect(() => {
    if (cachedDefs === null) {
      void loadDefs();
    }
  }, [cachedDefs, loadDefs]);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const onRetry = useCallback(async () => {
    setDefsLoading(true);
    setDefsError(null);
    try {
      const defs = await refreshClaudeFlags();
      setCachedDefs(defs);
      // After a successful refresh, reload state so the UI reflects any
      // values for newly-discovered flags.
      void loadState();
    } catch (e) {
      setDefsError(String(e));
    } finally {
      setDefsLoading(false);
    }
  }, [setCachedDefs, loadState]);

  const invalidateScope = useCallback(() => {
    if (scope.kind === "repo") {
      invalidateClaudeFlagsForRepo(scope.repoId);
    } else {
      invalidateAllWorkspaceClaudeFlags();
    }
  }, [scope, invalidateAllWorkspaceClaudeFlags, invalidateClaudeFlagsForRepo]);

  const partition = useMemo(() => {
    if (!cachedDefs || !state) return null;
    return partitionFlags(cachedDefs, state, scope);
  }, [cachedDefs, state, scope]);

  const filteredBrowse = useMemo(() => {
    if (!partition) return [];
    return filterFlags(partition.browse, searchQuery, filterMode);
  }, [partition, searchQuery, filterMode]);

  const handleToggleEnabled = useCallback(
    async (def: ClaudeFlagDef, next: boolean) => {
      if (!state) return;
      const current = rowStateFor(def, state, scope);
      try {
        await setClaudeFlagState(
          scope,
          def.name,
          next,
          current.value ? current.value : null,
        );
        invalidateScope();
        await loadState();
      } catch (e) {
        setStateError(String(e));
      }
    },
    [state, scope, loadState, invalidateScope],
  );

  const handleValueChange = useCallback(
    async (def: ClaudeFlagDef, next: string) => {
      if (!state) return;
      const current = rowStateFor(def, state, scope);
      try {
        await setClaudeFlagState(
          scope,
          def.name,
          current.enabled,
          next === "" ? null : next,
        );
        invalidateScope();
        await loadState();
      } catch (e) {
        setStateError(String(e));
      }
    },
    [state, scope, loadState, invalidateScope],
  );

  /// Promote a flag into a configured/repo-override entry. Mirrors the old
  /// per-row "Override" toggle's `true` branch but is now driven from the
  /// browse and inherited sections. The backend seeds the value from the
  /// current effective state when value is null.
  const handlePromote = useCallback(
    async (def: ClaudeFlagDef) => {
      if (!state) return;
      const current = rowStateFor(def, state, scope);
      try {
        await setClaudeFlagState(scope, def.name, true, current.value || null);
        invalidateScope();
        await loadState();
      } catch (e) {
        setStateError(String(e));
      }
    },
    [state, scope, loadState, invalidateScope],
  );

  /// Clear the flag's persisted state at this scope. Mirrors the old
  /// per-row "Override" toggle's `false` branch at repo scope, and acts as
  /// "uninstall" at global scope.
  const handleClear = useCallback(
    async (def: ClaudeFlagDef) => {
      try {
        if (scope.kind === "repo") {
          await clearClaudeFlagRepoOverride(scope.repoId, def.name);
        } else {
          await setClaudeFlagState(scope, def.name, false, null);
        }
        invalidateScope();
        await loadState();
      } catch (e) {
        setStateError(String(e));
      }
    },
    [scope, loadState, invalidateScope],
  );

  return (
    <div>
      {!hideHeader && (
        <>
          <h2 className={styles.sectionTitle}>{t("claude_flags_title")}</h2>
          <div className={styles.fieldHint}>
            {t("claude_flags_description")}
          </div>
        </>
      )}

      {defsError && (
        <div className={styles.flagErrorBanner}>
          <div className={styles.flagErrorMessage}>
            {t("claude_flags_error_load")}
            <div className={styles.fieldHint}>{defsError}</div>
          </div>
          <button
            className={styles.iconBtn}
            onClick={onRetry}
            disabled={defsLoading}
          >
            {t("claude_flags_retry")}
          </button>
        </div>
      )}

      {stateError && <div className={styles.error}>{stateError}</div>}

      {!cachedDefs && !defsError && defsLoading && (
        <div className={styles.fieldHint}>{t("claude_flags_loading")}</div>
      )}

      {cachedDefs && state && partition && (
        <ConfiguredSections
          scope={scope}
          state={state}
          partition={partition}
          onToggleEnabled={handleToggleEnabled}
          onValueChange={handleValueChange}
          onPromote={handlePromote}
          onClear={handleClear}
        />
      )}

      {cachedDefs && state && partition && (
        <BrowseSection
          scope={scope}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          filterMode={filterMode}
          setFilterMode={setFilterMode}
          totalBrowse={partition.browse.length}
          filteredBrowse={filteredBrowse}
          onPromote={handlePromote}
        />
      )}
    </div>
  );
}

interface ConfiguredSectionsProps {
  scope: FlagScope;
  state: FlagStateResponse;
  partition: ReturnType<typeof partitionFlags>;
  onToggleEnabled: (def: ClaudeFlagDef, next: boolean) => void;
  onValueChange: (def: ClaudeFlagDef, next: string) => void;
  onPromote: (def: ClaudeFlagDef) => void;
  onClear: (def: ClaudeFlagDef) => void;
}

function ConfiguredSections({
  scope,
  state,
  partition,
  onToggleEnabled,
  onValueChange,
  onPromote,
  onClear,
}: ConfiguredSectionsProps) {
  const { t } = useTranslation("settings");
  const repoNames = useMemo(
    () => new Set(partition.repoOverrides.map((d) => d.name)),
    [partition.repoOverrides],
  );

  if (scope.kind === "global") {
    return (
      <section className={styles.flagSection}>
        <div className={styles.flagSectionHeading}>
          {t("claude_flags_configured_heading")}
          <span className={styles.flagSectionCount}>
            {partition.configured.length}
          </span>
        </div>
        {partition.configured.length === 0 ? (
          <div className={styles.flagEmptyState}>
            {t("claude_flags_no_configured")}
          </div>
        ) : (
          <div className={styles.flagList}>
            {partition.configured.map((def) =>
              renderEditableRow({
                def,
                state,
                scope,
                variant: "configured",
                onToggleEnabled,
                onValueChange,
                onClear,
              }),
            )}
          </div>
        )}
      </section>
    );
  }

  // Repo scope — two stacked sections (overrides + inherited).
  return (
    <>
      <section className={styles.flagSection}>
        <div className={styles.flagSectionHeading}>
          {t("claude_flags_repo_overrides_heading")}
          <span className={styles.flagSectionCount}>
            {partition.repoOverrides.length}
          </span>
        </div>
        {partition.repoOverrides.length === 0 ? (
          <div className={styles.flagEmptyState}>
            {t("claude_flags_no_overrides")}
          </div>
        ) : (
          <div className={styles.flagList}>
            {partition.repoOverrides.map((def) =>
              renderEditableRow({
                def,
                state,
                scope,
                variant: "repo-override",
                onToggleEnabled,
                onValueChange,
                onClear,
              }),
            )}
          </div>
        )}
      </section>

      {partition.inherited.length > 0 && (
        <section className={styles.flagSection}>
          <div className={styles.flagSectionHeading}>
            {t("claude_flags_inherited_heading")}
            <span className={styles.flagSectionCount}>
              {partition.inherited.length}
            </span>
          </div>
          <div className={styles.flagList}>
            {partition.inherited.map((def) => {
              const row = rowStateFor(def, state, { kind: "global" });
              const overridden = repoNames.has(def.name);
              return (
                <ClaudeFlagRow
                  key={def.name}
                  def={def}
                  variant="inherited"
                  enabled={row.enabled}
                  value={row.value}
                  isOverridden={overridden}
                  onPromote={overridden ? undefined : () => onPromote(def)}
                  promoteLabel={t("claude_flags_override")}
                />
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}

interface RenderEditableRowArgs {
  def: ClaudeFlagDef;
  state: FlagStateResponse;
  scope: FlagScope;
  variant: FlagRowVariant;
  onToggleEnabled: (def: ClaudeFlagDef, next: boolean) => void;
  onValueChange: (def: ClaudeFlagDef, next: string) => void;
  onClear: (def: ClaudeFlagDef) => void;
}

function renderEditableRow(args: RenderEditableRowArgs) {
  const { def, state, scope, variant, onToggleEnabled, onValueChange, onClear } =
    args;
  const row = rowStateFor(def, state, scope);
  return (
    <ClaudeFlagRow
      key={def.name}
      def={def}
      variant={variant}
      enabled={row.enabled}
      value={row.value}
      onToggleEnabled={(next) => onToggleEnabled(def, next)}
      onValueChange={(next) => onValueChange(def, next)}
      onClear={() => onClear(def)}
    />
  );
}

interface BrowseSectionProps {
  scope: FlagScope;
  searchQuery: string;
  setSearchQuery: (next: string) => void;
  filterMode: FlagFilterMode;
  setFilterMode: (next: FlagFilterMode) => void;
  totalBrowse: number;
  filteredBrowse: ClaudeFlagDef[];
  onPromote: (def: ClaudeFlagDef) => void;
}

function BrowseSection({
  scope,
  searchQuery,
  setSearchQuery,
  filterMode,
  setFilterMode,
  totalBrowse,
  filteredBrowse,
  onPromote,
}: BrowseSectionProps) {
  const { t } = useTranslation("settings");
  const promoteLabel =
    scope.kind === "repo"
      ? t("claude_flags_override")
      : t("claude_flags_add");

  return (
    <section className={styles.flagSection}>
      <div className={styles.flagSectionHeading}>
        {t("claude_flags_browse_heading")}
      </div>
      <div className={styles.pluginToolbar}>
        <div className={styles.pluginFormRow}>
          <input
            className={styles.input}
            placeholder={t("claude_flags_search_placeholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label={t("claude_flags_search_placeholder")}
          />
          <select
            className={styles.select}
            value={filterMode}
            onChange={(e) => setFilterMode(e.target.value as FlagFilterMode)}
            aria-label={t("claude_flags_filter_label")}
          >
            <option value="all">{t("claude_flags_filter_all")}</option>
            <option value="boolean">{t("claude_flags_filter_boolean")}</option>
            <option value="takes_value">
              {t("claude_flags_filter_takes_value")}
            </option>
            <option value="dangerous">
              {t("claude_flags_filter_dangerous")}
            </option>
          </select>
        </div>
        <span className={styles.pluginMeta}>
          {t("claude_flags_browse_count", {
            shown: filteredBrowse.length,
            total: totalBrowse,
          })}
        </span>
      </div>

      <div className={styles.flagBrowseList}>
        {filteredBrowse.length === 0 ? (
          <div className={styles.flagEmptyState}>
            {totalBrowse === 0
              ? t("claude_flags_empty")
              : t("claude_flags_no_match")}
          </div>
        ) : (
          filteredBrowse.map((def) => (
            <ClaudeFlagRow
              key={def.name}
              def={def}
              variant="browse"
              enabled={false}
              value=""
              onPromote={() => onPromote(def)}
              promoteLabel={promoteLabel}
            />
          ))
        )}
      </div>
    </section>
  );
}
