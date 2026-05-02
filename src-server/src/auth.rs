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
    /// Auth section is retained for compatibility with older config files —
    /// if a `pairing_token` field is present on disk, we keep loading it but
    /// the runtime no longer consults it. New deployments don't need any
    /// global pairing token; all access is share-scoped.
    #[serde(default)]
    pub auth: Option<AuthSection>,
    /// Active shares. Each share holds its own pairing token, the workspace
    /// ids it grants access to, and the session tokens it has issued.
    /// Removing a share invalidates every session token that came from it
    /// (next request fails the share-existence check), giving immediate
    /// revocation without any separate "revoked" set to keep in sync.
    #[serde(default)]
    pub shares: Vec<ShareEntry>,
    /// Legacy persistent sessions from the pre-shares era, retained only
    /// so old config files round-trip cleanly. New code never appends here.
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

/// One share — a workspace-scoped authorization grant.
///
/// The pairing token in this struct is what the host hands out to the
/// people they want to grant access to (typically embedded in a
/// `claudette://...` connection string). The `allowed_workspace_ids` list
/// is the *complete* set of workspace ids any session token issued by this
/// share is permitted to see; every workspace-touching RPC consults it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShareEntry {
    /// Stable id for this share. The host UI uses it to revoke
    /// (`stop_share`) and list active shares.
    pub id: String,
    /// Optional human-friendly label (e.g. "Work team", "OSS collaborators").
    /// Surfaced on the host UI so the user can tell shares apart.
    #[serde(default)]
    pub label: Option<String>,
    /// The pairing token. Distinct from session tokens — clients pair
    /// once with this, then reuse the issued session_token on subsequent
    /// reconnects.
    pub pairing_token: String,
    /// Workspace ids this share grants access to. The set is fixed at
    /// share-creation time; to change scope, revoke and create a new share.
    pub allowed_workspace_ids: Vec<String>,
    /// `false` for plain remote-control shares; `true` when the share is
    /// for collaborative sessions. When true, joining a chat session in
    /// scope auto-creates a `Room` (with `consensus_required` from below).
    #[serde(default)]
    pub collaborative: bool,
    /// Whether plan-consensus voting is required for this share's collab
    /// sessions. Ignored when `collaborative=false`.
    #[serde(default)]
    pub consensus_required: bool,
    /// Session tokens issued by pair-ins against this share's
    /// `pairing_token`. Each entry inherits the share's scope.
    #[serde(default)]
    pub sessions: Vec<SessionEntry>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEntry {
    pub token: String,
    pub name: String,
    pub created_at: String,
    pub last_seen: String,
}

/// What a successful authentication produces — enough state for the WS
/// handler to construct a `ConnectionCtx`.
#[derive(Debug, Clone)]
pub struct ResolvedSession {
    pub session: SessionEntry,
    /// The id of the share this session was issued from. Existence of this
    /// id in `ServerConfig.shares` is checked on every RPC; if the share
    /// has been revoked, the connection is rejected.
    pub share_id: String,
    pub allowed_workspace_ids: Vec<String>,
    pub collaborative: bool,
    pub consensus_required: bool,
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
                auth: None,
                shares: Vec::new(),
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

    /// Mint a new share with the given scope and return the freshly-created
    /// entry (so the caller can read its `pairing_token` for display).
    pub fn create_share(
        &mut self,
        label: Option<String>,
        allowed_workspace_ids: Vec<String>,
        collaborative: bool,
        consensus_required: bool,
    ) -> &ShareEntry {
        let entry = ShareEntry {
            id: uuid_v4(),
            label,
            pairing_token: generate_token(),
            allowed_workspace_ids,
            collaborative,
            consensus_required,
            sessions: Vec::new(),
            created_at: now_iso(),
        };
        self.shares.push(entry);
        self.shares.last().expect("just pushed")
    }

    /// Drop a share by id and return whether it existed. Removing the
    /// share also drops every session token it issued — there is no other
    /// list to scrub. The next RPC from any of those connections looks up
    /// the missing `share_id` and is rejected.
    pub fn revoke_share(&mut self, share_id: &str) -> bool {
        let before = self.shares.len();
        self.shares.retain(|s| s.id != share_id);
        before != self.shares.len()
    }

    pub fn list_shares(&self) -> &[ShareEntry] {
        &self.shares
    }

    /// Validate a pairing token. On match, issue a new session token,
    /// record it on the share's session list, and return the resolved
    /// session bundle. Returns `None` for unknown / revoked tokens.
    pub fn pair(&mut self, pairing_token: &str, client_name: &str) -> Option<ResolvedSession> {
        let share_idx = self
            .shares
            .iter()
            .position(|s| s.pairing_token == pairing_token)?;
        let session_token = generate_token();
        let now = now_iso();
        let session = SessionEntry {
            token: session_token,
            name: client_name.to_string(),
            created_at: now.clone(),
            last_seen: now,
        };
        let share = &mut self.shares[share_idx];
        share.sessions.push(session.clone());
        Some(ResolvedSession {
            session,
            share_id: share.id.clone(),
            allowed_workspace_ids: share.allowed_workspace_ids.clone(),
            collaborative: share.collaborative,
            consensus_required: share.consensus_required,
        })
    }

    /// Re-authenticate an existing session token. Walks every share's
    /// session list (cheap — a host has O(few) shares each with O(few)
    /// sessions) and returns the matching `ResolvedSession` with
    /// `last_seen` bumped. Returns `None` for tokens belonging to
    /// revoked shares or otherwise unknown tokens.
    pub fn validate_session(&mut self, session_token: &str) -> Option<ResolvedSession> {
        for share in self.shares.iter_mut() {
            if let Some(session) = share.sessions.iter_mut().find(|s| s.token == session_token) {
                session.last_seen = now_iso();
                return Some(ResolvedSession {
                    session: session.clone(),
                    share_id: share.id.clone(),
                    allowed_workspace_ids: share.allowed_workspace_ids.clone(),
                    collaborative: share.collaborative,
                    consensus_required: share.consensus_required,
                });
            }
        }
        None
    }

