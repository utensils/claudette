import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Pencil, Plus } from "lucide-react";
import {
  type PinnedPrompt,
  type PinnedPromptToggleOverride,
  type PinnedPromptToggleOverrides,
  type SlashCommand,
  createPinnedPrompt,
  deletePinnedPrompt,
  listSlashCommands,
  reorderPinnedPrompts,
  updatePinnedPrompt,
} from "../../../services/tauri";
import { useAppStore } from "../../../stores/useAppStore";
import { EMPTY_PINNED_PROMPTS } from "../../../stores/slices/pinnedPromptsSlice";
import { useSlashAutocomplete } from "../../../hooks/useSlashAutocomplete";
import { PLAIN_TEXT_INPUT_PROPS } from "../../../utils/textInput";
import { SlashCommandPicker } from "../../chat/SlashCommandPicker";
import styles from "./PinnedPromptsManager.module.css";

export type PinnedPromptScope =
  | { kind: "global" }
  | { kind: "repo"; repoId: string };

interface PinnedPromptsManagerProps {
  scope: PinnedPromptScope;
  projectPath?: string;
}

interface DraftRow {
  draftId: string;
  display_name: string;
  prompt: string;
  auto_send: boolean;
  plan_mode: PinnedPromptToggleOverride;
  fast_mode: PinnedPromptToggleOverride;
  thinking_enabled: PinnedPromptToggleOverride;
  chrome_enabled: PinnedPromptToggleOverride;
}

interface EditPayload {
  display_name: string;
  prompt: string;
  auto_send: boolean;
  plan_mode: PinnedPromptToggleOverride;
  fast_mode: PinnedPromptToggleOverride;
  thinking_enabled: PinnedPromptToggleOverride;
  chrome_enabled: PinnedPromptToggleOverride;
}

function extractOverrides(p: {
  plan_mode: PinnedPromptToggleOverride;
  fast_mode: PinnedPromptToggleOverride;
  thinking_enabled: PinnedPromptToggleOverride;
  chrome_enabled: PinnedPromptToggleOverride;
}): PinnedPromptToggleOverrides {
  return {
    planMode: p.plan_mode,
    fastMode: p.fast_mode,
    thinkingEnabled: p.thinking_enabled,
    chromeEnabled: p.chrome_enabled,
  };
}

function makeDraftId(): string {
  return `draft-${Math.random().toString(36).slice(2, 10)}`;
}

