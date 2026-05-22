import { useCallback, useEffect, useMemo, useRef } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { ClaudeCodeAuthPanelView } from "./ClaudeCodeAuthPanel";
import {
  type AuthErrorProvider,
  classifyAuthError,
  useClaudeAuthLogin,
  useClaudeAuthRecovery,
  useCodexAuthLogin,
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
  // Pick the sign-in controller that matches the error's harness, not
  // the workspace's *currently selected* provider — the error string is
  // the authoritative signal (a Codex turn failed → show Codex
  // recovery), and reading from settings would drift if the user
  // switched providers between the failure and the callout render.
  const provider: AuthErrorProvider = error
    ? (classifyAuthError(error) ?? "claude")
    : "claude";
  const setClaudeAuthFailure = useAppStore((s) => s.setClaudeAuthFailure);
  const closeChatAuthLoginPanel = useAppStore(
    (s) => s.closeChatAuthLoginPanel,
  );
  const { markAuthRecovered, validateAuthLoginSuccess } = useClaudeAuthRecovery();
  // Both hooks must be called unconditionally — React rules-of-hooks.
  // The unused controller stays inert (idle authState, never invoked).
  const claudeController = useClaudeAuthLogin({
    onSuccess: async () => {
      await validateAuthLoginSuccess();
    },
  });
  const codexController = useCodexAuthLogin({
    onSuccess: markAuthRecovered,
  });
  const controller =
    provider === "codex" ? codexController : claudeController;
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
      provider={provider}
    />
  );
}
