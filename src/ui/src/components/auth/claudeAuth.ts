import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  cancelClaudeAuthLogin,
  claudeAuthLogin,
  getClaudeAuthStatus,
  launchCodexLogin,
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

/**
 * Sentinel emitted by the Codex App-Server harness when its OAuth
 * refresh token has been rotated out from under the running session.
 * Mirrors `CODEX_AUTH_EXPIRED_MESSAGE` in `src/agent/codex_app_server.rs` —
 * keep the substring match in lockstep with the backend constant so any
 * phrasing tweak there gets picked up here without a separate code path.
 */
const CODEX_AUTH_EXPIRED_SENTINEL = "codex authentication expired";

/**
 * Provider whose sign-in flow should drive the in-chat auth callout for
 * a given failure. `null` = not an auth error we know how to recover.
 *
 * Determined entirely from the error string so this works regardless of
 * which harness produced it (Codex App-Server, Claude CLI subprocess,
 * etc.). When the backend evolves to emit other harness-specific auth
 * sentinels, extend this classifier rather than scattering per-call-site
 * substring checks across the FE.
 */
export type AuthErrorProvider = "claude" | "codex";

export function classifyAuthError(error: string): AuthErrorProvider | null {
  if (error.includes("ENV_AUTH:")) return null;
  const normalized = error.toLowerCase();
  if (normalized.includes(CODEX_AUTH_EXPIRED_SENTINEL)) return "codex";
  if (AUTH_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return "claude";
  }
  return null;
}

export function isCodexAuthError(error: string): boolean {
  return classifyAuthError(error) === "codex";
}

/**
 * Backwards-compatible boolean — matches any auth flavour we recognise
 * so existing call-sites (chat message filters, settings panels) keep
 * working. The "Claude" name is historical; new code should prefer
 * `classifyAuthError` when it needs to distinguish providers.
 */
export function isClaudeAuthError(error: string): boolean {
  return classifyAuthError(error) !== null;
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

/**
 * Codex sign-in controller. Satisfies the same shape as
 * `useClaudeAuthLogin` so the shared `ClaudeCodeAuthPanelView` can
 * render either flavour without branching on provider beyond the title
 * and description strings.
 *
 * Unlike Claude Code, the Codex CLI's `codex login` flow is a one-shot
 * browser handoff — it does not emit progress events or accept a paste-
 * back auth code, so `manualUrl` is always null and `submitAuthCode` is
 * a no-op. The success signal lands implicitly via
 * `launch_codex_login`'s post-exit sweep that tears down any
 * persistent Codex session; the user then re-sends the message and a
 * fresh app-server picks up the new tokens. The controller stays in
 * `running` until the user explicitly cancels via the close button,
 * because there is no FE-visible "browser flow finished" signal.
 */
export function useCodexAuthLogin({
  onSuccess: _onSuccess,
}: {
  onSuccess?: () => void | Promise<void>;
} = {}) {
  const [authState, setAuthState] = useState<ClaudeAuthLoginState>({
    status: "idle",
  });

  const startAuthLogin = useCallback(async () => {
    setAuthState({ status: "running", manualUrl: null });
    try {
      await launchCodexLogin();
    } catch (e) {
      setAuthState({ status: "error", error: String(e) });
    }
  }, []);

  const cancelAuthLogin = useCallback(async () => {
    // No backend cancel — `codex login` runs detached. Just reset the
    // UI so the user can dismiss the spinner if they completed the
    // browser flow and want to retry their message.
    setAuthState({ status: "idle" });
  }, []);

  const submitAuthCode = useCallback(async (_code: string) => {
    // Codex's browser flow doesn't require a paste-back code. Treat as
    // a no-op so the shared controller interface compiles cleanly.
  }, []);

  return {
    authState,
    startAuthLogin,
    cancelAuthLogin,
    submitAuthCode,
  } satisfies ClaudeAuthLoginController;
}

/** Strip the "(or `codex login`...)" hint from the user-facing sentinel
 *  so the inline banner stays short. The hint stays in the full callout
 *  body so users still see the recovery options when the card is open. */
export function cleanCodexAuthError(error: string): string {
  return error
    .replace(/\s*\(or `codex login` in a terminal\)/, "")
    .replace(/, then send the message again\.?$/, "")
    .trim();
}
