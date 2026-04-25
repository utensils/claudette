import type { CSSProperties, ReactNode } from "react";

const ULTRATHINK_RE = /\bultrathink\b/gi;
const HAS_ULTRATHINK_RE = /\bultrathink\b/i;

const STATIC_COLORS = [
  "var(--ultrathink-red)",
  "var(--ultrathink-orange)",
  "var(--ultrathink-yellow)",
  "var(--ultrathink-green)",
  "var(--ultrathink-blue)",
  "var(--ultrathink-indigo)",
  "var(--ultrathink-violet)",
] as const;

const SHIMMER_COLORS = [
  "var(--ultrathink-red-shimmer)",
  "var(--ultrathink-orange-shimmer)",
  "var(--ultrathink-yellow-shimmer)",
  "var(--ultrathink-green-shimmer)",
  "var(--ultrathink-blue-shimmer)",
  "var(--ultrathink-indigo-shimmer)",
  "var(--ultrathink-violet-shimmer)",
] as const;

type UltrathinkPart =
  | { kind: "text"; text: string }
  | { kind: "ultrathink"; text: string };

type UltrathinkStyles = {
  ultrathinkChar: string;
  ultrathinkCharAnimated: string;
};

export function hasUltrathink(text: string): boolean {
  return HAS_ULTRATHINK_RE.test(text);
}

export function splitUltrathinkText(text: string): UltrathinkPart[] {
  const parts: UltrathinkPart[] = [];
  let cursor = 0;

  for (const match of text.matchAll(ULTRATHINK_RE)) {
    const start = match.index;
    if (start === undefined) continue;
    if (start > cursor) {
      parts.push({ kind: "text", text: text.slice(cursor, start) });
    }
    parts.push({
      kind: "ultrathink",
      text: match[0],
    });
    cursor = start + match[0].length;
  }

  if (cursor < text.length) {
    parts.push({ kind: "text", text: text.slice(cursor) });
  }

  return parts.length > 0 ? parts : [{ kind: "text", text }];
}

export function resolveUltrathinkEffort(
  input: string,
  currentEffort: string | undefined,
): string | undefined {
  if (!hasUltrathink(input)) return currentEffort;
  if (currentEffort === "xhigh" || currentEffort === "max") return currentEffort;
  return "high";
}

export function renderUltrathinkText(
  text: string,
  options: { animated: boolean; styles: UltrathinkStyles },
): ReactNode {
  return splitUltrathinkText(text).map((part, partIndex) => {
    if (part.kind === "text") {
      return part.text;
    }

    return Array.from(part.text).map((char, charIndex) => (
      <span
        className={`${options.styles.ultrathinkChar}${
          options.animated ? ` ${options.styles.ultrathinkCharAnimated}` : ""
        }`}
        key={`ultrathink-${partIndex}-${charIndex}`}
        style={{
          "--ultrathink-color": STATIC_COLORS[charIndex % STATIC_COLORS.length],
          "--ultrathink-shimmer": SHIMMER_COLORS[charIndex % SHIMMER_COLORS.length],
        } as CSSProperties}
      >
        {char}
      </span>
    ));
  });
}
