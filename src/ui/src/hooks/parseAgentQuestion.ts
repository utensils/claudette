import type { AgentQuestionItem } from "../stores/useAppStore";

/**
 * Parse AskUserQuestion tool input JSON into question items.
 * Supports two formats:
 * - Single: { question: "...", options: [...] }
 * - Multi:  { questions: [{ header?, question, options, multiSelect? }] }
 *
 * Options can be strings or objects with label/description fields.
 */
export function parseAskUserQuestion(
  parsed: Record<string, unknown>
): AgentQuestionItem[] {
  // Multi-question format
  if (Array.isArray(parsed.questions)) {
    return parsed.questions.map((q: Record<string, unknown>) => ({
      header: typeof q.header === "string" ? q.header : undefined,
      question: typeof q.question === "string" ? q.question : "",
      options: parseOptions(q.options),
      multiSelect: q.multiSelect === true,
    }));
  }

  // Single-question format
  if (typeof parsed.question === "string") {
    return [
      {
        question: parsed.question,
        options: parseOptions(parsed.options),
        multiSelect: false,
      },
    ];
  }

  return [];
}

export function parseOptions(
  raw: unknown
): Array<{ label: string; description?: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.map((opt: unknown) => {
    if (typeof opt === "string") return { label: opt };
    if (typeof opt === "object" && opt !== null) {
      const o = opt as Record<string, unknown>;
      return {
        label: typeof o.label === "string" ? o.label : String(o.label ?? ""),
        description:
          typeof o.description === "string" ? o.description : undefined,
      };
    }
    return { label: String(opt) };
  });
}
