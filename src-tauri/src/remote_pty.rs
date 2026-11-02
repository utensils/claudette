//! Local aliases for terminals running on a paired server.
//!
//! PTY IDs are small per-process counters, so a remote terminal's ID can
//! equal a local one (or one from another remote). The frontend keys
//! terminal panes, `pty-output` and `pty-exit` on the bare ID, so every
//! remote PTY is given a local alias from a range no local counter reaches.
//! Requests are rewritten alias → remote on the way out and events remote →
//! alias on the way in; events for remote PTYs this window didn't open
//! (another client's terminals) are dropped.
//!
//! A new shell can print (or exit) before its `spawn_pty` response arrives,
//! while its ID is still unknown here. So while a spawn is in flight on a
//! connection, events for unknown IDs are held and handed back when the
//! spawn registers its alias.

use std::collections::{HashMap, VecDeque};

use serde_json::Value;

/// First alias handed out. Far above any local PTY counter, and well inside
/// JavaScript's 2^53 safe-integer range.
pub const REMOTE_PTY_ALIAS_BASE: u64 = 1 << 40;

const PTY_ID_METHODS: &[&str] = &["write_pty", "resize_pty", "close_pty"];

/// Events held per unknown remote terminal while a spawn is in flight.
/// Startup output is a prompt or a few lines; beyond this, older events go.
const MAX_EARLY_EVENTS_PER_PTY: usize = 256;

/// A held event: name and (untranslated) payload.
pub type EarlyEvent = (String, Value);
const PTY_ID_EVENTS: &[&str] = &["pty-output", "pty-exit"];

pub struct PtyAliases {
    next: u64,
    by_alias: HashMap<u64, (String, u64)>,
    by_remote: HashMap<(String, u64), u64>,
    /// `spawn_pty` requests awaiting a response, per connection.
    spawns_in_flight: HashMap<String, usize>,
    /// Events for not-yet-registered remote terminals, oldest first.
    early: HashMap<(String, u64), VecDeque<EarlyEvent>>,
}

impl Default for PtyAliases {
    fn default() -> Self {
        Self {
            next: REMOTE_PTY_ALIAS_BASE,
            by_alias: HashMap::new(),
            by_remote: HashMap::new(),
            spawns_in_flight: HashMap::new(),
            early: HashMap::new(),
        }
    }
}

impl PtyAliases {
    fn register(&mut self, connection_id: &str, remote_id: u64) -> u64 {
        let key = (connection_id.to_string(), remote_id);
        if let Some(&alias) = self.by_remote.get(&key) {
            return alias;
        }
        let alias = self.next;
        self.next += 1;
        self.by_alias.insert(alias, key.clone());
        self.by_remote.insert(key, alias);
        alias
    }

    fn remove_alias(&mut self, alias: u64) {
        if let Some(key) = self.by_alias.remove(&alias) {
            self.by_remote.remove(&key);
        }
    }

    /// Forget every alias belonging to a dropped connection.
    pub fn drop_connection(&mut self, connection_id: &str) {
        self.by_alias.retain(|_, (conn, _)| conn != connection_id);
        self.by_remote.retain(|(conn, _), _| conn != connection_id);
        self.spawns_in_flight.remove(connection_id);
        self.early.retain(|(conn, _), _| conn != connection_id);
    }

    /// A `spawn_pty` request is about to go out on `connection_id`.
    pub fn begin_spawn(&mut self, connection_id: &str) {
        *self
            .spawns_in_flight
            .entry(connection_id.to_string())
            .or_default() += 1;
    }

    /// A `spawn_pty` request on `connection_id` finished (either way).
    /// Once none are left, held events belong to terminals this window
    /// didn't open, so they're dropped.
    pub fn end_spawn(&mut self, connection_id: &str) {
        let remaining = match self.spawns_in_flight.get_mut(connection_id) {
            Some(count) => {
                *count = count.saturating_sub(1);
                *count
            }
            None => 0,
        };
        if remaining == 0 {
            self.spawns_in_flight.remove(connection_id);
            self.early.retain(|(conn, _), _| conn != connection_id);
        }
    }

