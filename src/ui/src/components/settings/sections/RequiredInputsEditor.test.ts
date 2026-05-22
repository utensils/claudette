import { describe, expect, it } from "vitest";
import { blankRow, isPristinePlaceholder } from "./RequiredInputsEditor";

describe("isPristinePlaceholder", () => {
  it("treats a freshly added, untouched row as a placeholder", () => {
    // `addRow` inserts exactly this — it should be dropped silently on save.
    expect(isPristinePlaceholder(blankRow())).toBe(true);
  });

  it("does not treat a row with a temporarily-blank key as a placeholder", () => {
    // The rename hazard: an existing field whose key the user just cleared.
    // Persisting now must NOT drop it from the schema, so it can't be
    // mistaken for a brand-new placeholder.
    expect(
      isPristinePlaceholder({ ...blankRow(), key: "", label: "Ticket" }),
    ).toBe(false);
    expect(
      isPristinePlaceholder({ ...blankRow(), key: "", description: "ID" }),
    ).toBe(false);
    expect(
      isPristinePlaceholder({ ...blankRow(), key: "", type: "number" }),
    ).toBe(false);
    expect(
      isPristinePlaceholder({ ...blankRow(), key: "", min: "0" }),
    ).toBe(false);
    expect(
      isPristinePlaceholder({ ...blankRow(), key: "", required: false }),
    ).toBe(false);
  });

  it("does not treat a fully-specified row as a placeholder", () => {
    expect(
      isPristinePlaceholder({ ...blankRow(), key: "TICKET_ID" }),
    ).toBe(false);
  });

  it("ignores whitespace-only values the same as blank", () => {
    expect(
      isPristinePlaceholder({ ...blankRow(), key: "   ", label: "  " }),
    ).toBe(true);
  });
});
