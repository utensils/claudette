import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AVAILABLE_HARNESSES_BY_KIND,
  DEFAULT_HARNESS_BY_KIND,
} from "./modelRegistry";
import {
  availableHarnessesForKind,
  defaultHarnessForKind,
  type AgentBackendKind,
} from "../../services/tauri/agentBackends";

// Pin both TypeScript mirrors (`modelRegistry.ts` for the picker, and
// `services/tauri/agentBackends.ts` for the Settings card) to the
// canonical matrix that the Rust resolver reads at
// `src/agent_backend_matrix.json`. The Rust side has a matching test
// (`agent_backend::tests::matrix_matches_fixture`) so drift on either
// end surfaces immediately instead of as a silent dispatch mismatch
// between picker badge and actual send-time routing.
//
// vitest runs in Node, so we can reach the repo root via the
// project-root fs path; the file lives outside `src/ui/` because Rust
// needs to `include_str!` it relative to `src/agent_backend.rs`.

interface MatrixEntry {
  default: string;
  available: readonly string[];
}
interface Matrix {
  kinds: Readonly<Record<string, MatrixEntry>>;
}

// __dirname is `src/ui/src/components/chat`; four `..` segments climb
// back to `src/`, where the canonical matrix lives next to
// `agent_backend.rs`.
const FIXTURE_PATH = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "agent_backend_matrix.json",
);

function loadFixture(): Matrix {
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  const parsed = JSON.parse(raw) as Matrix;
  if (!parsed || typeof parsed !== "object" || !parsed.kinds) {
    throw new Error(
      `agent_backend_matrix.json missing top-level "kinds" object`,
    );
  }
  return parsed;
}

describe("harness matrix parity", () => {
  const fixture = loadFixture();
  const kindNames = Object.keys(fixture.kinds).sort();

  it("loads fixture from the repo root", () => {
    expect(kindNames.length).toBeGreaterThan(0);
  });

  it("modelRegistry.DEFAULT_HARNESS_BY_KIND matches the fixture", () => {
    const actual = Object.fromEntries(
      Object.entries(DEFAULT_HARNESS_BY_KIND).sort(),
    );
    const expected = Object.fromEntries(
      kindNames.map((k) => [k, fixture.kinds[k].default]),
    );
    expect(actual).toEqual(expected);
  });

  it("modelRegistry.AVAILABLE_HARNESSES_BY_KIND matches the fixture (order significant)", () => {
    const actual = Object.fromEntries(
      Object.entries(AVAILABLE_HARNESSES_BY_KIND).sort(),
    );
    const expected = Object.fromEntries(
      kindNames.map((k) => [k, [...fixture.kinds[k].available]]),
    );
    expect(actual).toEqual(expected);
  });

  it("services/tauri.defaultHarnessForKind agrees with the fixture", () => {
    for (const kind of kindNames) {
      expect(defaultHarnessForKind(kind as AgentBackendKind)).toEqual(
        fixture.kinds[kind].default,
      );
    }
  });

  it("services/tauri.availableHarnessesForKind agrees with the fixture (order significant)", () => {
    for (const kind of kindNames) {
      expect(availableHarnessesForKind(kind as AgentBackendKind)).toEqual(
        fixture.kinds[kind].available,
      );
    }
  });

  it("fixture: first available harness is the kind's default", () => {
    // Pinned because Rust's `available_harnesses` puts the default
    // first by convention, and the TS picker downgrade logic
    // (`resolveEffectiveHarness`) relies on iterating available and
    // taking the first non-Pi entry. Breaking this convention silently
    // changes downgrade behavior when the Pi card is disabled.
    for (const kind of kindNames) {
      expect(fixture.kinds[kind].available[0]).toEqual(
        fixture.kinds[kind].default,
      );
    }
  });
});