    /// Rewrite an outgoing request's `pty_id` from alias to remote ID.
    pub fn translate_request(
        &self,
        connection_id: &str,
        method: &str,
        params: &mut Value,
    ) -> Result<(), String> {
        if !PTY_ID_METHODS.contains(&method) {
            return Ok(());
        }
        let alias = params
            .get("pty_id")
            .and_then(|v| v.as_u64())
            .ok_or("missing pty_id")?;
        let (conn, remote_id) = self
            .by_alias
            .get(&alias)
            .ok_or_else(|| format!("Unknown remote terminal {alias}"))?;
        if conn != connection_id {
            return Err(format!(
                "Terminal {alias} belongs to a different remote connection"
            ));
        }
        params["pty_id"] = Value::from(*remote_id);
        Ok(())
    }

    /// Rewrite a response after it comes back: register the new terminal
    /// from `spawn_pty`, forget a closed one.
    ///
    /// For `spawn_pty`, also returns the terminal's events that arrived
    /// before this response, translated and ready to emit in order. (The
    /// caller must have called [`Self::begin_spawn`].)
    pub fn translate_response(
        &mut self,
        connection_id: &str,
        method: &str,
        alias_in_request: Option<u64>,
        mut result: Value,
    ) -> (Value, Vec<EarlyEvent>) {
        let mut early = Vec::new();
        match method {
            "spawn_pty" => {
                if let Some(remote_id) = result.get("pty_id").and_then(|v| v.as_u64()) {
                    result["pty_id"] = Value::from(self.register(connection_id, remote_id));
                    let held = self
                        .early
                        .remove(&(connection_id.to_string(), remote_id))
                        .unwrap_or_default();
                    early = held
                        .into_iter()
                        .filter_map(|(event, payload)| {
                            let payload = self.translate_event(connection_id, &event, payload)?;
                            Some((event, payload))
                        })
                        .collect();
                }
                self.end_spawn(connection_id);
            }
            "close_pty" => {
                if let Some(alias) = alias_in_request {
                    self.remove_alias(alias);
                }
            }
            _ => {}
        }
        (result, early)
    }

