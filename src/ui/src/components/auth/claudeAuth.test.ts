import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("../../services/tauri", () => ({
  claudeAuthLogin: vi.fn(() => Promise.resolve()),
  cancelClaudeAuthLogin: vi.fn(() => Promise.resolve()),
}));

import { cleanClaudeAuthError, isClaudeAuthError } from "./claudeAuth";

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
