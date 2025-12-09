import { test, expect, beforeAll, afterAll } from "bun:test";
import { expandImports, hasImports, toCanonicalPath } from "./imports";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "imports-test-"));

  // Create test files
  await Bun.write(join(testDir, "simple.md"), "Hello from simple.md");
  await Bun.write(join(testDir, "nested.md"), "Before @./simple.md After");
  await Bun.write(join(testDir, "circular-a.md"), "A imports @./circular-b.md");
  await Bun.write(join(testDir, "circular-b.md"), "B imports @./circular-a.md");
  await Bun.write(join(testDir, "subdir/deep.md"), "Deep file content");

  // Create subdir
  await Bun.write(join(testDir, "subdir/deep.md"), "Deep file content");
  await Bun.write(join(testDir, "imports-subdir.md"), "Import from @./subdir/deep.md done");
});

afterAll(async () => {
  await rm(testDir, { recursive: true });
});

test("hasImports detects @file syntax", () => {
  expect(hasImports("@./file.md")).toBe(true);
  expect(hasImports("@~/file.md")).toBe(true);
  expect(hasImports("@/absolute/path.md")).toBe(true);
  expect(hasImports("no imports here")).toBe(false);
  expect(hasImports("email@example.com")).toBe(false); // @ not followed by path
});

test("hasImports detects !`command` syntax", () => {
  expect(hasImports("!`ls -la`")).toBe(true);
  expect(hasImports("!`echo hello`")).toBe(true);
  expect(hasImports("no commands")).toBe(false);
  expect(hasImports("`code block`")).toBe(false); // Missing !
});

test("expandImports expands simple file import", async () => {
  const content = "Start @./simple.md End";
  const result = await expandImports(content, testDir);
  expect(result).toBe("Start Hello from simple.md End");
});

test("expandImports handles nested imports", async () => {
  const content = "@./nested.md";
  const result = await expandImports(content, testDir);
  expect(result).toBe("Before Hello from simple.md After");
});

test("expandImports detects circular imports", async () => {
  const content = "@./circular-a.md";
  await expect(expandImports(content, testDir)).rejects.toThrow("Circular import detected");
});

test("expandImports handles subdirectory imports", async () => {
  const content = "@./imports-subdir.md";
  const result = await expandImports(content, testDir);
  expect(result).toBe("Import from Deep file content done");
});

test("expandImports throws on missing file", async () => {
  const content = "@./nonexistent.md";
  await expect(expandImports(content, testDir)).rejects.toThrow("Import not found");
});

test("expandImports executes command inline", async () => {
  const content = "Output: !`echo hello`";
  const result = await expandImports(content, testDir);
  // Command output is wrapped in {% raw %} to prevent LiquidJS template interpretation
  expect(result).toBe("Output: {% raw %}\nhello\n{% endraw %}");
});

test("expandImports handles command with arguments", async () => {
  const content = "!`echo one two three`";
  const result = await expandImports(content, testDir);
  expect(result).toBe("{% raw %}\none two three\n{% endraw %}")
});

test("expandImports handles multiple imports", async () => {
  const content = "@./simple.md and @./simple.md again";
  const result = await expandImports(content, testDir);
  expect(result).toBe("Hello from simple.md and Hello from simple.md again");
});

test("expandImports handles mixed file and command", async () => {
  const content = "File: @./simple.md Command: !`echo test`";
  const result = await expandImports(content, testDir);
  expect(result).toBe("File: Hello from simple.md Command: {% raw %}\ntest\n{% endraw %}");
});

test("expandImports preserves content without imports", async () => {
  const content = "No imports here, just regular text";
  const result = await expandImports(content, testDir);
  expect(result).toBe("No imports here, just regular text");
});

test("expandImports handles ~ expansion", async () => {
  // This test uses the actual home directory
  // We can't easily test this without creating a file in ~
  // Just verify the function doesn't throw on ~ syntax
  const content = "Some text with email@example.com is not an import";
  const result = await expandImports(content, testDir);
  expect(result).toBe("Some text with email@example.com is not an import");
});