export function PinnedPromptsManager({ scope, projectPath }: PinnedPromptsManagerProps) {
  const { t } = useTranslation("settings");

  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  useEffect(() => {
    let cancelled = false;
    listSlashCommands(projectPath ?? undefined)
      .then((cmds) => { if (!cancelled) setSlashCommands(cmds); })
      .catch((e) => console.error("Failed to load slash commands:", e));
    return () => { cancelled = true; };
  }, [projectPath]);

  const repoId: string | null = scope.kind === "repo" ? scope.repoId : null;

  const prompts: readonly PinnedPrompt[] = useAppStore((s) =>
    repoId
      ? (s.repoPinnedPrompts[repoId] ?? EMPTY_PINNED_PROMPTS)
      : s.globalPinnedPrompts,
  );
  const setGlobal = useAppStore((s) => s.setGlobalPinnedPrompts);
  const setForRepo = useAppStore((s) => s.setRepoPinnedPrompts);
  const upsertPrompt = useAppStore((s) => s.upsertPinnedPrompt);
  const removePromptById = useAppStore((s) => s.removePinnedPromptById);
  const loadGlobals = useAppStore((s) => s.loadGlobalPinnedPrompts);
  const loadRepo = useAppStore((s) => s.loadRepoPinnedPrompts);

  const writeBack = useCallback(
    (next: readonly PinnedPrompt[]) => {
      const copy = [...next];
      if (repoId) setForRepo(repoId, copy);
      else setGlobal(copy);
    },
    [repoId, setForRepo, setGlobal],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (repoId === null) await loadGlobals();
        else await loadRepo(repoId);
      } catch (e) {
        if (!cancelled) {
          console.error("Failed to load pinned prompts:", e);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, loadGlobals, loadRepo]);

  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [errorByKey, setErrorByKey] = useState<Record<string, string>>({});

  const setError = useCallback((key: string, msg: string | null) => {
    setErrorByKey((prev) => {
      if (msg === null) {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: msg };
    });
  }, []);

  const persistedNames = useMemo(
    () => new Set(prompts.map((p) => p.display_name)),
    [prompts],
  );

  const handleAddDraft = useCallback(() => {
    setDrafts((prev) => [
      ...prev,
      {
        draftId: makeDraftId(),
        display_name: "",
        prompt: "",
        auto_send: false,
        plan_mode: null,
        fast_mode: null,
        thinking_enabled: null,
        chrome_enabled: null,
      },
    ]);
  }, []);

  const updateDraft = useCallback(
    (draftId: string, patch: Partial<DraftRow>) => {
      setDrafts((prev) =>
        prev.map((d) => (d.draftId === draftId ? { ...d, ...patch } : d)),
      );
    },
    [],
  );

  const removeDraft = useCallback((draftId: string) => {
    setDrafts((prev) => prev.filter((d) => d.draftId !== draftId));
  }, []);

  const validateName = useCallback(
    (name: string, otherNames: Set<string>): string | null => {
      const trimmed = name.trim();
      if (!trimmed) return t("pinned_prompts_error_name_required");
      if (otherNames.has(trimmed)) return t("pinned_prompts_error_name_unique");
      return null;
    },
    [t],
  );

  const commitDraft = useCallback(
    async (draft: DraftRow) => {
      const trimmedName = draft.display_name.trim();
      const otherNames = new Set(persistedNames);
      for (const other of drafts) {
        if (other.draftId === draft.draftId) continue;
        const otherTrimmed = other.display_name.trim();
        if (otherTrimmed) otherNames.add(otherTrimmed);
      }
      const nameErr = validateName(trimmedName, otherNames);
      if (nameErr) {
        setError(draft.draftId, nameErr);
        return;
      }
      if (!draft.prompt.trim()) {
        setError(draft.draftId, t("pinned_prompts_error_prompt_required"));
        return;
      }
      setError(draft.draftId, null);
      try {
        const saved = await createPinnedPrompt(
          repoId,
          trimmedName,
          draft.prompt,
          draft.auto_send,
          extractOverrides(draft),
        );
        upsertPrompt(saved);
        removeDraft(draft.draftId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(draft.draftId, msg);
      }
    },
    [
      validateName,
      persistedNames,
      drafts,
      setError,
      t,
      repoId,
      upsertPrompt,
      removeDraft,
    ],
  );

  const commitEdit = useCallback(
    async (
      original: PinnedPrompt,
      next: EditPayload,
    ): Promise<boolean> => {
      const trimmedName = next.display_name.trim();
      const others = new Set(
        prompts.filter((p) => p.id !== original.id).map((p) => p.display_name),
      );
      for (const draft of drafts) {
        const otherTrimmed = draft.display_name.trim();
        if (otherTrimmed) others.add(otherTrimmed);
      }
      const nameErr = validateName(trimmedName, others);
      if (nameErr) {
        setError(String(original.id), nameErr);
        return false;
      }
      if (!next.prompt.trim()) {
        setError(String(original.id), t("pinned_prompts_error_prompt_required"));
        return false;
      }
      if (
        trimmedName === original.display_name &&
        next.prompt === original.prompt &&
        next.auto_send === original.auto_send &&
        next.plan_mode === original.plan_mode &&
        next.fast_mode === original.fast_mode &&
        next.thinking_enabled === original.thinking_enabled &&
        next.chrome_enabled === original.chrome_enabled
      ) {
        setError(String(original.id), null);
        return true;
      }
      setError(String(original.id), null);
      try {
        const saved = await updatePinnedPrompt(
          original.id,
          trimmedName,
          next.prompt,
          next.auto_send,
          extractOverrides(next),
        );
        upsertPrompt(saved);
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(String(original.id), msg);
        return false;
      }
    },
    [prompts, drafts, setError, t, upsertPrompt, validateName],
  );

  const handleDelete = useCallback(
    async (prompt: PinnedPrompt) => {
      const previous = prompts;
      writeBack(prompts.filter((p) => p.id !== prompt.id));
      try {
        await deletePinnedPrompt(prompt.id);
        removePromptById(prompt.id);
      } catch (e) {
        console.error("Failed to delete pinned prompt:", e);
        writeBack(previous);
      }
    },
    [prompts, writeBack, removePromptById],
  );

  const handleMove = useCallback(
    async (index: number, direction: -1 | 1) => {
      const target = index + direction;
      if (target < 0 || target >= prompts.length) return;
      const reordered = [...prompts];
      const [moved] = reordered.splice(index, 1);
      reordered.splice(target, 0, moved);
      const previous = prompts;
      writeBack(reordered);
      try {
        await reorderPinnedPrompts(
          repoId,
          reordered.map((p) => p.id),
        );
      } catch (e) {
        console.error("Failed to reorder pinned prompts:", e);
        writeBack(previous);
      }
    },
    [prompts, writeBack, repoId],
  );

  return (
    <div>
      {prompts.length === 0 && drafts.length === 0 ? (
        <div className={styles.empty}>{t("pinned_prompts_empty")}</div>
      ) : (
        <div className={styles.list}>
          {prompts.map((p, i) => (
            <PromptRow
              key={p.id}
              prompt={p}
              error={errorByKey[String(p.id)]}
              canMoveUp={i > 0}
              canMoveDown={i < prompts.length - 1}
              onMoveUp={() => handleMove(i, -1)}
              onMoveDown={() => handleMove(i, +1)}
              onDelete={() => handleDelete(p)}
              onCommit={(next) => commitEdit(p, next)}
              clearError={() => setError(String(p.id), null)}
              slashCommands={slashCommands}
            />
          ))}
          {drafts.map((d) => (
            <DraftRowView
              key={d.draftId}
              draft={d}
              error={errorByKey[d.draftId]}
              onChange={(patch) => updateDraft(d.draftId, patch)}
              onCommit={() => commitDraft(d)}
              onCancel={() => {
                setError(d.draftId, null);
                removeDraft(d.draftId);
              }}
              slashCommands={slashCommands}
            />
          ))}
        </div>
      )}

      <button
        type="button"
        className={styles.addButton}
        onClick={handleAddDraft}
      >
        <Plus size={14} />
        {t("pinned_prompts_add")}
      </button>
    </div>
  );
}

type PromptRowMode = "display" | "editing" | "confirm-delete";

interface PromptRowProps {
  prompt: PinnedPrompt;
  error: string | undefined;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onCommit: (next: EditPayload) => Promise<boolean>;
  clearError: () => void;
  slashCommands: SlashCommand[];
}

function PromptRow({
  prompt,
  error,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onDelete,
  onCommit,
  clearError,
  slashCommands,
}: PromptRowProps) {
  const { t } = useTranslation("settings");
  const [mode, setMode] = useState<PromptRowMode>("display");
  const [name, setName] = useState(prompt.display_name);
  const [body, setBody] = useState(prompt.prompt);
  const [autoSend, setAutoSend] = useState(prompt.auto_send);
  const [planMode, setPlanMode] = useState<PinnedPromptToggleOverride>(prompt.plan_mode);
  const [fastMode, setFastMode] = useState<PinnedPromptToggleOverride>(prompt.fast_mode);
  const [thinking, setThinking] = useState<PinnedPromptToggleOverride>(prompt.thinking_enabled);
  const [chromeEnabled, setChromeEnabled] = useState<PinnedPromptToggleOverride>(prompt.chrome_enabled);
  const [cursorPos, setCursorPos] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const keepButtonRef = useRef<HTMLButtonElement>(null);

  // Sync local state when the prompt is replaced from the store.
  useEffect(() => {
    setName(prompt.display_name);
    setBody(prompt.prompt);
    setAutoSend(prompt.auto_send);
    setPlanMode(prompt.plan_mode);
    setFastMode(prompt.fast_mode);
    setThinking(prompt.thinking_enabled);
    setChromeEnabled(prompt.chrome_enabled);
  }, [
    prompt.display_name,
    prompt.prompt,
    prompt.auto_send,
    prompt.plan_mode,
    prompt.fast_mode,
    prompt.thinking_enabled,
    prompt.chrome_enabled,
  ]);

  // Auto-focus when entering editing or confirm-delete modes.
  useEffect(() => {
    if (mode === "editing") nameInputRef.current?.focus();
    else if (mode === "confirm-delete") keepButtonRef.current?.focus();
  }, [mode]);

  const resetLocalState = useCallback(() => {
    setName(prompt.display_name);
    setBody(prompt.prompt);
    setAutoSend(prompt.auto_send);
    setPlanMode(prompt.plan_mode);
    setFastMode(prompt.fast_mode);
    setThinking(prompt.thinking_enabled);
    setChromeEnabled(prompt.chrome_enabled);
  }, [
    prompt.display_name,
    prompt.prompt,
    prompt.auto_send,
    prompt.plan_mode,
    prompt.fast_mode,
    prompt.thinking_enabled,
    prompt.chrome_enabled,
  ]);

  const enterEdit = useCallback(() => {
    resetLocalState();
    clearError();
    setMode("editing");
  }, [resetLocalState, clearError]);

  const cancelEdit = useCallback(() => {
    resetLocalState();
    clearError();
    setMode("display");
  }, [resetLocalState, clearError]);

  const save = useCallback(async () => {
    const ok = await onCommit({
      display_name: name,
      prompt: body,
      auto_send: autoSend,
      plan_mode: planMode,
      fast_mode: fastMode,
      thinking_enabled: thinking,
      chrome_enabled: chromeEnabled,
    });
    if (ok) setMode("display");
  }, [onCommit, name, body, autoSend, planMode, fastMode, thinking, chromeEnabled]);

  const onSlashInsert = useCallback(
    (replacement: string, start: number, end: number) => {
      const next = body.slice(0, start) + replacement + body.slice(end);
      setBody(next);
      const newCursor = start + replacement.length;
      setCursorPos(newCursor);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.selectionStart = ta.selectionEnd = newCursor;
          ta.focus();
        }
      });
    },
    [body],
  );

  const slash = useSlashAutocomplete({
    value: body,
    cursorPosition: cursorPos,
    commands: slashCommands,
    onInsert: onSlashInsert,
  });

  const updateCursor = useCallback((el: HTMLTextAreaElement) => {
    setCursorPos(el.selectionStart);
  }, []);

  const canSave = name.trim().length > 0 && body.trim().length > 0;

  // Save/cancel shortcuts that work from any field in the editor.
  const handleSaveCancelKey = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (canSave) void save();
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit();
        return true;
      }
      return false;
    },
    [canSave, save, cancelEdit],
  );

  // Name input: only Cmd/Ctrl+Enter and Esc — never the slash picker, which
  // is anchored to the textarea. Otherwise arrow/Enter keys in the name field
  // would navigate/select picker items while the user is typing a name.
  const handleNameKeyDown = handleSaveCancelKey;

  // Textarea: slash autocomplete consumes its own keys first, then save/cancel.
  const handleEditorKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (slash.handleKeyDown(e)) {
        e.preventDefault();
        return;
      }
      handleSaveCancelKey(e);
    },
    [slash, handleSaveCancelKey],
  );

  // ---------- Display mode ----------
  if (mode === "display") {
    return (
      <div className={styles.row}>
        <div className={styles.displayHeader}>
          <span className={styles.displayName}>{prompt.display_name}</span>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.iconButton}
              disabled={!canMoveUp}
              onClick={onMoveUp}
              aria-label={t("pinned_prompts_move_up")}
              title={t("pinned_prompts_move_up")}
            >
              <ChevronUp size={14} />
            </button>
            <button
              type="button"
              className={styles.iconButton}
              disabled={!canMoveDown}
              onClick={onMoveDown}
              aria-label={t("pinned_prompts_move_down")}
              title={t("pinned_prompts_move_down")}
            >
              <ChevronDown size={14} />
            </button>
            <button
              type="button"
              className={styles.iconButton}
              onClick={enterEdit}
              aria-label={t("pinned_prompts_edit_action", { name: prompt.display_name })}
              title={t("pinned_prompts_edit_action", { name: prompt.display_name })}
            >
              <Pencil size={14} />
            </button>
          </div>
        </div>
        <div className={styles.displayPreview}>{prompt.prompt}</div>
        {(prompt.auto_send || hasAnyOverride(prompt)) && (
          <div className={styles.displayMeta}>
            <OverrideSummary prompt={prompt} />
            {prompt.auto_send && <span>{t("pinned_prompts_auto_send")}</span>}
          </div>
        )}
      </div>
    );
  }

  // ---------- Editing / Confirm-delete modes (shared editor body) ----------
  const cardClass = mode === "confirm-delete"
    ? `${styles.row} ${styles.rowDangerous}`
    : `${styles.row} ${styles.rowEditing}`;

  return (
    <div className={cardClass}>
      <div className={styles.rowHeader}>
        <input
          ref={nameInputRef}
          className={error ? styles.nameInputError : styles.nameInput}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={handleNameKeyDown}
          placeholder={t("pinned_prompts_display_name_placeholder")}
          aria-label={t("pinned_prompts_display_name_label")}
          disabled={mode === "confirm-delete"}
          {...PLAIN_TEXT_INPUT_PROPS}
        />
      </div>
      <div className={styles.textareaWrapper}>
        <textarea
          ref={textareaRef}
          className={styles.promptInput}
          value={body}
          onChange={(e) => { setBody(e.target.value); updateCursor(e.target); }}
          onSelect={(e) => updateCursor(e.currentTarget)}
          onKeyDown={handleEditorKeyDown}
          rows={3}
          placeholder={t("pinned_prompts_prompt_placeholder")}
          aria-label={t("pinned_prompts_prompt_label")}
          disabled={mode === "confirm-delete"}
          {...PLAIN_TEXT_INPUT_PROPS}
        />
        {mode === "editing" && slash.showPicker && (
          <SlashCommandPicker
            commands={slash.filteredCommands}
            selectedIndex={slash.selectedIndex}
            onSelect={slash.selectCommand}
            onHover={slash.setSelectedIndex}
            placement="below"
          />
        )}
      </div>
      <div className={styles.controlsRow}>
        <label className={styles.autoSendLabel}>
          <input
            type="checkbox"
            checked={autoSend}
            onChange={(e) => setAutoSend(e.target.checked)}
            disabled={mode === "confirm-delete"}
          />
          {t("pinned_prompts_auto_send")}
        </label>
        {error && <span className={styles.errorText}>{error}</span>}
      </div>

      <OverrideControls
        disabled={mode === "confirm-delete"}
        planMode={planMode}
        fastMode={fastMode}
        thinking={thinking}
        chromeEnabled={chromeEnabled}
        onPlanModeChange={setPlanMode}
        onFastModeChange={setFastMode}
        onThinkingChange={setThinking}
        onChromeEnabledChange={setChromeEnabled}
      />

      {mode === "editing" ? (
        <div className={styles.footer}>
          <button
            type="button"
            className={styles.btnDestructiveText}
            onClick={() => setMode("confirm-delete")}
          >
            {t("pinned_prompts_delete_prompt")}
          </button>
          <div className={styles.footerSpacer} />
          <button type="button" className={styles.btnGhost} onClick={cancelEdit}>
            {t("pinned_prompts_cancel")}
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={() => void save()}
            disabled={!canSave}
          >
            {t("pinned_prompts_save_changes")}
          </button>
        </div>
      ) : (
        <div className={styles.confirmPanel}>
          <div className={styles.confirmCopy}>
            <div className={styles.confirmTitle}>
              {t("pinned_prompts_confirm_delete_title")}
            </div>
            <div className={styles.confirmSubtitle}>
              {t("pinned_prompts_confirm_delete_subtitle")}
            </div>
          </div>
          <div className={styles.confirmActions}>
            <button
              ref={keepButtonRef}
              type="button"
              className={styles.btnGhost}
              onClick={() => setMode("editing")}
            >
              {t("pinned_prompts_keep")}
            </button>
            <button
              type="button"
              className={styles.btnDestructiveFill}
              onClick={onDelete}
            >
              {t("pinned_prompts_delete_prompt")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface DraftRowViewProps {
  draft: DraftRow;
  error: string | undefined;
  onChange: (patch: Partial<DraftRow>) => void;
  onCommit: () => void;
  onCancel: () => void;
  slashCommands: SlashCommand[];
}

function DraftRowView({
  draft,
  error,
  onChange,
  onCommit,
  onCancel,
  slashCommands,
}: DraftRowViewProps) {
  const { t } = useTranslation("settings");
  const [cursorPos, setCursorPos] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const onSlashInsert = useCallback(
    (replacement: string, start: number, end: number) => {
      const next = draft.prompt.slice(0, start) + replacement + draft.prompt.slice(end);
      onChange({ prompt: next });
      const newCursor = start + replacement.length;
      setCursorPos(newCursor);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.selectionStart = ta.selectionEnd = newCursor;
          ta.focus();
        }
      });
    },
    [draft.prompt, onChange],
  );

  const slash = useSlashAutocomplete({
    value: draft.prompt,
    cursorPosition: cursorPos,
    commands: slashCommands,
    onInsert: onSlashInsert,
  });

  const updateCursor = useCallback((el: HTMLTextAreaElement) => {
    setCursorPos(el.selectionStart);
  }, []);

  const canSave =
    draft.display_name.trim().length > 0 && draft.prompt.trim().length > 0;

  const handleSaveCancelKey = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (canSave) onCommit();
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return true;
      }
      return false;
    },
    [canSave, onCommit, onCancel],
  );

  // Name input: save/cancel only — the picker is anchored to the textarea.
  const handleNameKeyDown = handleSaveCancelKey;

  const handleEditorKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (slash.handleKeyDown(e)) {
        e.preventDefault();
        return;
      }
      handleSaveCancelKey(e);
    },
    [slash, handleSaveCancelKey],
  );

  return (
    <div className={`${styles.row} ${styles.rowEditing}`}>
      <div className={styles.rowHeader}>
        <input
          className={error ? styles.nameInputError : styles.nameInput}
          value={draft.display_name}
          onChange={(e) => onChange({ display_name: e.target.value })}
          onKeyDown={handleNameKeyDown}
          placeholder={t("pinned_prompts_display_name_placeholder")}
          aria-label={t("pinned_prompts_display_name_label")}
          autoFocus
          {...PLAIN_TEXT_INPUT_PROPS}
        />
      </div>
      <div className={styles.textareaWrapper}>
        <textarea
          ref={textareaRef}
          className={styles.promptInput}
          value={draft.prompt}
          onChange={(e) => { onChange({ prompt: e.target.value }); updateCursor(e.target); }}
          onSelect={(e) => updateCursor(e.currentTarget)}
          onKeyDown={handleEditorKeyDown}
          rows={3}
          placeholder={t("pinned_prompts_prompt_placeholder")}
          aria-label={t("pinned_prompts_prompt_label")}
          {...PLAIN_TEXT_INPUT_PROPS}
        />
        {slash.showPicker && (
          <SlashCommandPicker
            commands={slash.filteredCommands}
            selectedIndex={slash.selectedIndex}
            onSelect={slash.selectCommand}
            onHover={slash.setSelectedIndex}
            placement="below"
          />
        )}
      </div>
      <div className={styles.controlsRow}>
        <label className={styles.autoSendLabel}>
          <input
            type="checkbox"
            checked={draft.auto_send}
            onChange={(e) => onChange({ auto_send: e.target.checked })}
          />
          {t("pinned_prompts_auto_send")}
        </label>
        {error && <span className={styles.errorText}>{error}</span>}
      </div>

      <OverrideControls
        planMode={draft.plan_mode}
        fastMode={draft.fast_mode}
        thinking={draft.thinking_enabled}
        chromeEnabled={draft.chrome_enabled}
        onPlanModeChange={(v) => onChange({ plan_mode: v })}
        onFastModeChange={(v) => onChange({ fast_mode: v })}
        onThinkingChange={(v) => onChange({ thinking_enabled: v })}
        onChromeEnabledChange={(v) => onChange({ chrome_enabled: v })}
      />

      <div className={styles.footer}>
        <div className={styles.footerSpacer} />
        <button type="button" className={styles.btnGhost} onClick={onCancel}>
          {t("pinned_prompts_cancel")}
        </button>
        <button
          type="button"
          className={styles.btnPrimary}
          onClick={onCommit}
          disabled={!canSave}
        >
          {t("pinned_prompts_save_draft")}
        </button>
      </div>
    </div>
  );
}

