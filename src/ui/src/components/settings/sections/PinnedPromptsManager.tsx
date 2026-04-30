import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Plus, Save, Trash2 } from "lucide-react";
import {
  type PinnedPrompt,
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
}

function makeDraftId(): string {
  return `draft-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Settings UI for managing pinned prompts in a single scope.
 *
 * Renders the existing prompts, lets the user edit/reorder/delete them, and
 * exposes an "Add prompt" affordance. Persistence is optimistic; failures
 * roll back and surface an inline error.
 */
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

  // `null` for global scope, repo id string for repo scope. Used both as the
  // store key and as the API parameter — they're the same primitive.
  const repoId: string | null = scope.kind === "repo" ? scope.repoId : null;

  // Subscribe to the raw slice values. We deliberately reuse a single empty
  // array reference (EMPTY_PINNED_PROMPTS) for the missing-key case so the
  // selector returns a stable reference until the load completes — otherwise
  // useSyncExternalStore loops on the fresh `[]`.
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

  // Hydrate this scope when the manager mounts.
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
      // Other names must include both persisted prompts and any sibling
      // drafts in this scope — otherwise two drafts can race past the
      // client-side check and surface a raw SQLite UNIQUE error on save.
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
      next: { display_name: string; prompt: string; auto_send: boolean },
    ) => {
      const trimmedName = next.display_name.trim();
      // Other-name check must exclude the prompt being edited but include
      // sibling drafts so an edit can't collide with a not-yet-saved draft.
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
        return;
      }
      if (!next.prompt.trim()) {
        setError(String(original.id), t("pinned_prompts_error_prompt_required"));
        return;
      }
      // Skip the round-trip when nothing changed.
      if (
        trimmedName === original.display_name &&
        next.prompt === original.prompt &&
        next.auto_send === original.auto_send
      ) {
        setError(String(original.id), null);
        return;
      }
      setError(String(original.id), null);
      try {
        const saved = await updatePinnedPrompt(
          original.id,
          trimmedName,
          next.prompt,
          next.auto_send,
        );
        upsertPrompt(saved);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(String(original.id), msg);
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

interface PromptRowProps {
  prompt: PinnedPrompt;
  error: string | undefined;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onCommit: (next: {
    display_name: string;
    prompt: string;
    auto_send: boolean;
  }) => void;
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
  slashCommands,
}: PromptRowProps) {
  const { t } = useTranslation("settings");
  const [name, setName] = useState(prompt.display_name);
  const [body, setBody] = useState(prompt.prompt);
  const [autoSend, setAutoSend] = useState(prompt.auto_send);
  const [cursorPos, setCursorPos] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync local state when the prompt is replaced from the store (e.g. after a
  // successful save returns the canonical row, or another tab reloads).
  useEffect(() => {
    setName(prompt.display_name);
    setBody(prompt.prompt);
    setAutoSend(prompt.auto_send);
  }, [prompt.display_name, prompt.prompt, prompt.auto_send]);

  const flush = useCallback(() => {
    onCommit({ display_name: name, prompt: body, auto_send: autoSend });
  }, [onCommit, name, body, autoSend]);

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

  return (
    <div className={styles.row}>
      <div className={styles.rowHeader}>
        <input
          className={error ? styles.nameInputError : styles.nameInput}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={flush}
          placeholder={t("pinned_prompts_display_name_placeholder")}
          aria-label={t("pinned_prompts_display_name_label")}
        />
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
            className={styles.deleteButton}
            onClick={onDelete}
            aria-label={t("pinned_prompts_delete", { name: prompt.display_name })}
            title={t("pinned_prompts_delete", { name: prompt.display_name })}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      <div className={styles.textareaWrapper}>
        <textarea
          ref={textareaRef}
          className={styles.promptInput}
          value={body}
          onChange={(e) => { setBody(e.target.value); updateCursor(e.target); }}
          onSelect={(e) => updateCursor(e.currentTarget)}
          onBlur={flush}
          onKeyDown={(e) => { if (slash.handleKeyDown(e)) e.preventDefault(); }}
          rows={3}
          placeholder={t("pinned_prompts_prompt_placeholder")}
          aria-label={t("pinned_prompts_prompt_label")}
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
            checked={autoSend}
            onChange={(e) => {
              setAutoSend(e.target.checked);
              onCommit({
                display_name: name,
                prompt: body,
                auto_send: e.target.checked,
              });
            }}
          />
          {t("pinned_prompts_auto_send")}
        </label>
        {error && <span className={styles.errorText}>{error}</span>}
      </div>
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

  return (
    <div className={styles.row}>
      <div className={styles.rowHeader}>
        <input
          className={error ? styles.nameInputError : styles.nameInput}
          value={draft.display_name}
          onChange={(e) => onChange({ display_name: e.target.value })}
          placeholder={t("pinned_prompts_display_name_placeholder")}
          aria-label={t("pinned_prompts_display_name_label")}
          autoFocus
        />
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.deleteButton}
            onClick={onCancel}
            aria-label={t("pinned_prompts_cancel_draft")}
            title={t("pinned_prompts_cancel_draft")}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      <div className={styles.textareaWrapper}>
        <textarea
          ref={textareaRef}
          className={styles.promptInput}
          value={draft.prompt}
          onChange={(e) => { onChange({ prompt: e.target.value }); updateCursor(e.target); }}
          onSelect={(e) => updateCursor(e.currentTarget)}
          onKeyDown={(e) => { if (slash.handleKeyDown(e)) e.preventDefault(); }}
          rows={3}
          placeholder={t("pinned_prompts_prompt_placeholder")}
          aria-label={t("pinned_prompts_prompt_label")}
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
        <div className={styles.actions}>
          {error && <span className={styles.errorText}>{error}</span>}
          <button
            type="button"
            className={styles.iconButton}
            onClick={onCommit}
            title={t("pinned_prompts_save_draft")}
            aria-label={t("pinned_prompts_save_draft")}
          >
            <Save size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

interface InheritedGlobalsListProps {
  globals: PinnedPrompt[];
  repoNames: Set<string>;
}

/**
 * Read-only summary of the globals a repo will inherit. Anything whose name
 * is also defined as a repo prompt is flagged as overridden.
 */
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
