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
    in_escape: bool,
}

impl Osc133Parser {
    pub fn new() -> Self {
        Self {
            buffer: Vec::new(),
            command_buffer: Vec::new(),
            in_osc: false,
            tracking_command: false,
            in_escape: false,
        }
    }

    /// Feed bytes from PTY output, returns any detected OSC 133 events
    pub fn feed(&mut self, data: &[u8]) -> Vec<Osc133Event> {
        let mut events = Vec::new();

        for &byte in data {
            // Handle escape sequences (don't track command text while in escape)
            if self.in_escape {
                self.buffer.push(byte);

                // Check if we're starting an OSC sequence (ESC ])
                if self.buffer == b"\x1b]" {
                    self.in_osc = true;
                    self.buffer.clear();
                    self.in_escape = false;
                }
                // Check for CSI sequences (ESC [)
                else if self.buffer.len() >= 2 && self.buffer[0] == 0x1b && self.buffer[1] == b'['
                {
                    // CSI parameter bytes: 0x30-0x3F (digits, semicolon, etc.)
                    // CSI final byte: 0x40-0x7E (letters like H, J, K, m, etc.)
                    // Skip [ itself and wait for the final byte
                    if self.buffer.len() > 2 && (0x40..=0x7E).contains(&byte) {
                        self.buffer.clear();
                        self.in_escape = false;
                    }
                }
                // Check for other escape sequences (ESC followed by single printable char)
                else if self.buffer.len() == 2 && self.buffer[0] == 0x1b {
                    self.buffer.clear();
                    self.in_escape = false;
                }
                continue;
            }

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
                } else {
                    self.buffer.push(byte);
                }
            } else if byte == 0x1b {
                self.buffer.push(byte);
                self.in_escape = true;
            } else {
                // Track printable characters between B and C markers (not in escape sequences)
                if self.tracking_command && (0x20..0x7F).contains(&byte) {
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
        } else if s.starts_with("133;B") {
            // Command input starts - begin tracking
            self.tracking_command = true;
            self.command_buffer.clear();
            Some(Osc133Event::CommandStart)
        } else if s.starts_with("133;C") {
            // Execution starts - stop tracking command text
            self.tracking_command = false;
            Some(Osc133Event::CommandExecuted)
        } else if let Some(code_str) = s.strip_prefix("133;D;") {
            let exit_code = code_str.trim().parse().unwrap_or(0);
            Some(Osc133Event::CommandFinished { exit_code })
        } else if let Some(cmd_encoded) = s.strip_prefix("133;E;") {
            // Extended: explicit command text (URL-encoded)
            let command = urlencoding::decode(cmd_encoded.trim())
                .unwrap_or_default()
                .to_string();
            Some(Osc133Event::CommandText { command })
        } else {
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

        if cmd.is_empty() { None } else { Some(cmd) }
    }
}

impl Default for Osc133Parser {
    fn default() -> Self {
        Self::new()
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
        assert_eq!(
            events,
            vec![Osc133Event::CommandFinished { exit_code: 127 }]
        );
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

    #[test]
    fn test_explicit_command_text() {
        let mut parser = Osc133Parser::new();

        // Bash/Fish style with explicit command via OSC 133;E
        parser.feed(b"\x1b]133;B\x07");
        let events = parser.feed(b"\x1b]133;E;npm%20run%20dev\x07");
        assert_eq!(
            events,
            vec![Osc133Event::CommandText {
                command: "npm run dev".to_string()
            }]
        );
        parser.feed(b"\x1b]133;C\x07");
        parser.feed(b"\x1b]133;D;0\x07");
    }

    #[test]
    fn test_incremental_feed() {
        let mut parser = Osc133Parser::new();

        // Feed the sequence byte by byte
        assert!(parser.feed(b"\x1b").is_empty());
        assert!(parser.feed(b"]").is_empty());
        assert!(parser.feed(b"1").is_empty());
        assert!(parser.feed(b"3").is_empty());
        assert!(parser.feed(b"3").is_empty());
        assert!(parser.feed(b";").is_empty());
        assert!(parser.feed(b"A").is_empty());
        let events = parser.feed(b"\x07");
        assert_eq!(events, vec![Osc133Event::PromptStart]);
    }

    #[test]
    fn test_invalid_sequences_ignored() {
        let mut parser = Osc133Parser::new();

        // Invalid OSC code (not 133)
        let events = parser.feed(b"\x1b]999;X\x07");
        assert!(events.is_empty());

        // Malformed sequence
        let events = parser.feed(b"\x1b]133\x07");
        assert!(events.is_empty());
    }

    #[test]
    fn test_non_ascii_in_command() {
        let mut parser = Osc133Parser::new();

        parser.feed(b"\x1b]133;B\x07");
        // Command with only printable ASCII should be captured
        parser.feed(b"echo hello");
        parser.feed(b"\x1b]133;C\x07");
        assert_eq!(parser.extract_command(), Some("echo hello".to_string()));
    }

    #[test]
    fn test_escape_sequences_filtered() {
        let mut parser = Osc133Parser::new();

        parser.feed(b"\x1b]133;B\x07");
        // Command with ANSI escape sequences should filter them out
        parser.feed(b"\x1b[K\x1b[?1h\x1b=\x1b[?2004hpnpm dev");
        parser.feed(b"\x1b]133;C\x07");
        assert_eq!(parser.extract_command(), Some("pnpm dev".to_string()));
    }

    #[test]
    fn test_csi_sequences_filtered() {
        let mut parser = Osc133Parser::new();

        parser.feed(b"\x1b]133;B\x07");
        // CSI sequences like cursor movement should be filtered
        parser.feed(b"\x1b[2Jnpm run \x1b[31mbuild\x1b[0m");
        parser.feed(b"\x1b]133;C\x07");
        assert_eq!(parser.extract_command(), Some("npm run build".to_string()));
    }
}