    /// Rewrite an incoming event's `pty_id` from remote ID to alias.
    /// `None` means the event isn't for a terminal this window opened.
    pub fn translate_event(
        &mut self,
        connection_id: &str,
        event: &str,
        mut payload: Value,
    ) -> Option<Value> {
        if !PTY_ID_EVENTS.contains(&event) {
            return Some(payload);
        }
        let remote_id = payload.get("pty_id").and_then(|v| v.as_u64())?;
        let key = (connection_id.to_string(), remote_id);
        let Some(&alias) = self.by_remote.get(&key) else {
            if self.spawns_in_flight.contains_key(connection_id) {
                let held = self.early.entry(key).or_default();
                if held.len() == MAX_EARLY_EVENTS_PER_PTY {
                    held.pop_front();
                }
                held.push_back((event.to_string(), payload));
            }
            return None;
        };
        payload["pty_id"] = Value::from(alias);
        if event == "pty-exit" {
            self.remove_alias(alias);
        }
        Some(payload)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spawned(aliases: &mut PtyAliases, conn: &str, remote_id: u64) -> u64 {
        aliases.begin_spawn(conn);
        aliases
            .translate_response(conn, "spawn_pty", None, json!({"pty_id": remote_id}))
            .0["pty_id"]
            .as_u64()
            .unwrap()
    }

    #[test]
    fn spawn_hands_out_aliases_outside_the_local_range() {
        let mut aliases = PtyAliases::default();
        let a = spawned(&mut aliases, "c1", 1);
        let b = spawned(&mut aliases, "c2", 1);
        assert!(a >= REMOTE_PTY_ALIAS_BASE);
        assert_ne!(a, b, "same remote ID on two servers must not collide");
    }

    #[test]
    fn requests_and_events_round_trip_through_the_alias() {
        let mut aliases = PtyAliases::default();
        let alias = spawned(&mut aliases, "c1", 7);

        let mut params = json!({"pty_id": alias, "data": [104]});
        aliases
            .translate_request("c1", "write_pty", &mut params)
            .unwrap();
        assert_eq!(params["pty_id"], 7);

        let event = aliases
            .translate_event("c1", "pty-output", json!({"pty_id": 7, "data": [1]}))
            .unwrap();
        assert_eq!(event["pty_id"], alias);
    }

    #[test]
    fn events_for_terminals_this_window_did_not_open_are_dropped() {
        let mut aliases = PtyAliases::default();
        spawned(&mut aliases, "c1", 7);
        assert!(
            aliases
                .translate_event("c1", "pty-output", json!({"pty_id": 8}))
                .is_none()
        );
        assert!(
            aliases
                .translate_event("c2", "pty-output", json!({"pty_id": 7}))
                .is_none()
        );
    }

    #[test]
    fn exit_and_close_forget_the_alias() {
        let mut aliases = PtyAliases::default();
        let a = spawned(&mut aliases, "c1", 1);
        aliases.translate_event("c1", "pty-exit", json!({"pty_id": 1}));
        assert!(
            aliases
                .translate_request("c1", "write_pty", &mut json!({"pty_id": a}))
                .is_err()
        );

        let b = spawned(&mut aliases, "c1", 2);
        let _ = aliases.translate_response("c1", "close_pty", Some(b), json!(null));
        assert!(
            aliases
                .translate_event("c1", "pty-output", json!({"pty_id": 2}))
                .is_none()
        );
    }

    #[test]
    fn requests_against_another_connections_alias_are_rejected() {
        let mut aliases = PtyAliases::default();
        let a = spawned(&mut aliases, "c1", 1);
        assert!(
            aliases
                .translate_request("c2", "resize_pty", &mut json!({"pty_id": a}))
                .is_err()
        );
    }

    #[test]
    fn non_pty_traffic_passes_through() {
        let mut aliases = PtyAliases::default();
        let mut params = json!({"chat_session_id": "s"});
        aliases
            .translate_request("c1", "send_chat_message", &mut params)
            .unwrap();
        assert_eq!(params, json!({"chat_session_id": "s"}));
        assert_eq!(
            aliases.translate_event("c1", "agent-stream", json!({"a": 1})),
            Some(json!({"a": 1}))
        );
    }

    #[test]
    fn output_before_the_spawn_response_is_held_and_returned() {
        let mut aliases = PtyAliases::default();
        aliases.begin_spawn("c1");
        assert!(
            aliases
                .translate_event("c1", "pty-output", json!({"pty_id": 9, "data": [36]}))
                .is_none()
        );
        let (result, early) =
            aliases.translate_response("c1", "spawn_pty", None, json!({"pty_id": 9}));
        let alias = result["pty_id"].as_u64().unwrap();
        assert_eq!(early.len(), 1);
        assert_eq!(early[0].0, "pty-output");
        assert_eq!(early[0].1["pty_id"], alias);
        assert_eq!(early[0].1["data"], json!([36]));
    }

    #[test]
    fn an_immediate_exit_is_delivered_and_forgets_the_alias() {
        let mut aliases = PtyAliases::default();
        aliases.begin_spawn("c1");
        aliases.translate_event("c1", "pty-exit", json!({"pty_id": 9}));
        let (result, early) =
            aliases.translate_response("c1", "spawn_pty", None, json!({"pty_id": 9}));
        let alias = result["pty_id"].as_u64().unwrap();
        assert_eq!(
            early,
            vec![("pty-exit".to_string(), json!({"pty_id": alias}))]
        );
        assert!(
            aliases
                .translate_request("c1", "write_pty", &mut json!({"pty_id": alias}))
                .is_err()
        );
    }

    #[test]
    fn other_terminals_events_are_not_held_once_no_spawn_is_pending() {
        let mut aliases = PtyAliases::default();
        aliases.begin_spawn("c1");
        aliases.translate_event("c1", "pty-output", json!({"pty_id": 4, "data": []}));
        // A different terminal came back; 4 belongs to someone else.
        let (_, early) = aliases.translate_response("c1", "spawn_pty", None, json!({"pty_id": 9}));
        assert!(early.is_empty());
        assert!(aliases.early.is_empty());
        // And nothing is held while no spawn is in flight.
        aliases.translate_event("c1", "pty-output", json!({"pty_id": 4, "data": []}));
        assert!(aliases.early.is_empty());
    }

    #[test]
    fn held_events_are_bounded() {
        let mut aliases = PtyAliases::default();
        aliases.begin_spawn("c1");
        for i in 0..(MAX_EARLY_EVENTS_PER_PTY + 10) {
            aliases.translate_event("c1", "pty-output", json!({"pty_id": 9, "data": [i]}));
        }
        let (_, early) = aliases.translate_response("c1", "spawn_pty", None, json!({"pty_id": 9}));
        assert_eq!(early.len(), MAX_EARLY_EVENTS_PER_PTY);
        assert_eq!(early[0].1["data"], json!([10]));
    }
}
