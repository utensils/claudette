import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SlashCommand, PinnedCommand } from "../../services/tauri";
import { getPinnedCommands, pinCommand, unpinCommand } from "../../services/tauri";
import styles from "./PinnedCommandsBar.module.css";

interface PinnedCommandsBarProps {
  repoId: string | undefined;
  slashCommands: SlashCommand[];
  onInsertCommand: (commandText: string) => void;
}

export function PinnedCommandsBar({
  repoId,
  slashCommands,
  onInsertCommand,
}: PinnedCommandsBarProps) {
  const [pins, setPins] = useState<PinnedCommand[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const pickerInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!repoId) {
      setPins([]);
      return;
    }
    let cancelled = false;
    getPinnedCommands(repoId)
      .then((cmds) => {
        if (!cancelled) setPins(cmds);
      })
      .catch((e) => console.error("Failed to load pinned commands:", e));
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  const pinnedNames = useMemo(
    () => new Set(pins.map((p) => p.command_name)),
    [pins],
  );

  const availableCommands = useMemo(() => {
    const q = pickerQuery.toLowerCase();
    return slashCommands.filter(
      (cmd) => !pinnedNames.has(cmd.name) && (!q || cmd.name.toLowerCase().includes(q)),
    );
  }, [slashCommands, pinnedNames, pickerQuery]);

  const handlePin = useCallback(
    (name: string) => {
      if (!repoId) return;
      const temp: PinnedCommand = {
        id: -Date.now(),
        repo_id: repoId,
        command_name: name,
        sort_order: pins.length,
        created_at: "",
        use_count: 0,
      };
      setPins((prev) => [...prev, temp]);
      setShowPicker(false);
      setPickerQuery("");
      pinCommand(repoId, name)
        .then((saved) => {
          setPins((prev) => prev.map((p) => (p.id === temp.id ? saved : p)));
        })
        .catch((e) => {
          console.error("Failed to pin command:", e);
          setPins((prev) => prev.filter((p) => p.id !== temp.id));
        });
    },
    [repoId, pins.length],
  );

  const handleUnpin = useCallback((id: number) => {
    setPins((prev) => {
      const removed = prev.find((p) => p.id === id);
      unpinCommand(id).catch((e) => {
        console.error("Failed to unpin command:", e);
        if (removed) setPins((cur) => [...cur, removed].sort((a, b) => a.sort_order - b.sort_order));
      });
      return prev.filter((p) => p.id !== id);
    });
  }, []);

  const handlePickerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        setShowPicker(false);
        setPickerQuery("");
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (availableCommands.length > 0) {
          handlePin(availableCommands[0].name);
        } else if (pickerQuery.trim() && slashCommands.length === 0) {
          handlePin(pickerQuery.trim().replace(/^\//, ""));
        }
      }
    },
    [availableCommands, handlePin, pickerQuery, slashCommands.length],
  );

  useEffect(() => {
    if (showPicker) {
      pickerInputRef.current?.focus();
    }
  }, [showPicker]);

  if (!repoId) return null;

  return (
    <div className={styles.bar}>
      {pins.length > 0 && <span className={styles.label}>pinned</span>}
      {pins.length === 0 && !showPicker && (
        <span className={styles.hint}>pin a command…</span>
      )}

      {pins.map((pin) => {
        const isStale =
          slashCommands.length > 0 &&
          !slashCommands.some((c) => c.name === pin.command_name);
        return (
          <button
            key={pin.id}
            className={`${styles.pill}${isStale ? ` ${styles.pillStale}` : ""}`}
            onClick={() => onInsertCommand("/" + pin.command_name)}
            title={isStale ? `/${pin.command_name} (not available)` : `/${pin.command_name}`}
          >
            <span className={styles.slash}>/</span>
            {pin.command_name}
            <span
              className={styles.unpin}
              role="button"
              onClick={(e) => {
                e.stopPropagation();
                handleUnpin(pin.id);
              }}
            >
              ✕
            </span>
          </button>
        );
      })}

      {showPicker ? (
        <div className={styles.inlinePicker}>
          <input
            ref={pickerInputRef}
            className={styles.pickerInput}
            value={pickerQuery}
            onChange={(e) => setPickerQuery(e.target.value)}
            onKeyDown={handlePickerKeyDown}
            onBlur={() => {
              setShowPicker(false);
              setPickerQuery("");
            }}
            placeholder="search commands…"
          />
          {availableCommands.slice(0, 12).map((cmd) => (
            <button
              key={cmd.name}
              className={styles.pickerItem}
              onMouseDown={(e) => {
                e.preventDefault();
                handlePin(cmd.name);
              }}
            >
              /{cmd.name}
            </button>
          ))}
        </div>
      ) : (
        <button
          className={styles.addBtn}
          onClick={() => setShowPicker(true)}
          title="Pin a command"
        >
          +
        </button>
      )}
    </div>
  );
}
