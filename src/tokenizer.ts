/**
 * Token counting and context limit management
 *
 * Uses gpt-tokenizer for accurate token counting instead of length/4 heuristic.
 * Provides model-specific context window limits with config override support.
 */

import { encode } from "gpt-tokenizer";

/**
 * Default context window limits by model
 * These are conservative defaults based on documented model limits
 */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // Claude models
  opus: 200000,
  sonnet: 200000,
  haiku: 200000,
  "claude-3-opus": 200000,
  "claude-3-sonnet": 200000,
  "claude-3-haiku": 200000,
  "claude-3.5-sonnet": 200000,
  "claude-3.5-haiku": 200000,
  "claude-opus-4": 200000,
  "claude-sonnet-4": 200000,

  // OpenAI models
  "gpt-4": 128000,
  "gpt-4-turbo": 128000,
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "gpt-3.5-turbo": 16385,
  o1: 200000,
  "o1-mini": 128000,
  "o1-preview": 128000,

  // Gemini models
  gemini: 1000000,
  "gemini-pro": 1000000,
  "gemini-1.5-pro": 1000000,
  "gemini-1.5-flash": 1000000,
  "gemini-2.0-flash": 1000000,

  // Codex/Copilot
  codex: 8000,
  copilot: 8000,

  // Default fallback
  default: 100000,
};

/**
 * Count the number of tokens in a text string
 *
 * Uses gpt-tokenizer which provides accurate token counts.
 * While optimized for GPT models, it provides a good approximation
 * for other models as well (typically within 10-20% accuracy).
 *
 * @param text - The text to count tokens for
 * @returns The number of tokens
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  return encode(text).length;
}

/**
 * Get the context window limit for a model
 *
 * Looks up the model in the MODEL_CONTEXT_LIMITS map.
 * Supports partial matching (e.g., "opus" matches "claude-3-opus").
 *
 * @param model - The model name or identifier
 * @param configOverride - Optional context_window from config (takes priority)
 * @returns The context window limit in tokens
 */
export function getContextLimit(
  model?: string,
  configOverride?: number
): number {
  // Config override takes highest priority
  if (configOverride && configOverride > 0) {
    return configOverride;
  }

  if (!model) {
    return MODEL_CONTEXT_LIMITS.default;
  }

  const normalizedModel = model.toLowerCase();

  // Direct match first
  if (MODEL_CONTEXT_LIMITS[normalizedModel]) {
    return MODEL_CONTEXT_LIMITS[normalizedModel];
  }

  // Partial match - check if model contains any known key
  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (key !== "default" && normalizedModel.includes(key)) {
      return limit;
    }
  }

  // Check if any key is contained in the model name
  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (key !== "default" && key.includes(normalizedModel)) {
      return limit;
    }
  }

  return MODEL_CONTEXT_LIMITS.default;
}

/**
 * Check if text exceeds the token limit for a model
 *
 * @param text - The text to check
 * @param model - The model name
 * @param configOverride - Optional context_window from config
 * @returns true if the text exceeds the limit
 */
export function exceedsTokenLimit(
  text: string,
  model?: string,
  configOverride?: number
): boolean {
  const tokenCount = countTokens(text);
  const limit = getContextLimit(model, configOverride);
  return tokenCount > limit;
}

/**
 * Get token usage information for text
 *
 * @param text - The text to analyze
 * @param model - The model name
 * @param configOverride - Optional context_window from config
 * @returns Object with token count, limit, and usage percentage
 */
export function getTokenUsage(
  text: string,
  model?: string,
  configOverride?: number
): { tokens: number; limit: number; percentage: number; exceeds: boolean } {
  const tokens = countTokens(text);
  const limit = getContextLimit(model, configOverride);
  const percentage = (tokens / limit) * 100;

  return {
    tokens,
    limit,
    percentage: Math.round(percentage * 100) / 100,
    exceeds: tokens > limit,
  };
}
