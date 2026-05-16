//! Codex (ChatGPT-subscription) auth-material plumbing: parse
//! `~/.codex/auth.json`, decode the JWT access token to recover the
//! ChatGPT account id, and surface a typed `CodexAuthMaterial` to the
//! gateway translation layer that calls the Codex Responses endpoint.

use std::path::PathBuf;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(super) const CODEX_DEFAULT_BASE_URL: &str = "https://chatgpt.com/backend-api";
pub(super) const CODEX_JWT_AUTH_CLAIM: &str = "https://api.openai.com/auth";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct CodexAuthMaterial {
    pub(super) access_token: String,
    pub(super) account_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CodexAuthJson {
    auth_mode: Option<String>,
    #[serde(rename = "OPENAI_API_KEY")]
    openai_api_key: Option<String>,
    tokens: Option<CodexAuthTokens>,
}

#[derive(Debug, Deserialize)]
struct CodexAuthTokens {
    access_token: String,
    account_id: Option<String>,
}

pub(super) fn load_codex_auth_material() -> Result<CodexAuthMaterial, String> {
    let path = codex_auth_path()?;
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read Codex auth cache at {}: {e}", path.display()))?;
    let auth = serde_json::from_str::<CodexAuthJson>(&raw)
        .map_err(|e| format!("Failed to parse Codex auth cache: {e}"))?;
    match auth.auth_mode.as_deref() {
        Some("chatgpt") | Some("chatgpt_auth_tokens") => {
            let tokens = auth
                .tokens
                .ok_or("Codex auth cache is missing ChatGPT tokens. Run codex login.")?;
            if tokens.access_token.trim().is_empty() {
                return Err(
                    "Codex auth cache has an empty access token. Run codex login.".to_string(),
                );
            }
            Ok(CodexAuthMaterial {
                account_id: tokens
                    .account_id
                    .or_else(|| codex_account_id_from_access_token(&tokens.access_token)),
                access_token: tokens.access_token,
            })
        }
        Some("apikey") | Some("api_key") => {
            let key = auth
                .openai_api_key
                .filter(|key| !key.trim().is_empty())
                .ok_or("Codex API-key auth is missing OPENAI_API_KEY")?;
            Ok(CodexAuthMaterial {
                access_token: key,
                account_id: None,
            })
        }
        Some(other) => Err(format!(
            "Unsupported Codex auth mode `{other}`. Run codex login with ChatGPT or an API key."
        )),
        None => Err("Codex auth cache is missing auth_mode. Run codex login.".to_string()),
    }
}

fn codex_auth_path() -> Result<PathBuf, String> {
    if let Ok(home) = std::env::var("CODEX_HOME")
        && !home.trim().is_empty()
    {
        return Ok(PathBuf::from(home).join("auth.json"));
    }
    let home = dirs::home_dir().ok_or("Could not determine home directory for Codex auth")?;
    Ok(home.join(".codex").join("auth.json"))
}

pub(super) fn codex_account_id_from_access_token(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let value = serde_json::from_slice::<Value>(&decoded).ok()?;
    value
        .get(CODEX_JWT_AUTH_CLAIM)?
        .get("chatgpt_account_id")?
        .as_str()
        .filter(|account_id| !account_id.trim().is_empty())
        .map(ToString::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codex_account_id_can_be_derived_from_chatgpt_access_token() {
        let mut claims = serde_json::Map::new();
        claims.insert(
            CODEX_JWT_AUTH_CLAIM.to_string(),
            json!({"chatgpt_account_id": "acct-123"}),
        );
        let payload = Value::Object(claims);
        let encoded =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.to_string().as_bytes());
        let token = format!("header.{encoded}.signature");
        assert_eq!(
            codex_account_id_from_access_token(&token).as_deref(),
            Some("acct-123")
        );
        assert_eq!(codex_account_id_from_access_token("not-a-jwt"), None);
    }
}
