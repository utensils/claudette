import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import i18n from "../i18n";
import { shouldDisable1mContext } from "../components/chat/chatHelpers";
import { getChatSession, sendChatMessage } from "../services/tauri";
import { useAppStore } from "../stores/useAppStore";
import type { CiCheck } from "../types/plugin";

interface CiAutoFixSessionCreatedPayload {
  workspace_id: string;
  session_id: string;
  prompt: string;
  failed_checks: CiCheck[];
  model: string | null;
  backend_id: string | null;
}

export function useCiAutoFixSession() {
  useEffect(() => {
    let active = true;

    const unlistenPromise = listen<CiAutoFixSessionCreatedPayload>(
      "ci-auto-fix-session-created",
      async (event) => {
        if (!active) return;

        const { workspace_id, session_id, prompt, model, backend_id } =
          event.payload;
        const store = useAppStore.getState();

        try {
          const session = await getChatSession(session_id);
          if (!active) return;

          store.addChatSession(session);
          store.selectSession(workspace_id, session_id);

          const disable1mContext = shouldDisable1mContext(model);
          await sendChatMessage(
            session_id,
            prompt,
            undefined,
            undefined,
            model ?? undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            disable1mContext || undefined,
            backend_id ?? undefined,
          );

          if (active) {
            store.addToast(i18n.t("settings:ci_auto_fix_session_created"));
          }
        } catch (e) {
          console.error("CI auto-fix session creation failed:", e);
        }
      },
    );

    return () => {
      active = false;
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);
}
