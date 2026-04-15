use std::path::Path;

use rand::Rng;
use serde::{Deserialize, Serialize};

/// Maximum number of active sessions. When exceeded, the oldest session is evicted.
pub const MAX_SESSIONS: usize = 64;

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
        // Truncate oldest sessions to stay within the limit.
        // Handles both normal growth (one over) and legacy configs
        // that already exceed MAX_SESSIONS.
        let excess = self.sessions.len().saturating_sub(MAX_SESSIONS);
        if excess > 0 {
            self.sessions.drain(0..excess);
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    // ---- epoch_days_to_date tests ----

    #[test]
    fn test_epoch_day_zero() {
        assert_eq!(epoch_days_to_date(0), (1970, 1, 1));
    }

    #[test]
    fn test_epoch_day_one() {
        assert_eq!(epoch_days_to_date(1), (1970, 1, 2));
    }

    #[test]
    fn test_known_date_2020() {
        // 2020-01-01 00:00:00 UTC = 1577836800 / 86400 = 18262
        assert_eq!(epoch_days_to_date(18262), (2020, 1, 1));
    }

    #[test]
    fn test_leap_year_feb_29() {
        // 2024-02-29 00:00:00 UTC = 1709164800 / 86400 = 19782
        assert_eq!(epoch_days_to_date(19782), (2024, 2, 29));
    }

    #[test]
    fn test_century_leap_year_2000() {
        // Year 2000 is a leap year (divisible by 400).
        // 2000-02-29 00:00:00 UTC = 951782400 / 86400 = 11016
        assert_eq!(epoch_days_to_date(11016), (2000, 2, 29));
    }

    #[test]
    fn test_end_of_year() {
        // 2023-12-31 00:00:00 UTC = 1703980800 / 86400 = 19722
        assert_eq!(epoch_days_to_date(19722), (2023, 12, 31));
    }

    #[test]
    fn test_large_day_count() {
        // 3000-06-15: 376365 days from epoch
        assert_eq!(epoch_days_to_date(376365), (3000, 6, 15));
    }

    #[test]
    fn test_sequential_days_increment() {
        // 10 consecutive days starting 2023-01-28, crossing into February.
        let expected: [(u64, u64, u64); 10] = [
            (2023, 1, 28),
            (2023, 1, 29),
            (2023, 1, 30),
            (2023, 1, 31),
            (2023, 2, 1),
            (2023, 2, 2),
            (2023, 2, 3),
            (2023, 2, 4),
            (2023, 2, 5),
            (2023, 2, 6),
        ];
        let start_day: u64 = 19385; // 2023-01-28
        for (i, &exp) in expected.iter().enumerate() {
            assert_eq!(
                epoch_days_to_date(start_day + i as u64),
                exp,
                "mismatch at offset {i}"
            );
        }
    }

    // ---- now_iso tests ----

    #[test]
    fn test_now_iso_format() {
        let ts = now_iso();
        let bytes = ts.as_bytes();
        // Expected format: "YYYY-MM-DDTHH:MM:SSZ" (20 chars)
        assert_eq!(bytes.len(), 20, "timestamp {ts:?} should be 20 characters");
        assert!(
            bytes[0..4].iter().all(|b| b.is_ascii_digit()),
            "year should be digits"
        );
        assert_eq!(bytes[4], b'-');
        assert!(
            bytes[5..7].iter().all(|b| b.is_ascii_digit()),
            "month should be digits"
        );
        assert_eq!(bytes[7], b'-');
        assert!(
            bytes[8..10].iter().all(|b| b.is_ascii_digit()),
            "day should be digits"
        );
        assert_eq!(bytes[10], b'T');
        assert!(
            bytes[11..13].iter().all(|b| b.is_ascii_digit()),
            "hours should be digits"
        );
        assert_eq!(bytes[13], b':');
        assert!(
            bytes[14..16].iter().all(|b| b.is_ascii_digit()),
            "minutes should be digits"
        );
        assert_eq!(bytes[16], b':');
        assert!(
            bytes[17..19].iter().all(|b| b.is_ascii_digit()),
            "seconds should be digits"
        );
        assert_eq!(bytes[19], b'Z');
    }

    #[test]
    fn test_now_iso_ends_with_z() {
        let ts = now_iso();
        assert!(ts.ends_with('Z'), "timestamp {ts:?} should end with 'Z'");
    }

    #[test]
    fn test_now_iso_reasonable_year() {
        let ts = now_iso();
        let year: u64 = ts[..4].parse().expect("first 4 chars should be a year");
        assert!(
            year >= 1970,
            "year {year} should be at or after the Unix epoch"
        );
    }
}
