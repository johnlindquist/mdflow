/**
 * Portable adapter registry for provider-agnostic frontmatter translation.
 *
 * This file also re-exports legacy tool-adapter registry helpers used by
 * config.ts (print/interactive defaults).
 */

import type { Adapter, AgentFrontmatter } from "./types";

// Re-export legacy adapter registry API for config/defaults compatibility.
export {
  registerAdapter,
  getAdapter,
  hasAdapter,
  getRegisteredAdapters,
  getDefaultAdapter,
  buildBuiltinDefaults,
  clearAdapterRegistry,
  defaultAdapter,
} from "./adapters/index";

export type { ToolAdapter } from "./types";

type CanonicalPortableKey = "model" | "temperature" | "max-tokens";
type ProviderKeyMap = Record<CanonicalPortableKey, string>;

const MAX_TOKENS_ALIASES = ["max_tokens", "maxTokens"] as const;

function normalizeCanonicalKeys(frontmatter: AgentFrontmatter): AgentFrontmatter {
  const normalized = { ...frontmatter };

  if (normalized["max-tokens"] === undefined) {
    for (const alias of MAX_TOKENS_ALIASES) {
      const aliasedValue = normalized[alias];
      if (aliasedValue !== undefined) {
        normalized["max-tokens"] = aliasedValue;
        break;
      }
    }
  }

  for (const alias of MAX_TOKENS_ALIASES) {
    delete normalized[alias];
  }

  return normalized;
}

function translateCanonicalKeys(
  frontmatter: AgentFrontmatter,
  keyMap: ProviderKeyMap,
  capabilities: Adapter["capabilities"]
): AgentFrontmatter {
  const translated = { ...frontmatter };

  if (!capabilities.model) delete translated.model;
  if (!capabilities.temperature) delete translated.temperature;
  if (!capabilities.maxTokens) delete translated["max-tokens"];

  const mappings: Array<[CanonicalPortableKey, string]> = [
    ["model", keyMap.model],
    ["temperature", keyMap.temperature],
    ["max-tokens", keyMap["max-tokens"]],
  ];

  for (const [canonicalKey, providerKey] of mappings) {
    if (providerKey === canonicalKey) continue;
    const value = translated[canonicalKey];
    if (value === undefined) continue;

    // Prefer explicitly provider-specific key if user already set one.
    if (translated[providerKey] === undefined) {
      translated[providerKey] = value;
    }
    delete translated[canonicalKey];
  }

  return translated;
}

function createPortableAdapter(
  name: string,
  keyMap: ProviderKeyMap,
  capabilities: Adapter["capabilities"] = {
    model: true,
    temperature: true,
    maxTokens: true,
  }
): Adapter {
  return {
    name,
    capabilities,
    normalizeFrontmatter(frontmatter: AgentFrontmatter): AgentFrontmatter {
      const normalized = normalizeCanonicalKeys(frontmatter);
      return translateCanonicalKeys(normalized, keyMap, capabilities);
    },
    buildArgs(
      frontmatter: AgentFrontmatter,
      templateVars: Set<string>,
      buildGenericArgs: (frontmatter: AgentFrontmatter, templateVars: Set<string>) => string[]
    ): string[] {
      const normalized = this.normalizeFrontmatter(frontmatter);
      return buildGenericArgs(normalized, templateVars);
    },
  };
}

export const claudePortableAdapter = createPortableAdapter("claude", {
  model: "model",
  temperature: "temperature",
  "max-tokens": "max-tokens",
});

export const codexPortableAdapter = createPortableAdapter("codex", {
  model: "model",
  temperature: "temperature",
  "max-tokens": "max-output-tokens",
});

export const geminiPortableAdapter = createPortableAdapter("gemini", {
  model: "model",
  temperature: "temperature",
  "max-tokens": "max-output-tokens",
});

export const copilotPortableAdapter = createPortableAdapter("copilot", {
  model: "model",
  temperature: "temperature",
  "max-tokens": "max-completion-tokens",
});

export const droidPortableAdapter = createPortableAdapter("droid", {
  model: "model",
  temperature: "temperature",
  "max-tokens": "max-tokens",
});

export const opencodePortableAdapter = createPortableAdapter("opencode", {
  model: "model",
  temperature: "temperature",
  "max-tokens": "max-tokens",
});

// pi supports --model (with optional ":<thinking>" suffix); no temperature or
// max-tokens flags — those canonical keys are dropped, not passed through.
export const piPortableAdapter = createPortableAdapter(
  "pi",
  { model: "model", temperature: "temperature", "max-tokens": "max-tokens" },
  { model: true, temperature: false, maxTokens: false }
);

// cursor-agent supports --model only.
export const cursorAgentPortableAdapter = createPortableAdapter(
  "cursor-agent",
  { model: "model", temperature: "temperature", "max-tokens": "max-tokens" },
  { model: true, temperature: false, maxTokens: false }
);

// agy supports --model (e.g. gemini-3.1-pro, claude-opus); temperature and
// max-tokens are unconfirmed upstream, so they are dropped rather than passed.
export const agyPortableAdapter = createPortableAdapter(
  "agy",
  { model: "model", temperature: "temperature", "max-tokens": "max-tokens" },
  { model: true, temperature: false, maxTokens: false }
);

const PORTABLE_ADAPTERS: Record<string, Adapter> = {
  claude: claudePortableAdapter,
  codex: codexPortableAdapter,
  gemini: geminiPortableAdapter,
  copilot: copilotPortableAdapter,
  droid: droidPortableAdapter,
  opencode: opencodePortableAdapter,
  pi: piPortableAdapter,
  "cursor-agent": cursorAgentPortableAdapter,
  agy: agyPortableAdapter,
};

/**
 * Look up portable adapter by command/provider name.
 */
export function getPortableAdapter(command: string): Adapter | undefined {
  return PORTABLE_ADAPTERS[command.trim().toLowerCase()];
}

/**
 * List known portable provider adapters.
 */
export function getPortableAdapterNames(): string[] {
  return Object.keys(PORTABLE_ADAPTERS);
}
