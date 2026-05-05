/**
 * Filter logic for the Keyboard Settings search box.
 *
 * Pulled out of the component so it can be unit-tested without React. The
 * goal is "intuitive simple search" — a case-insensitive substring match
 * over the label the user actually sees: the action description, the
 * category, and the formatted binding (e.g. "⌘B" or "Ctrl+B").
 *
 * Tokens are AND-ed: typing `terminal split` matches "Split terminal side
 * by side" but not "Toggle terminal panel". This makes it easy to combine a
 * domain word ("terminal") with a verb ("split") without remembering the
 * exact phrasing.
 */
export interface SearchableShortcut {
  description: string;
  category: string;
  bindingLabel: string;
}

export function shortcutMatchesQuery(
  shortcut: SearchableShortcut,
  query: string,
): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = [
    shortcut.description,
    shortcut.category,
    shortcut.bindingLabel,
  ]
    .join(" ")
    .toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}
