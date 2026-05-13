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
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("../../services/tauri", () => serviceMocks);

import {
  cleanClaudeAuthError,
  isClaudeAuthError,
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
