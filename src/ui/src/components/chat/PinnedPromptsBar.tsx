import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import {
  EMPTY_PINNED_PROMPTS,
  mergePinnedPrompts,
} from "../../stores/slices/pinnedPromptsSlice";
import type { PinnedPrompt } from "../../services/tauri";
import styles from "./PinnedPromptsBar.module.css";

interface PinnedPromptsBarProps {
  repoId: string | undefined;
  onUsePinnedPrompt: (prompt: PinnedPrompt) => void;
}

/**
 * The pinned-prompts pill bar above the composer.
 *
 * Pills are click-to-use only — adding, editing, and removing prompts now
 * lives in Settings → Pinned Prompts (global) and per-repo settings.
 *
 * Globals appear in every workspace; repo-scoped prompts come first and
 * silently shadow globals with the same display name.
 */
export function PinnedPromptsBar({
  repoId,
  onUsePinnedPrompt,
}: PinnedPromptsBarProps) {
  const { t } = useTranslation("chat");

  // Subscribe to the raw slice arrays. Zustand keeps these references stable
  // until the underlying lists actually change, so the merge below only
  // reruns on real updates — not on every store tick.
  const globalPrompts = useAppStore((s) => s.globalPinnedPrompts);
  const repoPrompts = useAppStore((s) =>
    repoId
      ? (s.repoPinnedPrompts[repoId] ?? EMPTY_PINNED_PROMPTS)
      : EMPTY_PINNED_PROMPTS,
  );
  const loadGlobals = useAppStore((s) => s.loadGlobalPinnedPrompts);
  const loadRepo = useAppStore((s) => s.loadRepoPinnedPrompts);

  const prompts = useMemo(
    () => mergePinnedPrompts(repoPrompts, globalPrompts, repoId ?? null),
    [repoPrompts, globalPrompts, repoId],
  );

  useEffect(() => {
    loadGlobals().catch((e) =>
      console.error("Failed to load global pinned prompts:", e),
    );
  }, [loadGlobals]);

  useEffect(() => {
    if (!repoId) return;
    loadRepo(repoId).catch((e) =>
      console.error("Failed to load repo pinned prompts:", e),
    );
  }, [repoId, loadRepo]);

  if (prompts.length === 0) return null;

  return (
    <div className={styles.bar}>
      <span className={styles.label}>{t("pinned_prompts_label")}</span>
      {prompts.map((p) => {
        const tooltipKey = p.auto_send
          ? "pinned_prompt_tooltip_auto"
          : "pinned_prompt_tooltip_insert";
        return (
          <span key={p.id} className={styles.pill}>
            <button
              type="button"
              className={styles.pillAction}
              onClick={() => onUsePinnedPrompt(p)}
              title={t(tooltipKey, { name: p.display_name })}
            >
              {p.display_name}
            </button>
          </span>
        );
      })}
    </div>
  );
}
