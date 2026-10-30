//! Certificate pinning must bind to the server's private key, not just the
//! certificate bytes. A peer that replays a copy of the pinned certificate
//! but signs the handshake with a different key has to be refused before
//! any credential is sent.

use std::sync::Arc;

use claudette::transport::ws::WebSocketTransport;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::sign::CertifiedKey;
use sha2::{Digest, Sha256};

#[derive(Debug)]
struct FixedCert(Arc<CertifiedKey>);

impl rustls::server::ResolvesServerCert for FixedCert {
    fn resolve(&self, _hello: rustls::server::ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        Some(Arc::clone(&self.0))
    }
}

fn signing_key(key: &rcgen::KeyPair) -> Arc<dyn rustls::sign::SigningKey> {
    let der = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der()));
    rustls::crypto::aws_lc_rs::sign::any_supported_type(&der).unwrap()
}

/// Serve WSS on an ephemeral port, presenting `cert` and signing with `key`
/// (which need not match). Returns the port.
async fn serve(cert: CertificateDer<'static>, key: Arc<dyn rustls::sign::SigningKey>) -> u16 {
    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_cert_resolver(Arc::new(FixedCert(Arc::new(CertifiedKey::new(
            vec![cert],
            key,
        )))));
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                if let Ok(tls) = acceptor.accept(stream).await {
                    let _ws = tokio_tungstenite::accept_async(tls).await;
                    // Hold the socket briefly so the client finishes its side.
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
            });
        }
    });
    port
}

#[tokio::test]
async fn a_copied_certificate_without_its_private_key_is_refused() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    let real_key = rcgen::KeyPair::generate().unwrap();
    let cert = rcgen::CertificateParams::new(vec!["localhost".to_string()])
        .unwrap()
        .self_signed(&real_key)
        .unwrap();
    let cert_der = cert.der().clone();
    let pinned = hex::encode(Sha256::digest(cert_der.as_ref()));

    // Control: the genuine server (matching key) passes pinning.
    let genuine = serve(cert_der.clone(), signing_key(&real_key)).await;
    let ok = WebSocketTransport::connect("127.0.0.1", genuine, Some(&pinned)).await;
    assert!(ok.is_ok(), "genuine server rejected: {:?}", ok.err());

    // Impersonator: same certificate bytes, different signing key.
    let attacker_key = rcgen::KeyPair::generate().unwrap();
    let impostor = serve(cert_der, signing_key(&attacker_key)).await;
    let refused = WebSocketTransport::connect("127.0.0.1", impostor, Some(&pinned)).await;
    assert!(
        refused.is_err(),
        "a handshake signed by a key other than the certificate's must fail"
    );
}
