import { test, expect, beforeAll, afterAll, describe, afterEach } from "bun:test";
import { expandImports, MAX_TOKENS, WARN_TOKENS, CHARS_PER_TOKEN } from "./imports";
import { join } from "node:path";
import { createTempDir, createStderrSpy, type ConsoleSpy } from "./test-utils";

let testDir: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const temp = await createTempDir("import-feedback-test-");
  testDir = temp.tempDir;
  cleanup = temp.cleanup;
});

afterAll(async () => {
  await cleanup();
});

describe("import feedback logging", () => {
  let stderrSpy: ConsoleSpy;

  beforeAll(() => {
    stderrSpy = createStderrSpy();
  });

  afterEach(() => {
    stderrSpy.clear();
  });

  afterAll(() => {
    stderrSpy.restore();
  });

  test("logs file imports to stderr", async () => {
    await Bun.write(join(testDir, "feedback-test.md"), "Hello world");
    await expandImports("@./feedback-test.md", testDir);

    expect(stderrSpy.hasMessage("[imports] Loading:")).toBe(true);
    expect(stderrSpy.hasMessage("feedback-test.md")).toBe(true);
  });

  test("logs command execution to stderr", async () => {
    await expandImports("!`echo test`", testDir);

    expect(stderrSpy.hasMessage("[imports] Executing:")).toBe(true);
    expect(stderrSpy.hasMessage("echo test")).toBe(true);
  });

  test("logs glob expansion to stderr with file count and tokens", async () => {
    await Bun.write(join(testDir, "glob-feedback/a.ts"), "const a = 1;");
    await Bun.write(join(testDir, "glob-feedback/b.ts"), "const b = 2;");

    await expandImports("@./glob-feedback/*.ts", testDir);

    expect(stderrSpy.hasMessage("[imports] Expanding")).toBe(true);
    expect(stderrSpy.hasMessage("2 files")).toBe(true);
    expect(stderrSpy.hasMessage("tokens")).toBe(true);
  });
});

describe("token thresholds", () => {
  let stderrSpy: ConsoleSpy;

  beforeAll(() => {
    stderrSpy = createStderrSpy();
  });

  afterEach(() => {
    stderrSpy.clear();
  });

  afterAll(() => {
    stderrSpy.restore();
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
    const warnDir = join(testDir, "warn-threshold");
    const fileContent = "word ".repeat(15_000);
    for (let i = 0; i < 5; i++) {
      await Bun.write(join(warnDir, `file${i}.txt`), fileContent);
    }

    await expandImports("@./warn-threshold/*.txt", testDir);

    expect(stderrSpy.hasMessage("Warning: High token count")).toBe(true);
    expect(stderrSpy.hasMessage("This may be expensive")).toBe(true);
  });

  test("does not warn when token count is below 50% of limit", async () => {
    const smallDir = join(testDir, "small-threshold");
    const fileContent = "word ".repeat(5_000);
    for (let i = 0; i < 4; i++) {
      await Bun.write(join(smallDir, `file${i}.txt`), fileContent);
    }

    await expandImports("@./small-threshold/*.txt", testDir);

    expect(stderrSpy.hasMessage("Warning: High token count")).toBe(false);
  });

  test("errors when token count exceeds context limit (without MA_FORCE_CONTEXT)", async () => {
    const originalEnv = process.env.MA_FORCE_CONTEXT;
    delete process.env.MA_FORCE_CONTEXT;

    try {
      const largeDir = join(testDir, "large-threshold");
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
      const fileContent = "word ".repeat(60_000);
      for (let i = 0; i < 5; i++) {
        await Bun.write(join(forceDir, `file${i}.txt`), fileContent);
      }

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
  let stderrSpy: ConsoleSpy;

  beforeAll(() => {
    stderrSpy = createStderrSpy();
  });

  afterEach(() => {
    stderrSpy.clear();
  });

  afterAll(() => {
    stderrSpy.restore();
  });

  test("all feedback messages use [imports] prefix", async () => {
    await Bun.write(join(testDir, "prefix-test.md"), "content");
    await expandImports("@./prefix-test.md", testDir);

    const importMessages = stderrSpy.getMessages().filter(
      (line) =>
        line.includes("Loading:") ||
        line.includes("Expanding") ||
        line.includes("Executing:") ||
        line.includes("Fetching:")
    );

    for (const msg of importMessages) {
      expect(msg).toContain("[imports]");
    }
  });

  test("token counts are formatted with locale separators", async () => {
    const tokenDir = join(testDir, "token-format");
    const fileContent = "x".repeat(50_000);
    for (let i = 0; i < 5; i++) {
      await Bun.write(join(tokenDir, `file${i}.txt`), fileContent);
    }

    await expandImports("@./token-format/*.txt", testDir);

    const hasFormattedNumber = stderrSpy.getMessages().some((line) => /\d{1,3}(,\d{3})+/.test(line));
    expect(hasFormattedNumber).toBe(true);
  });
});
