// Curated list of Pi providers that surface in Claudette's Settings card
// by default. Each entry maps to a Pi `ModelRegistry` provider id (see
// `BUILT_IN_PROVIDER_DISPLAY_NAMES` in pi-coding-agent, plus the OAuth
// providers in @earendil-works/pi-ai/utils/oauth/*).
//
// Ordering matters: the first `DEFAULT_VISIBLE_COUNT` render expanded; the
// rest stay under a "More providers..." disclosure. Users can later
// override their personal curated set in Settings.
//
// `kind` controls the configure flow:
//   - "api_key"          → API-key entry dialog (writes to auth.json or
//                          keychain)
//   - "oauth"            → device-code modal driven by Pi's loginX()
//                          helpers
//   - "oauth+enterprise" → device-code modal with an optional self-hosted
//                          domain prompt first (GHES for Copilot)
//   - "env_only"         → "configured via env vars" status row, no in-app
//                          entry (Bedrock / Vertex / Azure — too many env
//                          vars to model in a single dialog; surface a
//                          docs link instead)
//
// The Pi harness reads this list at IPC `list_providers` and merges it
// with live auth status from ModelRegistry.

export type ProviderKind =
  | "api_key"
  | "oauth"
  | "oauth+enterprise"
  | "env_only";

export interface CuratedProvider {
  /** Pi provider id, e.g. "openrouter" or "github-copilot". */
  id: string;
  /** Display name for the card row. */
  label: string;
  /** Short description (one line) explaining what configuring this unlocks. */
  description: string;
  /** Configure flow. */
  kind: ProviderKind;
  /** Optional env var name(s) Pi will pick up automatically. Shown as a
   *  hint under the input ("or set $X in your shell"). */
  envHint?: string;
  /** "Get an API key" link surfaced under the input. */
  docsUrl?: string;
}

/** Providers above this index render expanded; the rest sit under a
 *  "More providers..." disclosure. 6 keeps the card scannable on a 13"
 *  laptop without forcing the user to expand for the common picks. */
export const DEFAULT_VISIBLE_COUNT = 6;

// Curation reasoning:
//
// Slot 1 — github-copilot (OAuth). A meaningful share of Claudette users
//   already pay for Copilot via their employer; OAuth flow means "click
//   one button" and they get every Claude/GPT/Gemini model Copilot
//   exposes for free. Highest leverage row in the list.
//
// Slot 2 — openrouter (API key). Explicitly requested. One key unlocks
//   ~300 models, and OpenRouter is the lingua franca of model
//   experimentation right now.
//
// Slot 3 — openai (API key). Direct OpenAI access for users who don't
//   have ChatGPT Plus/Pro (which goes through the dedicated Codex card).
//
// Slot 4 — anthropic (API key). Distinct from Claudette's Claude OAuth
//   card: this is for users on an Anthropic API plan ("extra usage"
//   billing) who want Pi's harness to route Claude calls. Useful when
//   the Pro/Max plan is exhausted.
//
// Slot 5 — google (API key, Gemini). Gemini 2.5 / 3.x are now first-tier
//   coding models. Free tier exists, so the bar to configure is low.
//
// Slot 6 — deepseek (API key). Best-in-class price/performance for
//   coding workloads; popular with cost-conscious users.
//
// Disclosure (less mainstream but still common enough to want
// in-app entry):
//   xai      — Grok 4.x getting traction
//   groq     — speed-optimized hosting of Llama/Qwen
//   cerebras — wafer-scale, fastest token throughput
//   mistral  — European compliance, Codestral coding model
//   fireworks — popular OSS-model host (Llama, Qwen, Mixtral)
//   opencode — OpenCode Zen, used by some teams who like its routing
//
// Cloud / env-only (we don't try to collect their many env vars in a
// dialog; show a docs link and detect when they're configured):
//   amazon-bedrock, google-vertex, azure-openai-responses
//
// Deliberately omitted from the curated list:
//   - openai-codex      → already surfaced via Claudette's Codex card
//   - cloudflare-ai-gateway / cloudflare-workers-ai → need account id +
//                         gateway id env vars, fits env_only better but
//                         too niche to default-show
//   - huggingface, kimi-coding, minimax / minimax-cn, vercel-ai-gateway,
//     zai, opencode-go, all xiaomi-* → niche / regional / newer; users
//     who want them can configure via `pi auth` and Claudette will pick
//     them up on next refresh
//
// Implementation note on envHint: pi-ai's `getApiKeyEnvVars` is the
// source of truth; the strings below mirror it. If Pi updates the env
// names in a future release, the harness still works (Pi auto-detects
// via its own env map) — the hint is purely UX.

