// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "../../i18n";
import { SafeTrans } from "./SafeTrans";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(node);
  });
  return container;
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

async function renderDeleteMessage(name: string): Promise<HTMLElement> {
  // en: "Move <strong>{{name}}</strong> to Trash?"
  return render(
    <SafeTrans
      i18nKey="files_delete_message"
      ns="modals"
      values={{ name }}
      components={{ strong: <strong /> }}
    />,
  );
}

describe("SafeTrans", () => {
  it("renders the translation's own tags", async () => {
    const el = await renderDeleteMessage("notes.txt");
    expect(el.textContent).toBe("Move notes.txt to Trash?");
    expect(el.querySelector("strong")?.textContent).toBe("notes.txt");
  });

  it.each([
    "<strong>big</strong>.txt",
    "x</strong> and ALL files",
    "a<b.txt",
    "<0>z</0>",
    "<br/>",
    "Tom & Jerry's \"file\"/path",
    "&lt;already-escaped&gt; &amp; &nbsp;",
  ])("keeps the interpolated value %j as literal text", async (name) => {
    const el = await renderDeleteMessage(name);
    expect(el.textContent).toBe(`Move ${name} to Trash?`);
    const strongs = el.querySelectorAll("strong");
    expect(strongs).toHaveLength(1);
    expect(strongs[0].textContent).toBe(name);
    expect(el.querySelector("br")).toBeNull();
  });

  it("escapes values next to a numeric placeholder", async () => {
    // en: "Resolving <strong>{{plugin}}</strong>… {{seconds}}s elapsed"
    const el = await render(
      <SafeTrans
        i18nKey="env_panel_resolving"
        ns="settings"
        values={{ plugin: "<i>direnv</i>", seconds: 12 }}
        components={{ strong: <strong /> }}
      />,
    );
    expect(el.textContent).toBe("Resolving <i>direnv</i>… 12s elapsed");
    expect(el.querySelector("i")).toBeNull();
  });

  it("does not change i18next's global escaping", () => {
    expect(i18n.options.interpolation?.escapeValue).toBe(false);
  });
});
