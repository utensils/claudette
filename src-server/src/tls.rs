use std::path::Path;
use std::sync::Arc;

use rustls::pki_types::CertificateDer;
use sha2::{Digest, Sha256};

/// Load existing TLS cert/key or generate a self-signed one.
pub fn load_or_generate_tls(
    config_dir: &Path,
) -> Result<Arc<rustls::ServerConfig>, Box<dyn std::error::Error>> {
    let cert_path = config_dir.join("cert.pem");
    let key_path = config_dir.join("key.pem");

    if !cert_path.exists() || !key_path.exists() {
        generate_self_signed(config_dir)?;
    }

    let cert_pem = std::fs::read(&cert_path)?;
    let key_pem = std::fs::read(&key_path)?;

    let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut &cert_pem[..])
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| -> Box<dyn std::error::Error> {
            format!("Failed to parse cert.pem: {e}").into()
        })?;
    let key = rustls_pemfile::private_key(&mut &key_pem[..])?.ok_or("No private key found")?;

    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)?;

    Ok(Arc::new(config))
}

fn generate_self_signed(config_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    std::fs::create_dir_all(config_dir)?;

    let hostname = gethostname::gethostname().to_string_lossy().to_string();

    let mut params = rcgen::CertificateParams::new(vec![hostname.clone()])?;
    params
        .subject_alt_names
        .push(rcgen::SanType::DnsName(hostname.try_into()?));
    params
        .subject_alt_names
        .push(rcgen::SanType::DnsName("localhost".to_string().try_into()?));

    let key_pair = rcgen::KeyPair::generate()?;
    let cert = params.self_signed(&key_pair)?;

    std::fs::write(config_dir.join("cert.pem"), cert.pem())?;
    std::fs::write(config_dir.join("key.pem"), key_pair.serialize_pem())?;

    Ok(())
}

/// Compute SHA-256 fingerprint of the server's certificate (hex-encoded).
pub fn cert_fingerprint(config_dir: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let cert_pem = std::fs::read(config_dir.join("cert.pem"))?;
    let cert = rustls_pemfile::certs(&mut &cert_pem[..])
        .next()
        .ok_or("No certificate found")??;

    let mut hasher = Sha256::new();
    hasher.update(cert.as_ref());
    let hash = hasher.finalize();
    Ok(hex::encode(hash))
}
