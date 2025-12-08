import { test, expect, beforeAll, afterAll, describe, spyOn, afterEach } from "bun:test";
import { expandImports, MAX_TOKENS, WARN_TOKENS, CHARS_PER_TOKEN } from "./imports";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let testDir: string;
let stderrSpy: ReturnType<typeof spyOn>;
let stderrOutput: string[];

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "import-feedback-test-"));
});

afterAll(async () => {
  await rm(testDir, { recursive: true });
});

describe("import feedback logging", () => {
  beforeAll(() => {
    stderrOutput = [];
    stderrSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    stderrOutput = [];
  });

  afterAll(() => {
    stderrSpy.mockRestore();
  });

  test("logs file imports to stderr", async () => {
    await Bun.write(join(testDir, "feedback-test.md"), "Hello world");

    await expandImports("@./feedback-test.md", testDir);

    expect(stderrOutput.some(line => line.includes("[imports] Loading:"))).toBe(true);
    expect(stderrOutput.some(line => line.includes("feedback-test.md"))).toBe(true);
  });

  test("logs command execution to stderr", async () => {
    await expandImports("!`echo test`", testDir);

    expect(stderrOutput.some(line => line.includes("[imports] Executing:"))).toBe(true);
    expect(stderrOutput.some(line => line.includes("echo test"))).toBe(true);
  });

  test("logs glob expansion to stderr with file count and tokens", async () => {
    // Create test files
    await Bun.write(join(testDir, "glob-feedback/a.ts"), "const a = 1;");
    await Bun.write(join(testDir, "glob-feedback/b.ts"), "const b = 2;");

    await expandImports("@./glob-feedback/*.ts", testDir);

    expect(stderrOutput.some(line => line.includes("[imports] Expanding"))).toBe(true);
    expect(stderrOutput.some(line => line.includes("2 files"))).toBe(true);
    expect(stderrOutput.some(line => line.includes("tokens"))).toBe(true);
  });
});

describe("token thresholds", () => {
  let stderrOutput: string[];
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeAll(() => {
    stderrOutput = [];
    stderrSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    stderrOutput = [];
  });

  afterAll(() => {
    stderrSpy.mockRestore();
  });

  test("WARN_TOKENS is 50000", () => {
    expect(WARN_TOKENS).toBe(50_000);
  });

  test("MAX_TOKENS is 100000", () => {
    expect(MAX_TOKENS).toBe(100_000);
  });

  test("CHARS_PER_TOKEN is 4", () => {
    expect(CHARS_PER_TOKEN).toBe(4);
  });

  test("warns when token count exceeds 50% of limit but not 100%", async () => {
    // Create a directory with files that exceed 50% of context limit (50k tokens)
    // but not 100% (100k tokens) - warning threshold is dynamic now
    // Using natural language text which tokenizes closer to 1 token per 4 chars
    const warnDir = join(testDir, "warn-threshold");

    // Create files with natural language content that tokenizes more predictably
    // "word " = 5 chars, roughly 1-2 tokens per word
    // 15k repetitions per file * 5 files = ~75k tokens (above 50k warning, below 100k limit)
    const fileContent = "word ".repeat(15_000);
    for (let i = 0; i < 5; i++) {
      await Bun.write(join(warnDir, `file${i}.txt`), fileContent);
    }

    await expandImports("@./warn-threshold/*.txt", testDir);

    expect(stderrOutput.some(line => line.includes("Warning: High token count"))).toBe(true);
    expect(stderrOutput.some(line => line.includes("This may be expensive"))).toBe(true);
  });

  test("does not warn when token count is below 50% of limit", async () => {
    const smallDir = join(testDir, "small-threshold");

    // Create small files with content that stays well below 50k token warning threshold
    // Using repeated "word " (5 chars, ~1-2 tokens per word)
    const fileContent = "word ".repeat(5_000); // ~5k tokens per file
    for (let i = 0; i < 4; i++) { // 4 files = ~20k tokens total (well under 50k warning)
      await Bun.write(join(smallDir, `file${i}.txt`), fileContent);
    }

    await expandImports("@./small-threshold/*.txt", testDir);

    expect(stderrOutput.some(line => line.includes("Warning: High token count"))).toBe(false);
  });

  test("errors when token count exceeds context limit (without MA_FORCE_CONTEXT)", async () => {
    // Ensure MA_FORCE_CONTEXT is not set
    const originalEnv = process.env.MA_FORCE_CONTEXT;
    delete process.env.MA_FORCE_CONTEXT;

    try {
      const largeDir = join(testDir, "large-threshold");

      // Create files that exceed the default 100k token limit
      // Using "word " (5 chars) which tokenizes to ~1-2 tokens
      // 60k words per file * 5 files = 300k words = ~150k+ tokens (exceeds 100k default)
      const fileContent = "word ".repeat(60_000);
      for (let i = 0; i < 5; i++) {
        await Bun.write(join(largeDir, `file${i}.txt`), fileContent);
      }

      await expect(expandImports("@./large-threshold/*.txt", testDir)).rejects.toThrow(
        /exceeds the \d[\d,]* token limit/
      );
    } finally {
      if (originalEnv !== undefined) {
        process.env.MA_FORCE_CONTEXT = originalEnv;
      }
    }
  });

  test("does not error when MA_FORCE_CONTEXT is set", async () => {
    const originalEnv = process.env.MA_FORCE_CONTEXT;
    process.env.MA_FORCE_CONTEXT = "1";

    try {
      const forceDir = join(testDir, "force-context");

      // Create files that would exceed the default 100k token limit
      // Using "word " which tokenizes predictably
      const fileContent = "word ".repeat(60_000);
      for (let i = 0; i < 5; i++) {
        await Bun.write(join(forceDir, `file${i}.txt`), fileContent);
      }

      // Should not throw when MA_FORCE_CONTEXT is set
      const result = await expandImports("@./force-context/*.txt", testDir);
      expect(result).toBeDefined();
    } finally {
      if (originalEnv !== undefined) {
        process.env.MA_FORCE_CONTEXT = originalEnv;
      } else {
        delete process.env.MA_FORCE_CONTEXT;
      }
    }
  });
});

describe("stderr output format", () => {
  let stderrOutput: string[];
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeAll(() => {
    stderrOutput = [];
    stderrSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    stderrOutput = [];
  });

  afterAll(() => {
    stderrSpy.mockRestore();
  });

  test("all feedback messages use [imports] prefix", async () => {
    await Bun.write(join(testDir, "prefix-test.md"), "content");
    await expandImports("@./prefix-test.md", testDir);

    // All logged messages should have [imports] prefix
    const importMessages = stderrOutput.filter(line => line.includes("Loading:") ||
                                                       line.includes("Expanding") ||
                                                       line.includes("Executing:") ||
                                                       line.includes("Fetching:"));

    for (const msg of importMessages) {
      expect(msg).toContain("[imports]");
    }
  });

  test("token counts are formatted with locale separators", async () => {
    const tokenDir = join(testDir, "token-format");

    // Create files totaling enough chars to show formatted numbers
    const fileContent = "x".repeat(50_000);
    for (let i = 0; i < 5; i++) {
      await Bun.write(join(tokenDir, `file${i}.txt`), fileContent);
    }

    await expandImports("@./token-format/*.txt", testDir);

    // Check for formatted token count (should have comma separator)
    expect(stderrOutput.some(line => /\d{1,3}(,\d{3})+/.test(line))).toBe(true);
  });
});
