import { describe, expect, it } from "vitest";
import {
  coerceInputValue,
  toPluginSettingField,
  validateInputKey,
  type RepositoryInputField,
} from "./repositoryInput";

describe("validateInputKey", () => {
  it("accepts typical env var names", () => {
    expect(validateInputKey("TICKET_ID")).toBeNull();
    expect(validateInputKey("_internal")).toBeNull();
    expect(validateInputKey("a1")).toBeNull();
  });

  it("rejects empty, leading-digit, and bad-character names", () => {
    expect(validateInputKey("")).toMatch(/cannot be empty/);
    expect(validateInputKey("1FOO")).toMatch(/must start/);
    expect(validateInputKey("FOO-BAR")).toMatch(/letters/);
    expect(validateInputKey("FOO BAR")).toMatch(/letters/);
  });
});

describe("coerceInputValue", () => {
  it("boolean accepts only true/false", () => {
    const field: RepositoryInputField = {
      type: "boolean",
      key: "FLAG",
      label: "Flag",
    };
    expect(coerceInputValue(field, "true")).toEqual({ ok: true, value: "true" });
    expect(coerceInputValue(field, "false")).toEqual({ ok: true, value: "false" });
    expect(coerceInputValue(field, "yes").ok).toBe(false);
    // Casing matters — the renderer always normalizes through onChange.
    expect(coerceInputValue(field, "True").ok).toBe(false);
  });

  it("number rejects non-numeric and out-of-range values", () => {
    const field: RepositoryInputField = {
      type: "number",
      key: "RETRIES",
      label: "Retries",
      min: 0,
      max: 10,
    };
    expect(coerceInputValue(field, "5")).toEqual({ ok: true, value: "5" });
    expect(coerceInputValue(field, "  3.5  ")).toEqual({ ok: true, value: "3.5" });
    expect(coerceInputValue(field, "abc").ok).toBe(false);
    expect(coerceInputValue(field, "-1").ok).toBe(false);
    expect(coerceInputValue(field, "11").ok).toBe(false);
    expect(coerceInputValue(field, "").ok).toBe(false);
  });

  it("string rejects empty values (every declared input is required)", () => {
    const field: RepositoryInputField = {
      type: "string",
      key: "TICKET_ID",
      label: "Ticket",
    };
    expect(coerceInputValue(field, "PROJ-123")).toEqual({ ok: true, value: "PROJ-123" });
    expect(coerceInputValue(field, "   ").ok).toBe(false);
    expect(coerceInputValue(field, "").ok).toBe(false);
  });
});

describe("toPluginSettingField", () => {
  it("maps string → text and preserves shape", () => {
    const adapted = toPluginSettingField({
      type: "string",
      key: "TICKET",
      label: "Ticket",
      placeholder: "PROJ-1",
    });
    expect(adapted.type).toBe("text");
    expect(adapted.key).toBe("TICKET");
    if (adapted.type === "text") {
      expect(adapted.placeholder).toBe("PROJ-1");
    }
  });

  it("passes number bounds through", () => {
    const adapted = toPluginSettingField({
      type: "number",
      key: "N",
      label: "N",
      min: 1,
      max: 10,
      default: 3,
    });
    expect(adapted.type).toBe("number");
    if (adapted.type === "number") {
      expect(adapted.min).toBe(1);
      expect(adapted.max).toBe(10);
      expect(adapted.default).toBe(3);
    }
  });
});
