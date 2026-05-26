use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use futures_util::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, broadcast, oneshot};
use tokio_tungstenite::tungstenite::Message;

use super::{ServerEvent, Transport};

/// WebSocket transport connecting to a remote claudette-server over WSS.
pub struct WebSocketTransport {
    writer: Arc<
        Mutex<
            futures_util::stream::SplitSink<
                tokio_tungstenite::WebSocketStream<
                    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
                >,
                Message,
            >,
        >,
    >,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>>,
    next_id: AtomicU64,
    event_tx: broadcast::Sender<ServerEvent>,
    connected: Arc<AtomicBool>,
    _reader_task: tokio::task::JoinHandle<()>,
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
        let url = format!("wss://{host}:{port}");

        // Shared slot to capture the cert fingerprint from the TLS verifier callback.
        let fingerprint_slot: Arc<std::sync::Mutex<Option<String>>> =
            Arc::new(std::sync::Mutex::new(None));

        // Build a TLS config that accepts self-signed certificates.
        // We do our own fingerprint verification (TOFU).
        let tls_config = rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(FingerprintCapturingVerifier {
                fingerprint: Arc::clone(&fingerprint_slot),
            }))
            .with_no_client_auth();

        let connector = tokio_tungstenite::Connector::Rustls(Arc::new(tls_config));

        let (ws_stream, _response) =
            tokio_tungstenite::connect_async_tls_with_config(&url, None, false, Some(connector))
                .await
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

        // Spawn reader task.
        let pending_clone = Arc::clone(&pending);
        let event_tx_clone = event_tx.clone();
        let connected_clone = Arc::clone(&connected);
        let reader_task = tokio::spawn(async move {
            let mut read = read;
            while let Some(msg_result) = read.next().await {
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
                    Ok(Message::Ping(data)) => {
                        // Respond with pong — handled by tungstenite automatically.
                        let _ = data;
                    }
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
                    "error": {"code": -3, "message": "Connection closed"}
                }));
            }
        });

        Ok(ConnectionResult {
            transport: WebSocketTransport {
                writer,
                pending,
                next_id: AtomicU64::new(1),
                event_tx,
                connected,
                _reader_task: reader_task,
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
            pending.insert(id, tx);
        }

        let text = serde_json::to_string(&req).map_err(|e| e.to_string())?;
        {
            let mut writer = self.writer.lock().await;
            writer
                .send(Message::Text(text.into()))
                .await
                .map_err(|e| format!("Failed to send: {e}"))?;
        }

        rx.await.map_err(|_| "Response channel closed".to_string())
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
}

/// TLS certificate verifier that accepts all certificates but captures the
/// server's certificate fingerprint (SHA-256) for TOFU verification.
#[derive(Debug)]
struct FingerprintCapturingVerifier {
    fingerprint: Arc<std::sync::Mutex<Option<String>>>,
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
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        vec![
            rustls::SignatureScheme::RSA_PKCS1_SHA256,
            rustls::SignatureScheme::RSA_PKCS1_SHA384,
            rustls::SignatureScheme::RSA_PKCS1_SHA512,
            rustls::SignatureScheme::ECDSA_NISTP256_SHA256,
            rustls::SignatureScheme::ECDSA_NISTP384_SHA384,
            rustls::SignatureScheme::ECDSA_NISTP521_SHA512,
            rustls::SignatureScheme::RSA_PSS_SHA256,
            rustls::SignatureScheme::RSA_PSS_SHA384,
            rustls::SignatureScheme::RSA_PSS_SHA512,
            rustls::SignatureScheme::ED25519,
            rustls::SignatureScheme::ED448,
        ]
    }
}
