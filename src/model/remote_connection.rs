use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct RemoteConnection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub session_token: Option<String>,
    pub cert_fingerprint: Option<String>,
    pub auto_connect: bool,
    pub created_at: String,
}
