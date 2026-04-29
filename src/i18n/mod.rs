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
const TRAY_JA: &str = include_str!("../locales/ja/tray.json");
const TRAY_ZH_CN: &str = include_str!("../locales/zh-CN/tray.json");

/// Supported locales. Mirrors `SUPPORTED_LANGUAGES` in `src/ui/src/i18n.ts`;
/// keep both lists in sync. Unknown values from the DB fall back to `En`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locale {
    En,
    Es,
    PtBr,
    Ja,
    ZhCn,
}

impl Locale {
    /// Parse a value read from the `language` app setting. Empty/unknown
    /// inputs return `En` so a corrupted or out-of-band setting can never
    /// crash the tray.
    pub fn from_db_value(value: Option<&str>) -> Self {
        match value.map(str::trim).unwrap_or("") {
            "es" => Locale::Es,
            "pt-BR" => Locale::PtBr,
            "ja" => Locale::Ja,
            "zh-CN" => Locale::ZhCn,
            _ => Locale::En,
        }
    }

    fn store(self) -> &'static HashMap<String, String> {
        match self {
            Locale::En => en_store(),
            Locale::Es => es_store(),
            Locale::PtBr => pt_br_store(),
            Locale::Ja => ja_store(),
            Locale::ZhCn => zh_cn_store(),
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

fn ja_store() -> &'static HashMap<String, String> {
    static JA: OnceLock<HashMap<String, String>> = OnceLock::new();
    JA.get_or_init(|| parse_locale(TRAY_JA, "ja"))
}

fn zh_cn_store() -> &'static HashMap<String, String> {
    static ZH_CN: OnceLock<HashMap<String, String>> = OnceLock::new();
    ZH_CN.get_or_init(|| parse_locale(TRAY_ZH_CN, "zh-CN"))
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
        assert_eq!(Locale::from_db_value(Some("ja")), Locale::Ja);
        assert_eq!(Locale::from_db_value(Some(" ja ")), Locale::Ja);
        assert_eq!(Locale::from_db_value(Some("zh-CN")), Locale::ZhCn);
        assert_eq!(Locale::from_db_value(Some(" zh-CN ")), Locale::ZhCn);
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
        assert_eq!(t(Locale::Ja, "menu_settings"), "設定");
        assert_eq!(t(Locale::ZhCn, "menu_settings"), "设置");
    }

    #[test]
    fn t_args_interpolates_placeholders() {
        let body = t_args(
            Locale::En,
            "notification_body",
            &[("ws_name", "vast-daffodil")],
        );
        assert_eq!(body, "vast-daffodil is waiting for your response");

        for locale in [Locale::Es, Locale::PtBr, Locale::Ja, Locale::ZhCn] {
            let body = t_args(locale, "notification_body", &[("ws_name", "vast-daffodil")]);
            assert!(
                body.contains("vast-daffodil"),
                "{locale:?} body should still interpolate ws_name: {body}"
            );
        }
    }

    /// Every non-English tray locale must declare exactly the same key set as
    /// English. Translators aren't expected to add new keys (that's a code
    /// change), and missing keys would silently fall back to English at
    /// runtime — fine in principle, but easy to ship by accident. This test
    /// makes parity drift a hard CI failure.
    ///
    /// Iterates over all non-English locales so adding a new locale only
    /// requires extending the array, not duplicating the comparison.
    #[test]
    fn locales_have_identical_key_sets() {
        let en: std::collections::BTreeSet<_> = en_store().keys().collect();

        for (tag, store) in [
            ("es", es_store()),
            ("pt-BR", pt_br_store()),
            ("ja", ja_store()),
            ("zh-CN", zh_cn_store()),
        ] {
            let other: std::collections::BTreeSet<_> = store.keys().collect();
            let only_en: Vec<_> = en.difference(&other).collect();
            let only_other: Vec<_> = other.difference(&en).collect();
            assert!(
                only_en.is_empty() && only_other.is_empty(),
                "tray locale key drift between en and {tag} — only_en={only_en:?} only_{tag}={only_other:?}"
            );
        }
    }
}
