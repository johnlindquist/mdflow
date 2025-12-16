/**
 * Tests for context-dashboard.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  analyzeContext,
  renderDashboard,
  formatSize,
  formatTokens,
  shouldShowDashboard,
  type ContextAnalysis,
} from "./context-dashboard";

describe("formatSize", () => {
  it("formats bytes", () => {
    expect(formatSize(500)).toBe("500b");
    expect(formatSize(0)).toBe("0b");
  });

  it("formats kilobytes", () => {
    expect(formatSize(1024)).toBe("1.0kb");
    expect(formatSize(2048)).toBe("2.0kb");
    expect(formatSize(5500)).toBe("5.4kb");
  });

  it("formats megabytes", () => {
    expect(formatSize(1024 * 1024)).toBe("1.0mb");
    expect(formatSize(2.5 * 1024 * 1024)).toBe("2.5mb");
  });
});

describe("formatTokens", () => {
  it("formats small token counts", () => {
    expect(formatTokens(500)).toBe("500");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats large token counts with k suffix", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(12500)).toBe("12.5k");
    expect(formatTokens(100000)).toBe("100.0k");
  });
});

describe("shouldShowDashboard", () => {
  it("returns false for content without imports", () => {
    expect(shouldShowDashboard("Hello world")).toBe(false);
    expect(shouldShowDashboard("# Title\n\nSome content")).toBe(false);
  });

  it("returns true for content with file imports", () => {
    expect(shouldShowDashboard("@./file.ts")).toBe(true);
    expect(shouldShowDashboard("Load this: @./config.json")).toBe(true);
  });

  it("returns true for content with glob imports", () => {
    expect(shouldShowDashboard("@./src/**/*.ts")).toBe(true);
  });

  it("returns true for content with URL imports", () => {
    expect(shouldShowDashboard("@https://example.com/file.md")).toBe(true);
  });

  it("returns true for content with command imports", () => {
    expect(shouldShowDashboard("!`ls -la`")).toBe(true);
  });

  it("ignores imports inside code blocks", () => {
    const content = "```\n@./file.ts\n```";
    expect(shouldShowDashboard(content)).toBe(false);
  });
});

describe("analyzeContext", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "context-dashboard-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("analyzes a simple prompt file", async () => {
    const promptPath = join(tempDir, "task.claude.md");
    const content = "Hello, please help me with this task.";
    await Bun.write(promptPath, content);

    const analysis = await analyzeContext(promptPath, content, tempDir);

    expect(analysis.promptFile).toBe(promptPath);
    expect(analysis.totalFiles).toBe(1);
    expect(analysis.items.length).toBe(1);
    expect(analysis.items[0]!.type).toBe("prompt");
    expect(analysis.items[0]!.name).toBe("task.claude.md");
  });

  it("analyzes file imports", async () => {
    const configPath = join(tempDir, "config.ts");
    await Bun.write(configPath, "export const config = { key: 'value' };");

    const promptPath = join(tempDir, "task.claude.md");
    const content = "Review this config:\n@./config.ts";
    await Bun.write(promptPath, content);

    const analysis = await analyzeContext(promptPath, content, tempDir);

    expect(analysis.totalFiles).toBe(2);
    expect(analysis.items.length).toBe(2);
    expect(analysis.items[1]!.type).toBe("file");
    expect(analysis.items[1]!.name).toBe("@./config.ts");
    expect(analysis.items[1]!.size).toBeGreaterThan(0);
  });

  it("analyzes glob imports", async () => {
    // Create some files
    await Bun.write(join(tempDir, "a.ts"), "const a = 1;");
    await Bun.write(join(tempDir, "b.ts"), "const b = 2;");
    await Bun.write(join(tempDir, "c.ts"), "const c = 3;");

    const promptPath = join(tempDir, "task.claude.md");
    const content = "Review these files:\n@./*.ts";
    await Bun.write(promptPath, content);

    const analysis = await analyzeContext(promptPath, content, tempDir);

    // Find the glob item
    const globItem = analysis.items.find(i => i.type === "glob");
    expect(globItem).toBeDefined();
    expect(globItem!.fileCount).toBe(3);
    expect(globItem!.size).toBeGreaterThan(0);
  });

  it("analyzes URL imports", async () => {
    const promptPath = join(tempDir, "task.claude.md");
    const content = "Check this URL:\n@https://example.com/docs.md";
    await Bun.write(promptPath, content);

    const analysis = await analyzeContext(promptPath, content, tempDir);

    const urlItem = analysis.items.find(i => i.type === "url");
    expect(urlItem).toBeDefined();
    expect(urlItem!.name).toBe("@https://example.com/docs.md");
    expect(urlItem!.size).toBe(0); // Unknown until fetched
  });

  it("analyzes command imports", async () => {
    const promptPath = join(tempDir, "task.claude.md");
    const content = "Current directory:\n!`pwd`";
    await Bun.write(promptPath, content);

    const analysis = await analyzeContext(promptPath, content, tempDir);

    const cmdItem = analysis.items.find(i => i.type === "command");
    expect(cmdItem).toBeDefined();
    expect(cmdItem!.name).toContain("pwd");
    expect(cmdItem!.size).toBe(0); // Unknown until executed
  });

  it("analyzes symbol imports", async () => {
    const typesPath = join(tempDir, "types.ts");
    await Bun.write(typesPath, `
export interface User {
  id: string;
  name: string;
}

export interface Post {
  title: string;
  content: string;
}
`);

    const promptPath = join(tempDir, "task.claude.md");
    const content = "Review this interface:\n@./types.ts#User";
    await Bun.write(promptPath, content);

    const analysis = await analyzeContext(promptPath, content, tempDir);

    const symbolItem = analysis.items.find(i => i.type === "symbol");
    expect(symbolItem).toBeDefined();
    expect(symbolItem!.name).toBe("@./types.ts#User");
  });

  it("calculates total size and token estimate", async () => {
    const file1 = join(tempDir, "file1.ts");
    const file2 = join(tempDir, "file2.ts");
    await Bun.write(file1, "a".repeat(1000));
    await Bun.write(file2, "b".repeat(2000));

    const promptPath = join(tempDir, "task.claude.md");
    const content = "@./file1.ts\n@./file2.ts";
    await Bun.write(promptPath, content);

    const analysis = await analyzeContext(promptPath, content, tempDir);

    expect(analysis.totalSize).toBeGreaterThan(3000);
    expect(analysis.estimatedTokens).toBeGreaterThan(0);
  });
});

