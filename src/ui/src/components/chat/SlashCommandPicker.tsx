import type { SlashCommand } from "../../services/tauri";
import styles from "./SlashCommandPicker.module.css";

interface SlashCommandPickerProps {
  commands: SlashCommand[];
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
  onHover: (index: number) => void;
}

export function SlashCommandPicker({
  commands,
  selectedIndex,
  onSelect,
  onHover,
}: SlashCommandPickerProps) {
  if (commands.length === 0) return null;

  return (
    <div className={styles.picker}>
      {commands.map((cmd, i) => (
        <div
          key={cmd.name}
          className={`${styles.item} ${i === selectedIndex ? styles.itemSelected : ""}`}
          onClick={() => onSelect(cmd)}
          onMouseEnter={() => onHover(i)}
        >
          <span className={styles.commandSlash}>/</span>
          <span className={styles.commandName}>{cmd.name}</span>
          <span className={styles.commandDesc}>{cmd.description}</span>
        </div>
      ))}
    </div>
  );
}

export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  return commands.filter((cmd) => cmd.name.includes(q));
}