// URL import tests
test("hasImports detects @https:// URL syntax", () => {
  expect(hasImports("@https://example.com/docs")).toBe(true);
  expect(hasImports("@https://github.com/user/repo/blob/main/README.md")).toBe(true);
});

test("hasImports detects @http:// URL syntax", () => {
  expect(hasImports("@http://example.com/api")).toBe(true);
  expect(hasImports("@http://localhost:3000/data.json")).toBe(true);
});

test("hasImports does NOT match emails", () => {
  expect(hasImports("contact@example.com")).toBe(false);
  expect(hasImports("foo@bar.org")).toBe(false);
  expect(hasImports("user.name@company.io")).toBe(false);
  expect(hasImports("Send email to admin@test.com please")).toBe(false);
});

test("hasImports distinguishes emails from URL imports", () => {
  // Email should not match
  expect(hasImports("foo@example.com")).toBe(false);
  // URL import should match
  expect(hasImports("@https://example.com")).toBe(true);
  // Mixed content - URL should be detected
  expect(hasImports("Email: foo@bar.com and docs: @https://docs.com")).toBe(true);
});

test("expandImports fetches markdown URL", async () => {
  // Use jsonplaceholder for testing - reliable API
  const content = "Docs: @https://jsonplaceholder.typicode.com/posts/1";
  const result = await expandImports(content, testDir);
  expect(result).toContain("Docs:");
  expect(result).not.toContain("@https://");
});

test("expandImports fetches JSON URL", async () => {
  const content = "Data: @https://jsonplaceholder.typicode.com/users/1";
  const result = await expandImports(content, testDir);
  expect(result).toContain("Data:");
  expect(result).toContain("Leanne Graham"); // jsonplaceholder user 1 name
  expect(result).not.toContain("@https://");
});

test("expandImports preserves emails while expanding URLs", async () => {
  const content = "Contact: admin@example.com\nDocs: @https://jsonplaceholder.typicode.com/posts/1";
  const result = await expandImports(content, testDir);
  expect(result).toContain("admin@example.com"); // Email preserved
  expect(result).not.toContain("@https://"); // URL expanded
});

