import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import {
  MAX_INPUT_SIZE,
  MAX_INPUT_SIZE_HUMAN,
  StdinSizeLimitError,
  FileSizeLimitError,
  formatBytes,
  exceedsLimit,
} from "./limits";
import { expandImports } from "./imports";

describe("limits", () => {
  describe("constants", () => {
    it("MAX_INPUT_SIZE is 10MB", () => {
      expect(MAX_INPUT_SIZE).toBe(10 * 1024 * 1024);
    });

    it("MAX_INPUT_SIZE_HUMAN is readable", () => {
      expect(MAX_INPUT_SIZE_HUMAN).toBe("10MB");
    });
  });

  describe("formatBytes", () => {
    it("formats bytes", () => {
      expect(formatBytes(500)).toBe("500 bytes");
    });

    it("formats kilobytes", () => {
      expect(formatBytes(2048)).toBe("2.0KB");
    });

    it("formats megabytes", () => {
      expect(formatBytes(5 * 1024 * 1024)).toBe("5.0MB");
    });

    it("formats decimal megabytes", () => {
      expect(formatBytes(10.5 * 1024 * 1024)).toBe("10.5MB");
    });
  });

  describe("exceedsLimit", () => {
    it("returns false for small sizes", () => {
      expect(exceedsLimit(1000)).toBe(false);
    });

    it("returns false at exactly the limit", () => {
      expect(exceedsLimit(MAX_INPUT_SIZE)).toBe(false);
    });

    it("returns true above the limit", () => {
      expect(exceedsLimit(MAX_INPUT_SIZE + 1)).toBe(true);
    });
  });

  describe("StdinSizeLimitError", () => {
    it("has descriptive error message", () => {
      const error = new StdinSizeLimitError(15 * 1024 * 1024);
      expect(error.name).toBe("StdinSizeLimitError");
      expect(error.message).toContain("Input exceeds 10MB limit");
      expect(error.message).toContain("15.0MB");
      expect(error.message).toContain("Use a file path argument instead of piping");
    });
  });

  describe("FileSizeLimitError", () => {
    it("has descriptive error message with file path", () => {
      const error = new FileSizeLimitError("/path/to/large.log", 20 * 1024 * 1024);
      expect(error.name).toBe("FileSizeLimitError");
      expect(error.message).toContain("/path/to/large.log");
      expect(error.message).toContain("exceeds 10MB limit");
      expect(error.message).toContain("20.0MB");
      expect(error.message).toContain("line ranges");
      expect(error.message).toContain("symbol extraction");
    });
  });
});

describe("file import size limits", () => {
  const testDir = join(tmpdir(), `ma-limits-test-${Date.now()}`);
  const smallFilePath = join(testDir, "small.txt");
  const largeFilePath = join(testDir, "large.txt");

  beforeAll(async () => {
    // Create test directory
    await Bun.write(join(testDir, ".gitkeep"), "");

    // Create a small file (100 bytes)
    await Bun.write(smallFilePath, "x".repeat(100));

    // Create a file just over the limit (10MB + 1KB)
    const largeContent = "x".repeat(MAX_INPUT_SIZE + 1024);
    await Bun.write(largeFilePath, largeContent);
  });

  afterAll(async () => {
    // Clean up test files
    const fs = await import("fs/promises");
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("allows importing small files", async () => {
    const content = `@${smallFilePath}`;
    const result = await expandImports(content, testDir);
    expect(result).toBe("x".repeat(100));
  });

  it("throws FileSizeLimitError for files exceeding limit", async () => {
    const content = `@${largeFilePath}`;

    try {
      await expandImports(content, testDir);
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error).toBeInstanceOf(FileSizeLimitError);
      expect((error as FileSizeLimitError).message).toContain(largeFilePath);
      expect((error as FileSizeLimitError).message).toContain("exceeds 10MB limit");
    }
  });

  it("provides helpful suggestions in error message", async () => {
    const content = `@${largeFilePath}`;

    try {
      await expandImports(content, testDir);
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      const message = (error as Error).message;
      // Error should suggest alternatives
      expect(message).toContain("line ranges");
      expect(message).toContain("symbol extraction");
    }
  });
});