export const CURATED_PROVIDERS: CuratedProvider[] = [
  {
    id: "github-copilot",
    label: "GitHub Copilot",
    description:
      "Sign in once to use Claude, GPT, and Gemini models via your Copilot subscription.",
    kind: "oauth+enterprise",
    docsUrl: "https://github.com/features/copilot",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    description:
      "One API key, ~300 models. Mix open-weight and frontier proprietary models.",
    kind: "api_key",
    envHint: "OPENROUTER_API_KEY",
    docsUrl: "https://openrouter.ai/keys",
  },
  {
    id: "openai",
    label: "OpenAI",
    description: "Direct API access — GPT-5.x and o-series reasoning models.",
    kind: "api_key",
    envHint: "OPENAI_API_KEY",
    docsUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    label: "Anthropic (API)",
    description:
      "API-billed Claude access. Use instead of Pro/Max OAuth when your subscription quota is exhausted.",
    kind: "api_key",
    envHint: "ANTHROPIC_API_KEY",
    docsUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "google",
    label: "Google Gemini",
    description: "Gemini 2.5 / 3.x — generous free tier on AI Studio.",
    kind: "api_key",
    envHint: "GEMINI_API_KEY",
    docsUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    description:
      "Best price/performance for coding. DeepSeek-V3 and reasoning variants.",
    kind: "api_key",
    envHint: "DEEPSEEK_API_KEY",
    docsUrl: "https://platform.deepseek.com/api_keys",
  },

  // --- "More providers..." disclosure below this line. ---

  {
    id: "xai",
    label: "xAI (Grok)",
    description: "Grok 4.x family.",
    kind: "api_key",
    envHint: "XAI_API_KEY",
    docsUrl: "https://console.x.ai",
  },
  {
    id: "groq",
    label: "Groq",
    description: "Fast inference for Llama, Qwen, and Mixtral.",
    kind: "api_key",
    envHint: "GROQ_API_KEY",
    docsUrl: "https://console.groq.com/keys",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    description: "Wafer-scale inference — highest token throughput.",
    kind: "api_key",
    envHint: "CEREBRAS_API_KEY",
    docsUrl: "https://cloud.cerebras.ai",
  },
  {
    id: "mistral",
    label: "Mistral",
    description: "Codestral and Mistral Large for code-heavy work.",
    kind: "api_key",
    envHint: "MISTRAL_API_KEY",
    docsUrl: "https://console.mistral.ai/api-keys",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    description: "Hosted open-weight models (Llama, Qwen, Mixtral, DeepSeek).",
    kind: "api_key",
    envHint: "FIREWORKS_API_KEY",
    docsUrl: "https://fireworks.ai/account/api-keys",
  },
  {
    id: "opencode",
    label: "OpenCode Zen",
    description: "OpenCode-routed open and frontier models.",
    kind: "api_key",
    envHint: "OPENCODE_API_KEY",
    docsUrl: "https://opencode.ai",
  },

  // --- Cloud / env-only providers (show status + docs link, no dialog). ---

  {
    id: "amazon-bedrock",
    label: "Amazon Bedrock",
    description:
      "Configure via AWS credentials in your shell. AWS_PROFILE or IAM keys.",
    kind: "env_only",
    docsUrl:
      "https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/providers.md#amazon-bedrock",
  },
  {
    id: "google-vertex",
    label: "Google Vertex AI",
    description:
      "Configure via gcloud ADC: GOOGLE_CLOUD_PROJECT + GOOGLE_CLOUD_LOCATION.",
    kind: "env_only",
    docsUrl:
      "https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/providers.md#google-vertex-ai",
  },
  {
    id: "azure-openai-responses",
    label: "Azure OpenAI",
    description:
      "AZURE_OPENAI_API_KEY + AZURE_OPENAI_BASE_URL (or resource name).",
    kind: "env_only",
    docsUrl:
      "https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/providers.md#azure-openai",
  },
];
