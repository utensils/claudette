//! Lightweight i18n for Rust-side user-facing strings (tray menu, native
//! notifications, quit dialog). Mirrors the frontend's i18next setup: flat
//! key→string JSON files per locale, bundled at compile time, fallback to
//! English on missing keys. Pluralization uses the i18next `_one`/`_other`
//! convention; the call site picks the form.
//!
//! See issue #362 — Phase 2.

use std::collections::HashMap;
use std::sync::OnceLock;

const TRAY_EN: &str = include_str!("../locales/en/tray.json");
const TRAY_ES: &str = include_str!("../locales/es/tray.json");
const TRAY_PT_BR: &str = include_str!("../locales/pt-BR/tray.json");

/// Supported locales. Mirrors `SUPPORTED_LANGUAGES` in `src/ui/src/i18n.ts`;
/// keep both lists in sync. Unknown values from the DB fall back to `En`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locale {
    En,
    Es,
    PtBr,
}

impl Locale {
    /// Parse a value read from the `language` app setting. Empty/unknown
    /// inputs return `En` so a corrupted or out-of-band setting can never
    /// crash the tray.
    pub fn from_db_value(value: Option<&str>) -> Self {
        match value.map(str::trim).unwrap_or("") {
            "es" => Locale::Es,
            "pt-BR" => Locale::PtBr,
            _ => Locale::En,
        }
    }

    fn store(self) -> &'static HashMap<String, String> {
        match self {
            Locale::En => en_store(),
            Locale::Es => es_store(),
            Locale::PtBr => pt_br_store(),
        }
    }
}

fn en_store() -> &'static HashMap<String, String> {
    static EN: OnceLock<HashMap<String, String>> = OnceLock::new();
    EN.get_or_init(|| parse_locale(TRAY_EN, "en"))
}

fn es_store() -> &'static HashMap<String, String> {
    static ES: OnceLock<HashMap<String, String>> = OnceLock::new();
    ES.get_or_init(|| parse_locale(TRAY_ES, "es"))
}

fn pt_br_store() -> &'static HashMap<String, String> {
    static PT_BR: OnceLock<HashMap<String, String>> = OnceLock::new();
    PT_BR.get_or_init(|| parse_locale(TRAY_PT_BR, "pt-BR"))
}

fn parse_locale(raw: &str, tag: &str) -> HashMap<String, String> {
    serde_json::from_str(raw)
        .unwrap_or_else(|e| panic!("src/locales/{tag}/tray.json failed to parse as flat JSON: {e}"))
}

/// Look up a translation key. Returns the English value if the locale is
/// missing the key, and the key itself if English is missing it (a bug —
/// caught by the consistency test in CI). Missing keys do not panic in
/// release builds, but invalid bundled locale JSON will still panic when
/// the locale store is first initialized — that condition is an authoring
/// error, not a runtime one.
pub fn t(locale: Locale, key: &str) -> String {
    if let Some(v) = locale.store().get(key) {
        return v.clone();
    }
    if locale != Locale::En
        && let Some(v) = en_store().get(key)
    {
        return v.clone();
    }
    debug_assert!(false, "missing i18n key: {key}");
    key.to_string()
}

/// Look up a translation key and substitute `{{name}}` placeholders. The
/// frontend uses the same `{{var}}` delimiters via i18next, so translators
/// see one syntax across the codebase.
pub fn t_args(locale: Locale, key: &str, args: &[(&str, &str)]) -> String {
    let mut out = t(locale, key);
    for (name, value) in args {
        let needle = format!("{{{{{name}}}}}");
        if out.contains(&needle) {
            out = out.replace(&needle, value);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_db_value_parses_known_locales() {
        assert_eq!(Locale::from_db_value(Some("en")), Locale::En);
        assert_eq!(Locale::from_db_value(Some("es")), Locale::Es);
        assert_eq!(Locale::from_db_value(Some(" es ")), Locale::Es);
        assert_eq!(Locale::from_db_value(Some("pt-BR")), Locale::PtBr);
        assert_eq!(Locale::from_db_value(Some(" pt-BR ")), Locale::PtBr);
    }

    #[test]
    fn from_db_value_falls_back_to_english() {
        assert_eq!(Locale::from_db_value(None), Locale::En);
        assert_eq!(Locale::from_db_value(Some("")), Locale::En);
        assert_eq!(Locale::from_db_value(Some("de")), Locale::En);
        assert_eq!(Locale::from_db_value(Some("xx-XX")), Locale::En);
    }

    #[test]
    fn t_returns_localized_string() {
        assert_eq!(t(Locale::En, "menu_settings"), "Settings");
        assert_eq!(t(Locale::Es, "menu_settings"), "Configuración");
        assert_eq!(t(Locale::PtBr, "menu_settings"), "Configurações");
    }

    #[test]
    fn t_args_interpolates_placeholders() {
        let body = t_args(
            Locale::En,
            "notification_body",
            &[("ws_name", "vast-daffodil")],
        );
        assert_eq!(body, "vast-daffodil is waiting for your response");

        let body_es = t_args(
            Locale::Es,
            "notification_body",
            &[("ws_name", "vast-daffodil")],
        );
        assert!(
            body_es.contains("vast-daffodil"),
            "Spanish body should still interpolate ws_name: {body_es}"
        );
    }

    #[test]
    fn locales_have_identical_key_sets() {
        let en: std::collections::BTreeSet<_> = en_store().keys().collect();
        let es: std::collections::BTreeSet<_> = es_store().keys().collect();
        let pt_br: std::collections::BTreeSet<_> = pt_br_store().keys().collect();
        let only_en_vs_es: Vec<_> = en.difference(&es).collect();
        let only_es_vs_en: Vec<_> = es.difference(&en).collect();
        let only_en_vs_pt_br: Vec<_> = en.difference(&pt_br).collect();
        let only_pt_br_vs_en: Vec<_> = pt_br.difference(&en).collect();
        assert!(
            only_en_vs_es.is_empty()
                && only_es_vs_en.is_empty()
                && only_en_vs_pt_br.is_empty()
                && only_pt_br_vs_en.is_empty(),
            "tray locale key drift — \
             only_en_vs_es={only_en_vs_es:?} only_es_vs_en={only_es_vs_en:?} \
             only_en_vs_pt_br={only_en_vs_pt_br:?} only_pt_br_vs_en={only_pt_br_vs_en:?}"
        );
    }
}
