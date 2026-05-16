import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./useAppStore";

describe("editor view-state (word wrap, line numbers, font zoom)", () => {
  beforeEach(() => {
    useAppStore.setState({
      editorWordWrap: true,
      editorLineNumbersEnabled: true,
      editorFontZoom: 1,
    });
  });

  it("defaults to wrap on, line numbers on, zoom 1.0", () => {
    const state = useAppStore.getState();
    expect(state.editorWordWrap).toBe(true);
    expect(state.editorLineNumbersEnabled).toBe(true);
    expect(state.editorFontZoom).toBe(1);
  });

  it("setEditorWordWrap toggles the flag", () => {
    useAppStore.getState().setEditorWordWrap(false);
    expect(useAppStore.getState().editorWordWrap).toBe(false);
    useAppStore.getState().setEditorWordWrap(true);
    expect(useAppStore.getState().editorWordWrap).toBe(true);
  });

  it("setEditorLineNumbersEnabled toggles the flag", () => {
    useAppStore.getState().setEditorLineNumbersEnabled(false);
    expect(useAppStore.getState().editorLineNumbersEnabled).toBe(false);
  });

  it("setEditorFontZoom clamps to the [0.7, 2] range", () => {
    useAppStore.getState().setEditorFontZoom(1.4);
    expect(useAppStore.getState().editorFontZoom).toBeCloseTo(1.4);

    useAppStore.getState().setEditorFontZoom(5);
    expect(useAppStore.getState().editorFontZoom).toBe(2);

    useAppStore.getState().setEditorFontZoom(0.1);
    expect(useAppStore.getState().editorFontZoom).toBe(0.7);
  });

  it("setEditorFontZoom rejects non-finite values without mutating state", () => {
    useAppStore.getState().setEditorFontZoom(1.2);
    useAppStore.getState().setEditorFontZoom(Number.NaN);
    expect(useAppStore.getState().editorFontZoom).toBeCloseTo(1.2);
    useAppStore.getState().setEditorFontZoom(Number.POSITIVE_INFINITY);
    expect(useAppStore.getState().editorFontZoom).toBeCloseTo(1.2);
  });
});
