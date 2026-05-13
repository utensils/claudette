import { useCallback, useEffect, useMemo, useRef } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { ClaudeCodeAuthPanelView } from "./ClaudeCodeAuthPanel";
import {
  useClaudeAuthLogin,
  useClaudeAuthRecovery,
} from "./claudeAuth";

export function ChatAuthFailureCallout({
  error,
  messageId,
  autoStartKey = null,
  autoStartedKey = null,
  onAutoStarted,
}: {
  error?: string | null;
  messageId?: string | null;
  autoStartKey?: number | null;
  autoStartedKey?: number | null;
  onAutoStarted?: (key: number) => void;
}) {
  const setClaudeAuthFailure = useAppStore((s) => s.setClaudeAuthFailure);
  const closeChatAuthLoginPanel = useAppStore(
    (s) => s.closeChatAuthLoginPanel,
  );
  const { validateAuthLoginSuccess } = useClaudeAuthRecovery();
  const controller = useClaudeAuthLogin({
    onSuccess: async () => {
      await validateAuthLoginSuccess();
    },
  });
  const {
    authState,
    startAuthLogin: startControllerAuthLogin,
    cancelAuthLogin,
    submitAuthCode,
  } = controller;
  const startedKeyRef = useRef<number | null>(null);

  const startAuthLogin = useCallback(async () => {
    if (messageId && error) {
      setClaudeAuthFailure({ messageId, error });
    }
    await startControllerAuthLogin();
  }, [error, messageId, setClaudeAuthFailure, startControllerAuthLogin]);

  const cancelChatAuthLogin = useCallback(async () => {
    try {
      await cancelAuthLogin();
    } finally {
      closeChatAuthLoginPanel();
    }
  }, [cancelAuthLogin, closeChatAuthLoginPanel]);

  useEffect(() => {
    if (
      autoStartKey === null ||
      autoStartedKey === autoStartKey ||
      startedKeyRef.current === autoStartKey
    ) {
      return;
    }
    startedKeyRef.current = autoStartKey;
    onAutoStarted?.(autoStartKey);
    void startAuthLogin();
  }, [autoStartedKey, autoStartKey, onAutoStarted, startAuthLogin]);

  useEffect(() => {
    if (authState.status === "success") {
      closeChatAuthLoginPanel();
    }
  }, [authState.status, closeChatAuthLoginPanel]);

  const chatController = useMemo(
    () => ({
      authState,
      cancelAuthLogin: cancelChatAuthLogin,
      submitAuthCode,
      startAuthLogin,
    }),
    [authState, cancelChatAuthLogin, startAuthLogin, submitAuthCode],
  );

  return (
    <ClaudeCodeAuthPanelView
      controller={chatController}
      error={error}
      showDescription={false}
    />
  );
}