// Line range import tests
test("expandImports handles line range syntax", async () => {
  // Create a test file with numbered lines
  const lineContent = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`).join("\n");
  await Bun.write(join(testDir, "lines.txt"), lineContent);

  const content = "@./lines.txt:3-5";
  const result = await expandImports(content, testDir);
  expect(result).toBe("Line 3\nLine 4\nLine 5");
});

test("expandImports line range handles out of bounds", async () => {
  const lineContent = "Line 1\nLine 2\nLine 3";
  await Bun.write(join(testDir, "short.txt"), lineContent);

  const content = "@./short.txt:2-100";
  const result = await expandImports(content, testDir);
  expect(result).toBe("Line 2\nLine 3");
});

// Symbol extraction tests
test("expandImports extracts interface", async () => {
  const tsContent = `
import { foo } from "bar";

export interface UserData {
  id: number;
  name: string;
}

const x = 1;
`;
  await Bun.write(join(testDir, "types.ts"), tsContent);

  const content = "@./types.ts#UserData";
  const result = await expandImports(content, testDir);
  expect(result).toContain("interface UserData");
  expect(result).toContain("id: number");
  expect(result).toContain("name: string");
  expect(result).not.toContain("import");
  expect(result).not.toContain("const x");
});

test("expandImports extracts function", async () => {
  const tsContent = `
const helper = () => {};

export function fetchUser(id: number): Promise<User> {
  return api.get(\`/users/\${id}\`);
}

export function anotherFunc() {}
`;
  await Bun.write(join(testDir, "api.ts"), tsContent);

  const content = "@./api.ts#fetchUser";
  const result = await expandImports(content, testDir);
  expect(result).toContain("function fetchUser");
  expect(result).toContain("Promise<User>");
  expect(result).not.toContain("helper");
});

test("expandImports extracts const", async () => {
  const tsContent = `
export const CONFIG = {
  apiUrl: "https://api.example.com",
  timeout: 5000,
};

export const OTHER = {};
`;
  await Bun.write(join(testDir, "config.ts"), tsContent);

  const content = "@./config.ts#CONFIG";
  const result = await expandImports(content, testDir);
  expect(result).toContain("const CONFIG");
  expect(result).toContain("apiUrl");
  expect(result).not.toContain("OTHER");
});

test("expandImports throws on missing symbol", async () => {
  const tsContent = `export const foo = 1;`;
  await Bun.write(join(testDir, "missing.ts"), tsContent);

  const content = "@./missing.ts#NonExistent";
  await expect(expandImports(content, testDir)).rejects.toThrow('Symbol "NonExistent" not found');
});

// Glob import tests
test("hasImports detects glob patterns", () => {
  expect(hasImports("@./src/**/*.ts")).toBe(true);
  expect(hasImports("@./lib/*.js")).toBe(true);
  expect(hasImports("@./test/[abc].ts")).toBe(true);
});

test("expandImports handles glob patterns", async () => {
  // Create test files for glob
  await Bun.write(join(testDir, "glob/a.ts"), "const a = 1;");
  await Bun.write(join(testDir, "glob/b.ts"), "const b = 2;");
  await Bun.write(join(testDir, "glob/c.js"), "const c = 3;");

  const content = "@./glob/*.ts";
  const result = await expandImports(content, testDir);

  // Should include .ts files only
  expect(result).toContain("const a = 1");
  expect(result).toContain("const b = 2");
  expect(result).not.toContain("const c = 3");
  // Should be formatted as XML
  expect(result).toContain("<a path=");
  expect(result).toContain("<b path=");
});

// Canonical path tests
test("toCanonicalPath resolves symlinks to real path", async () => {
  // Create a real file
  const realFile = join(testDir, "real-file.md");
  await Bun.write(realFile, "Real content");

  // Create a symlink to it
  const linkFile = join(testDir, "link-to-real.md");
  await symlink(realFile, linkFile);

  // Both should resolve to the same canonical path
  const canonicalReal = toCanonicalPath(realFile);
  const canonicalLink = toCanonicalPath(linkFile);

  expect(canonicalReal).toBe(canonicalLink);
});

test("toCanonicalPath returns original path for non-existent files", () => {
  const nonExistent = join(testDir, "does-not-exist.md");
  const result = toCanonicalPath(nonExistent);
  expect(result).toBe(nonExistent);
});

test("toCanonicalPath handles regular files without symlinks", async () => {
  const regularFile = join(testDir, "regular.md");
  await Bun.write(regularFile, "Regular content");

  const canonical = toCanonicalPath(regularFile);
  // For a regular file, canonical path resolves system symlinks too (e.g., /var -> /private/var on macOS)
  // The canonical path should end with the same relative path
  expect(canonical.endsWith("regular.md")).toBe(true);
  // And calling it twice should give the same result
  expect(toCanonicalPath(canonical)).toBe(canonical);
});

test("expandImports detects circular import via symlink", async () => {
  // Create a file that imports itself via a symlink
  // File A imports symlink-to-A, which points to A -> circular!
  const fileA = join(testDir, "symlink-cycle-a.md");
  const symlinkToA = join(testDir, "symlink-to-a.md");

  // Create the symlink first
  await Bun.write(fileA, "placeholder");
  await symlink(fileA, symlinkToA);

  // Now update fileA to import via the symlink
  await Bun.write(fileA, "A imports @./symlink-to-a.md");

  // This should detect the cycle even though paths are different
  const content = "@./symlink-cycle-a.md";
  await expect(expandImports(content, testDir)).rejects.toThrow("Circular import detected");
});

test("expandImports detects indirect circular import via symlink", async () => {
  // A -> B -> symlink-to-A (which points to A)
  const fileA = join(testDir, "indirect-a.md");
  const fileB = join(testDir, "indirect-b.md");
  const symlinkToA = join(testDir, "indirect-link-to-a.md");

  // Create files and symlink
  await Bun.write(fileA, "A imports @./indirect-b.md");
  await Bun.write(fileB, "B imports @./indirect-link-to-a.md");
  await symlink(fileA, symlinkToA);

  // This should detect the cycle: A -> B -> symlink-to-A (= A)
  const content = "@./indirect-a.md";
  await expect(expandImports(content, testDir)).rejects.toThrow("Circular import detected");
});

test("expandImports allows same content via different files (not symlinks)", async () => {
  // Two different files with the same content should NOT be a cycle
  const file1 = join(testDir, "same-content-1.md");
  const file2 = join(testDir, "same-content-2.md");

  await Bun.write(file1, "Same content");
  await Bun.write(file2, "Same content");

  const content = "@./same-content-1.md @./same-content-2.md";
  const result = await expandImports(content, testDir);

  // Should work fine - not a cycle
  expect(result).toBe("Same content Same content");
});

// Command cwd tests
test("expandImports runs commands in invocationCwd, not file directory", async () => {
  // Create a separate directory to simulate the agent file location
  const agentDir = join(testDir, "agent-dir");
  await Bun.write(join(agentDir, "dummy.md"), ""); // ensure dir exists

  // Create another directory to simulate the invocation directory
  const invocationDir = join(testDir, "invocation-dir");
  await Bun.write(join(invocationDir, "dummy.md"), ""); // ensure dir exists

  // Command that outputs the current working directory
  const content = "!`pwd`";

  // When invocationCwd is set, commands should run in that directory
  const result = await expandImports(content, agentDir, new Set(), false, {
    invocationCwd: invocationDir,
  });

  // The pwd output should be the invocation directory, not the agent directory
  expect(result).toContain(invocationDir);
  expect(result).not.toContain("agent-dir");
});

test("expandImports uses file directory for commands when invocationCwd not set", async () => {
  // This tests backward compatibility - when invocationCwd is not provided,
  // commands should still run in the file's directory (current behavior)
  const content = "!`pwd`";
  const result = await expandImports(content, testDir);

  // Should contain the testDir path
  expect(result).toContain(testDir.split("/").pop());
});

test("expandImports allows _cwd override via ImportContext", async () => {
  // Test that invocationCwd can be explicitly set to override where commands run
  const customDir = join(testDir, "custom-cwd");
  await Bun.write(join(customDir, "dummy.md"), ""); // ensure dir exists

  const content = "!`pwd`";
  const result = await expandImports(content, testDir, new Set(), false, {
    invocationCwd: customDir,
  });

  // The command should run in customDir, not testDir
  expect(result).toContain("custom-cwd");
});

test("expandImports runs bun commands in invocationCwd", async () => {
  // Test using bun's process.cwd() to verify the working directory
  // This ensures the cwd is properly passed to spawned processes
  const agentDir = join(testDir, "bun-agent-dir");
  await Bun.write(join(agentDir, "dummy.md"), ""); // ensure dir exists

  const invocationDir = join(testDir, "bun-invocation-dir");
  await Bun.write(join(invocationDir, "dummy.md"), ""); // ensure dir exists

  // Use bun to check process.cwd()
  const content = '!`bun -e "console.log(process.cwd())"`';

  const result = await expandImports(content, agentDir, new Set(), false, {
    invocationCwd: invocationDir,
  });

  // The bun process should report the invocation directory as cwd
  expect(result).toContain("bun-invocation-dir");
  expect(result).not.toContain("bun-agent-dir");
});
