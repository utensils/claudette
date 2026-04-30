import type { SlashCommand } from "../../services/tauri";
import styles from "./SlashCommandPicker.module.css";

interface SlashCommandPickerProps {
  commands: SlashCommand[];
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
  onHover: (index: number) => void;
  placement?: "above" | "below";
}

export function SlashCommandPicker({
  commands,
  selectedIndex,
  onSelect,
  onHover,
  placement = "above",
}: SlashCommandPickerProps) {
  if (commands.length === 0) return null;

  const className = placement === "below"
    ? `${styles.picker} ${styles.pickerBelow}`
    : styles.picker;

  return (
    <div
      className={className}
      role="listbox"
      onMouseDown={(e) => e.preventDefault()}
    >
      {commands.map((cmd, i) => (
        <div
          key={cmd.name}
          role="option"
          aria-selected={i === selectedIndex}
          className={`${styles.item} ${i === selectedIndex ? styles.itemSelected : ""}`}
          onClick={() => onSelect(cmd)}
          onMouseEnter={() => onHover(i)}
        >
          <span className={styles.commandSlash}>/</span>
          <span className={styles.commandName}>{cmd.name}</span>
          {cmd.argument_hint ? (
            <span className={styles.commandArgHint}>{cmd.argument_hint}</span>
          ) : null}
          <span className={styles.commandDesc}>{cmd.description}</span>
        </div>
      ))}
    </div>
  );
}

export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  return commands.filter((cmd) => {
    if (cmd.name.toLowerCase().includes(q)) return true;
    const aliases = cmd.aliases ?? [];
    return aliases.some((alias) => alias.toLowerCase().includes(q));
  });
}
