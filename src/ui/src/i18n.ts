import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import commonEn from "./locales/en/common.json";
import settingsEn from "./locales/en/settings.json";
import chatEn from "./locales/en/chat.json";
import modalsEn from "./locales/en/modals.json";
import sidebarEn from "./locales/en/sidebar.json";

void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
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
  },
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
