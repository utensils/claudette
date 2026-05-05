//! Parent-side listener for the Claudette MCP grandchild.
//!
//! Each persistent agent session owns one [`McpBridgeSession`], which:
//! - Binds a per-session local socket (Unix domain socket / Windows named pipe).
//! - Issues a bearer token (env var `CLAUDETTE_MCP_TOKEN`) that authenticates
//!   incoming connections.
//! - Spawns a tokio task that accepts grandchild connections and routes their
//!   [`BridgePayload`]s through a [`Sink`] to the Tauri app (DB writes, event
//!   emission).
//! - Releases the listener and unlinks the socket file on `Drop` — RAII so
//!   teardown is guaranteed even on panic.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use interprocess::local_socket::tokio::{Stream, prelude::*};
use interprocess::local_socket::{GenericFilePath, GenericNamespaced, ListenerOptions, Name};
use rand::RngCore;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::agent_mcp::protocol::{BridgePayload, BridgeRequest, BridgeResponse};

// Suppress unused-import warning on platforms where one branch of `name_for`
// isn't taken. The underscored `_` const consumes the imported type without
// keeping it visible (and stays out of any test-module-ordering lint).
#[cfg(unix)]
const _UNUSED_ON_UNIX: Option<GenericNamespaced> = None;
#[cfg(windows)]
const _UNUSED_ON_WINDOWS: Option<GenericFilePath> = None;

/// Implemented by the Tauri-side glue. The bridge listener calls this for
/// every authenticated request so the lib stays Tauri-free and unit-testable
/// against a mock implementation.
///
/// Boxed-future return rather than `async fn in trait` so generic listener
/// code can name the `Send` bound on the returned future without depending
/// on RPITIT-stable Send inference.
pub trait Sink: Send + Sync + 'static {
    fn handle(
        &self,
        payload: BridgePayload,
    ) -> Pin<Box<dyn Future<Output = BridgeResponse> + Send + '_>>;
}

/// Parameters used to launch the grandchild MCP server. The bridge owns the
/// socket address + token; the caller takes these and feeds them into the
/// `--mcp-config` env block so the Claude CLI passes them to the grandchild.
#[derive(Debug, Clone)]
pub struct BridgeHandle {
    /// Filesystem path (Unix) or namespaced name (Windows) of the local
    /// socket the grandchild should connect to.
    pub socket_addr: String,
    /// One-time bearer token that authenticates the grandchild.
    pub token: String,
}

/// A live MCP bridge listener. Drop to tear down.
pub struct McpBridgeSession {
    handle: BridgeHandle,
    cancel_tx: Option<oneshot::Sender<()>>,
    listener_task: Option<JoinHandle<()>>,
    /// On Unix we created a socket file we want to clean up. On Windows the
    /// named pipe disappears with the listener handle, so this is `None`.
    socket_file_path: Option<PathBuf>,
}

impl McpBridgeSession {
    pub fn handle(&self) -> &BridgeHandle {
        &self.handle
    }

    /// Spin up a listener bound to a fresh per-session socket and return a
    /// session handle. The `sink` is shared across all incoming connections.
    pub async fn start<S: Sink>(sink: Arc<S>) -> Result<Self, String> {
        let session_uuid = uuid::Uuid::new_v4().to_string();
        let token = generate_token();
        let (socket_addr, socket_file_path) = make_socket_address(&session_uuid)?;
        let name = name_for(&socket_addr)?;

        let listener = ListenerOptions::new()
            .name(name)
            .create_tokio()
            .map_err(|e| format!("bind socket {socket_addr}: {e}"))?;

        let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
        let task_token = token.clone();
        let task_sink = Arc::clone(&sink);
        let listener_task = tokio::spawn(async move {
            run_listener(listener, task_token, task_sink, cancel_rx).await;
        });

        Ok(Self {
            handle: BridgeHandle { socket_addr, token },
            cancel_tx: Some(cancel_tx),
            listener_task: Some(listener_task),
            socket_file_path,
        })
    }
}

impl Drop for McpBridgeSession {
    fn drop(&mut self) {
        if let Some(tx) = self.cancel_tx.take() {
            let _ = tx.send(());
        }
        if let Some(task) = self.listener_task.take() {
            task.abort();
        }
        if let Some(path) = self.socket_file_path.take() {
            let _ = std::fs::remove_file(&path);
        }
    }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Decide where to put the per-session socket. Unix: a short file under
/// `${TMPDIR}/cmcp/` — macOS caps `sun_path` at 104 bytes, so directory and
/// filename are kept terse. Windows: a namespaced pipe name (no fs entry).
fn make_socket_address(session_uuid: &str) -> Result<(String, Option<PathBuf>), String> {
    #[cfg(unix)]
    {
        // Trim the UUID to the first 8 chars (32 bits of randomness — plenty
        // for per-process uniqueness) so paths stay well under macOS's
        // 104-byte `sun_path` limit even when TMPDIR is the long
        // `/var/folders/.../T/` path.
        let short_id: String = session_uuid.chars().take(8).collect();
        let dir = std::env::temp_dir().join("cmcp");
        std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
        let path = dir.join(format!("{short_id}.sock"));
        // Pre-clean any stale file (e.g. from a crashed parent).
        let _ = std::fs::remove_file(&path);
        let path_str = path
            .to_str()
            .ok_or_else(|| "socket path is not valid UTF-8".to_string())?
            .to_string();
        Ok((path_str, Some(path)))
    }
    #[cfg(windows)]
    {
        let name = format!("claudette-mcp-{session_uuid}");
        Ok((name, None))
    }
}

/// Build a `Name` we can pass to listener / connect APIs.
fn name_for(addr: &str) -> Result<Name<'static>, String> {
    let owned = addr.to_string();
    #[cfg(unix)]
    {
        owned
            .to_fs_name::<GenericFilePath>()
            .map_err(|e| format!("fs name {addr}: {e}"))
    }
    #[cfg(windows)]
    {
        owned
            .to_ns_name::<GenericNamespaced>()
            .map_err(|e| format!("ns name {addr}: {e}"))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = owned;
        Err("unsupported platform".into())
    }
}

