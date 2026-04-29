import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import commonEn from "./locales/en/common.json";
import settingsEn from "./locales/en/settings.json";
import chatEn from "./locales/en/chat.json";
import modalsEn from "./locales/en/modals.json";
import sidebarEn from "./locales/en/sidebar.json";
import commonEs from "./locales/es/common.json";
import settingsEs from "./locales/es/settings.json";
import chatEs from "./locales/es/chat.json";
import modalsEs from "./locales/es/modals.json";
import sidebarEs from "./locales/es/sidebar.json";

export const SUPPORTED_LANGUAGES = ["en", "es"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export function isSupportedLanguage(lang: string): lang is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(lang);
}

void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  initAsync: false,
  ns: ["common", "settings", "chat", "modals", "sidebar"],
  defaultNS: "common",
  resources: {
    en: {
      common: commonEn,
      settings: settingsEn,
      chat: chatEn,
      modals: modalsEn,
      sidebar: sidebarEn,
    },
    es: {
      common: commonEs,
      settings: settingsEs,
      chat: chatEs,
      modals: modalsEs,
      sidebar: sidebarEs,
    },
  },
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
