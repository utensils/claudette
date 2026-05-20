import { describe, expect, it } from "vitest";
import {
  coerceInputValue,
  isFieldRequired,
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

  it("string rejects empty values when the field is required", () => {
    const field: RepositoryInputField = {
      type: "string",
      key: "TICKET_ID",
      label: "Ticket",
    };
    expect(coerceInputValue(field, "PROJ-123")).toEqual({ ok: true, value: "PROJ-123" });
    expect(coerceInputValue(field, "   ").ok).toBe(false);
    expect(coerceInputValue(field, "").ok).toBe(false);
  });

  it("non-required string accepts blank values", () => {
    const field: RepositoryInputField = {
      type: "string",
      key: "NOTES",
      label: "Notes",
      required: false,
    };
    expect(coerceInputValue(field, "")).toEqual({ ok: true, value: "" });
    expect(coerceInputValue(field, "   ")).toEqual({ ok: true, value: "   " });
    expect(coerceInputValue(field, "anything")).toEqual({
      ok: true,
      value: "anything",
    });
  });

  it("non-required number accepts blank but still validates non-blank input", () => {
    const field: RepositoryInputField = {
      type: "number",
      key: "BUDGET",
      label: "Budget",
      min: 0,
      max: 100,
      required: false,
    };
    // Blank ⇒ "" so scripts can `[ -z "$BUDGET" ]`.
    expect(coerceInputValue(field, "")).toEqual({ ok: true, value: "" });
    expect(coerceInputValue(field, "   ")).toEqual({ ok: true, value: "" });
    // Non-blank still goes through the full numeric path.
    expect(coerceInputValue(field, "42")).toEqual({ ok: true, value: "42" });
    expect(coerceInputValue(field, "abc").ok).toBe(false);
    expect(coerceInputValue(field, "200").ok).toBe(false);
  });
});

describe("isFieldRequired", () => {
  it("defaults to true when `required` is absent (legacy schemas)", () => {
    expect(isFieldRequired({ type: "string", key: "X", label: "X" })).toBe(true);
    expect(isFieldRequired({ type: "number", key: "X", label: "X" })).toBe(true);
  });

  it("honors explicit required: false for string/number", () => {
    expect(
      isFieldRequired({ type: "string", key: "X", label: "X", required: false }),
    ).toBe(false);
    expect(
      isFieldRequired({ type: "number", key: "X", label: "X", required: false }),
    ).toBe(false);
  });

  it("always returns true for booleans regardless of the flag", () => {
    // Booleans always carry a value (true / false); the `required` flag is
    // meaningless for them and the UI/coerce paths treat them as required.
    expect(
      isFieldRequired({
        type: "boolean",
        key: "FLAG",
        label: "Flag",
        required: false,
      }),
    ).toBe(true);
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

  it("boolean without a declared default propagates as undefined", () => {
    // Used to coerce missing defaults to `false`, which made
    // "no opinion" indistinguishable from "explicitly off" downstream.
    // Now `undefined` flows through so renderers can pick their own
    // initial state.
    const adapted = toPluginSettingField({
      type: "boolean",
      key: "DEBUG",
      label: "Debug",
    });
    expect(adapted.type).toBe("boolean");
    if (adapted.type === "boolean") {
      expect(adapted.default).toBeUndefined();
    }
  });

  it("boolean with an explicit default preserves the value", () => {
    const explicitTrue = toPluginSettingField({
      type: "boolean",
      key: "DEBUG",
      label: "Debug",
      default: true,
    });
    if (explicitTrue.type === "boolean") {
      expect(explicitTrue.default).toBe(true);
    }
    const explicitFalse = toPluginSettingField({
      type: "boolean",
      key: "DEBUG",
      label: "Debug",
      default: false,
    });
    if (explicitFalse.type === "boolean") {
      expect(explicitFalse.default).toBe(false);
    }
  });
});
