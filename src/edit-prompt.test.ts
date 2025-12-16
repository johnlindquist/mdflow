import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { getEditor, getTempFilePath, editPrompt } from "./edit-prompt";
import {
  extractFlag,
  createFlagExtractionTests,
  createTempDir,
  saveEnv,
} from "./test-utils";

/**
 * Tests for the --_edit flag:
 * - --_edit is consumed by md (not passed to command)
 * - Opens resolved prompt in $EDITOR before execution
 * - Waits for editor to close
 * - Prompts user to confirm
 * - Returns modified prompt or null if cancelled
 */

describe("--_edit flag consumption", () => {
  const FLAG = "--_edit";
  const testCases = createFlagExtractionTests(FLAG);

  test("--_edit flag is consumed and not passed to command", () => {
    const args = [...testCases.atStart.input];
    const found = extractFlag(args, FLAG);
    expect(found).toBe(testCases.atStart.expected.flagFound);
    expect(args).toEqual(testCases.atStart.expected.remaining);
  });

  test("--_edit flag at end of args is consumed", () => {
    const args = [...testCases.atEnd.input];
    const found = extractFlag(args, FLAG);
    expect(found).toBe(testCases.atEnd.expected.flagFound);
    expect(args).toEqual(testCases.atEnd.expected.remaining);
  });

  test("--_edit flag in middle of args is consumed", () => {
    const args = [...testCases.inMiddle.input];
    const found = extractFlag(args, FLAG);
    expect(found).toBe(testCases.inMiddle.expected.flagFound);
    expect(args).toEqual(testCases.inMiddle.expected.remaining);
  });

  test("no --_edit flag means editFlag is false", () => {
    const args = [...testCases.notPresent.input];
    const found = extractFlag(args, FLAG);
    expect(found).toBe(testCases.notPresent.expected.flagFound);
    expect(args).toEqual(testCases.notPresent.expected.remaining);
  });
});

describe("getEditor", () => {
  let envSnapshot: ReturnType<typeof saveEnv>;

  beforeAll(() => {
    envSnapshot = saveEnv(["EDITOR", "VISUAL"]);
  });

  afterAll(() => {
    envSnapshot.restore();
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
  let cleanup: () => Promise<void>;
  let envSnapshot: ReturnType<typeof saveEnv>;

  beforeAll(async () => {
    const temp = await createTempDir("md-edit-test-");
    tempDir = temp.tempDir;
    cleanup = temp.cleanup;
    envSnapshot = saveEnv(["EDITOR"]);
  });

  afterAll(async () => {
    envSnapshot.restore();
    await cleanup();
  });

  test("returns confirmed: false when user declines", async () => {
    process.env.EDITOR = "true"; // Unix 'true' command - exits 0 immediately
    const result = await editPrompt("Test prompt", {
      confirmFn: async () => "n",
    });
    expect(result.confirmed).toBe(false);
    expect(result.prompt).toBe(null);
  });

  test("returns prompt when user confirms with 'y'", async () => {
    process.env.EDITOR = "true";
    const result = await editPrompt("Test prompt content", {
      confirmFn: async () => "y",
    });
    expect(result.confirmed).toBe(true);
    expect(result.prompt).toBe("Test prompt content");
  });

  test("returns prompt when user confirms with 'yes'", async () => {
    process.env.EDITOR = "true";
    const result = await editPrompt("Another test", {
      confirmFn: async () => "yes",
    });
    expect(result.confirmed).toBe(true);
    expect(result.prompt).toBe("Another test");
  });

  test("returns prompt when user confirms with 'Y' (case insensitive)", async () => {
    process.env.EDITOR = "true";
    const result = await editPrompt("Case test", {
      confirmFn: async () => "Y",
    });
    expect(result.confirmed).toBe(true);
  });

  test("skipConfirm option bypasses confirmation", async () => {
    process.env.EDITOR = "true";
    const result = await editPrompt("Skip confirm test", {
      skipConfirm: true,
    });
    expect(result.confirmed).toBe(true);
    expect(result.prompt).toBe("Skip confirm test");
  });

  test("returns null when editor fails", async () => {
    process.env.EDITOR = "false"; // Unix 'false' command - exits 1
    const result = await editPrompt("Will fail", {
      confirmFn: async () => "y",
    });
    expect(result.confirmed).toBe(false);
    expect(result.prompt).toBe(null);
  });
});
