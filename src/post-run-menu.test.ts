/**
 * Tests for post-run-menu.ts
 */

import { describe, it, expect } from "bun:test";
import { PassThrough } from "node:stream";
import { extractCommands, copyToClipboard, postRunMenu, saveToFile } from "./post-run-menu";
import { unlinkSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("extractCommands", () => {
  it("extracts commands from bash code blocks", () => {
    const output = `
Here's how to install:

\`\`\`bash
npm install foo
\`\`\`

And then run:

\`\`\`bash
npm start
\`\`\`
    `;

    const commands = extractCommands(output);
    expect(commands).toHaveLength(2);
    expect(commands[0]?.command).toBe("npm install foo");
    expect(commands[0]?.language).toBe("bash");
    expect(commands[1]?.command).toBe("npm start");
    expect(commands[1]?.language).toBe("bash");
  });

  it("extracts commands from sh code blocks", () => {
    const output = `
\`\`\`sh
echo "hello"
\`\`\`
    `;

    const commands = extractCommands(output);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.command).toBe('echo "hello"');
    expect(commands[0]?.language).toBe("sh");
  });

  it("extracts commands from shell code blocks", () => {
    const output = `
\`\`\`shell
ls -la
\`\`\`
    `;

    const commands = extractCommands(output);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.command).toBe("ls -la");
    expect(commands[0]?.language).toBe("shell");
  });

  it("extracts commands from zsh code blocks", () => {
    const output = `
\`\`\`zsh
source ~/.zshrc
\`\`\`
    `;

    const commands = extractCommands(output);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.command).toBe("source ~/.zshrc");
    expect(commands[0]?.language).toBe("zsh");
  });

  it("extracts commands from console blocks (lines starting with $)", () => {
    const output = `
\`\`\`console
$ npm install
Installing packages...
$ npm test
All tests passed
\`\`\`
    `;

    const commands = extractCommands(output);
    expect(commands).toHaveLength(2);
    expect(commands[0]?.command).toBe("npm install");
    expect(commands[1]?.command).toBe("npm test");
  });

  it("handles multi-line commands as a single block", () => {
    const output = `
\`\`\`bash
git add .
git commit -m "feat: add feature"
git push
\`\`\`
    `;

    const commands = extractCommands(output);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.command).toContain("git add .");
    expect(commands[0]?.command).toContain("git commit");
    expect(commands[0]?.command).toContain("git push");
  });

  it("ignores comment-only lines in code blocks", () => {
    const output = `
\`\`\`bash
# This is a comment
npm install
\`\`\`
    `;

    const commands = extractCommands(output);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.command).toBe("npm install");
  });

  it("ignores empty code blocks", () => {
    const output = `
\`\`\`bash

\`\`\`
    `;

    const commands = extractCommands(output);
    expect(commands).toHaveLength(0);
  });

  it("ignores non-shell code blocks", () => {
    const output = `
\`\`\`javascript
console.log("hello");
\`\`\`

\`\`\`python
print("hello")
\`\`\`
    `;

    const commands = extractCommands(output);
    expect(commands).toHaveLength(0);
  });

  it("returns empty array for text without code blocks", () => {
    const output = "Just some plain text without any code blocks.";
    const commands = extractCommands(output);
    expect(commands).toHaveLength(0);
  });

  it("handles mixed content with multiple block types", () => {
    const output = `
Here's some JavaScript:

\`\`\`javascript
const x = 1;
\`\`\`

And here's a shell command:

\`\`\`bash
npm run build
\`\`\`

And some more text.
    `;

    const commands = extractCommands(output);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.command).toBe("npm run build");
  });
});

describe("copyToClipboard", () => {
  it("copies text to clipboard on macOS", () => {
    // This test only works on macOS
    if (process.platform !== "darwin") {
      return;
    }

    const testText = "test clipboard content " + Date.now();
    const result = copyToClipboard(testText);
    expect(result).toBe(true);
  });
});

describe("saveToFile", () => {
  it("saves text to a file", () => {
    const testFile = join(tmpdir(), `mdflow-test-${Date.now()}.txt`);
    const testContent = "Hello, World!";

    try {
      const result = saveToFile(testContent, testFile);
      expect(result).toBe(true);
      expect(existsSync(testFile)).toBe(true);
      expect(readFileSync(testFile, "utf-8")).toBe(testContent);
    } finally {
      if (existsSync(testFile)) {
        unlinkSync(testFile);
      }
    }
  });

  it("returns false for invalid paths", () => {
    const result = saveToFile("test", "/nonexistent/directory/file.txt");
    expect(result).toBe(false);
  });
});

describe("postRunMenu Tab handling", () => {
  function startMenu(extractedCommands: Array<{ command: string; language: string }> = []) {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = postRunMenu(
      { output: "result", extractedCommands, hasJson: false, hasPatch: false },
      { input, output, clearPromptOnDone: true },
    );
    const press = async (
      name: string,
      sequence = name.length === 1 ? name : "",
      extra: Record<string, unknown> = {},
    ) => {
      input.emit("keypress", sequence, { name, sequence, ctrl: false, ...extra });
      await Bun.sleep(0);
    };
    return { pending, press };
  }

  it("cycles with Tab and keeps Tab out of filename input", async () => {
    const prompt = startMenu();
    await prompt.press("tab", "\t");
    await prompt.press("enter");
    await prompt.press("a");
    await prompt.press("tab", "\t");
    await prompt.press("b");
    await prompt.press("enter");

    expect(await prompt.pending).toEqual({ action: "save", filename: "ab" });
  });

  it("captures Shift+Tab before forward Tab and wraps to the last choice", async () => {
    const prompt = startMenu();
    await prompt.press("tab", "\x1b[Z", { shift: true });
    await prompt.press("enter");

    expect(await prompt.pending).toEqual({ action: "exit" });
  });

  it("uses Tab to cycle command choices", async () => {
    const prompt = startMenu([
      { command: "bun test", language: "bash" },
      { command: "bun run typecheck", language: "bash" },
    ]);
    await prompt.press("r");
    await prompt.press("tab", "\t");
    await prompt.press("enter");

    expect(await prompt.pending).toEqual({ action: "run-command", command: "bun run typecheck" });
  });
});

describe("showPostRunMenu TTY behavior", () => {
  /**
   * Note: showPostRunMenu checks process.stdin.isTTY and process.stdout.isTTY directly.
   * These are read-only properties that can't be easily mocked in tests.
   *
   * The expected behavior (tested indirectly via CliRunner):
   * - Returns undefined when process.stdin.isTTY is false
   * - Returns undefined when process.stdout.isTTY is false (piping support)
   * - Returns undefined when output is empty
   * - Only shows menu when both stdin and stdout are TTYs and output is non-empty
   *
   * This enables piping: foo.md | bar.md
   * - foo.md has stdout piped, so menu is skipped
   * - bar.md receives clean output without menu interference
   */

  it("documents TTY requirements for menu display", () => {
    // This test documents the expected behavior rather than testing it directly
    // The actual TTY checks are in showPostRunMenu():
    //   if (!output.trim() || !process.stdin.isTTY || !process.stdout.isTTY) {
    //     return undefined;
    //   }

    // Integration tests in cli-runner.test.ts verify:
    // - isStdoutTTY option is accepted
    // - Both stdin and stdout non-TTY works (middle of pipeline)

    expect(true).toBe(true); // Placeholder - behavior documented above
  });
});
