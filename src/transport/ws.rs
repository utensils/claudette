use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, broadcast, oneshot, watch};
use tokio_tungstenite::tungstenite::Message;

use super::{ServerEvent, Transport};

/// Deadlines that keep a silently broken link from looking connected.
#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    /// Limit on the TCP + TLS + WebSocket handshake.
    pub connect: Duration,
    /// Backstop on waiting for a response from a server that is alive (it
    /// answers pings) but never replies. Generous because some requests
    /// legitimately run long (`create_workspace` runs the setup script); a
    /// dead link is caught by `liveness` instead. On expiry the request's
    /// outcome is unknown, so callers get an error saying so and nothing is
    /// retried automatically.
    pub request: Duration,
    /// How often the connection pings the server.
    pub heartbeat: Duration,
    /// A connection that has received nothing (not even a pong) for this
    /// long is treated as dead, so sleep or a network change can't leave
    /// it "connected" with requests hanging.
    pub liveness: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(15),
            request: Duration::from_secs(10 * 60),
            heartbeat: Duration::from_secs(15),
            liveness: Duration::from_secs(45),
        }
    }
}

/// WebSocket transport connecting to a remote claudette-server over WSS.
pub struct WebSocketTransport {
    writer: Arc<Writer>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>>,
    next_id: AtomicU64,
    request_timeout: Duration,
    event_tx: broadcast::Sender<ServerEvent>,
    connected: Arc<AtomicBool>,
    /// Flips to `true` once the reader task observes the socket closing.
    /// Lets owners react to a dropped connection without polling.
    closed_rx: watch::Receiver<bool>,
    _reader_task: tokio::task::JoinHandle<()>,
    heartbeat_task: tokio::task::JoinHandle<()>,
}

impl Drop for WebSocketTransport {
    fn drop(&mut self) {
        self.heartbeat_task.abort();
    }
}

/// Certificate fingerprint (SHA-256 hex) obtained during connection.
pub struct ConnectionResult {
    pub transport: WebSocketTransport,
    pub cert_fingerprint: String,
}

impl WebSocketTransport {
    /// Connect to a remote claudette-server.
    ///
    /// If `expected_fingerprint` is Some, the server's certificate fingerprint is verified.
    /// Returns the transport and the server's certificate fingerprint.
    pub async fn connect(
        host: &str,
        port: u16,
        expected_fingerprint: Option<&str>,
    ) -> Result<ConnectionResult, String> {
        Self::connect_with(host, port, expected_fingerprint, Timeouts::default()).await
    }

    /// [`Self::connect`] with explicit [`Timeouts`].
    pub async fn connect_with(
        host: &str,
        port: u16,
        expected_fingerprint: Option<&str>,
        timeouts: Timeouts,
    ) -> Result<ConnectionResult, String> {
        let url = format!("wss://{host}:{port}");

        // Shared slot to capture the cert fingerprint from the TLS verifier callback.
        let fingerprint_slot: Arc<std::sync::Mutex<Option<String>>> =
            Arc::new(std::sync::Mutex::new(None));

        // Build a TLS config that accepts self-signed certificates.
        // We do our own fingerprint verification (TOFU).
        let tls_config = rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(FingerprintCapturingVerifier::new(
                Arc::clone(&fingerprint_slot),
            )))
            .with_no_client_auth();

        let connector = tokio_tungstenite::Connector::Rustls(Arc::new(tls_config));

        let (ws_stream, _response) = tokio::time::timeout(
            timeouts.connect,
            tokio_tungstenite::connect_async_tls_with_config(&url, None, false, Some(connector)),
        )
        .await
        .map_err(|_| format!("WebSocket connection failed: timed out connecting to {url}"))?
        .map_err(|e| format!("WebSocket connection failed: {e}"))?;

        // Read the fingerprint captured during the TLS handshake.
        let cert_fingerprint = fingerprint_slot
            .lock()
            .ok()
            .and_then(|slot| slot.clone())
            .ok_or_else(|| "Failed to capture server certificate fingerprint".to_string())?;

