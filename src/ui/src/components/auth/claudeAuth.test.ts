// @vitest-environment happy-dom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeAuthStatus } from "../../services/tauri";

const serviceMocks = vi.hoisted(() => ({
  getClaudeAuthStatus: vi.fn<() => Promise<ClaudeAuthStatus>>(() =>
    Promise.resolve({
      state: "signed_out",
      loggedIn: false,
      verified: false,
      authMethod: null,
      apiProvider: null,
      message: null,
    }),
  ),
  claudeAuthLogin: vi.fn(() => Promise.resolve()),
  cancelClaudeAuthLogin: vi.fn(() => Promise.resolve()),
  submitClaudeAuthCode: vi.fn(() => Promise.resolve()),
  // `claudeAuth.ts` now imports `launchCodexLogin` for the Codex
  // sign-in controller. `vi.mock` replaces the whole module with
  // exactly what this factory returns — anything not listed comes
  // back as `undefined` to importers, so a future test that wires up
  // `useCodexAuthLogin` would explode with `TypeError: ... is not a
  // function`. Keep the mock surface in sync with the real module.
  launchCodexLogin: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("../../services/tauri", () => serviceMocks);

import {
  classifyAuthError,
  cleanClaudeAuthError,
  cleanCodexAuthError,
  isClaudeAuthError,
  isCodexAuthError,
  useClaudeAuthRecovery,
} from "./claudeAuth";
import { useAppStore } from "../../stores/useAppStore";

type RecoveryApi = ReturnType<typeof useClaudeAuthRecovery>;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderRecoveryHarness(onReady: (api: RecoveryApi) => void) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  function Harness() {
    const api = useClaudeAuthRecovery();
    useEffect(() => onReady(api), [api]);
    return null;
  }

  act(() => {
    root?.render(createElement(Harness));
  });
}

beforeEach(() => {
  serviceMocks.getClaudeAuthStatus.mockReset();
  serviceMocks.getClaudeAuthStatus.mockResolvedValue({
    state: "signed_out",
    loggedIn: false,
    verified: false,
    authMethod: null,
    apiProvider: null,
    message: null,
  });
  useAppStore.setState({
    claudeAuthFailure: null,
    resolvedClaudeAuthFailureMessageId: null,
  });
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

describe("isClaudeAuthError", () => {
  it("detects 401 invalid credential failures", () => {
    expect(
      isClaudeAuthError(
        "Failed to authenticate. API Error: 401 Invalid authentication credentials",
      ),
    ).toBe(true);
  });

  it("detects missing credential failures", () => {
    expect(
      isClaudeAuthError(
        "Claude Code credentials not found. Sign in with 'claude auth login'.",
      ),
    ).toBe(true);
  });

  it("detects revoked or expired token failures", () => {
    expect(
      isClaudeAuthError("Your token has expired or been revoked."),
    ).toBe(true);
  });

  it("detects token refresh failures", () => {
    expect(isClaudeAuthError("Token refresh failed: HTTP 401")).toBe(true);
  });

  it("detects Claude CLI /login failures", () => {
    expect(isClaudeAuthError("Not logged in · Please run /login")).toBe(true);
  });

  it("does not route ENV_AUTH usage-scope errors to interactive login", () => {
    expect(
      isClaudeAuthError("ENV_AUTH: Usage Insights requires standard OAuth login."),
    ).toBe(false);
  });

  it("treats the Codex auth-expired sentinel as an auth error", () => {
    expect(
      isClaudeAuthError(
        "Codex authentication expired. Run /login (or `codex login` in a terminal), then send the message again.",
      ),
    ).toBe(true);
  });
});

describe("classifyAuthError", () => {
  it("returns codex for the Codex auth-expired sentinel (case-insensitive)", () => {
    expect(
      classifyAuthError(
        "Codex authentication expired. Run /login (or `codex login` in a terminal), then send the message again.",
      ),
    ).toBe("codex");
    expect(classifyAuthError("CODEX AUTHENTICATION EXPIRED")).toBe("codex");
  });

  it("returns claude for Claude CLI auth failures", () => {
    expect(classifyAuthError("API Error: 401 Invalid credentials")).toBe(
      "claude",
    );
    expect(classifyAuthError("Token refresh failed: HTTP 401")).toBe("claude");
  });

  it("returns null for ENV_AUTH usage-scope errors", () => {
    expect(
      classifyAuthError("ENV_AUTH: Usage Insights requires standard OAuth login."),
    ).toBeNull();
  });

  it("returns null for unrelated errors", () => {
    expect(classifyAuthError("Workspace not found")).toBeNull();
    expect(classifyAuthError("Network unreachable")).toBeNull();
  });
});

describe("isCodexAuthError", () => {
  it("matches only the Codex sentinel, not Claude errors", () => {
    expect(
      isCodexAuthError(
        "Codex authentication expired. Run /login (or `codex login` in a terminal), then send the message again.",
      ),
    ).toBe(true);
    expect(isCodexAuthError("Token refresh failed: HTTP 401")).toBe(false);
  });
});

describe("cleanCodexAuthError", () => {
  it("strips the recovery hint so the inline banner stays short", () => {
    expect(
      cleanCodexAuthError(
        "Codex authentication expired. Run /login (or `codex login` in a terminal), then send the message again.",
      ),
    ).toBe("Codex authentication expired. Run /login");
  });
});

describe("cleanClaudeAuthError", () => {
  it("strips the ENV_AUTH marker for display", () => {
    expect(cleanClaudeAuthError("ENV_AUTH: Missing OAuth scope")).toBe(
      "Missing OAuth scope",
    );
  });

  it("formats Claude API auth errors without repeating transport wrappers", () => {
    expect(
      cleanClaudeAuthError(
        "Failed to authenticate. API Error: 401 Invalid authentication credentials",
      ),
    ).toBe("Invalid authentication credentials (401)");
  });

  it("removes Claude CLI slash-login instructions from display text", () => {
    expect(cleanClaudeAuthError("Not logged in · Please run /login")).toBe(
      "Not logged in",
    );
  });
});

describe("useClaudeAuthRecovery", () => {
  it("clears the chat auth failure when validated login is verified", async () => {
    useAppStore.setState({
      claudeAuthFailure: {
        messageId: "assistant-1",
        error: "Not logged in · Please run /login",
      },
      resolvedClaudeAuthFailureMessageId: null,
    });
    serviceMocks.getClaudeAuthStatus.mockResolvedValueOnce({
      state: "signed_in",
      loggedIn: true,
      verified: true,
      authMethod: "oauth",
      apiProvider: "firstParty",
      message: null,
    });

    let api!: RecoveryApi;
    renderRecoveryHarness((next) => {
      api = next;
    });

    await act(async () => {
      await api.validateAuthLoginSuccess();
    });

    expect(useAppStore.getState().claudeAuthFailure).toBeNull();
    expect(useAppStore.getState().resolvedClaudeAuthFailureMessageId).toBe(
      "assistant-1",
    );
  });

  it("keeps the chat auth failure active when validated login is still signed out", async () => {
    useAppStore.setState({
      claudeAuthFailure: {
        messageId: "assistant-1",
        error: "Not logged in · Please run /login",
      },
      resolvedClaudeAuthFailureMessageId: "assistant-1",
    });
    serviceMocks.getClaudeAuthStatus.mockResolvedValueOnce({
      state: "signed_out",
      loggedIn: false,
      verified: false,
      authMethod: null,
      apiProvider: null,
      message: "Not logged in",
    });

    let api!: RecoveryApi;
    renderRecoveryHarness((next) => {
      api = next;
    });

    await act(async () => {
      await expect(api.validateAuthLoginSuccess()).rejects.toThrow(
        "Not logged in",
      );
    });

    expect(useAppStore.getState().claudeAuthFailure).toEqual({
      messageId: "assistant-1",
      error: "Not logged in",
    });
    expect(useAppStore.getState().resolvedClaudeAuthFailureMessageId).toBeNull();
  });
});
