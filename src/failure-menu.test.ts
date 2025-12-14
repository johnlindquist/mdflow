/**
 * Tests for failure-menu.ts
 */

import { describe, it, expect } from "bun:test";
import { buildFixPrompt } from "./failure-menu";

describe("buildFixPrompt", () => {
  it("includes exit code in the fix prompt", () => {
    const result = buildFixPrompt(
      "original prompt",
      "error message",
      "some output",
      42
    );

    expect(result).toContain("Exit code: 42");
  });

  it("includes stderr when provided", () => {
    const result = buildFixPrompt(
      "original prompt",
      "Permission denied: cannot write to /etc/hosts",
      "",
      1
    );

    expect(result).toContain("--- STDERR ---");
    expect(result).toContain("Permission denied: cannot write to /etc/hosts");
    expect(result).toContain("--- END STDERR ---");
  });

  it("includes stdout when provided", () => {
    const result = buildFixPrompt(
      "original prompt",
      "",
      "Build started...\nCompiling...",
      1
    );

    expect(result).toContain("--- STDOUT (partial) ---");
    expect(result).toContain("Build started...");
    expect(result).toContain("Compiling...");
    expect(result).toContain("--- END STDOUT ---");
  });

  it("includes the original prompt at the end", () => {
    const originalPrompt = "Write a function to calculate fibonacci numbers";
    const result = buildFixPrompt(
      originalPrompt,
      "syntax error",
      "",
      1
    );

    expect(result).toContain("Original request:");
    expect(result).toContain(originalPrompt);
  });

  it("truncates long stdout to 2000 chars", () => {
    const longOutput = "x".repeat(3000);
    const result = buildFixPrompt(
      "original prompt",
      "",
      longOutput,
      1
    );

    // Should contain truncation indicator
    expect(result).toContain("(truncated)");
    // Should not contain the full 3000 chars
    expect(result.length).toBeLessThan(3000 + 500); // 500 for other content
  });

  it("handles empty stderr and stdout", () => {
    const result = buildFixPrompt(
      "original prompt",
      "",
      "",
      1
    );

    expect(result).not.toContain("--- STDERR ---");
    expect(result).not.toContain("--- STDOUT ---");
    expect(result).toContain("Exit code: 1");
    expect(result).toContain("original prompt");
  });

  it("includes fix instruction", () => {
    const result = buildFixPrompt(
      "original prompt",
      "error",
      "",
      1
    );

    expect(result).toContain("The previous command failed");
    expect(result).toContain("analyze the error");
    expect(result).toContain("fix");
  });

  it("handles both stderr and stdout together", () => {
    const result = buildFixPrompt(
      "run tests",
      "Test failed: assertion error",
      "Running test suite...\n10 tests found",
      1
    );

    expect(result).toContain("--- STDERR ---");
    expect(result).toContain("Test failed: assertion error");
    expect(result).toContain("--- STDOUT (partial) ---");
    expect(result).toContain("Running test suite...");
    expect(result).toContain("Original request:");
    expect(result).toContain("run tests");
  });

  it("preserves multiline stderr formatting", () => {
    const multilineStderr = `Error: Module not found
  at require (/app/index.js:10:5)
  at main (/app/index.js:20:3)`;

    const result = buildFixPrompt(
      "original prompt",
      multilineStderr,
      "",
      1
    );

    expect(result).toContain("Error: Module not found");
    expect(result).toContain("at require");
    expect(result).toContain("at main");
  });
});
