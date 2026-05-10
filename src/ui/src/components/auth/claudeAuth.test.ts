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
});
