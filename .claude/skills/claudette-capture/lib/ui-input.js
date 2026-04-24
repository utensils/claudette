// React-safe synthetic input helpers.
// Loaded into eval payloads via: const SHIM = $(cat lib/ui-input.js)
// Exposes window.capture.{typeInto, clickSelector, selectWorkspace, setTheme, seedState, delay, waitFor}
(function () {
  const SHIM_VERSION = 2;
  if (window.capture && window.capture.__version === SHIM_VERSION) return; // idempotent
  const store = () => window.__CLAUDETTE_STORE__;

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  // Native input value setter — React's synthetic system ignores plain .value = "...",
  // so we dispatch through React's value hook.
  function setReactValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function typeInto(selector, text, delayMs = 40) {
    const el = document.querySelector(selector);
    if (!el) throw new Error("typeInto: selector not found: " + selector);
    el.focus();
    let current = "";
    for (const ch of text) {
      current += ch;
      setReactValue(el, current);
      if (delayMs > 0) await delay(delayMs);
    }
  }

  function clickSelector(selector) {
    const el = document.querySelector(selector);
    if (!el) throw new Error("clickSelector: selector not found: " + selector);
    el.click();
    return true;
  }

  function selectWorkspace(idOrName) {
    const s = store().getState();
    const ws = s.workspaces.find((w) => w.id === idOrName || w.name === idOrName);
    if (!ws) throw new Error("selectWorkspace: not found: " + idOrName);
    s.selectWorkspace(ws.id);
    return ws.id;
  }

  function setTheme(id) {
    const s = store().getState();
    s.setCurrentThemeId(id);
    // setCurrentThemeId only updates the store; applyTheme is the side-effect.
    // For built-in themes, flipping data-theme on <html> is sufficient — the
    // CSS [data-theme="…"] blocks carry the palette. User themes layer via
    // inline vars (not supported here; use AppearanceSettings for those).
    document.documentElement.setAttribute("data-theme", id);
    return id;
  }

  function seedState(patch) {
    store().setState(patch);
  }

  async function waitFor(fn, { timeout = 3000, interval = 50 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const r = fn();
        if (r) return r;
      } catch (_) {
        // swallow; retry
      }
      await delay(interval);
    }
    throw new Error("waitFor: timed out after " + timeout + "ms");
  }

  function listThemes() {
    const s = store().getState();
    return (s.themes || []).map((t) => ({ id: t.id, name: t.name, mode: t.mode }));
  }

  function summary() {
    const s = store().getState();
    return {
      currentThemeId: s.currentThemeId,
      selectedWorkspaceId: s.selectedWorkspaceId,
      workspaces: s.workspaces.length,
      repositories: s.repositories.length,
      themes: (s.themes || []).length,
      sidebarVisible: s.sidebarVisible,
      rightSidebarVisible: s.rightSidebarVisible,
    };
  }

  window.capture = {
    __version: SHIM_VERSION,
    typeInto,
    clickSelector,
    selectWorkspace,
    setTheme,
    seedState,
    waitFor,
    delay,
    listThemes,
    summary,
  };
})();
