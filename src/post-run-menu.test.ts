/**
 * Tests for post-run-menu.ts
 */

import { describe, it, expect } from "bun:test";
import { extractCommands, copyToClipboard, saveToFile } from "./post-run-menu";
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
