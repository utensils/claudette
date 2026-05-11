import { describe, expect, it } from "vitest";
import {
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react";
import { resolveScmPrIcon } from "./workspaceStatusIcon";
import type { ScmSummary } from "../../types/plugin";

const summary = (over: Partial<ScmSummary>): ScmSummary => ({
  hasPr: true,
  prState: "open",
  ciState: null,
  lastUpdated: 0,
  ...over,
});

describe("resolveScmPrIcon", () => {
  it("returns null when there is no summary or no PR — caller falls through to idle/stopped", () => {
    expect(resolveScmPrIcon(undefined)).toBeNull();
    expect(
      resolveScmPrIcon(summary({ hasPr: false, prState: null })),
    ).toBeNull();
  });

  it("renders GitMerge in badge-plan purple for merged PRs (matches Sidebar)", () => {
    const spec = resolveScmPrIcon(summary({ prState: "merged" }));
    expect(spec).not.toBeNull();
    expect(spec?.Icon).toBe(GitMerge);
    expect(spec?.color).toBe("var(--badge-plan)");
    expect(spec?.title).toBe("PR: merged");
  });

  it("renders GitPullRequestClosed in status-stopped for closed PRs", () => {
    const spec = resolveScmPrIcon(summary({ prState: "closed" }));
    expect(spec?.Icon).toBe(GitPullRequestClosed);
    expect(spec?.color).toBe("var(--status-stopped)");
  });

  it("renders GitPullRequestDraft in text-dim for draft PRs", () => {
    const spec = resolveScmPrIcon(summary({ prState: "draft" }));
    expect(spec?.Icon).toBe(GitPullRequestDraft);
    expect(spec?.color).toBe("var(--text-dim)");
  });

  it("tints open PRs by CI state", () => {
    const open = (ciState: ScmSummary["ciState"]) =>
      resolveScmPrIcon(summary({ prState: "open", ciState }));
    expect(open(null)?.Icon).toBe(GitPullRequestArrow);
    expect(open(null)?.color).toBe("var(--badge-done)");
    expect(open("success")?.color).toBe("var(--badge-done)");
    expect(open("pending")?.color).toBe("var(--badge-ask)");
    expect(open("failure")?.color).toBe("var(--status-stopped)");
  });

  it("includes CI state in the title when present", () => {
    expect(
      resolveScmPrIcon(summary({ prState: "open", ciState: "pending" }))?.title,
    ).toBe("PR: open, CI: pending");
    expect(
      resolveScmPrIcon(summary({ prState: "merged", ciState: null }))?.title,
    ).toBe("PR: merged");
  });
});
