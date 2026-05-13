import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  cancelClaudeAuthLogin,
  claudeAuthLogin,
  getClaudeAuthStatus,
  submitClaudeAuthCode,
  type ClaudeAuthStatus,
} from "../../services/tauri";
import { useAppStore } from "../../stores/useAppStore";

export type ClaudeAuthLoginState =
  | { status: "idle" }
  | { status: "running"; manualUrl: string | null }
  | { status: "success" }
  | { status: "error"; error: string };

export interface ClaudeAuthLoginController {
  authState: ClaudeAuthLoginState;
  startAuthLogin: () => Promise<void>;
  cancelAuthLogin: () => Promise<void>;
  submitAuthCode: (code: string) => Promise<void>;
}

type AuthLoginProgress = { stream: "stdout" | "stderr"; line: string };
type AuthLoginComplete = { success: boolean; error: string | null };

const AUTH_URL_PATTERN = /https?:\/\/[^\s]+/;

export const AUTH_SETTINGS_FOCUS = "claude-auth";

const AUTH_ERROR_PATTERNS = [
  "api error: 401",
  "401 invalid authentication credentials",
  "invalid authentication credentials",
  "token refresh failed",
  "credentials not found",
  "not logged in",
  "please run /login",
  "run /login",
  "expired or been revoked",
  "run claude auth login",
  "failed to authenticate",
];

export function isClaudeAuthError(error: string): boolean {
  if (error.includes("ENV_AUTH:")) return false;
  const normalized = error.toLowerCase();
  return AUTH_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}

export function cleanClaudeAuthError(error: string): string {
  const cleaned = error
    .replace(/^Error:\s*/i, "")
    .replace(/^ENV_AUTH:\s*/i, "")
    .trim();
  const cliLoginHint = cleaned.match(/^(.+?)\s*[·-]\s*please run\s+\/login\.?$/i);
  if (cliLoginHint) {
    return cliLoginHint[1].trim();
  }
  if (/^please run\s+\/login\.?$/i.test(cleaned)) {
    return "Not signed in";
  }
  const apiError = cleaned.match(
    /^(?:Failed to authenticate\.\s*)?API Error:\s*(\d+)\s*(.+)$/i,
  );
  if (apiError) {
    const [, status, message] = apiError;
    return `${message.replace(/[.\s]+$/, "")} (${status})`;
  }
  return cleaned;
}

export function useClaudeAuthRecovery() {
  const claudeAuthFailureMessageId = useAppStore(
    (s) => s.claudeAuthFailure?.messageId ?? null,
  );
  const setClaudeAuthFailure = useAppStore((s) => s.setClaudeAuthFailure);
  const setResolvedClaudeAuthFailureMessageId = useAppStore(
    (s) => s.setResolvedClaudeAuthFailureMessageId,
  );

  const markAuthRecovered = useCallback(() => {
    if (claudeAuthFailureMessageId) {
      setResolvedClaudeAuthFailureMessageId(claudeAuthFailureMessageId);
    }
    setClaudeAuthFailure(null);
  }, [
    claudeAuthFailureMessageId,
    setClaudeAuthFailure,
    setResolvedClaudeAuthFailureMessageId,
  ]);

  const applyAuthStatusRecovery = useCallback(
    (value: ClaudeAuthStatus, validate = false) => {
      if (value.state === "signed_in" && value.verified) {
        markAuthRecovered();
        return;
      }

      if (
        validate &&
        value.message &&
        (value.state === "signed_out" || isClaudeAuthError(value.message))
      ) {
        if (claudeAuthFailureMessageId) {
          setResolvedClaudeAuthFailureMessageId(null);
        }
        setClaudeAuthFailure({
          messageId: claudeAuthFailureMessageId,
          error: value.message,
        });
      }
    },
    [
      claudeAuthFailureMessageId,
      markAuthRecovered,
      setClaudeAuthFailure,
      setResolvedClaudeAuthFailureMessageId,
    ],
  );

  const validateAuthLoginSuccess = useCallback(async () => {
    const value = await getClaudeAuthStatus(true);
    applyAuthStatusRecovery(value, true);
    if (value.state !== "signed_in" || !value.verified) {
      throw new Error(
        value.message ?? "Claude Code sign-in could not be verified.",
      );
    }
    return value;
  }, [applyAuthStatusRecovery]);

  return {
    applyAuthStatusRecovery,
    markAuthRecovered,
    validateAuthLoginSuccess,
  };
}

export function useClaudeAuthLogin({
  onSuccess,
}: {
  onSuccess?: () => void | Promise<void>;
} = {}) {
  const onSuccessRef = useRef(onSuccess);
  const [authState, setAuthState] = useState<ClaudeAuthLoginState>({
    status: "idle",
  });

  useEffect(() => {
    onSuccessRef.current = onSuccess;
  }, [onSuccess]);

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;

    listen<AuthLoginProgress>("auth://login-progress", (event) => {
      const { line } = event.payload;
      const match = line.match(AUTH_URL_PATTERN);
      if (!match) return;
      setAuthState((current) => {
        if (current.status !== "running" || current.manualUrl !== null) {
          return current;
        }
        return { status: "running", manualUrl: match[0] };
      });
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisteners.push(fn);
      })
      .catch((err) => {
        console.error("Failed to subscribe to auth://login-progress", err);
      });

    listen<AuthLoginComplete>("auth://login-complete", (event) => {
      const { success, error } = event.payload;
      if (!success) {
        setAuthState({
          status: "error",
          error: error ?? "Sign-in failed.",
        });
        return;
      }

      void Promise.resolve(onSuccessRef.current?.())
        .then(() => {
          setAuthState({ status: "success" });
        })
        .catch((err) => {
          setAuthState({
            status: "error",
            error:
              err instanceof Error
                ? err.message
                : String(err || "Sign-in could not be verified."),
          });
        });
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisteners.push(fn);
      })
      .catch((err) => {
        console.error("Failed to subscribe to auth://login-complete", err);
      });

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  const startAuthLogin = useCallback(async () => {
    setAuthState({ status: "running", manualUrl: null });
    try {
      await claudeAuthLogin();
    } catch (e) {
      setAuthState({ status: "error", error: String(e) });
    }
  }, []);

  const cancelAuthLogin = useCallback(async () => {
    try {
      await cancelClaudeAuthLogin();
    } catch (e) {
      setAuthState({ status: "error", error: String(e) });
    }
  }, []);

  const submitAuthCode = useCallback(async (code: string) => {
    try {
      await submitClaudeAuthCode(code);
    } catch (e) {
      setAuthState({ status: "error", error: String(e) });
      throw e;
    }
  }, []);

  return {
    authState,
    startAuthLogin,
    cancelAuthLogin,
    submitAuthCode,
  } satisfies ClaudeAuthLoginController;
}