interface InheritedGlobalsListProps {
  globals: PinnedPrompt[];
  repoNames: Set<string>;
}

export function InheritedGlobalsList({
  globals,
  repoNames,
}: InheritedGlobalsListProps) {
  const { t } = useTranslation("settings");
  if (globals.length === 0) return null;
  return (
    <div>
      <div className={styles.inheritedHeading}>
        {t("pinned_prompts_inherited_label")}
      </div>
      {globals.map((g) => {
        const overridden = repoNames.has(g.display_name);
        return (
          <div key={g.id} className={styles.inheritedRow}>
            <span className={styles.inheritedName}>{g.display_name}</span>
            <span className={styles.inheritedPrompt}>{g.prompt}</span>
            {overridden && (
              <span className={styles.overriddenBadge}>
                {t("pinned_prompts_overridden_badge")}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ===== Toolbar override controls (tri-state segmented) =====

interface OverrideControlsProps {
  disabled?: boolean;
  planMode: PinnedPromptToggleOverride;
  fastMode: PinnedPromptToggleOverride;
  thinking: PinnedPromptToggleOverride;
  chromeEnabled: PinnedPromptToggleOverride;
  onPlanModeChange: (v: PinnedPromptToggleOverride) => void;
  onFastModeChange: (v: PinnedPromptToggleOverride) => void;
  onThinkingChange: (v: PinnedPromptToggleOverride) => void;
  onChromeEnabledChange: (v: PinnedPromptToggleOverride) => void;
}

function OverrideControls({
  disabled,
  planMode,
  fastMode,
  thinking,
  chromeEnabled,
  onPlanModeChange,
  onFastModeChange,
  onThinkingChange,
  onChromeEnabledChange,
}: OverrideControlsProps) {
  const { t } = useTranslation("settings");
  return (
    <div className={styles.overridesGroup}>
      <div className={styles.overridesLabel}>
        {t("pinned_prompts_toggle_overrides_label")}
      </div>
      <SegmentedTriState
        label={t("pinned_prompts_override_plan_mode")}
        value={planMode}
        onChange={onPlanModeChange}
        disabled={disabled}
      />
      <SegmentedTriState
        label={t("pinned_prompts_override_fast_mode")}
        value={fastMode}
        onChange={onFastModeChange}
        disabled={disabled}
      />
      <SegmentedTriState
        label={t("pinned_prompts_override_thinking")}
        value={thinking}
        onChange={onThinkingChange}
        disabled={disabled}
      />
      <SegmentedTriState
        label={t("pinned_prompts_override_chrome")}
        value={chromeEnabled}
        onChange={onChromeEnabledChange}
        disabled={disabled}
      />
    </div>
  );
}

interface SegmentedTriStateProps {
  label: string;
  value: PinnedPromptToggleOverride;
  onChange: (v: PinnedPromptToggleOverride) => void;
  disabled?: boolean;
}

// Encode tri-state value as a radio `value` string (radios are string-only).
type TriStateKey = "inherit" | "on" | "off";
function encodeTriState(v: PinnedPromptToggleOverride): TriStateKey {
  if (v === null) return "inherit";
  return v ? "on" : "off";
}
function decodeTriState(s: TriStateKey): PinnedPromptToggleOverride {
  if (s === "inherit") return null;
  return s === "on";
}

function SegmentedTriState({ label, value, onChange, disabled }: SegmentedTriStateProps) {
  const { t } = useTranslation("settings");
  // useId gives each instance a unique radio-group name, so two
  // SegmentedTriState components on the same page don't share selection.
  const groupName = useId();
  const buttonClass = (active: boolean) =>
    active ? styles.segmentedButtonActive : styles.segmentedButton;

  // Native <input type="radio"> gives us roving-tabindex + Left/Right/Up/Down
  // arrow navigation for free — handled by the browser, which is what
  // `role="radiogroup"` promises to assistive tech. The visible "buttons"
  // are <label>s associated with hidden radio inputs.
  const options: { key: TriStateKey; label: string }[] = [
    { key: "inherit", label: t("pinned_prompts_override_inherit") },
    { key: "on", label: t("pinned_prompts_override_on") },
    { key: "off", label: t("pinned_prompts_override_off") },
  ];
  const selected = encodeTriState(value);

  return (
    <div className={styles.overrideRow}>
      <span className={styles.overrideName}>{label}</span>
      <div className={styles.segmentedControl} role="radiogroup" aria-label={label}>
        {options.map((opt) => {
          const id = `${groupName}-${opt.key}`;
          const checked = selected === opt.key;
          return (
            <Fragment key={opt.key}>
              <input
                type="radio"
                id={id}
                name={groupName}
                value={opt.key}
                checked={checked}
                onChange={() => onChange(decodeTriState(opt.key))}
                disabled={disabled}
                className={styles.segmentedRadioInput}
              />
              <label htmlFor={id} className={buttonClass(checked)}>
                {opt.label}
              </label>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

function hasAnyOverride(p: PinnedPrompt): boolean {
  return (
    p.plan_mode !== null ||
    p.fast_mode !== null ||
    p.thinking_enabled !== null ||
    p.chrome_enabled !== null
  );
}

function OverrideSummary({ prompt }: { prompt: PinnedPrompt }) {
  const { t } = useTranslation("settings");
  const chips: { key: string; label: string; on: boolean }[] = [];
  if (prompt.plan_mode !== null) {
    chips.push({
      key: "plan",
      label: t("pinned_prompts_override_plan_mode"),
      on: prompt.plan_mode,
    });
  }
  if (prompt.fast_mode !== null) {
    chips.push({
      key: "fast",
      label: t("pinned_prompts_override_fast_mode"),
      on: prompt.fast_mode,
    });
  }
  if (prompt.thinking_enabled !== null) {
    chips.push({
      key: "thinking",
      label: t("pinned_prompts_override_thinking"),
      on: prompt.thinking_enabled,
    });
  }
  if (prompt.chrome_enabled !== null) {
    chips.push({
      key: "chrome",
      label: t("pinned_prompts_override_chrome"),
      on: prompt.chrome_enabled,
    });
  }
  if (chips.length === 0) return null;
  return (
    <>
      {chips.map((c) => (
        <span key={c.key} className={styles.overrideSummaryChip}>
          {c.label}: {c.on ? t("pinned_prompts_override_on") : t("pinned_prompts_override_off")}
        </span>
      ))}
    </>
  );
}
