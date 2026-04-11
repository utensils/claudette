# Technical Design: Terminal Command Display via Shell Integration (OSC 133)

**Status**: Draft
**Date**: 2026-04-10
**Issue**: [#121](https://github.com/utensils/Claudette/issues/121)
**Related**: Alternative design to `terminal-command-display-tdd.md`

## 1. Overview

Show the currently running terminal command for each workspace in the sidebar using industry-standard OSC 133 shell integration sequences. This approach provides accurate command tracking, process exit detection, and exit code reporting.

### User Stories

- As a developer, I want to see which workspaces have running processes (like `npm run dev` or `rails server`) so I can quickly identify active environments without switching between workspaces
- As a developer, I want to see when commands finish so I know if my build/test/deploy completed
- As a developer, I want to see exit codes so I know if commands succeeded or failed
- As a developer, I want the setup process to be transparent so I understand what's being added to my shell configuration

### Advantages Over Input Tracking Approach

| Feature | Input Tracking | Shell Integration (OSC 133) |
|---------|---------------|----------------------------|
| Command detection | ✅ Yes | ✅ Yes |
| Process exit detection | ❌ No (Ctrl+C only) | ✅ Yes (always) |
| Exit code reporting | ❌ No | ✅ Yes |
| Works with shell history (↑) | ❌ No | ✅ Yes |
| Works with aliases | ❌ No | ✅ Yes |
| Multiline commands | ❌ Last line only | ✅ Full command |
| Setup required | None | One-time per shell |
| Implementation complexity | High (byte parsing) | Medium (OSC parsing) |

## 2. Background: OSC 133 Standard

### What is OSC 133?

OSC 133 is an industry-standard terminal escape sequence protocol for "semantic shell integration," originated by FinalTerm and widely adopted by:
- iTerm2
- VSCode Terminal
- kitty
- WezTerm
- Ghostty
- Windows Terminal

### The Core Sequences

```
\033]133;A\007      → Prompt starts (PS1 is being displayed)
\033]133;B\007      → Command input starts (user can type)
\033]133;C\007      → Command execution begins
\033]133;D;$?\007   → Command finishes (with exit code $?)
\033]133;E;cmd\007  → Explicit command text (Claudette extension)
```

Where:
- `\033]` = OSC (Operating System Command)
- `\007` = BEL (bell character, string terminator)
- Alternative ST: `\033\` (ESC backslash)

### How It Works

**Standard OSC 133 flow (ideal, used by zsh):**
1. Shell emits `A` before displaying prompt
2. User sees prompt, shell emits `B` to mark input start
3. User types command text
4. User presses Enter, shell emits `C` to mark execution
5. Terminal captures text between `B` and `C` as the command
6. Command runs, outputs to terminal
7. Command exits, shell emits `D` with exit code
8. Cycle repeats

**Bash/Fish workaround (using OSC 133;E extension):**
- Bash/Fish lack hooks to emit `B` before user input
- Instead, they emit `B`, then `E` with the command text explicitly, then `C`
- The `E` sequence contains the command as URL-encoded text
- Parser extracts command from `E` sequence instead of between `B` and `C`

### Backward Compatibility

Terminals that don't understand OSC 133 **silently ignore** these sequences (treated as non-printable), so there's zero risk to unsupported terminals or tools like `tmux`.

## 3. Design

### 3.1 Setup Flow: Guided Wizard

When a user opens a terminal for the first time (or when `shell_integration_enabled` is not set in app settings), show a modal:

```
┌───────────────────────────────────────────────────────┐
│  Terminal Shell Integration Setup                     │
├───────────────────────────────────────────────────────┤
│                                                       │
│  Claudette can display running commands and exit     │
│  codes in the sidebar by integrating with your shell. │
│                                                       │
│  Detected shell: /bin/zsh                            │
│                                                       │
│  This will add a few lines to your shell config:     │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │ # Claudette shell integration                   │ │
│  │ if [[ -n "$CLAUDETTE_PTY" ]]; then              │ │
│  │   source ~/.config/claudette/shell-integration\ │ │
│  │     .zsh                                        │ │
│  │ fi                                              │ │
│  └─────────────────────────────────────────────────┘ │
│                                                       │
│  File to modify: /Users/you/.zshrc                   │
│                                                       │
│  [✓] Show me what will be added (opens in editor)    │
│                                                       │
│  [ Don't ask again ]  [ Skip ]  [ Enable ]           │
└───────────────────────────────────────────────────────┘
```

#### Wizard Behavior

**Enable button clicked:**
1. Write shell integration script to `~/.config/claudette/shell-integration.{bash,zsh,fish}`
2. Append integration loader to user's RC file (`~/.bashrc`, `~/.zshrc`, or `~/.config/fish/config.fish`)
3. Set `shell_integration_enabled = true` in app settings
4. Show success message with instructions to restart existing terminals
5. Spawn PTY with `CLAUDETTE_PTY=1` environment variable

**Skip button clicked:**
1. Spawn PTY normally (without shell integration)
2. Don't show wizard again this session
3. Show wizard again next app launch

**Don't ask again clicked:**
1. Set `shell_integration_dismissed = true` in app settings
2. Never show wizard again
3. Spawn PTY normally

**Show me what will be added checkbox:**
1. Open user's RC file in default editor
2. Scroll to end of file (where lines will be added)
3. Keep wizard open for user to review

### 3.2 Shell Integration Scripts

Claudette ships with three scripts (created on first setup):

**File: `~/.config/claudette/shell-integration.bash`**

```bash
#!/bin/bash
# Claudette shell integration for bash
# This script enables command tracking and exit code reporting.

_claudette_command_finished() {
    local exit_code=$?
    printf '\033]133;D;%s\007' "$exit_code"
    return $exit_code
}

# Hook into bash prompt system
if [[ -z "$PROMPT_COMMAND" ]]; then
    PROMPT_COMMAND="_claudette_command_finished"
else
    PROMPT_COMMAND="${PROMPT_COMMAND%;}; _claudette_command_finished"
fi

# Emit A (prompt start) at the beginning of the prompt
PS1='\[\033]133;A\007\]'"${PS1}"

# PS0 is executed after command line is read, before execution
# Bash doesn't let us emit B before user input, so we use an extended
# format: OSC 133;E;command to send the command text explicitly
# We also emit B and C for compatibility
_claudette_ps0() {
    # URL-encode the command to avoid issues with special characters
    local cmd_encoded=$(printf '%s' "$BASH_COMMAND" | jq -sRr @uri 2>/dev/null || echo "")
    printf '\033]133;B\007'
    if [[ -n "$cmd_encoded" ]]; then
        printf '\033]133;E;%s\007' "$cmd_encoded"
    fi
    printf '\033]133;C\007'
}
PS0='$(_claudette_ps0)'
```

**File: `~/.config/claudette/shell-integration.zsh`**

```zsh
# Claudette shell integration for zsh
# This script enables command tracking and exit code reporting.

_claudette_precmd() {
    local exit_code=$?
    printf '\033]133;D;%s\007' "$exit_code"
    printf '\033]133;A\007'  # Prompt starts
    return $exit_code
}

_claudette_preexec() {
    printf '\033]133;C\007'  # Command output starts
}

# Add hooks
autoload -Uz add-zsh-hook
add-zsh-hook precmd _claudette_precmd
add-zsh-hook preexec _claudette_preexec

# Embed B marker (command start) at the END of the prompt
# Use %{...%} to mark as non-printing for correct width calculation
PS1="${PS1}"'%{$(printf "\033]133;B\007")%}'
```

**File: `~/.config/claudette/shell-integration.fish`**

```fish
# Claudette shell integration for fish
# This script enables command tracking and exit code reporting.

function __claudette_prompt_start --on-event fish_prompt
    printf '\033]133;A\007'
end

# Emit B, explicit command text via E, and C in preexec
# Fish provides the command in $argv
function __claudette_preexec --on-event fish_preexec
    printf '\033]133;B\007'
    # URL-encode command to handle special characters
    set cmd_encoded (string join ' ' $argv | jq -sRr @uri 2>/dev/null; or echo "")
    if test -n "$cmd_encoded"
        printf '\033]133;E;%s\007' "$cmd_encoded"
    end
    printf '\033]133;C\007'
end

function __claudette_postexec --on-event fish_postexec
    printf '\033]133;D;%s\007' $status
end
```

### 3.3 RC File Modifications

**Added to `~/.bashrc` or `~/.zshrc`:**

```bash
# Claudette shell integration
# Auto-generated on YYYY-MM-DD
# To disable, comment out or remove these lines
if [[ -n "$CLAUDETTE_PTY" ]]; then
    source ~/.config/claudette/shell-integration.bash
fi
```

**Added to `~/.config/fish/config.fish`:**

```fish
# Claudette shell integration
# Auto-generated on YYYY-MM-DD
# To disable, comment out or remove these lines
if test -n "$CLAUDETTE_PTY"
    source ~/.config/claudette/shell-integration.fish
end
```

### 3.4 Shell Detection

**File: `src-tauri/src/pty.rs`**

```rust
fn detect_user_shell() -> (String, ShellType) {
    // Try $SHELL environment variable first
    if let Ok(shell) = std::env::var("SHELL") {
        let shell_type = match shell.as_str() {
            s if s.contains("bash") => ShellType::Bash,
            s if s.contains("zsh") => ShellType::Zsh,
            s if s.contains("fish") => ShellType::Fish,
            _ => ShellType::Unknown,
        };
        return (shell, shell_type);
    }

    // Fallback: use system default
    #[cfg(target_os = "macos")]
    let default = ("/bin/zsh".to_string(), ShellType::Zsh);

    #[cfg(target_os = "linux")]
    let default = ("/bin/bash".to_string(), ShellType::Bash);

    default
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
enum ShellType {
    Bash,
    Zsh,
    Fish,
    Unknown,
}
```

### 3.5 Data Model Changes

#### Backend: PTY Handle Enhancement

**File: `src-tauri/src/state.rs`**

```rust
pub struct PtyHandle {
    pub writer: Mutex<Box<dyn std::io::Write + Send>>,
    pub master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    pub child: Mutex<Box<dyn portable_pty::Child + Send>>,

    /// OSC 133 state tracking
    pub current_command: Arc<Mutex<Option<String>>>,
    pub command_running: Arc<Mutex<bool>>,
    pub last_exit_code: Arc<Mutex<Option<i32>>>,
}
```

#### Backend: OSC 133 Parser

**File: `src-tauri/src/osc133.rs`** (new file)

```rust
use std::str;

#[derive(Debug, Clone, PartialEq)]
pub enum Osc133Event {
    PromptStart,
    CommandStart,
    CommandExecuted,
    CommandFinished { exit_code: i32 },
    CommandText { command: String }, // Extended: explicit command text
}

pub struct Osc133Parser {
    buffer: Vec<u8>,
    command_buffer: Vec<u8>,
    in_osc: bool,
    tracking_command: bool,
}

impl Osc133Parser {
    pub fn new() -> Self {
        Self {
            buffer: Vec::new(),
            command_buffer: Vec::new(),
            in_osc: false,
            tracking_command: false,
        }
    }

    /// Feed bytes from PTY output, returns any detected OSC 133 events
    pub fn feed(&mut self, data: &[u8]) -> Vec<Osc133Event> {
        let mut events = Vec::new();

        for &byte in data {
            if self.in_osc {
                // Look for BEL terminator
                if byte == 0x07 {
                    if let Some(event) = self.parse_osc133() {
                        events.push(event);
                    }
                    self.in_osc = false;
                    self.buffer.clear();
                }
                // Look for ESC \ terminator
                else if self.buffer.last() == Some(&0x1b) && byte == b'\\' {
                    self.buffer.pop(); // Remove ESC
                    if let Some(event) = self.parse_osc133() {
                        events.push(event);
                    }
                    self.in_osc = false;
                    self.buffer.clear();
                }
                else {
                    self.buffer.push(byte);
                }
            }
            else if byte == 0x1b {
                self.buffer.push(byte);
            }
            else if !self.buffer.is_empty() {
                // Check if we're starting an OSC sequence (ESC ])
                if self.buffer == b"\x1b" && byte == b']' {
                    self.in_osc = true;
                    self.buffer.clear();
                }
                else {
                    // Not an OSC sequence, track as command text if needed
                    if self.tracking_command && byte >= 0x20 && byte < 0x7F {
                        self.command_buffer.push(byte);
                    }
                    self.buffer.clear();
                }
            }
            else {
                // Track printable characters between B and C markers
                if self.tracking_command && byte >= 0x20 && byte < 0x7F {
                    self.command_buffer.push(byte);
                }
            }
        }

        events
    }

    fn parse_osc133(&mut self) -> Option<Osc133Event> {
        let s = String::from_utf8_lossy(&self.buffer);

        if s.starts_with("133;A") {
            Some(Osc133Event::PromptStart)
        }
        else if s.starts_with("133;B") {
            // Command input starts - begin tracking
            self.tracking_command = true;
            self.command_buffer.clear();
            Some(Osc133Event::CommandStart)
        }
        else if s.starts_with("133;C") {
            // Execution starts - stop tracking command text
            self.tracking_command = false;
            Some(Osc133Event::CommandExecuted)
        }
        else if let Some(code_str) = s.strip_prefix("133;D;") {
            let exit_code = code_str.trim().parse().unwrap_or(0);
            Some(Osc133Event::CommandFinished { exit_code })
        }
        else if let Some(cmd_encoded) = s.strip_prefix("133;E;") {
            // Extended: explicit command text (URL-encoded)
            let command = urlencoding::decode(cmd_encoded.trim())
                .unwrap_or_default()
                .to_string();
            Some(Osc133Event::CommandText { command })
        }
        else {
            None
        }
    }

    pub fn extract_command(&mut self) -> Option<String> {
        if self.command_buffer.is_empty() {
            return None;
        }

        let cmd = String::from_utf8_lossy(&self.command_buffer)
            .trim()
            .to_string();

        self.command_buffer.clear();

        if cmd.is_empty() {
            None
        } else {
            Some(cmd)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_basic_sequence() {
        let mut parser = Osc133Parser::new();

        // Prompt start
        let events = parser.feed(b"\x1b]133;A\x07");
        assert_eq!(events, vec![Osc133Event::PromptStart]);

        // Command start
        let events = parser.feed(b"\x1b]133;B\x07");
        assert_eq!(events, vec![Osc133Event::CommandStart]);

        // User types command
        parser.feed(b"npm run dev\r");

        // Execution starts
        let events = parser.feed(b"\x1b]133;C\x07");
        assert_eq!(events, vec![Osc133Event::CommandExecuted]);
        assert_eq!(parser.extract_command(), Some("npm run dev".to_string()));

        // Command finishes with exit code 0
        let events = parser.feed(b"\x1b]133;D;0\x07");
        assert_eq!(events, vec![Osc133Event::CommandFinished { exit_code: 0 }]);
    }

    #[test]
    fn test_exit_code_parsing() {
        let mut parser = Osc133Parser::new();

        let events = parser.feed(b"\x1b]133;D;127\x07");
        assert_eq!(events, vec![Osc133Event::CommandFinished { exit_code: 127 }]);
    }

    #[test]
    fn test_esc_backslash_terminator() {
        let mut parser = Osc133Parser::new();

        // Use ESC \ instead of BEL
        let events = parser.feed(b"\x1b]133;A\x1b\\");
        assert_eq!(events, vec![Osc133Event::PromptStart]);
    }

    #[test]
    fn test_multiline_command() {
        let mut parser = Osc133Parser::new();

        parser.feed(b"\x1b]133;B\x07");
        parser.feed(b"for i in {1..10}; do\r\n");
        parser.feed(b"  echo $i\r\n");
        parser.feed(b"done\r");
        parser.feed(b"\x1b]133;C\x07");

        let cmd = parser.extract_command().unwrap();
        assert!(cmd.contains("for i in"));
        assert!(cmd.contains("echo"));
        assert!(cmd.contains("done"));
    }
}
```

#### Backend: PTY Spawn Changes

**File: `src-tauri/src/pty.rs`**

```rust
use std::sync::Arc;
use parking_lot::Mutex as ParkingMutex;

mod osc133;
use osc133::{Osc133Parser, Osc133Event};

#[derive(Clone, Serialize)]
struct CommandEvent {
    pty_id: u64,
    command: Option<String>,
    exit_code: Option<i32>,
}

#[tauri::command]
pub async fn spawn_pty(
    working_dir: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let mut cmd = CommandBuilder::new_default_prog();
    cmd.cwd(&working_dir);

    // NEW: Set CLAUDETTE_PTY environment variable to enable shell integration
    cmd.env("CLAUDETTE_PTY", "1");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {e}"))?;

    drop(pair.slave);

    let pty_id = state.next_pty_id();

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {e}"))?;

    // NEW: OSC 133 tracking state
    let current_command = Arc::new(ParkingMutex::new(None));
    let command_running = Arc::new(ParkingMutex::new(false));
    let last_exit_code = Arc::new(ParkingMutex::new(None));

    // Background reader with OSC 133 parsing
    let emitter_app = app.clone();
    let reader_pty_id = pty_id;
    let cmd_clone = current_command.clone();
    let running_clone = command_running.clone();
    let exit_clone = last_exit_code.clone();

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut parser = Osc133Parser::new();

        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = &buf[..n];

                    // Emit raw output for xterm.js
                    let payload = PtyOutputPayload {
                        pty_id: reader_pty_id,
                        data: data.to_vec(),
                    };
                    let _ = emitter_app.emit("pty-output", &payload);

                    // Parse OSC 133 sequences
                    for event in parser.feed(data) {
                        match event {
                            Osc133Event::CommandStart => {
                                // Will extract command from CommandText event or text between B and C
                            }
                            Osc133Event::CommandText { command } => {
                                // Explicit command text (used by bash via OSC 133;E)
                                *cmd_clone.lock() = Some(command.clone());
                                *running_clone.lock() = true;

                                let _ = emitter_app.emit("pty-command-detected", &CommandEvent {
                                    pty_id: reader_pty_id,
                                    command: Some(command),
                                    exit_code: None,
                                });
                            }
                            Osc133Event::CommandExecuted => {
                                // Extract command text captured between B and C markers (zsh)
                                if let Some(cmd) = parser.extract_command() {
                                    *cmd_clone.lock() = Some(cmd.clone());
                                    *running_clone.lock() = true;

                                    let _ = emitter_app.emit("pty-command-detected", &CommandEvent {
                                        pty_id: reader_pty_id,
                                        command: Some(cmd),
                                        exit_code: None,
                                    });
                                }
                            }
                            Osc133Event::CommandFinished { exit_code } => {
                                *running_clone.lock() = false;
                                *exit_clone.lock() = Some(exit_code);

                                let _ = emitter_app.emit("pty-command-stopped", &CommandEvent {
                                    pty_id: reader_pty_id,
                                    command: cmd_clone.lock().clone(),
                                    exit_code: Some(exit_code),
                                });
                            }
                            Osc133Event::PromptStart => {
                                // Prompt appeared - reset running state if still set
                                if *running_clone.lock() {
                                    *running_clone.lock() = false;
                                }
                            }
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });

    let handle = PtyHandle {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
        current_command,
        command_running,
        last_exit_code,
    };

    state.ptys.write().await.insert(pty_id, handle);

    Ok(pty_id)
}
```

#### Frontend: Workspace Display State

Same as input tracking approach:

**File: `src/ui/src/stores/useAppStore.ts`**

```typescript
interface WorkspaceCommandState {
  command: string | null;
  isRunning: boolean;
  exitCode: number | null;
}

interface AppStore {
  // ... existing fields ...

  /// Map of workspace_id → terminal command state
  workspaceTerminalCommands: Record<string, WorkspaceCommandState>;

  /// Update the terminal command state for a workspace
  setWorkspaceTerminalCommand: (
    wsId: string,
    state: WorkspaceCommandState
  ) => void;
}
```

### 3.6 Setup Wizard Implementation

**New Tauri Command:**

```rust
#[tauri::command]
pub async fn setup_shell_integration(
    shell_type: ShellType,
) -> Result<SetupResult, String> {
    let config_dir = dirs::config_dir()
        .ok_or("Could not find config directory")?
        .join("claudette");

    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config dir: {e}"))?;

    // Write shell integration script
    let script_content = match shell_type {
        ShellType::Bash => include_str!("../shell-integration.bash"),
        ShellType::Zsh => include_str!("../shell-integration.zsh"),
        ShellType::Fish => include_str!("../shell-integration.fish"),
        ShellType::Unknown => return Err("Unsupported shell".to_string()),
    };

    let script_path = config_dir.join(format!(
        "shell-integration.{}",
        match shell_type {
            ShellType::Bash => "bash",
            ShellType::Zsh => "zsh",
            ShellType::Fish => "fish",
            _ => unreachable!(),
        }
    ));

    std::fs::write(&script_path, script_content)
        .map_err(|e| format!("Failed to write integration script: {e}"))?;

    // Determine RC file path
    let rc_path = match shell_type {
        ShellType::Bash => dirs::home_dir().unwrap().join(".bashrc"),
        ShellType::Zsh => dirs::home_dir().unwrap().join(".zshrc"),
        ShellType::Fish => {
            dirs::config_dir().unwrap().join("fish").join("config.fish")
        }
        ShellType::Unknown => unreachable!(),
    };

    // Generate integration loader code
    let loader_code = generate_loader_code(shell_type, &script_path);

    // Check if already integrated
    let existing_content = std::fs::read_to_string(&rc_path).unwrap_or_default();
    let already_integrated = existing_content.contains("Claudette shell integration");

    Ok(SetupResult {
        script_path: script_path.to_string_lossy().to_string(),
        rc_path: rc_path.to_string_lossy().to_string(),
        loader_code,
        already_integrated,
    })
}

#[tauri::command]
pub async fn apply_shell_integration(
    rc_path: String,
    loader_code: String,
) -> Result<(), String> {
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(&rc_path)
        .map_err(|e| format!("Failed to open RC file: {e}"))?;

    use std::io::Write;
    writeln!(file, "\n{}", loader_code)
        .map_err(|e| format!("Failed to write to RC file: {e}"))?;

    Ok(())
}

#[derive(Serialize)]
struct SetupResult {
    script_path: String,
    rc_path: String,
    loader_code: String,
    already_integrated: bool,
}

fn generate_loader_code(shell_type: ShellType, script_path: &Path) -> String {
    let script_str = script_path.to_string_lossy();
    let date = chrono::Local::now().format("%Y-%m-%d");

    match shell_type {
        ShellType::Bash | ShellType::Zsh => format!(
            "# Claudette shell integration\n\
             # Auto-generated on {date}\n\
             # To disable, comment out or remove these lines\n\
             if [[ -n \"$CLAUDETTE_PTY\" ]]; then\n    \
                 source {script_str}\n\
             fi"
        ),
        ShellType::Fish => format!(
            "# Claudette shell integration\n\
             # Auto-generated on {date}\n\
             # To disable, comment out or remove these lines\n\
             if test -n \"$CLAUDETTE_PTY\"\n    \
                 source {script_str}\n\
             end"
        ),
        ShellType::Unknown => String::new(),
    }
}
```

**Frontend Modal Component:**

**File: `src/ui/src/components/modals/ShellIntegrationSetupModal.tsx`**

```typescript
import { useState, useEffect } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { setupShellIntegration, applyShellIntegration } from "../../services/tauri";
import { invoke } from "@tauri-apps/api/core";
import styles from "./Modal.module.css";

export function ShellIntegrationSetupModal() {
  const closeModal = useAppStore((s) => s.closeModal);
  const [showPreview, setShowPreview] = useState(false);
  const [setupResult, setSetupResult] = useState<{
    script_path: string;
    rc_path: string;
    loader_code: string;
    already_integrated: boolean;
  } | null>(null);

  // Fetch setup details on mount
  useEffect(() => {
    detectAndFetchSetup();
  }, []);

  async function detectAndFetchSetup() {
    try {
      // Detect shell via Tauri command
      const shell = await invoke<string>("detect_user_shell");
      const result = await setupShellIntegration(shell);
      setSetupResult(result);
    } catch (e) {
      console.error("Failed to detect shell:", e);
    }
  }

  async function handleEnable() {
    if (!setupResult) return;

    try {
      await applyShellIntegration(setupResult.rc_path, setupResult.loader_code);

      // Save to app settings
      await invoke("set_app_setting", {
        key: "shell_integration_enabled",
        value: "true",
      });

      closeModal();

      // Show success message
      useAppStore.getState().showNotification({
        type: "success",
        message: "Shell integration enabled! Restart existing terminals to activate.",
      });
    } catch (e) {
      console.error("Failed to enable shell integration:", e);
      useAppStore.getState().showNotification({
        type: "error",
        message: `Failed to enable shell integration: ${e}`,
      });
    }
  }

  async function handleSkip() {
    closeModal();
  }

  async function handleDontAskAgain() {
    await invoke("set_app_setting", {
      key: "shell_integration_dismissed",
      value: "true",
    });
    closeModal();
  }

  async function handleShowPreview() {
    if (!setupResult) return;

    // Open RC file in default editor
    await invoke("open_in_editor", { path: setupResult.rc_path });
    setShowPreview(true);
  }

  if (!setupResult) {
    return (
      <div className={styles.modal}>
        <div className={styles.content}>
          <p>Detecting shell...</p>
        </div>
      </div>
    );
  }

  if (setupResult.already_integrated) {
    return (
      <div className={styles.modal}>
        <div className={styles.content}>
          <h2>Shell Integration Already Enabled</h2>
          <p>
            Claudette shell integration is already configured in your shell.
          </p>
          <div className={styles.actions}>
            <button onClick={closeModal}>Close</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.modal}>
      <div className={styles.content}>
        <h2>Terminal Shell Integration Setup</h2>
        <p>
          Claudette can display running commands and exit codes in the sidebar
          by integrating with your shell.
        </p>

        <div className={styles.infoBox}>
          <strong>File to modify:</strong> {setupResult.rc_path}
        </div>

        <p>The following will be added to your shell config:</p>

        <pre className={styles.codeBlock}>{setupResult.loader_code}</pre>

        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={showPreview}
            onChange={(e) => {
              if (e.target.checked) {
                handleShowPreview();
              }
            }}
          />
          Show me what will be added (opens in editor)
        </label>

        <div className={styles.actions}>
          <button onClick={handleDontAskAgain} className={styles.secondary}>
            Don't ask again
          </button>
          <button onClick={handleSkip} className={styles.secondary}>
            Skip
          </button>
          <button onClick={handleEnable} className={styles.primary}>
            Enable
          </button>
        </div>
      </div>
    </div>
  );
}
```

### 3.7 UI Display

Same as input tracking approach, but enhanced with exit code:

**File: `src/ui/src/components/sidebar/Sidebar.tsx`**

```typescript
function WorkspaceItem({ workspace }: { workspace: Workspace }) {
  const commandState = useAppStore(
    (s) => s.workspaceTerminalCommands[workspace.id]
  );

  return (
    <div className={styles.workspaceItem}>
      <div className={styles.workspaceName}>{workspace.name}</div>
      <div className={styles.branchName}>{workspace.branch_name}</div>

      {commandState?.command && (
        <div className={styles.terminalCommand}>
          {commandState.isRunning ? (
            <span className={styles.runningIcon} title="Running">⚙️</span>
          ) : commandState.exitCode === 0 ? (
            <span className={styles.successIcon} title="Exited successfully">✓</span>
          ) : commandState.exitCode !== null ? (
            <span className={styles.errorIcon} title={`Exit code: ${commandState.exitCode}`}>✗</span>
          ) : (
            <span className={styles.commandIcon}>▸</span>
          )}

          <span className={styles.commandText} title={commandState.command}>
            {truncateCommand(commandState.command, 40)}
          </span>
        </div>
      )}
    </div>
  );
}

function truncateCommand(cmd: string, maxLen: number): string {
  if (cmd.length <= maxLen) return cmd;
  return cmd.slice(0, maxLen - 3) + "...";
}
```

**CSS:**

```css
.terminalCommand {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-tertiary);
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.runningIcon {
  color: var(--color-success);
  animation: spin 2s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.successIcon {
  color: var(--color-success);
}

.errorIcon {
  color: var(--color-error);
}

.commandIcon {
  opacity: 0.7;
}

.commandText {
  overflow: hidden;
  text-overflow: ellipsis;
}
```

## 4. Files Modified

| File | Change |
|------|--------|
| `src-tauri/src/state.rs` | Add `current_command`, `command_running`, `last_exit_code` to `PtyHandle` |
| `src-tauri/src/osc133.rs` | **NEW**: OSC 133 parser implementation |
| `src-tauri/src/pty.rs` | Add OSC 133 parsing in reader thread; set `CLAUDETTE_PTY` env var |
| `src-tauri/src/commands/shell.rs` | **NEW**: `setup_shell_integration`, `apply_shell_integration`, `detect_user_shell` |
| `src-tauri/shell-integration.bash` | **NEW**: Bash integration script |
| `src-tauri/shell-integration.zsh` | **NEW**: Zsh integration script |
| `src-tauri/shell-integration.fish` | **NEW**: Fish integration script |
| `src/ui/src/types/terminal.ts` | Add `pty_id?: number` to `TerminalTab` |
| `src/ui/src/stores/useAppStore.ts` | Add `workspaceTerminalCommands`, `setWorkspaceTerminalCommand` |
| `src/ui/src/components/terminal/TerminalPanel.tsx` | Store `pty_id` on tab after spawn; show setup wizard on first use |
| `src/ui/src/components/modals/ShellIntegrationSetupModal.tsx` | **NEW**: Setup wizard UI |
| `src/ui/src/App.tsx` | Add event listeners for `pty-command-detected` and `pty-command-stopped` |
| `src/ui/src/components/sidebar/Sidebar.tsx` | Display command with running/success/error icons |
| `src/ui/src/components/sidebar/Sidebar.module.css` | Add styles for terminal command display with icons |

## 5. Edge Cases & Limitations

### 5.1 Known Limitations

1. **Requires one-time setup**: User must complete setup wizard and restart terminals
   - **Mitigation**: Wizard is clear and simple; restart prompt shown
   - **Future**: Could auto-inject without modifying RC files (via `BASH_ENV`, `ZDOTDIR`)

2. **Non-integrated terminals**: If user has existing terminals open before setup, they won't emit OSC 133
   - **Mitigation**: Clear "restart terminals" message after setup
   - **Detection**: Can detect lack of OSC 133 and show reminder

3. **Custom prompts**: Users with complex prompt themes might have conflicts
   - **Mitigation**: Integration scripts preserve existing `PS1`/`PROMPT_COMMAND`
   - **Testing**: Test with popular frameworks (oh-my-zsh, starship, powerlevel10k)

4. **Unsupported shells**: Shells other than bash/zsh/fish won't work
   - **Mitigation**: Wizard detects unsupported shells and shows message
   - **Future**: Add support for dash, ksh, other shells as requested

### 5.2 Fallback Behavior

If shell integration is not set up:
- Sidebar shows nothing (no command display)
- No errors or warnings shown
- Terminals work normally

If shell integration breaks (corrupt RC file, etc.):
- User's shell still works (integration code is defensive)
- No OSC 133 sequences emitted
- Sidebar shows nothing (graceful degradation)

### 5.3 Uninstallation

Users can disable by:
1. Opening app settings → "Terminal" → "Disable shell integration"
   - Removes loader code from RC file
   - Keeps integration script in place (harmless)
2. Manually commenting out integration code in RC file
3. Uninstalling Claudette (RC file changes remain but are harmless)

## 6. Testing

### 6.1 Unit Tests

**`src-tauri/src/osc133.rs`**:
- `test_basic_sequence`: Full A→B→C→D cycle
- `test_exit_code_parsing`: Various exit codes (0, 1, 127, 255)
- `test_esc_backslash_terminator`: ESC \ instead of BEL
- `test_multiline_command`: Commands with newlines
- `test_command_extraction`: Verify captured text between B and C
- `test_partial_sequences`: Incremental feeding of bytes
- `test_invalid_sequences`: Malformed OSC codes (should ignore)

### 6.2 Integration Tests

1. **Setup wizard**:
   - Detect bash → Correct script and RC path shown
   - Detect zsh → Correct script and RC path shown
   - Detect fish → Correct script and RC path shown
   - Already integrated → Show "already enabled" message
   - Apply integration → RC file correctly modified

2. **Command tracking**:
   - Type `npm run dev` → Sidebar shows "⚙️ npm run dev"
   - Command exits (Ctrl+C) → Sidebar shows "✗ npm run dev" with exit code
   - Type `npm run build` → Success → Sidebar shows "✓ npm run build"
   - Switch workspaces → Each shows correct command state

3. **Cross-shell compatibility**:
   - Test identical workflow in bash, zsh, fish
   - Verify all shells emit correct OSC 133 sequences

### 6.3 Manual Verification

Setup phase:
- [ ] First terminal open → Wizard appears
- [ ] Click "Enable" → RC file modified correctly
- [ ] Click "Show me what will be added" → Editor opens
- [ ] Click "Skip" → Terminal works, wizard reappears next launch
- [ ] Click "Don't ask again" → Wizard never shows again

Runtime phase:
- [ ] Run dev server → Sidebar shows "⚙️ npm run dev"
- [ ] Server exits successfully → Sidebar shows "✓ npm run dev"
- [ ] Run failing command → Sidebar shows "✗ command" with red icon
- [ ] Use shell history (↑) → Commands still captured correctly
- [ ] Use alias → Real command (post-expansion) captured
- [ ] Multiline command → Full command captured
- [ ] Close terminal → Command cleared from sidebar
- [ ] Archive workspace → Command cleared

Compatibility:
- [ ] Works with oh-my-zsh
- [ ] Works with starship prompt
- [ ] Works with powerlevel10k
- [ ] Works inside tmux
- [ ] Works with custom PS1 colors/formatting

## 7. Future Enhancements

### 7.1 Auto-Injection (No Setup Required)

Inject shell integration without modifying RC files:

```rust
// For bash: Use BASH_ENV to source integration script
cmd.env("BASH_ENV", "/path/to/integration.bash");

// For zsh: Override ZDOTDIR to load integration first
cmd.env("ZDOTDIR", "/path/to/custom-zdotdir");

// For fish: Override XDG_CONFIG_HOME
cmd.env("XDG_CONFIG_HOME", "/path/to/custom-config");
```

**Pros**: Zero user friction
**Cons**: More complex, might conflict with user's environment

### 7.2 Smart Command Display

Filter/categorize commands:
- Long-running servers highlighted in green
- Short-lived commands (builds, tests) fade after completion
- User-configurable patterns for "important" commands

### 7.3 Process Management Actions

Right-click command in sidebar:
- "Stop process" → Sends Ctrl+C to PTY
- "Restart process" → Stops and re-runs last command
- "View output" → Switches to terminal panel

### 7.4 Persistence Across Restarts

Store command state in database so it survives app restarts (until terminal is explicitly closed).

### 7.5 Remote Shell Integration

Extend OSC 133 to work with remote workspaces:
- SSH connections propagate `CLAUDETTE_PTY` env var
- Remote shells source integration script from `~/.config/claudette/`
- Events flow back through SSH tunnel

## 8. Comparison with Input Tracking

| Aspect | Input Tracking TDD | Shell Integration TDD (This Doc) |
|--------|-------------------|----------------------------------|
| **User setup** | None | One-time wizard |
| **Command detection** | Input parsing | OSC 133 sequences |
| **Exit detection** | Ctrl+C only | All exits (natural, Ctrl+C, kill) |
| **Exit codes** | ❌ No | ✅ Yes |
| **Multiline commands** | Last line only | Full command |
| **Shell history (↑)** | Sees ANSI escapes | Sees actual command |
| **Aliases** | Shows alias name | Shows expanded command |
| **Implementation LOC** | ~300 | ~250 |
| **Maintenance risk** | High (shell quirks) | Low (standard protocol) |
| **User friction** | None | Low (one-time setup) |
| **Industry precedent** | Custom solution | Used by VSCode, iTerm2, etc. |

## 9. Rollout Plan

### Phase 1: Backend Infrastructure (Week 1)
- Implement OSC 133 parser with tests
- Add shell detection logic
- Modify PTY spawn to parse sequences
- Emit Tauri events

### Phase 2: Shell Integration Scripts (Week 1)
- Write bash integration script
- Write zsh integration script
- Write fish integration script
- Test with popular prompt themes

### Phase 3: Setup Wizard (Week 2)
- Implement `setup_shell_integration` command
- Implement `apply_shell_integration` command
- Build setup modal UI
- Add app settings for dismiss/enabled state

### Phase 4: UI Integration (Week 2)
- Update Sidebar to show command state
- Add CSS styling for icons
- Wire up event listeners
- Test across workspaces

### Phase 5: Polish & Testing (Week 3)
- Cross-shell compatibility testing
- Prompt theme testing (oh-my-zsh, starship, etc.)
- Error handling and edge cases
- Documentation and help text

## 10. Success Metrics

- ≥80% of users complete setup wizard (not dismiss)
- Command updates appear within 50ms of OSC 133 event
- Zero shell crashes due to integration code
- Support for top 3 shells (bash, zsh, fish) covers ≥95% of users
- Exit code accuracy: 100% (matches actual command exit code)

## 11. Recommendation

**This approach (Shell Integration) is recommended over input tracking** because:

1. **More accurate**: Captures full commands, aliases, multiline, history navigation
2. **Process lifecycle**: Knows when commands start AND finish
3. **Exit codes**: Shows success/failure state in UI
4. **Industry standard**: OSC 133 is proven and widely adopted
5. **Lower maintenance**: Standard protocol vs. custom byte parsing
6. **Better UX**: Visual feedback (⚙️/✓/✗) vs. static text

**Trade-off**: Requires one-time setup vs. zero config
**Mitigation**: Setup wizard is simple, transparent, and skippable

The setup wizard provides full transparency while maintaining ease of use for users who want the feature.
