import { useCallback, useEffect, useMemo, useState } from "react";
import type { SlashCommand } from "../services/tauri";
import { describeSlashQuery } from "../components/chat/nativeSlashCommands";
import { filterSlashCommands } from "../components/chat/SlashCommandPicker";

type ComposerMode = "prompt" | "shell";

interface UseSlashPickerOptions {
  chatInput: string;
  composerMode: ComposerMode;
  slashCommands: SlashCommand[];
  /**
   * Called when the user selects a command — either via Enter or by clicking
   * the picker. `send` is what should be dispatched: the full input if the
   * user already typed arguments after the command name, otherwise the
   * canonical `/<name>`. The caller decides what to do with it (typically
   * onSend(send) + setChatInput("") + recordSlashCommandUsage).
   */
  onSelectCommand: (cmd: SlashCommand, send: string) => void;
  /**
   * Called when the user accepts a command via Tab (autocomplete-and-stay).
   * Receives the canonical `"/<name> "` text the caller should write into
   * the input. The hook dismisses itself afterwards.
   */
  onAutocomplete: (replacement: string) => void;
}

interface UseSlashPickerResult {
  showSlashPicker: boolean;
  slashResults: SlashCommand[];
  selectedIndex: number;
  setSelectedIndex: (i: number) => void;
  /**
   * Returns true if the event was consumed by the picker (Arrow/Enter/Tab/
   * Escape while open). The caller should `return` immediately on true. The
   * hook does NOT call `preventDefault` — the caller does, to keep all
   * preventDefault calls in one place (the surrounding keyboard handler).
   */
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
  /** Imperatively select a command — used as the picker's onSelect prop. */
  selectCommand: (cmd: SlashCommand) => void;
}

/**
 * Slash-command picker state for the chat composer.
 *
 * Owns: open/closed (showSlashPicker), result list, selected index, dismiss
 * state, keyboard navigation (Arrow/Enter/Tab/Escape), and the send-vs-
 * autocomplete decision. Does NOT own slash-command loading — `slashCommands`
 * is shared with PinnedPromptsManager and lives outside.
 *
 * Distinct from `useSlashAutocomplete` (used by the pinned-prompt editor),
 * which treats `/x` as text to *insert*. The composer treats `/x` as a
 * command to *run*, so Enter sends and Tab autocompletes.
 */
export function useSlashPicker({
  chatInput,
  composerMode,
  slashCommands,
  onSelectCommand,
  onAutocomplete,
}: UseSlashPickerOptions): UseSlashPickerResult {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const slashQuery = composerMode === "prompt" ? describeSlashQuery(chatInput) : null;
  const slashQueryToken = slashQuery?.token ?? null;
  const slashHasArgs = slashQuery?.hasArgs ?? false;

  const slashResults = useMemo(
    () => (slashQueryToken === null ? [] : filterSlashCommands(slashCommands, slashQueryToken)),
    [slashCommands, slashQueryToken],
  );

  const showSlashPicker =
    slashQueryToken !== null && slashResults.length > 0 && !dismissed;

  // Reset selection + dismiss whenever the slash token changes so a fresh
  // query always starts from the top of the list. Preserves the exact
  // behavior from ChatInputArea.tsx prior to extraction.
  useEffect(() => {
    setSelectedIndex(0);
    setDismissed(false);
  }, [slashQueryToken]);

  const selectCommand = useCallback(
    (cmd: SlashCommand) => {
      // If the user has already typed arguments after the command name,
      // keep what they typed; otherwise substitute the canonical name.
      const send = slashHasArgs ? chatInput : "/" + cmd.name;
      onSelectCommand(cmd, send);
    },
    [chatInput, slashHasArgs, onSelectCommand],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!showSlashPicker) return false;

      if (e.key === "ArrowDown") {
        setSelectedIndex((i) => Math.min(i + 1, slashResults.length - 1));
        return true;
      }
      if (e.key === "ArrowUp") {
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return true;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        const cmd = slashResults[selectedIndex];
        if (cmd) selectCommand(cmd);
        return true;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        const cmd = slashResults[selectedIndex];
        if (cmd) {
          onAutocomplete("/" + cmd.name + " ");
          setDismissed(true);
        }
        return true;
      }
      if (e.key === "Escape") {
        setDismissed(true);
        return true;
      }
      return false;
    },
    [showSlashPicker, slashResults, selectedIndex, selectCommand, onAutocomplete],
  );

  return {
    showSlashPicker,
    slashResults,
    selectedIndex,
    setSelectedIndex,
    handleKeyDown,
    selectCommand,
  };
}
