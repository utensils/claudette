import type commonEn from "../locales/en/common.json";
import type settingsEn from "../locales/en/settings.json";
import type chatEn from "../locales/en/chat.json";
import type modalsEn from "../locales/en/modals.json";
import type sidebarEn from "../locales/en/sidebar.json";
import type schedulerEn from "../locales/en/scheduler.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: {
      common: typeof commonEn;
      settings: typeof settingsEn;
      chat: typeof chatEn;
      modals: typeof modalsEn;
      sidebar: typeof sidebarEn;
      scheduler: typeof schedulerEn;
    };
  }
}