        // Verify fingerprint if expected (TOFU).
        if let Some(expected) = expected_fingerprint
            && cert_fingerprint != expected
        {
            return Err(format!(
                "Certificate fingerprint mismatch! Expected {expected}, got {cert_fingerprint}. \
                 The server's certificate may have changed."
            ));
        }

        let (write, read) = ws_stream.split();
        let writer = Arc::new(Mutex::new(write));
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let (event_tx, _) = broadcast::channel(256);
        let connected = Arc::new(AtomicBool::new(true));
        let (closed_tx, closed_rx) = watch::channel(false);

        // Spawn reader task.
        let pending_clone = Arc::clone(&pending);
        let event_tx_clone = event_tx.clone();
        let connected_clone = Arc::clone(&connected);
        let reader_task = tokio::spawn(async move {
            let mut read = read;
            let mut last_heard = tokio::time::Instant::now();
            loop {
                let msg_result = tokio::select! {
                    msg = read.next() => match msg {
                        Some(msg) => msg,
                        None => break,
                    },
                    _ = tokio::time::sleep_until(last_heard + timeouts.liveness) => {
                        tracing::warn!(
                            target: "claudette::transport",
                            "no traffic from server within the liveness timeout; closing"
                        );
                        break;
                    }
                };
                last_heard = tokio::time::Instant::now();
                match msg_result {
                    Ok(Message::Text(text)) => {
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                            if value.get("id").is_some_and(|v| !v.is_null()) {
                                // Response to a request.
                                if let Some(id) = value.get("id").and_then(|v| v.as_u64()) {
                                    let mut pending = pending_clone.lock().await;
                                    if let Some(tx) = pending.remove(&id) {
                                        let _ = tx.send(value);
                                    }
                                }
                            } else if value.get("event").is_some() {
                                // Unsolicited event.
                                if let Ok(event) = serde_json::from_value::<ServerEvent>(value) {
                                    let _ = event_tx_clone.send(event);
                                }
                            }
                        }
                    }
                    // Pings are answered by tungstenite; pongs only count
                    // as traffic (above).
                    Ok(Message::Close(_)) => break,
                    Err(_) => break,
                    _ => {}
                }
            }
            connected_clone.store(false, Ordering::Relaxed);

            // Drain all pending requests so callers get an error instead of hanging.
            let mut pending = pending_clone.lock().await;
            for (_, tx) in pending.drain() {
                let _ = tx.send(serde_json::json!({
                    "error": {
                        "code": -3,
                        "message": "Connection closed before the server responded; \
                                    the request may still have completed"
                    }
                }));
            }
            drop(pending);
            let _ = closed_tx.send(true);
        });

        let heartbeat_task = tokio::spawn(heartbeat(
            Arc::clone(&writer),
            Arc::clone(&connected),
            timeouts.heartbeat,
        ));

        Ok(ConnectionResult {
            transport: WebSocketTransport {
                writer,
                pending,
                next_id: AtomicU64::new(1),
                request_timeout: timeouts.request,
                event_tx,
                connected,
                closed_rx,
                _reader_task: reader_task,
                heartbeat_task,
            },
            cert_fingerprint,
        })
    }

    /// Authenticate with the remote server.
    pub async fn authenticate_pairing(
        &self,
        pairing_token: &str,
        client_name: &str,
    ) -> Result<AuthResult, String> {
        let resp = self
            .send(serde_json::json!({
                "id": 0,
                "method": "authenticate",
                "params": {
                    "pairing_token": pairing_token,
                    "client_name": client_name,
                }
            }))
            .await?;

        if let Some(error) = resp.get("error") {
            return Err(error
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("Authentication failed")
                .to_string());
        }

        let result = resp.get("result").ok_or("No result in response")?;
        Ok(AuthResult {
            session_token: result
                .get("session_token")
                .and_then(|t| t.as_str())
                .map(String::from),
            server_name: result
                .get("server_name")
                .and_then(|n| n.as_str())
                .unwrap_or("Unknown")
                .to_string(),
        })
    }

    /// Authenticate with a saved session token.
    pub async fn authenticate_session(&self, session_token: &str) -> Result<AuthResult, String> {
        let resp = self
            .send(serde_json::json!({
                "id": 0,
                "method": "authenticate",
                "params": {
                    "session_token": session_token,
                }
            }))
            .await?;

        if let Some(error) = resp.get("error") {
            return Err(error
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("Authentication failed")
                .to_string());
        }

        let result = resp.get("result").ok_or("No result in response")?;
        Ok(AuthResult {
            session_token: None,
            server_name: result
                .get("server_name")
                .and_then(|n| n.as_str())
                .unwrap_or("Unknown")
                .to_string(),
        })
    }
}

