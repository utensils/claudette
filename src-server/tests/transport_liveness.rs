//! The client transport's deadlines: a server that stops responding must
//! end the connection (so reconnect kicks in) instead of leaving requests
//! hanging forever.

use std::sync::Arc;
use std::time::Duration;

use claudette::transport::Transport;
use claudette::transport::ws::{Timeouts, WebSocketTransport};
use futures_util::StreamExt;
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};

const FAST: Timeouts = Timeouts {
    connect: Duration::from_millis(500),
    request: Duration::from_millis(300),
    heartbeat: Duration::from_millis(100),
    liveness: Duration::from_millis(400),
};

#[derive(Clone, Copy)]
enum Peer {
    /// Completes the handshakes, then never reads or writes again.
    Silent,
    /// Reads (so pings get their pongs) but never answers a request.
    Unresponsive,
}

async fn serve(peer: Peer) -> u16 {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let key = rcgen::KeyPair::generate().unwrap();
    let cert = rcgen::CertificateParams::new(vec!["localhost".to_string()])
        .unwrap()
        .self_signed(&key)
        .unwrap();
    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(
            vec![cert.der().clone()],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
        )
        .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let tls = acceptor.accept(stream).await.unwrap();
                let mut ws = tokio_tungstenite::accept_async(tls).await.unwrap();
                match peer {
                    Peer::Silent => tokio::time::sleep(Duration::from_secs(30)).await,
                    Peer::Unresponsive => while ws.next().await.is_some() {},
                }
            });
        }
    });
    port
}

#[tokio::test]
async fn a_silent_server_is_detected_as_dead() {
    let port = serve(Peer::Silent).await;
    let t = WebSocketTransport::connect_with("127.0.0.1", port, None, FAST)
        .await
        .unwrap()
        .transport;
    let mut closed = t.closed();
    tokio::time::timeout(Duration::from_secs(5), closed.wait_for(|c| *c))
        .await
        .expect("a server that went silent still looked connected")
        .unwrap();
    assert!(!t.is_connected());
}

#[tokio::test]
async fn an_unanswered_request_times_out_while_the_link_stays_up() {
    let port = serve(Peer::Unresponsive).await;
    let t = WebSocketTransport::connect_with("127.0.0.1", port, None, FAST)
        .await
        .unwrap()
        .transport;
    let err = t
        .send(serde_json::json!({"method": "slow", "params": {}}))
        .await
        .unwrap_err();
    assert!(err.contains("may still have completed"), "{err}");

    // Pongs keep a live-but-slow server connected past the liveness window.
    tokio::time::sleep(FAST.liveness * 3).await;
    assert!(t.is_connected());
}

#[tokio::test]
async fn a_stalled_handshake_times_out() {
    // Accepts TCP but never speaks TLS.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _held = listener.accept().await;
        tokio::time::sleep(Duration::from_secs(30)).await;
    });
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        WebSocketTransport::connect_with("127.0.0.1", port, None, FAST),
    )
    .await
    .expect("connect ignored its deadline");
    assert!(result.is_err());
}
