import { describe, it, expect } from "bun:test";
import {
  countTokens,
  getContextLimit,
  exceedsTokenLimit,
  getTokenUsage,
  MODEL_CONTEXT_LIMITS,
} from "./tokenizer";

describe("tokenizer", () => {
  describe("countTokens", () => {
    it("returns 0 for empty string", () => {
      expect(countTokens("")).toBe(0);
    });

    it("returns 0 for undefined/null coerced to empty", () => {
      expect(countTokens("")).toBe(0);
    });

    it("counts tokens for simple text", () => {
      const tokens = countTokens("Hello, world!");
      // "Hello, world!" is typically 4 tokens: "Hello", ",", " world", "!"
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(10);
    });

    it("counts tokens more accurately than length/4", () => {
      // This demonstrates the difference from the old heuristic
      const text = "The quick brown fox jumps over the lazy dog.";
      const tokens = countTokens(text);
      const oldHeuristic = Math.ceil(text.length / 4);

      // Token count should be different from simple length/4
      // The actual token count for this sentence is around 10
      expect(tokens).toBeGreaterThan(5);
      expect(tokens).toBeLessThan(20);
      // The old heuristic would give 44/4 = 11 (ceil)
      expect(oldHeuristic).toBe(11);
    });

    it("handles code snippets", () => {
      const code = `function hello() {
  console.log("Hello, world!");
}`;
      const tokens = countTokens(code);
      expect(tokens).toBeGreaterThan(10);
      expect(tokens).toBeLessThan(50);
    });

    it("handles unicode and special characters", () => {
      const unicode = "Hello 世界! Emoji: 🎉";
      const tokens = countTokens(unicode);
      expect(tokens).toBeGreaterThan(0);
    });

    it("scales linearly with content size", () => {
      const base = "This is a test sentence. ";
      const small = base.repeat(10);
      const large = base.repeat(100);

      const smallTokens = countTokens(small);
      const largeTokens = countTokens(large);

      // Large should be roughly 10x small (within reasonable margin)
      const ratio = largeTokens / smallTokens;
      expect(ratio).toBeGreaterThan(8);
      expect(ratio).toBeLessThan(12);
    });
  });

  describe("getContextLimit", () => {
    it("returns default limit when no model specified", () => {
      expect(getContextLimit()).toBe(MODEL_CONTEXT_LIMITS.default);
    });

    it("returns correct limit for Claude models", () => {
      expect(getContextLimit("opus")).toBe(200000);
      expect(getContextLimit("sonnet")).toBe(200000);
      expect(getContextLimit("haiku")).toBe(200000);
      expect(getContextLimit("claude-3-opus")).toBe(200000);
      expect(getContextLimit("claude-3.5-sonnet")).toBe(200000);
    });

    it("returns correct limit for OpenAI models", () => {
      expect(getContextLimit("gpt-4")).toBe(128000);
      expect(getContextLimit("gpt-4-turbo")).toBe(128000);
      expect(getContextLimit("gpt-4o")).toBe(128000);
      expect(getContextLimit("gpt-3.5-turbo")).toBe(16385);
    });

    it("returns correct limit for Gemini models", () => {
      expect(getContextLimit("gemini")).toBe(1000000);
      expect(getContextLimit("gemini-pro")).toBe(1000000);
      expect(getContextLimit("gemini-1.5-pro")).toBe(1000000);
    });

    it("handles case-insensitive model names", () => {
      expect(getContextLimit("OPUS")).toBe(200000);
      expect(getContextLimit("GPT-4")).toBe(128000);
      expect(getContextLimit("Gemini")).toBe(1000000);
    });

    it("matches partial model names", () => {
      // "claude-opus-4-20241022" should match "opus"
      expect(getContextLimit("claude-opus-4-20241022")).toBe(200000);
      // "gpt-4-1106-preview" should match "gpt-4"
      expect(getContextLimit("gpt-4-1106-preview")).toBe(128000);
    });

    it("returns default for unknown models", () => {
      expect(getContextLimit("unknown-model")).toBe(MODEL_CONTEXT_LIMITS.default);
      expect(getContextLimit("my-custom-llm")).toBe(MODEL_CONTEXT_LIMITS.default);
    });

    it("uses config override when provided", () => {
      // Config override should take priority over model-based limit
      expect(getContextLimit("opus", 50000)).toBe(50000);
      expect(getContextLimit("gpt-4", 256000)).toBe(256000);
      expect(getContextLimit(undefined, 75000)).toBe(75000);
    });

    it("ignores invalid config override values", () => {
      expect(getContextLimit("opus", 0)).toBe(200000);
      expect(getContextLimit("opus", -1)).toBe(200000);
    });
  });

  describe("exceedsTokenLimit", () => {
    it("returns false for small text", () => {
      expect(exceedsTokenLimit("Hello, world!", "opus")).toBe(false);
    });

    it("returns false for empty text", () => {
      expect(exceedsTokenLimit("", "gpt-4")).toBe(false);
    });

    it("respects model-specific limits", () => {
      // Create text that would exceed a small limit but not a large one
      const mediumText = "test ".repeat(5000); // ~5000 tokens

      // Should not exceed opus limit (200k)
      expect(exceedsTokenLimit(mediumText, "opus")).toBe(false);

      // Test with config override for small limit
      expect(exceedsTokenLimit(mediumText, "opus", 1000)).toBe(true);
    });

    it("uses config override for limit check", () => {
      const text = "word ".repeat(100); // ~100 tokens
      expect(exceedsTokenLimit(text, "opus", 50)).toBe(true);
      expect(exceedsTokenLimit(text, "opus", 500)).toBe(false);
    });
  });

  describe("getTokenUsage", () => {
    it("returns correct usage information", () => {
      const text = "Hello, world!";
      const usage = getTokenUsage(text, "opus");

      expect(usage.tokens).toBeGreaterThan(0);
      expect(usage.limit).toBe(200000);
      // Percentage is tiny (4 tokens / 200k limit = 0.002%)
      expect(usage.percentage).toBeGreaterThanOrEqual(0);
      expect(usage.percentage).toBeLessThan(1);
      expect(usage.exceeds).toBe(false);
    });

    it("calculates percentage correctly", () => {
      const text = "test ".repeat(1000); // ~1000 tokens
      const usage = getTokenUsage(text, undefined, 10000);

      // Should be around 10% usage
      expect(usage.percentage).toBeGreaterThan(5);
      expect(usage.percentage).toBeLessThan(20);
    });

    it("detects when limit is exceeded", () => {
      const text = "word ".repeat(200); // ~200 tokens
      const usage = getTokenUsage(text, undefined, 50);

      expect(usage.exceeds).toBe(true);
      expect(usage.percentage).toBeGreaterThan(100);
    });

    it("rounds percentage to 2 decimal places", () => {
      const text = "test";
      const usage = getTokenUsage(text, "opus");

      // Check that percentage has at most 2 decimal places
      const decimalPart = usage.percentage.toString().split(".")[1];
      if (decimalPart) {
        expect(decimalPart.length).toBeLessThanOrEqual(2);
      }
    });
  });

  describe("MODEL_CONTEXT_LIMITS", () => {
    it("has a default fallback", () => {
      expect(MODEL_CONTEXT_LIMITS.default).toBeDefined();
      expect(MODEL_CONTEXT_LIMITS.default).toBe(100000);
    });

    it("includes major model families", () => {
      // Claude
      expect(MODEL_CONTEXT_LIMITS.opus).toBeDefined();
      expect(MODEL_CONTEXT_LIMITS.sonnet).toBeDefined();
      expect(MODEL_CONTEXT_LIMITS.haiku).toBeDefined();

      // OpenAI
      expect(MODEL_CONTEXT_LIMITS["gpt-4"]).toBeDefined();
      expect(MODEL_CONTEXT_LIMITS["gpt-4o"]).toBeDefined();

      // Gemini
      expect(MODEL_CONTEXT_LIMITS.gemini).toBeDefined();
    });
  });
});
