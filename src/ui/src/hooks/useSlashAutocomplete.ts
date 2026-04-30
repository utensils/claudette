import { useCallback, useEffect, useMemo, useState } from "react";
import type { SlashCommand } from "../services/tauri";
import { describeSlashQueryAtCursor } from "../components/chat/nativeSlashCommands";
import { filterSlashCommands } from "../components/chat/SlashCommandPicker";

interface UseSlashAutocompleteOptions {
  value: string;
  cursorPosition: number;
  commands: SlashCommand[];
  onInsert: (replacement: string, rangeStart: number, rangeEnd: number) => void;
}

interface SlashAutocompleteResult {
  showPicker: boolean;
  filteredCommands: SlashCommand[];
  selectedIndex: number;
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
  dismiss: () => void;
  selectCommand: (cmd: SlashCommand) => void;
  setSelectedIndex: (i: number) => void;
}

export function useSlashAutocomplete({
  value,
  cursorPosition,
  commands,
  onInsert,
}: UseSlashAutocompleteOptions): SlashAutocompleteResult {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const query = describeSlashQueryAtCursor(value, cursorPosition);
  const token = query?.token ?? null;

  const filteredCommands = useMemo(
    () => (token === null ? [] : filterSlashCommands(commands, token)),
    [commands, token],
  );

  const showPicker = token !== null && filteredCommands.length > 0 && !dismissed;

  useEffect(() => {
    setSelectedIndex(0);
    setDismissed(false);
  }, [token]);

  // The token can stay stable while filteredCommands changes — e.g. the slash
  // command list reloads asynchronously and a previously matching command
  // disappears. Clamp selectedIndex so Enter/Tab never lands on an undefined
  // entry and the highlight stays in range.
  useEffect(() => {
    if (!showPicker) return;
    setSelectedIndex((i) => Math.min(i, filteredCommands.length - 1));
  }, [showPicker, filteredCommands.length]);

  const selectCommand = useCallback(
    (cmd: SlashCommand) => {
      if (!query) return;
      const replacement = `/${cmd.name} `;
      onInsert(replacement, query.start, query.end);
      setDismissed(true);
    },
    [query, onInsert],
  );

  const dismiss = useCallback(() => setDismissed(true), []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!showPicker) return false;

      if (e.key === "ArrowDown") {
        setSelectedIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
        return true;
      }
      if (e.key === "ArrowUp") {
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        const cmd = filteredCommands[selectedIndex];
        if (cmd) selectCommand(cmd);
        return true;
      }
      if (e.key === "Escape") {
        setDismissed(true);
        return true;
      }
      return false;
    },
    [showPicker, filteredCommands, selectedIndex, selectCommand],
  );

  return {
    showPicker,
    filteredCommands,
    selectedIndex,
    handleKeyDown,
    dismiss,
    selectCommand,
    setSelectedIndex,
  };
}
