import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../stores/useAppStore";
import type { ChatSession } from "../types";

export function useChatSessionCreatedEvent() {
  useEffect(() => {
    const unlisten = listen<ChatSession>("chat-session-created", (event) => {
      useAppStore.getState().addChatSession(event.payload);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);
}
