//! Remote connection CRUD methods on `Database`.
//!
//! This file contributes a `impl Database { ... }` block to the type defined
//! in `super::Database`. Multiple `impl` blocks on the same type across files
//! are idiomatic Rust; the public method paths resolve identically to a
//! single-block layout.

use rusqlite::{OptionalExtension, params};

use crate::model::RemoteConnection;

use super::Database;

impl Database {
    // --- Remote Connections ---

    fn parse_port(row: &rusqlite::Row, idx: usize) -> rusqlite::Result<u16> {
        let p: i32 = row.get(idx)?;
        if !(0..=65535).contains(&p) {
            return Err(rusqlite::Error::IntegralValueOutOfRange(idx, p as i64));
        }
        Ok(p as u16)
    }

    pub fn insert_remote_connection(&self, conn: &RemoteConnection) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO remote_connections (id, name, host, port, session_token, cert_fingerprint, auto_connect)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                conn.id,
                conn.name,
                conn.host,
                conn.port as i32,
                conn.session_token,
                conn.cert_fingerprint,
                conn.auto_connect as i32,
            ],
        )?;
        Ok(())
    }

    pub fn list_remote_connections(&self) -> Result<Vec<RemoteConnection>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, host, port, session_token, cert_fingerprint, auto_connect, created_at
             FROM remote_connections ORDER BY created_at",
        )?;
        let rows = stmt.query_map([], |row| {
            let auto_connect_int: i32 = row.get(6)?;
            Ok(RemoteConnection {
                id: row.get(0)?,
                name: row.get(1)?,
                host: row.get(2)?,
                port: Self::parse_port(row, 3)?,
                session_token: row.get(4)?,
                cert_fingerprint: row.get(5)?,
                auto_connect: auto_connect_int != 0,
                created_at: row.get(7)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_remote_connection(
        &self,
        id: &str,
    ) -> Result<Option<RemoteConnection>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT id, name, host, port, session_token, cert_fingerprint, auto_connect, created_at
                 FROM remote_connections WHERE id = ?1",
                params![id],
                |row| {
                    let auto_connect_int: i32 = row.get(6)?;
                    Ok(RemoteConnection {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        host: row.get(2)?,
                        port: Self::parse_port(row, 3)?,
                        session_token: row.get(4)?,
                        cert_fingerprint: row.get(5)?,
                        auto_connect: auto_connect_int != 0,
                        created_at: row.get(7)?,
                    })
                },
            )
            .optional()
    }

    pub fn find_remote_connection_by_host(
        &self,
        host: &str,
        port: u16,
    ) -> Result<Option<RemoteConnection>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT id, name, host, port, session_token, cert_fingerprint, auto_connect, created_at
                 FROM remote_connections WHERE host = ?1 AND port = ?2
                 ORDER BY created_at LIMIT 1",
                params![host, port as i32],
                |row| {
                    let auto_connect_int: i32 = row.get(6)?;
                    Ok(RemoteConnection {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        host: row.get(2)?,
                        port: Self::parse_port(row, 3)?,
                        session_token: row.get(4)?,
                        cert_fingerprint: row.get(5)?,
                        auto_connect: auto_connect_int != 0,
                        created_at: row.get(7)?,
                    })
                },
            )
            .optional()
    }

    pub fn update_remote_connection_session(
        &self,
        id: &str,
        name: &str,
        session_token: &str,
        cert_fingerprint: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE remote_connections SET name = ?1, session_token = ?2, cert_fingerprint = ?3
             WHERE id = ?4",
            params![name, session_token, cert_fingerprint, id],
        )?;
        Ok(())
    }

    pub fn delete_remote_connection(&self, id: &str) -> Result<(), rusqlite::Error> {
        self.conn
            .execute("DELETE FROM remote_connections WHERE id = ?1", params![id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::model::RemoteConnection as RemoteConn;

    fn make_remote_conn(id: &str, name: &str, host: &str, port: u16) -> RemoteConn {
        RemoteConn {
            id: id.into(),
            name: name.into(),
            host: host.into(),
            port,
            session_token: None,
            cert_fingerprint: None,
            auto_connect: false,
            created_at: String::new(),
        }
    }

    #[test]
    fn test_insert_and_list_remote_connections() {
        let db = Database::open_in_memory().unwrap();
        db.insert_remote_connection(&make_remote_conn("rc1", "Server A", "host-a.local", 7683))
            .unwrap();
        db.insert_remote_connection(&make_remote_conn("rc2", "Server B", "host-b.local", 9000))
            .unwrap();
        let conns = db.list_remote_connections().unwrap();
        assert_eq!(conns.len(), 2);
        assert_eq!(conns[0].name, "Server A");
        assert_eq!(conns[1].port, 9000);
    }

    #[test]
    fn test_get_remote_connection() {
        let db = Database::open_in_memory().unwrap();
        db.insert_remote_connection(&make_remote_conn("rc1", "Server A", "host-a.local", 7683))
            .unwrap();
        let conn = db.get_remote_connection("rc1").unwrap().unwrap();
        assert_eq!(conn.host, "host-a.local");
        assert!(!conn.created_at.is_empty()); // DB default fills this
    }

    #[test]
    fn test_get_remote_connection_missing() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.get_remote_connection("nonexistent").unwrap();
        assert!(conn.is_none());
    }

    #[test]
    fn test_update_remote_connection_session() {
        let db = Database::open_in_memory().unwrap();
        db.insert_remote_connection(&make_remote_conn("rc1", "Server A", "host-a.local", 7683))
            .unwrap();
        db.update_remote_connection_session("rc1", "Server A (renamed)", "tok-123", "fp-abc")
            .unwrap();
        let conn = db.get_remote_connection("rc1").unwrap().unwrap();
        assert_eq!(conn.name, "Server A (renamed)");
        assert_eq!(conn.session_token.as_deref(), Some("tok-123"));
        assert_eq!(conn.cert_fingerprint.as_deref(), Some("fp-abc"));
    }

    #[test]
    fn test_find_remote_connection_by_host() {
        let db = Database::open_in_memory().unwrap();
        db.insert_remote_connection(&make_remote_conn("rc1", "Server A", "host-a.local", 7683))
            .unwrap();
        db.insert_remote_connection(&make_remote_conn("rc2", "Server B", "host-b.local", 9000))
            .unwrap();

        let found = db
            .find_remote_connection_by_host("host-a.local", 7683)
            .unwrap()
            .expect("connection by host:port");
        assert_eq!(found.id, "rc1");

        // Different port on same host: no match.
        let none = db
            .find_remote_connection_by_host("host-a.local", 9999)
            .unwrap();
        assert!(none.is_none());

        // Unknown host.
        let none = db
            .find_remote_connection_by_host("nope.local", 7683)
            .unwrap();
        assert!(none.is_none());
    }

    #[test]
    fn test_delete_remote_connection() {
        let db = Database::open_in_memory().unwrap();
        db.insert_remote_connection(&make_remote_conn("rc1", "Server A", "host-a.local", 7683))
            .unwrap();
        db.delete_remote_connection("rc1").unwrap();
        let conns = db.list_remote_connections().unwrap();
        assert!(conns.is_empty());
    }

    #[test]
    fn test_remote_connection_auto_connect_flag() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = make_remote_conn("rc1", "Server A", "host-a.local", 7683);
        conn.auto_connect = true;
        db.insert_remote_connection(&conn).unwrap();
        let fetched = db.get_remote_connection("rc1").unwrap().unwrap();
        assert!(fetched.auto_connect);
    }
}
