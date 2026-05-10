import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  cancelClaudeAuthLogin,
  claudeAuthLogin,
} from "../../services/tauri";

export type ClaudeAuthLoginState =
  | { status: "idle" }
  | { status: "running"; manualUrl: string | null }
  | { status: "success" }
  | { status: "error"; error: string };

type AuthLoginProgress = { stream: "stdout" | "stderr"; line: string };
type AuthLoginComplete = { success: boolean; error: string | null };

const AUTH_URL_PATTERN = /https?:\/\/[^\s]+/;

const AUTH_ERROR_PATTERNS = [
  "api error: 401",
  "401 invalid authentication credentials",
  "invalid authentication credentials",
  "token refresh failed",
  "credentials not found",
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
  const apiError = cleaned.match(
    /^(?:Failed to authenticate\.\s*)?API Error:\s*(\d+)\s*(.+)$/i,
  );
  if (apiError) {
    const [, status, message] = apiError;
    return `${message.replace(/[.\s]+$/, "")} (${status})`;
  }
  return cleaned;
}

export function useClaudeAuthLogin({
  onSuccess,
}: {
  onSuccess?: () => void | Promise<void>;
} = {}) {
  const [authState, setAuthState] = useState<ClaudeAuthLoginState>({
    status: "idle",
  });

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
      if (success) {
        setAuthState({ status: "success" });
        void onSuccess?.();
      } else {
        setAuthState({
          status: "error",
          error: error ?? "Sign-in failed.",
        });
      }
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
  }, [onSuccess]);

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

  return {
    authState,
    startAuthLogin,
    cancelAuthLogin,
  };
}
