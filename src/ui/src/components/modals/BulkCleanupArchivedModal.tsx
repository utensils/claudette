import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { GitBranch } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import { deleteWorkspacesBulk } from "../../services/tauri";
import type { Workspace } from "../../types";
import { Modal } from "./Modal";
import shared from "./shared.module.css";
import styles from "./BulkCleanupArchivedModal.module.css";
import {
  AGE_FILTERS,
  type AgeBucket,
  type AgeFilter,
  ageBucket,
  filterByAge,
} from "./BulkCleanupArchivedModal.helpers";

export function BulkCleanupArchivedModal() {
  const { t } = useTranslation("modals");
  const { t: tCommon } = useTranslation("common");
  const closeModal = useAppStore((s) => s.closeModal);
  const modalData = useAppStore((s) => s.modalData);
  // `repoId` lives in `modalData`, which is typed as `Record<string,
  // unknown>` — every entry surface in this PR populates it, but a
  // future deep link / command-palette item could open the modal
  // without it. Guard so the modal closes loudly instead of rendering
  // an empty selection that looks like the cleanup just succeeded.
  const repoId =
    typeof modalData.repoId === "string" && modalData.repoId.length > 0
      ? modalData.repoId
      : null;
  const workspaces = useAppStore((s) => s.workspaces);
  const repositories = useAppStore((s) => s.repositories);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const addToast = useAppStore((s) => s.addToast);

  useEffect(() => {
    if (!repoId) closeModal();
  }, [repoId, closeModal]);

  const repo = useMemo(
    () => (repoId ? repositories.find((r) => r.id === repoId) ?? null : null),
    [repositories, repoId],
  );

  const ageBucketLabel = (bucket: AgeBucket | null): string => {
    if (!bucket) return "";
    switch (bucket.kind) {
      case "today":
        return t("bulk_cleanup_age_today");
      case "days":
        return t("bulk_cleanup_age_days", { count: bucket.count });
      case "months":
        return t("bulk_cleanup_age_months", { count: bucket.count });
      case "years":
        return t("bulk_cleanup_age_years", { count: bucket.count });
    }
  };

  const archived = useMemo<Workspace[]>(
    () =>
      workspaces
        // Drop rows owned by a paired remote connection — the local
        // Tauri delete command only validates IDs in the desktop app's
        // local DB and would reject them. Entry points already gate by
        // repo, but this is a belt-and-suspenders defense in case a
        // future surface (command palette, deep link) lands here with a
        // remote repo id.
        .filter(
          (w) =>
            w.repository_id === repoId &&
            w.status === "Archived" &&
            !w.remote_connection_id,
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [workspaces, repoId],
  );

  const [ageFilter, setAgeFilter] = useState<AgeFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [failures, setFailures] = useState<Map<string, string>>(new Map());

  // Treat the modal's mounted instant as "now". Stable across renders so
  // the age column doesn't tick mid-selection.
  const nowSecs = useMemo(
    () => Math.floor(Date.now() / 1000),
    [],
  );

  const eligible = useMemo<Workspace[]>(
    () => filterByAge(archived, ageFilter, nowSecs),
    [archived, ageFilter, nowSecs],
  );

  const eligibleIds = useMemo(
    () => new Set(eligible.map((w) => w.id)),
    [eligible],
  );

  // Selection is always the intersection of user picks with eligibility —
  // switching the filter to a stricter window can never delete more rows
  // than the user can see.
  const effectiveSelection = useMemo(() => {
    const out = new Set<string>();
    for (const id of selected) {
      if (eligibleIds.has(id)) out.add(id);
    }
    return out;
  }, [selected, eligibleIds]);

  const allEligibleSelected =
    eligible.length > 0 && effectiveSelection.size === eligible.length;

  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allEligibleSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(eligible.map((w) => w.id)));
    }
  };

  const handleDelete = async () => {
    const ids = [...effectiveSelection];
    if (ids.length === 0) return;
    setDeleting(true);
    try {
      const result = await deleteWorkspacesBulk(ids);
      for (const id of result.deleted) {
        removeWorkspace(id);
      }
      if (result.failed.length === 0) {
        addToast(
          t(
            result.deleted.length === 1
              ? "bulk_cleanup_success_singular"
              : "bulk_cleanup_success_plural",
            { count: result.deleted.length },
          ),
        );
        closeModal();
        return;
      }
      // Partial failure: keep the modal open, surface per-row errors,
      // shrink the selection to the rows that actually need attention.
      const failureMap = new Map<string, string>();
      for (const f of result.failed) failureMap.set(f.id, f.error);
      setFailures(failureMap);
      setSelected(new Set(result.failed.map((f) => f.id)));
      addToast(
        t("bulk_cleanup_partial", {
          succeeded: result.deleted.length,
          failed: result.failed.length,
        }),
      );
    } catch (e) {
      addToast(
        t("bulk_cleanup_failed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal
      title={t("bulk_cleanup_title", {
        repo: repo?.name ?? t("bulk_cleanup_title_fallback_repo"),
      })}
      onClose={closeModal}
      wide
      bodyScroll
    >
      <div className={shared.warning}>{t("bulk_cleanup_warning")}</div>

      <div className={styles.filterRow}>
        <span className={styles.filterLabel}>
          {t("bulk_cleanup_older_than")}
        </span>
        <div className={styles.filterChoices} role="radiogroup">
          {AGE_FILTERS.map((f) => (
            <label
              key={f.key}
              className={
                ageFilter === f.key
                  ? styles.filterChipActive
                  : styles.filterChip
              }
            >
              <input
                type="radio"
                name="bulk-cleanup-age"
                value={f.key}
                checked={ageFilter === f.key}
                onChange={() => setAgeFilter(f.key)}
                className={styles.filterRadio}
              />
              {t(`bulk_cleanup_filter_${f.key}`)}
            </label>
          ))}
        </div>
      </div>

      <div className={styles.headerRow}>
        <label className={styles.selectAllLabel}>
          <input
            type="checkbox"
            checked={allEligibleSelected}
            disabled={eligible.length === 0}
            onChange={toggleSelectAll}
          />
          <span>{t("bulk_cleanup_select_all")}</span>
        </label>
        <span className={styles.counter}>
          {t("bulk_cleanup_counter", {
            selected: effectiveSelection.size,
            total: eligible.length,
          })}
        </span>
      </div>

      {eligible.length === 0 ? (
        <div className={styles.empty}>{t("bulk_cleanup_no_eligible")}</div>
      ) : (
        <ul className={styles.list}>
          {eligible.map((ws) => {
            const isSelected = effectiveSelection.has(ws.id);
            const err = failures.get(ws.id);
            return (
              <li key={ws.id} className={styles.row}>
                <label className={styles.rowLabel}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleRow(ws.id)}
                  />
                  <span className={styles.rowName}>{ws.name}</span>
                  <span className={styles.rowBranch}>
                    <GitBranch size={11} aria-hidden="true" />
                    {ws.branch_name}
                  </span>
                  <span className={styles.rowAge}>
                    {ageBucketLabel(ageBucket(ws.created_at, nowSecs))}
                  </span>
                </label>
                {err && <div className={styles.rowError}>{err}</div>}
              </li>
            );
          })}
        </ul>
      )}

      <div className={shared.actions}>
        <button className={shared.btn} onClick={closeModal} disabled={deleting}>
          {tCommon("cancel")}
        </button>
        <button
          className={shared.btnDanger}
          onClick={handleDelete}
          disabled={deleting || effectiveSelection.size === 0}
        >
          {deleting
            ? t("bulk_cleanup_deleting")
            : t("bulk_cleanup_confirm", { count: effectiveSelection.size })}
        </button>
      </div>
    </Modal>
  );
}
