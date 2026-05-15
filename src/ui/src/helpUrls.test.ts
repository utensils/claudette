import { describe, it, expect } from "vitest";
import { releaseTagFor } from "./helpUrls";

describe("releaseTagFor", () => {
  // Nightly builds stamp `<x.y.z>-dev.<n>.g<sha>` into CARGO_PKG_VERSION
  // (see .github/workflows/nightly.yml) but publish to the rolling
  // `nightly` GitHub tag. The Help → "What's New" link must route those
  // to `nightly` instead of constructing a tag URL that 404s.
  it("routes nightly versions to the rolling 'nightly' tag", () => {
    expect(releaseTagFor("0.25.0-dev.40.g34ce71e")).toBe("nightly");
    expect(releaseTagFor("0.26.0-dev.1.gabcdef0")).toBe("nightly");
  });

  it("routes stable versions to v<version>", () => {
    expect(releaseTagFor("0.24.0")).toBe("v0.24.0");
    expect(releaseTagFor("1.2.3")).toBe("v1.2.3");
  });

  it("treats rc / pre-release suffixes (no '-dev.') as stable tags", () => {
    expect(releaseTagFor("1.0.0-rc.1")).toBe("v1.0.0-rc.1");
    expect(releaseTagFor("0.25.0-beta.2")).toBe("v0.25.0-beta.2");
  });
});
