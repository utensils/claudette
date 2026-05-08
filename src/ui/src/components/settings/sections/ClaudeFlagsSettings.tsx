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
import type { FlagRowScope } from "./claudeFlagRowLogic";
import { rowStateFor, sortFlags } from "./claudeFlagsLogic";
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
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadDefs = useCallback(async () => {
    setDefsLoading(true);
    setDefsError(null);
    try {
      const defs = await listClaudeFlags();
      setCachedDefs(defs);
    } catch (e) {
      if (isStillLoading(e)) {
        // Don't surface a Retry banner during the boot-time discovery
        // window — re-poll until discovery resolves to Ok or a real error.
        if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
        pollTimerRef.current = setTimeout(() => {
          if (useAppStore.getState().claudeFlagDefs === null) {
            void loadDefs();
          }
        }, 500);
        return;
      }
      setDefsError(String(e));
    } finally {
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

  const rowScope: FlagRowScope = scope.kind === "repo" ? "repo" : "global";

  const sortedDefs = useMemo(
    () => (cachedDefs ? sortFlags(cachedDefs) : []),
    [cachedDefs],
  );

  const handleToggleEnabled = useCallback(
    async (def: ClaudeFlagDef, next: boolean) => {
      const current = state ? rowStateFor(def, state, scope) : null;
      try {
        await setClaudeFlagState(
          scope,
          def.name,
          next,
          current?.value ? current.value : null,
        );
        if (scope.kind === "repo") {
          invalidateClaudeFlagsForRepo(scope.repoId);
        } else {
          invalidateAllWorkspaceClaudeFlags();
        }
        await loadState();
      } catch (e) {
        setStateError(String(e));
      }
    },
    [
      state,
      scope,
      loadState,
      invalidateAllWorkspaceClaudeFlags,
      invalidateClaudeFlagsForRepo,
    ],
  );

  const handleValueChange = useCallback(
    async (def: ClaudeFlagDef, next: string) => {
      const current = state ? rowStateFor(def, state, scope) : null;
      try {
        await setClaudeFlagState(
          scope,
          def.name,
          current?.enabled ?? false,
          next === "" ? null : next,
        );
        if (scope.kind === "repo") {
          invalidateClaudeFlagsForRepo(scope.repoId);
        } else {
          invalidateAllWorkspaceClaudeFlags();
        }
        await loadState();
      } catch (e) {
        setStateError(String(e));
      }
    },
    [
      state,
      scope,
      loadState,
      invalidateAllWorkspaceClaudeFlags,
      invalidateClaudeFlagsForRepo,
    ],
  );

  const handleToggleOverride = useCallback(
    async (def: ClaudeFlagDef, next: boolean) => {
      if (scope.kind !== "repo") return;
      try {
        if (next) {
          // Seed override from current effective value (the backend does the
          // seed-from-global itself when value=null).
          const current = state ? rowStateFor(def, state, scope) : null;
          await setClaudeFlagState(
            scope,
            def.name,
            current?.enabled ?? false,
            null,
          );
        } else {
          await clearClaudeFlagRepoOverride(scope.repoId, def.name);
        }
        if (scope.kind === "repo") {
          invalidateClaudeFlagsForRepo(scope.repoId);
        } else {
          invalidateAllWorkspaceClaudeFlags();
        }
        await loadState();
      } catch (e) {
        setStateError(String(e));
      }
    },
    [
      scope,
      state,
      loadState,
      invalidateAllWorkspaceClaudeFlags,
      invalidateClaudeFlagsForRepo,
    ],
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

      {cachedDefs && state && (
        <div>
          {sortedDefs.map((def) => {
            const row = rowStateFor(def, state, scope);
            return (
              <ClaudeFlagRow
                key={def.name}
                def={def}
                enabled={row.enabled}
                value={row.value}
                scope={rowScope}
                isOverride={row.isOverride}
                onToggleEnabled={(next) => handleToggleEnabled(def, next)}
                onValueChange={(next) => handleValueChange(def, next)}
                onToggleOverride={
                  rowScope === "repo"
                    ? (next) => handleToggleOverride(def, next)
                    : undefined
                }
              />
            );
          })}
          {sortedDefs.length === 0 && (
            <div className={styles.fieldHint}>{t("claude_flags_empty")}</div>
          )}
        </div>
      )}
    </div>
  );
}
