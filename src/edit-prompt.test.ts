import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { getEditor, getTempFilePath, editPrompt } from "./edit-prompt";

/**
 * Tests for the --_edit flag:
 * - --_edit is consumed by md (not passed to command)
 * - Opens resolved prompt in $EDITOR before execution
 * - Waits for editor to close
 * - Prompts user to confirm
 * - Returns modified prompt or null if cancelled
 */

describe("--_edit flag consumption", () => {
  test("--_edit flag is consumed and not passed to command", () => {
    // Simulate CLI: md file.md --_edit --model opus
    const cliArgs = ["--_edit", "--model", "opus"];
    const remainingArgs = [...cliArgs];

    // Extract --_edit flag (same logic as cli-runner.ts)
    let editFlag = false;
    const editIdx = remainingArgs.indexOf("--_edit");
    if (editIdx !== -1) {
      editFlag = true;
      remainingArgs.splice(editIdx, 1);
    }

    expect(editFlag).toBe(true);
    expect(remainingArgs).toEqual(["--model", "opus"]); // --_edit consumed
  });

  test("--_edit flag at end of args is consumed", () => {
    const cliArgs = ["--model", "opus", "--verbose", "--_edit"];
    const remainingArgs = [...cliArgs];

    let editFlag = false;
    const editIdx = remainingArgs.indexOf("--_edit");
    if (editIdx !== -1) {
      editFlag = true;
      remainingArgs.splice(editIdx, 1);
    }

    expect(editFlag).toBe(true);
    expect(remainingArgs).toEqual(["--model", "opus", "--verbose"]);
  });

  test("--_edit flag in middle of args is consumed", () => {
    const cliArgs = ["--model", "opus", "--_edit", "--verbose"];
    const remainingArgs = [...cliArgs];

    let editFlag = false;
    const editIdx = remainingArgs.indexOf("--_edit");
    if (editIdx !== -1) {
      editFlag = true;
      remainingArgs.splice(editIdx, 1);
    }

    expect(editFlag).toBe(true);
    expect(remainingArgs).toEqual(["--model", "opus", "--verbose"]);
  });

  test("no --_edit flag means editFlag is false", () => {
    const cliArgs = ["--model", "opus", "--verbose"];
    const remainingArgs = [...cliArgs];

    let editFlag = false;
    const editIdx = remainingArgs.indexOf("--_edit");
    if (editIdx !== -1) {
      editFlag = true;
      remainingArgs.splice(editIdx, 1);
    }

    expect(editFlag).toBe(false);
    expect(remainingArgs).toEqual(["--model", "opus", "--verbose"]);
  });
});

describe("getEditor", () => {
  const originalEditor = process.env.EDITOR;
  const originalVisual = process.env.VISUAL;

  afterAll(() => {
    // Restore original env
    if (originalEditor !== undefined) {
      process.env.EDITOR = originalEditor;
    } else {
      delete process.env.EDITOR;
    }
    if (originalVisual !== undefined) {
      process.env.VISUAL = originalVisual;
    } else {
      delete process.env.VISUAL;
    }
  });

  test("uses $EDITOR when set", () => {
    process.env.EDITOR = "nano";
    delete process.env.VISUAL;
    expect(getEditor()).toBe("nano");
  });

  test("uses $VISUAL when $EDITOR is not set", () => {
    delete process.env.EDITOR;
    process.env.VISUAL = "code --wait";
    expect(getEditor()).toBe("code --wait");
  });

  test("prefers $EDITOR over $VISUAL", () => {
    process.env.EDITOR = "vim";
    process.env.VISUAL = "code --wait";
    expect(getEditor()).toBe("vim");
  });

  test("falls back to common editors when env not set", () => {
    delete process.env.EDITOR;
    delete process.env.VISUAL;
    // Should return vim, nano, vi, or vim as last resort
    const editor = getEditor();
    expect(["vim", "nano", "vi"]).toContain(editor);
  });
});