async fn run_listener<S: Sink>(
    listener: interprocess::local_socket::tokio::Listener,
    token: String,
    sink: Arc<S>,
    mut cancel_rx: oneshot::Receiver<()>,
) {
    loop {
        let conn = tokio::select! {
            _ = &mut cancel_rx => return,
            res = listener.accept() => match res {
                Ok(c) => c,
                Err(_) => return,
            },
        };
        let token = token.clone();
        let sink = Arc::clone(&sink);
        tokio::spawn(async move {
            let _ = handle_connection(conn, token, sink).await;
        });
    }
}

async fn handle_connection<S: Sink>(
    conn: Stream,
    expected_token: String,
    sink: Arc<S>,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(&conn);
    let mut writer = &conn;
    let mut line = String::new();

    loop {
        line.clear();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            return Ok(()); // peer closed
        }

        let response = match serde_json::from_str::<BridgeRequest>(line.trim()) {
            Err(e) => BridgeResponse::err(format!("bad request: {e}")),
            Ok(req) if req.token != expected_token => BridgeResponse::err("unauthorized"),
            Ok(req) => sink.handle(req.payload).await,
        };

        let mut bytes = serde_json::to_vec(&response).unwrap_or_else(|_| b"{}".to_vec());
        bytes.push(b'\n');
        writer.write_all(&bytes).await?;
        writer.flush().await?;
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct CountingSink {
        count: AtomicU32,
        last_payload: tokio::sync::Mutex<Option<BridgePayload>>,
    }

    impl Sink for CountingSink {
        fn handle(
            &self,
            payload: BridgePayload,
        ) -> Pin<Box<dyn Future<Output = BridgeResponse> + Send + '_>> {
            Box::pin(async move {
                self.count.fetch_add(1, Ordering::SeqCst);
                *self.last_payload.lock().await = Some(payload);
                BridgeResponse::ok("att-test")
            })
        }
    }

    async fn connect_and_send(addr: &str, req: &BridgeRequest) -> BridgeResponse {
        let name = name_for(addr).unwrap();
        let conn = Stream::connect(name).await.expect("connect");
        let mut reader = BufReader::new(&conn);
        let mut writer = &conn;
        let mut bytes = serde_json::to_vec(req).unwrap();
        bytes.push(b'\n');
        writer.write_all(&bytes).await.unwrap();
        writer.flush().await.unwrap();

        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        serde_json::from_str(line.trim()).unwrap()
    }

    #[tokio::test]
    async fn bridge_round_trip_with_valid_token() {
        let sink = Arc::new(CountingSink {
            count: AtomicU32::new(0),
            last_payload: tokio::sync::Mutex::new(None),
        });
        let session = McpBridgeSession::start(Arc::clone(&sink)).await.unwrap();
        let handle = session.handle().clone();

        let req = BridgeRequest {
            token: handle.token.clone(),
            payload: BridgePayload::SendAttachment {
                file_path: "/tmp/x.png".into(),
                media_type: "image/png".into(),
                caption: None,
            },
        };
        let resp = connect_and_send(&handle.socket_addr, &req).await;
        assert!(resp.ok, "{resp:?}");
        assert_eq!(resp.attachment_id.as_deref(), Some("att-test"));
        assert_eq!(sink.count.load(Ordering::SeqCst), 1);

        let path_opt = session.socket_file_path.clone();
        drop(session);
        if let Some(p) = path_opt {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            assert!(!p.exists(), "socket file should be unlinked on Drop");
        }
    }

    #[tokio::test]
    async fn bridge_rejects_bad_token() {
        let sink = Arc::new(CountingSink {
            count: AtomicU32::new(0),
            last_payload: tokio::sync::Mutex::new(None),
        });
        let session = McpBridgeSession::start(Arc::clone(&sink)).await.unwrap();
        let handle = session.handle().clone();

        let req = BridgeRequest {
            token: "wrong-token".into(),
            payload: BridgePayload::SendAttachment {
                file_path: "/tmp/x.png".into(),
                media_type: "image/png".into(),
                caption: None,
            },
        };
        let resp = connect_and_send(&handle.socket_addr, &req).await;
        assert!(!resp.ok);
        assert_eq!(resp.error.as_deref(), Some("unauthorized"));
        assert_eq!(sink.count.load(Ordering::SeqCst), 0);
    }
}