describe("renderDashboard", () => {
  it("renders a basic dashboard", () => {
    const analysis: ContextAnalysis = {
      promptFile: "/path/to/task.claude.md",
      items: [
        { name: "task.claude.md", type: "prompt", size: 500 },
        { name: "@./config.ts", type: "file", size: 2000 },
      ],
      totalSize: 2500,
      totalFiles: 2,
      estimatedTokens: 625,
    };

    const output = renderDashboard(analysis, { color: false });

    expect(output).toContain("Context: 2 files");
    expect(output).toContain("2.4kb");
    expect(output).toContain("task.claude.md");
    expect(output).toContain("@./config.ts");
    expect(output).toContain("~625 tokens");
  });

  it("renders glob items with file count", () => {
    const analysis: ContextAnalysis = {
      promptFile: "/path/to/task.claude.md",
      items: [
        { name: "task.claude.md", type: "prompt", size: 100 },
        { name: "@./src/**/*.ts", type: "glob", size: 10000, fileCount: 5 },
      ],
      totalSize: 10100,
      totalFiles: 6,
      estimatedTokens: 2525,
    };

    const output = renderDashboard(analysis, { color: false });

    expect(output).toContain("6 files");
    expect(output).toContain("5 files"); // file count for glob
    expect(output).toContain("[glob]");
  });

  it("renders with color codes when enabled", () => {
    const analysis: ContextAnalysis = {
      promptFile: "/path/to/task.claude.md",
      items: [
        { name: "task.claude.md", type: "prompt", size: 100 },
      ],
      totalSize: 100,
      totalFiles: 1,
      estimatedTokens: 25,
    };

    const colorOutput = renderDashboard(analysis, { color: true });
    const noColorOutput = renderDashboard(analysis, { color: false });

    // Color output should contain ANSI color codes (not just escape sequences from emoji)
    // The bold/green/reset codes have specific patterns
    expect(colorOutput).toContain("\x1B[1m"); // bold
    expect(colorOutput).toContain("\x1B[0m"); // reset
    // No-color output should not contain ANSI color codes
    expect(noColorOutput).not.toContain("\x1B[1m"); // no bold
    expect(noColorOutput).not.toContain("\x1B[32m"); // no green
  });

  it("uses box drawing characters", () => {
    const analysis: ContextAnalysis = {
      promptFile: "/path/to/task.claude.md",
      items: [
        { name: "task.claude.md", type: "prompt", size: 100 },
        { name: "@./file.ts", type: "file", size: 200 },
      ],
      totalSize: 300,
      totalFiles: 2,
      estimatedTokens: 75,
    };

    const output = renderDashboard(analysis, { color: false });

    // Should contain box drawing characters
    expect(output).toContain("\u251C"); // branch
    expect(output).toContain("\u2514"); // corner
    expect(output).toContain("\u2500"); // horizontal
  });

  it("renders compact mode without type indicators", () => {
    const analysis: ContextAnalysis = {
      promptFile: "/path/to/task.claude.md",
      items: [
        { name: "task.claude.md", type: "prompt", size: 100 },
        { name: "@./file.ts", type: "file", size: 200 },
      ],
      totalSize: 300,
      totalFiles: 2,
      estimatedTokens: 75,
    };

    const compactOutput = renderDashboard(analysis, { color: false, compact: true });
    const normalOutput = renderDashboard(analysis, { color: false, compact: false });

    // Compact should not have type indicator
    expect(compactOutput).not.toContain("(Prompt)");
    expect(normalOutput).toContain("(Prompt)");
  });

  it("shows warning colors for high token counts", () => {
    const highTokenAnalysis: ContextAnalysis = {
      promptFile: "/path/to/task.claude.md",
      items: [{ name: "task.claude.md", type: "prompt", size: 400000 }],
      totalSize: 400000,
      totalFiles: 1,
      estimatedTokens: 110000, // Over 100k - red
    };

    const output = renderDashboard(highTokenAnalysis, { color: true });
    // Should contain red color code for high token count
    expect(output).toContain("\x1B[31m"); // red
  });
});