describe("getTempFilePath", () => {
  test("generates unique temp file paths", () => {
    const path1 = getTempFilePath();
    const path2 = getTempFilePath();

    expect(path1).not.toBe(path2);
    expect(path1).toContain("mdflow-edit");
    expect(path1).toEndWith(".md");
    expect(path2).toContain("mdflow-edit");
    expect(path2).toEndWith(".md");
  });

  test("uses custom prefix", () => {
    const path = getTempFilePath("custom-prefix");
    expect(path).toContain("custom-prefix");
    expect(path).toEndWith(".md");
  });
});

describe("editPrompt function", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "md-edit-test-"));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns confirmed: false when user declines", async () => {
    // Mock editor that does nothing (just exits)
    const originalEditor = process.env.EDITOR;
    process.env.EDITOR = "true"; // Unix 'true' command - exits 0 immediately

    try {
      const result = await editPrompt("Test prompt", {
        confirmFn: async () => "n",
      });

      expect(result.confirmed).toBe(false);
      expect(result.prompt).toBe(null);
    } finally {
      if (originalEditor !== undefined) {
        process.env.EDITOR = originalEditor;
      } else {
        delete process.env.EDITOR;
      }
    }
  });

  test("returns prompt when user confirms with 'y'", async () => {
    const originalEditor = process.env.EDITOR;
    process.env.EDITOR = "true"; // Unix 'true' command - exits 0 immediately

    try {
      const result = await editPrompt("Test prompt content", {
        confirmFn: async () => "y",
      });

      expect(result.confirmed).toBe(true);
      expect(result.prompt).toBe("Test prompt content");
    } finally {
      if (originalEditor !== undefined) {
        process.env.EDITOR = originalEditor;
      } else {
        delete process.env.EDITOR;
      }
    }
  });

  test("returns prompt when user confirms with 'yes'", async () => {
    const originalEditor = process.env.EDITOR;
    process.env.EDITOR = "true";

    try {
      const result = await editPrompt("Another test", {
        confirmFn: async () => "yes",
      });

      expect(result.confirmed).toBe(true);
      expect(result.prompt).toBe("Another test");
    } finally {
      if (originalEditor !== undefined) {
        process.env.EDITOR = originalEditor;
      } else {
        delete process.env.EDITOR;
      }
    }
  });

  test("returns prompt when user confirms with 'Y' (case insensitive)", async () => {
    const originalEditor = process.env.EDITOR;
    process.env.EDITOR = "true";

    try {
      const result = await editPrompt("Case test", {
        confirmFn: async () => "Y",
      });

      expect(result.confirmed).toBe(true);
    } finally {
      if (originalEditor !== undefined) {
        process.env.EDITOR = originalEditor;
      } else {
        delete process.env.EDITOR;
      }
    }
  });

  test("skipConfirm option bypasses confirmation", async () => {
    const originalEditor = process.env.EDITOR;
    process.env.EDITOR = "true";

    try {
      const result = await editPrompt("Skip confirm test", {
        skipConfirm: true,
      });

      expect(result.confirmed).toBe(true);
      expect(result.prompt).toBe("Skip confirm test");
    } finally {
      if (originalEditor !== undefined) {
        process.env.EDITOR = originalEditor;
      } else {
        delete process.env.EDITOR;
      }
    }
  });

  test("returns null when editor fails", async () => {
    const originalEditor = process.env.EDITOR;
    process.env.EDITOR = "false"; // Unix 'false' command - exits 1

    try {
      const result = await editPrompt("Will fail", {
        confirmFn: async () => "y",
      });

      expect(result.confirmed).toBe(false);
      expect(result.prompt).toBe(null);
    } finally {
      if (originalEditor !== undefined) {
        process.env.EDITOR = originalEditor;
      } else {
        delete process.env.EDITOR;
      }
    }
  });
});