    /// Look up which workspaces a given session token is scoped to,
    /// without modifying state. Used by RPC authorization gates so we
    /// don't have to thread the resolved scope through every call.
    pub fn share_for_session(&self, session_token: &str) -> Option<&ShareEntry> {
        self.shares
            .iter()
            .find(|s| s.sessions.iter().any(|x| x.token == session_token))
    }
}

/// Derive a stable, opaque participant id from a session token. The same
/// pairing always yields the same id; different pairings (or token rotation)
/// yield different ids. One-way: the id reveals nothing about the token, so
/// it is safe to broadcast in events and persist in chat-message rows.
pub fn participant_id_for_token(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(token.as_bytes());
    base64::Engine::encode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        &digest[..16],
    )
}

fn uuid_v4() -> String {
    // Lightweight UUID using random bytes — avoids pulling another dep at
    // this layer and matches the existing `generate_token` convention.
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill(&mut bytes);
    // Set version (4) and variant (RFC4122) bits.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    )
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

    fn empty_config() -> ServerConfig {
        ServerConfig {
            server: ServerSection {
                name: "test".into(),
                port: 0,
                bind: "127.0.0.1".into(),
            },
            auth: None,
            shares: Vec::new(),
            sessions: Vec::new(),
        }
    }

    #[test]
    fn create_share_assigns_unique_id_and_token() {
        let mut cfg = empty_config();
        let a = cfg
            .create_share(None, vec!["ws-1".into()], false, false)
            .clone();
        let b = cfg
            .create_share(None, vec!["ws-2".into()], true, true)
            .clone();
        assert_ne!(a.id, b.id);
        assert_ne!(a.pairing_token, b.pairing_token);
        assert_eq!(a.allowed_workspace_ids, vec!["ws-1"]);
        assert!(b.consensus_required);
    }

    #[test]
    fn pair_only_matches_existing_share_token() {
        let mut cfg = empty_config();
        let token = cfg
            .create_share(None, vec!["ws-1".into()], false, false)
            .pairing_token
            .clone();
        assert!(cfg.pair("not-a-real-token", "alice").is_none());
        let resolved = cfg.pair(&token, "alice").unwrap();
        assert_eq!(resolved.allowed_workspace_ids, vec!["ws-1"]);
        // Share now has one issued session.
        assert_eq!(cfg.shares[0].sessions.len(), 1);
    }

    #[test]
    fn validate_session_returns_scope_and_bumps_last_seen() {
        let mut cfg = empty_config();
        let token = cfg
            .create_share(
                Some("Work".into()),
                vec!["ws-A".into(), "ws-B".into()],
                true,
                true,
            )
            .pairing_token
            .clone();
        let resolved = cfg.pair(&token, "bob").unwrap();
        let session_token = resolved.session.token.clone();
        let original_last_seen = resolved.session.last_seen.clone();

        // Sleep a real second so last_seen visibly bumps. now_iso has
        // 1s resolution.
        std::thread::sleep(std::time::Duration::from_millis(1100));

        let revalidated = cfg.validate_session(&session_token).unwrap();
        assert_eq!(revalidated.allowed_workspace_ids, vec!["ws-A", "ws-B"]);
        assert!(revalidated.collaborative);
        assert!(revalidated.consensus_required);
        assert_ne!(revalidated.session.last_seen, original_last_seen);
    }

    #[test]
    fn revoke_share_invalidates_its_sessions() {
        let mut cfg = empty_config();
        let share = cfg
            .create_share(None, vec!["ws-1".into()], false, false)
            .clone();
        let resolved = cfg.pair(&share.pairing_token, "alice").unwrap();
        let token = resolved.session.token.clone();

        // Sanity: validates before revocation.
        assert!(cfg.validate_session(&token).is_some());

        let removed = cfg.revoke_share(&share.id);
        assert!(removed);

        // After revocation, the session token is unknown — no remaining
        // share carries it.
        assert!(cfg.validate_session(&token).is_none());
    }

    #[test]
    fn revoke_share_returns_false_for_unknown_id() {
        let mut cfg = empty_config();
        assert!(!cfg.revoke_share("nonexistent"));
    }

    #[test]
    fn share_for_session_finds_owning_share() {
        let mut cfg = empty_config();
        let token_a = cfg
            .create_share(None, vec!["ws-1".into()], false, false)
            .pairing_token
            .clone();
        let token_b = cfg
            .create_share(None, vec!["ws-2".into()], false, false)
            .pairing_token
            .clone();
        let session_a = cfg.pair(&token_a, "alice").unwrap().session.token;
        let session_b = cfg.pair(&token_b, "bob").unwrap().session.token;

        let share_a = cfg.share_for_session(&session_a).unwrap();
        assert_eq!(share_a.allowed_workspace_ids, vec!["ws-1"]);
        let share_b = cfg.share_for_session(&session_b).unwrap();
        assert_eq!(share_b.allowed_workspace_ids, vec!["ws-2"]);
    }

    #[test]
    fn participant_ids_are_stable_per_token() {
        let token = "abc";
        assert_eq!(
            participant_id_for_token(token),
            participant_id_for_token(token)
        );
        assert_ne!(
            participant_id_for_token("abc"),
            participant_id_for_token("abd")
        );
    }
}
