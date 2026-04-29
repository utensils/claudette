---
title: Contributing Translations
description: Help bring Claudette to your language. No Rust or TypeScript required.
---

Claudette is built by a small team and a growing community. One of the most impactful contributions you can make — especially if you're not a developer — is **translating the app into your language**.

## What's localized today

The app ships with English, Spanish, and Brazilian Portuguese:

- **English** is the complete baseline: the full UI (buttons, tooltips, settings, modals, chat, sidebar) plus the system tray menu, native notifications, and the quit-confirm dialog.
- **Spanish** is a complete translation: the full UI (buttons, tooltips, settings, modals, chat, sidebar) plus the system tray menu, native notifications, and the quit-confirm dialog.
- **Brazilian Portuguese (pt-BR)** is a complete translation: the full UI plus the system tray menu, native notifications, and the quit-confirm dialog.

Missing translation keys fall back to English at runtime, so a partially translated language is safe to ship — anything not yet translated simply shows in English until someone fills it in.

## How it works

Translations live in the [Claudette repository](https://github.com/utensils/Claudette) as plain JSON files. Each language gets its own folder, and translating is mostly a matter of editing key/value pairs:

- **Frontend strings** live in `src/ui/src/locales/<lang>/` and are split across five files by area (`common`, `chat`, `modals`, `settings`, `sidebar`).
- **Tray, notification, and quit-dialog strings** live in `src/locales/<lang>/tray.json`.

Both sides use the same `{{name}}` placeholder syntax for inserting dynamic values, so you only need to learn one convention.

## How to contribute a translation

1. **Open an issue** on GitHub to claim the language you want to translate. This stops two contributors from duplicating effort.
2. **Fork the repository** and create a feature branch.
3. **Copy the English locale folders** to a new folder named with your language code (`fr`, `de`, `pt`, `pt-BR`, etc.) and translate the values. Keep the keys exactly as they are.
4. **Register your language** so the app knows it exists — this is a small change to two files (one TypeScript, one Rust). The exact steps are in the [Contributing Guide on GitHub](https://github.com/utensils/Claudette/blob/main/CONTRIBUTING.md#translating-claudette).
5. **Open a pull request.** CI runs a key-parity check on the backend (`src/locales/<lang>/tray.json`) that fails if any of the locales it knows about disagree on which keys exist — note that adding a brand-new backend locale also means extending that test to include your locale. The frontend doesn't enforce parity; partial translations are fine and rely on English fallback for any keys you haven't filled in yet.

If you only want to fix a typo or polish wording in an existing language, the process is even simpler — edit the relevant JSON file and open a PR. No registration step is required.

## A few translator tips

- **Don't translate `{{placeholder}}` tokens.** They're swapped in at runtime; translating them will break the rendered string.
- **Watch for tight UI space.** Some labels (especially in the sidebar and tray menu) have limited room. Prefer concise wording where the language allows.
- **Plural forms** use i18next's `_one` / `_other` key convention. If English provides both, please provide both in your language too — i18next will pick the right one based on the count.

## Questions?

Hop into our [Discord](https://discord.gg/aumGBKccmD) and ask in the contributors channel, or open a discussion on GitHub. Translations are a fantastic way to make Claudette accessible to people who would otherwise have to work in a second language — thank you for helping out.
