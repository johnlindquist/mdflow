import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { expandImports, hasImports, toCanonicalPath, isMarkdownFileCommand } from "./imports";
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
  // Command output is returned directly (Phase 3 runs after LiquidJS)
  expect(result).toBe("Output: hello");
});

test("expandImports handles command with arguments", async () => {
  const content = "!`echo one two three`";
  const result = await expandImports(content, testDir);
  expect(result).toBe("one two three");
});

test("expandImports handles multiple imports", async () => {
  const content = "@./simple.md and @./simple.md again";
  const result = await expandImports(content, testDir);
  expect(result).toBe("Hello from simple.md and Hello from simple.md again");
});

test("expandImports handles mixed file and command", async () => {
  const content = "File: @./simple.md Command: !`echo test`";
  const result = await expandImports(content, testDir);
  expect(result).toBe("File: Hello from simple.md Command: test");
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

test("expandImports handles parent directory glob patterns (issue #13)", async () => {
  // Create a nested subdirectory structure to test parent directory globs
  // Structure: testDir/parent-glob-test/subdir/agent.md
  //            testDir/parent-glob-test/*.rs (files to find)
  const parentDir = join(testDir, "parent-glob-test");
  const subDir = join(parentDir, "subdir");

  // Create the Rust files in the parent directory
  await Bun.write(join(parentDir, "main.rs"), "fn main() {}");
  await Bun.write(join(parentDir, "lib.rs"), "pub mod lib;");

  // Create dummy file in subdir to ensure it exists
  await Bun.write(join(subDir, "dummy.md"), "");

  // Run glob from subdir looking at parent with ../*.rs
  const content = "@../*.rs";
  const result = await expandImports(content, subDir);

  // Should include both .rs files
  expect(result).toContain("fn main() {}");
  expect(result).toContain("pub mod lib;");
  // Should be formatted as XML
  expect(result).toContain("main.rs");
  expect(result).toContain("lib.rs");
});

test("expandImports handles deep parent directory glob patterns", async () => {
  // Test ../../**/*.rs pattern (2 levels up)
  const deepParent = join(testDir, "deep-parent");
  const level1 = join(deepParent, "level1");
  const level2 = join(level1, "level2");

  // Create files at the top level
  await Bun.write(join(deepParent, "top.rs"), "// top level");
  await Bun.write(join(deepParent, "nested/inner.rs"), "// nested");

  // Create dummy to ensure level2 exists
  await Bun.write(join(level2, "dummy.md"), "");

  // Run glob from level2 looking 2 levels up with **/*.rs
  const content = "@../../**/*.rs";
  const result = await expandImports(content, level2);

  // Should include both .rs files
  expect(result).toContain("// top level");
  expect(result).toContain("// nested");
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
  expect(result).toContain(testDir.split("/").pop()!);
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

// Auto-run .md files with md tests
describe("isMarkdownFileCommand", () => {
  test("detects simple .md file", () => {
    expect(isMarkdownFileCommand("foo.md")).toBe(true);
  });

  test("detects relative path .md file", () => {
    expect(isMarkdownFileCommand("./foo.md")).toBe(true);
    expect(isMarkdownFileCommand("../foo.md")).toBe(true);
  });

  test("detects home path .md file", () => {
    expect(isMarkdownFileCommand("~/foo.md")).toBe(true);
    expect(isMarkdownFileCommand("~/.mdflow/foo.md")).toBe(true);
  });

  test("detects absolute path .md file", () => {
    expect(isMarkdownFileCommand("/path/to/foo.md")).toBe(true);
  });

  test("detects compound .md file names", () => {
    expect(isMarkdownFileCommand("foo.claude.md")).toBe(true);
    expect(isMarkdownFileCommand("task.i.claude.md")).toBe(true);
  });

  test("detects .md file with arguments", () => {
    expect(isMarkdownFileCommand("foo.md arg1 arg2")).toBe(true);
    expect(isMarkdownFileCommand("./task.claude.md --verbose")).toBe(true);
  });

  test("does NOT match non-.md files", () => {
    expect(isMarkdownFileCommand("foo.txt")).toBe(false);
    expect(isMarkdownFileCommand("foo.js")).toBe(false);
    expect(isMarkdownFileCommand("echo hello")).toBe(false);
    expect(isMarkdownFileCommand("ls -la")).toBe(false);
  });

  test("does NOT match commands containing .md elsewhere", () => {
    expect(isMarkdownFileCommand("echo foo.md")).toBe(false);
    expect(isMarkdownFileCommand("cat foo.md")).toBe(false);
    expect(isMarkdownFileCommand("grep pattern foo.md")).toBe(false);
  });

  test("does NOT match .md in the middle of command", () => {
    expect(isMarkdownFileCommand("cp foo.md bar.md")).toBe(false);
  });
});

test("expandImports does not affect non-.md commands", async () => {
  const content = "!`echo 'not an md file'`";
  const result = await expandImports(content, testDir);
  expect(result).toContain("not an md file");
});

test("expandImports preserves normal shell commands", async () => {
  const content = "!`echo hello.txt`";
  const result = await expandImports(content, testDir);
  expect(result).toContain("hello.txt");
});

// Template variable substitution in commands
describe("template variables in commands", () => {
  test("substitutes template variables in command strings", async () => {
    const content = "!`echo {{ _name }}`";
    const result = await expandImports(content, testDir, new Set(), false, {
      templateVars: { _name: "John" },
    });
    expect(result).toContain("John");
  });

  test("substitutes multiple template variables", async () => {
    const content = "!`echo {{ _greeting }} {{ _name }}`";
    const result = await expandImports(content, testDir, new Set(), false, {
      templateVars: { _greeting: "Hello", _name: "World" },
    });
    expect(result).toContain("Hello World");
  });

  test("handles undefined variables gracefully (empty string)", async () => {
    // When a variable exists but the referenced one doesn't, LiquidJS renders empty
    const content = "!`echo 'prefix{{ _undefined }}suffix'`";
    const result = await expandImports(content, testDir, new Set(), false, {
      templateVars: { _name: "exists" }, // At least one var so substitution runs
    });
    expect(result).toContain("prefixsuffix");
  });

  test("does not substitute when templateVars not provided", async () => {
    const content = "!`echo '{{ _name }}'`";
    const result = await expandImports(content, testDir);
    // Without templateVars, the literal {{ _name }} is passed to echo
    expect(result).toContain("{{ _name }}");
  });

  test("combines with _stdin variable", async () => {
    const content = "!`echo '{{ _stdin }}'`";
    const result = await expandImports(content, testDir, new Set(), false, {
      templateVars: { _stdin: "piped-content" },
    });
    expect(result).toContain("piped-content");
  });

  test("command output is returned directly (Phase 3 runs after LiquidJS)", async () => {
    // Command output containing template-like syntax is returned as-is
    // (no wrapping needed since commands run after template processing)
    const content = "!`echo '{{ output }}'`";
    const result = await expandImports(content, testDir, new Set(), false, {
      templateVars: {},
    });
    // Output should contain the literal {{ output }} text
    expect(result).toContain("{{ output }}");
  });
});

// Parallel resolution tests
describe("parallel import resolution", () => {
  test("resolves multiple file imports in parallel", async () => {
    // Create multiple test files
    await Bun.write(join(testDir, "parallel-a.md"), "Content A");
    await Bun.write(join(testDir, "parallel-b.md"), "Content B");
    await Bun.write(join(testDir, "parallel-c.md"), "Content C");

    const content = "@./parallel-a.md @./parallel-b.md @./parallel-c.md";
    const result = await expandImports(content, testDir);

    expect(result).toBe("Content A Content B Content C");
  });

  test("resolves mixed imports (files, commands) in parallel", async () => {
    await Bun.write(join(testDir, "parallel-mixed.md"), "File content");

    const content = "@./parallel-mixed.md !`echo Command output`";
    const result = await expandImports(content, testDir);

    expect(result).toContain("File content");
    expect(result).toContain("Command output");
  });

  test("maintains correct order when resolving in parallel", async () => {
    // Create files with distinct content to verify ordering
    await Bun.write(join(testDir, "order-1.md"), "FIRST");
    await Bun.write(join(testDir, "order-2.md"), "SECOND");
    await Bun.write(join(testDir, "order-3.md"), "THIRD");

    const content = "Start @./order-1.md Middle @./order-2.md End @./order-3.md Final";
    const result = await expandImports(content, testDir);

    expect(result).toBe("Start FIRST Middle SECOND End THIRD Final");
  });

  test("handles parallel resolution with concurrency limit", async () => {
    // Create many files to test concurrency limiting
    const fileCount = 20;
    for (let i = 0; i < fileCount; i++) {
      await Bun.write(join(testDir, `concurrent-${i}.md`), `File ${i}`);
    }

    // Build content with many imports
    const imports = Array.from({ length: fileCount }, (_, i) => `@./concurrent-${i}.md`);
    const content = imports.join(" ");

    // Use a low concurrency limit to test the semaphore
    const result = await expandImports(content, testDir, new Set(), false, undefined, 3);

    // Verify all files were resolved
    for (let i = 0; i < fileCount; i++) {
      expect(result).toContain(`File ${i}`);
    }
  });

  test("parallel resolution still detects cycles correctly", async () => {
    // Create files that form a cycle
    await Bun.write(join(testDir, "cycle-parallel-a.md"), "A imports @./cycle-parallel-b.md");
    await Bun.write(join(testDir, "cycle-parallel-b.md"), "B imports @./cycle-parallel-a.md");

    const content = "@./cycle-parallel-a.md";
    await expect(expandImports(content, testDir)).rejects.toThrow("Circular import detected");
  });

  test("parallel resolution handles errors correctly", async () => {
    // One valid file, one missing
    await Bun.write(join(testDir, "exists.md"), "I exist");

    const content = "@./exists.md @./does-not-exist.md";
    await expect(expandImports(content, testDir)).rejects.toThrow("Import not found");
  });

  test("parallel resolution with URL and file imports", async () => {
    await Bun.write(join(testDir, "with-url.md"), "Local file");

    const content = "@./with-url.md @https://jsonplaceholder.typicode.com/posts/1";
    const result = await expandImports(content, testDir);

    expect(result).toContain("Local file");
    expect(result).not.toContain("@https://");
  });

  test("concurrency limit of 1 processes sequentially", async () => {
    // This tests that the semaphore actually limits concurrency
    await Bun.write(join(testDir, "seq-1.md"), "First");
    await Bun.write(join(testDir, "seq-2.md"), "Second");

    const content = "@./seq-1.md @./seq-2.md";
    const result = await expandImports(content, testDir, new Set(), false, undefined, 1);

    expect(result).toBe("First Second");
  });

  test("parallel nested imports are handled correctly", async () => {
    // Create nested import structure
    await Bun.write(join(testDir, "nest-parent-1.md"), "Parent1 @./nest-child.md end1");
    await Bun.write(join(testDir, "nest-parent-2.md"), "Parent2 @./nest-child.md end2");
    await Bun.write(join(testDir, "nest-child.md"), "Child");

    // Both parents import the same child - should work in parallel
    const content = "@./nest-parent-1.md @./nest-parent-2.md";
    const result = await expandImports(content, testDir);

    expect(result).toBe("Parent1 Child end1 Parent2 Child end2");
  });
});

// Executable code fence tests
describe("executable code fences", () => {
  test("executes bash code fence with shebang", async () => {
    const content = '```sh\n#!/bin/bash\necho "hello from bash"\n```';
    const result = await expandImports(content, testDir);
    expect(result).toContain("hello from bash");
  });

  test("executes bun/typescript code fence with shebang", async () => {
    const content = '```ts\n#!/usr/bin/env bun\nconsole.log("hello from bun")\n```';
    const result = await expandImports(content, testDir);
    expect(result).toContain("hello from bun");
  });

  test("does NOT execute code fence without shebang", async () => {
    const content = '```ts\nconsole.log("should not run")\n```';
    const result = await expandImports(content, testDir);
    // The code fence should remain as-is since it has no shebang
    expect(result).toBe('```ts\nconsole.log("should not run")\n```');
  });

  test("handles code fence failure gracefully", async () => {
    const content = '```sh\n#!/bin/bash\nexit 1\n```';
    await expect(expandImports(content, testDir)).rejects.toThrow("Code fence failed");
  });

  test("code fence output is returned directly (Phase 3 runs after LiquidJS)", async () => {
    const content = '```sh\n#!/bin/bash\necho "{{ template syntax }}"\n```';
    const result = await expandImports(content, testDir);
    // Output returned as-is (no wrapping needed since code fences run after template processing)
    expect(result).toContain("{{ template syntax }}");
    expect(result).not.toContain("{% raw %}");
  });

  test("respects dry-run mode for code fences", async () => {
    const content = '```sh\n#!/bin/bash\necho "should not run"\n```';
    const result = await expandImports(content, testDir, new Set(), false, {
      dryRun: true,
    });
    expect(result).toContain("Dry Run");
    expect(result).toContain("Code fence not executed");
  });

  test("mixes code fence with file imports", async () => {
    await Bun.write(join(testDir, "fence-file.md"), "File content");

    const content = '@./fence-file.md\n\n```sh\n#!/bin/bash\necho "Command output"\n```';
    const result = await expandImports(content, testDir);
    expect(result).toContain("File content");
    expect(result).toContain("Command output");
  });

  test("hasImports detects executable code fences", () => {
    expect(hasImports('```sh\n#!/bin/bash\necho hi\n```')).toBe(true);
  });
});
