use std::path::Path;

use rand::Rng;
use serde::{Deserialize, Serialize};

/// Generate a cryptographically random token encoded as URL-safe base64.
pub fn generate_token() -> String {
    let mut bytes = [0u8; 32]; // 256 bits
    rand::thread_rng().fill(&mut bytes);
    base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub server: ServerSection,
    pub auth: AuthSection,
    #[serde(default)]
    pub sessions: Vec<SessionEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerSection {
    pub name: String,
    pub port: u16,
    pub bind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthSection {
    pub pairing_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEntry {
    pub token: String,
    pub name: String,
    pub created_at: String,
    pub last_seen: String,
}

impl ServerConfig {
    pub fn load_or_create(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        if path.exists() {
            let content = std::fs::read_to_string(path)?;
            let config: Self = toml::from_str(&content)?;
            Ok(config)
        } else {
            let hostname = gethostname::gethostname().to_string_lossy().to_string();
            let config = Self {
                server: ServerSection {
                    name: hostname,
                    port: crate::DEFAULT_PORT,
                    bind: "0.0.0.0".to_string(),
                },
                auth: AuthSection {
                    pairing_token: generate_token(),
                },
                sessions: Vec::new(),
            };
            config.save(path)?;
            Ok(config)
        }
    }

    pub fn save(&self, path: &Path) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = toml::to_string_pretty(self)?;
        std::fs::write(path, content)?;
        Ok(())
    }

    pub fn regenerate_token(&mut self) {
        self.auth.pairing_token = generate_token();
        self.sessions.clear();
    }

    /// Validate a pairing token and issue a new session token.
    pub fn pair(&mut self, pairing_token: &str, client_name: &str) -> Option<String> {
        if self.auth.pairing_token != pairing_token {
            return None;
        }
        let session_token = generate_token();
        let now = now_iso();
        self.sessions.push(SessionEntry {
            token: session_token.clone(),
            name: client_name.to_string(),
            created_at: now.clone(),
            last_seen: now,
        });
        Some(session_token)
    }

    /// Validate an existing session token. Returns true and updates last_seen if valid.
    pub fn validate_session(&mut self, session_token: &str) -> bool {
        if let Some(session) = self.sessions.iter_mut().find(|s| s.token == session_token) {
            session.last_seen = now_iso();
            true
        } else {
            false
        }
    }
}

fn now_iso() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    // Simple ISO-8601 timestamp.
    let secs = dur.as_secs();
    let days = secs / 86400;
    let time_secs = secs % 86400;
    let hours = time_secs / 3600;
    let minutes = (time_secs % 3600) / 60;
    let seconds = time_secs % 60;

    // Approximate date from epoch days (good enough for last_seen timestamps).
    let (year, month, day) = epoch_days_to_date(days);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}Z")
}

fn epoch_days_to_date(days: u64) -> (u64, u64, u64) {
    // Algorithm from http://howardhinnant.github.io/date_algorithms.html
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
