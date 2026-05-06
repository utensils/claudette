import { describe, expect, it } from "vitest";
import type { CiCheck, PullRequest } from "../types/plugin";
import { deriveBannerStatus } from "./usePrBannerData";

const pr: PullRequest = {
  number: 655,
  title: "Add SCM checks",
  state: "open",
  url: "https://example.test/pull/655",
  author: "octocat",
  branch: "feat/detailed-scm-checks",
  base: "main",
  draft: false,
  ci_status: null,
};

function check(status: CiCheck["status"]): CiCheck {
  return {
    name: status,
    status,
    url: null,
    started_at: null,
  };
}

describe("deriveBannerStatus", () => {
  it("uses individual checks when PR aggregate status is absent", () => {
    expect(deriveBannerStatus(pr, [check("failure")])).toBe("ci-failed");
    expect(deriveBannerStatus(pr, [check("pending")])).toBe("ci-pending");
    expect(deriveBannerStatus(pr, [check("success")])).toBe("ready");
  });

  it("keeps PR lifecycle states ahead of checks", () => {
    expect(deriveBannerStatus({ ...pr, state: "draft" }, [check("success")])).toBe("draft");
    expect(deriveBannerStatus({ ...pr, state: "closed" }, [check("failure")])).toBe("closed");
  });
});