type Writer = Mutex<
    futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Message,
    >,
>;

/// Ping the server every `period` so the reader hears back (a pong) at
/// least that often while the link is alive.
async fn heartbeat(writer: Arc<Writer>, connected: Arc<AtomicBool>, period: Duration) {
    let mut interval = tokio::time::interval(period);
    interval.tick().await;
    loop {
        interval.tick().await;
        if !connected.load(Ordering::Relaxed) {
            break;
        }
        if writer
            .lock()
            .await
            .send(Message::Ping(Vec::new().into()))
            .await
            .is_err()
        {
            break;
        }
    }
}

pub struct AuthResult {
    pub session_token: Option<String>,
    pub server_name: String,
}

#[async_trait::async_trait]
impl Transport for WebSocketTransport {
    async fn send(&self, request: serde_json::Value) -> Result<serde_json::Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut req = request;
        if let Some(obj) = req.as_object_mut() {
            obj.insert("id".to_string(), serde_json::json!(id));
        }

        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            // Checked under the `pending` lock: the reader task drains
            // `pending` under the same lock after clearing `connected`, so a
            // request inserted here is either drained or rejected — never
            // parked forever on a dead socket.
            if !self.connected.load(Ordering::Relaxed) {
                return Err("Connection closed".to_string());
            }
            pending.insert(id, tx);
        }

        let text = serde_json::to_string(&req).map_err(|e| e.to_string())?;
        {
            let mut writer = self.writer.lock().await;
            if let Err(e) = writer.send(Message::Text(text.into())).await {
                self.pending.lock().await.remove(&id);
                return Err(format!("Failed to send: {e}"));
            }
        }

        match tokio::time::timeout(self.request_timeout, rx).await {
            Ok(response) => response.map_err(|_| "Response channel closed".to_string()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!(
                    "No response from the server within {}s; it may still have \
                     completed the request",
                    self.request_timeout.as_secs()
                ))
            }
        }
    }

    fn event_stream(&self) -> broadcast::Receiver<ServerEvent> {
        self.event_tx.subscribe()
    }

    async fn close(&self) -> Result<(), String> {
        let mut writer = self.writer.lock().await;
        writer
            .send(Message::Close(None))
            .await
            .map_err(|e| format!("Failed to close: {e}"))?;
        self.connected.store(false, Ordering::Relaxed);
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    fn closed(&self) -> watch::Receiver<bool> {
        self.closed_rx.clone()
    }
}

/// TLS certificate verifier that accepts any certificate (servers are
/// self-signed) but captures its SHA-256 fingerprint for TOFU pinning.
///
/// Handshake signatures are still verified against the presented
/// certificate's public key. Without that, a peer could present a copy of
/// the pinned certificate while holding a different private key and the
/// fingerprint check would pass.
#[derive(Debug)]
struct FingerprintCapturingVerifier {
    fingerprint: Arc<std::sync::Mutex<Option<String>>>,
    /// Explicit rather than `CryptoProvider::get_default()`: clients never
    /// install a process default (only the embedded server does).
    algorithms: rustls::crypto::WebPkiSupportedAlgorithms,
}

impl FingerprintCapturingVerifier {
    fn new(fingerprint: Arc<std::sync::Mutex<Option<String>>>) -> Self {
        Self {
            fingerprint,
            algorithms: rustls::crypto::aws_lc_rs::default_provider()
                .signature_verification_algorithms,
        }
    }
}

impl rustls::client::danger::ServerCertVerifier for FingerprintCapturingVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let mut hasher = Sha256::new();
        hasher.update(end_entity.as_ref());
        let fp = hex::encode(hasher.finalize());
        if let Ok(mut slot) = self.fingerprint.lock() {
            *slot = Some(fp);
        }
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}
