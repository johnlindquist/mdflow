/**
 * Snapshot Testing for mdflow Prompts
 *
 * This file tests the full prompt expansion pipeline using Bun's built-in
 * snapshot testing. Snapshots are stored in __snapshots__/snapshot.test.ts.snap
 *
 * To update snapshots when intentional changes are made:
 *   bun test src/snapshot.test.ts --update-snapshots
 *
 * Or to update all snapshots:
 *   bun test --update-snapshots
 */

import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { join, dirname } from "path";
import { parseFrontmatter } from "./parse";
import { expandImports, hasImports } from "./imports";
import { substituteTemplateVars } from "./template";

/**
 * Process a markdown agent file through the full pipeline
 * This mirrors the core flow in index.ts but without command execution
 *
 * @param fixturePath - Absolute path to the fixture file
 * @param templateVars - Template variables to substitute
 * @returns The fully expanded prompt ready for LLM consumption
 */
export async function processPrompt(
  fixturePath: string,
  templateVars: Record<string, string> = {}
): Promise<{
  frontmatter: Record<string, unknown>;
  prompt: string;
}> {
  const file = Bun.file(fixturePath);
  const content = await file.text();

  // Parse frontmatter
  const { frontmatter, body: rawBody } = parseFrontmatter(content);

  // Get the directory for resolving relative imports
  const fileDir = dirname(fixturePath);

  // Expand imports if present
  let expandedBody = rawBody;
  if (hasImports(rawBody)) {
    expandedBody = await expandImports(rawBody, fileDir, new Set());
  }

  // Apply template substitution
  const prompt = substituteTemplateVars(expandedBody, templateVars);

  return { frontmatter, prompt };
}

/**
 * Helper to test a fixture against its snapshot
 * Normalizes paths in output for cross-machine compatibility
 */
async function testPromptSnapshot(
  fixtureName: string,
  templateVars: Record<string, string> = {}
): Promise<string> {
  const fixturePath = join(
    import.meta.dir,
    "..",
    "test",
    "fixtures",
    fixtureName
  );

  const result = await processPrompt(fixturePath, templateVars);

  // Normalize absolute paths in the output for cross-machine snapshots
  // Replace the fixtures directory path with a stable placeholder
  const fixturesDir = join(import.meta.dir, "..", "test", "fixtures");
  let normalizedPrompt = result.prompt.replace(
    new RegExp(fixturesDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
    "<FIXTURES>"
  );

  return normalizedPrompt;
}

// Fixture directory path for tests
const fixturesDir = join(import.meta.dir, "..", "test", "fixtures");

describe("Snapshot Tests", () => {
  describe("Simple markdown (no imports)", () => {
    test("preserves simple markdown content", async () => {
      const prompt = await testPromptSnapshot("simple.claude.md");
      expect(prompt).toMatchSnapshot();
    });
  });

  describe("File imports", () => {
    test("expands single file import", async () => {
      const prompt = await testPromptSnapshot("file-import.claude.md");
      expect(prompt).toMatchSnapshot();
    });

    test("expands nested imports recursively", async () => {
      const prompt = await testPromptSnapshot("nested-import.claude.md");
      expect(prompt).toMatchSnapshot();
    });
  });

  describe("Line range imports", () => {
    test("extracts specific line ranges", async () => {
      const prompt = await testPromptSnapshot("line-range.claude.md");
      expect(prompt).toMatchSnapshot();
    });
  });

  describe("Symbol extraction", () => {
    test("extracts TypeScript symbols", async () => {
      const prompt = await testPromptSnapshot("symbol-extraction.claude.md");
      expect(prompt).toMatchSnapshot();
    });
  });

  describe("Glob imports", () => {
    test("expands glob patterns to XML format", async () => {
      const prompt = await testPromptSnapshot("glob-import.claude.md");
      expect(prompt).toMatchSnapshot();
    });
  });

  describe("Command substitution", () => {
    test("executes and inlines command output", async () => {
      const prompt = await testPromptSnapshot("command-substitution.claude.md");
      expect(prompt).toMatchSnapshot();
    });
  });

  describe("Template variables", () => {
    test("substitutes template variables", async () => {
      const prompt = await testPromptSnapshot("template-vars.claude.md", {
        target: "src/main.ts",
        action: "refactor",
      });
      expect(prompt).toMatchSnapshot();
    });

    test("handles conditional blocks (verbose enabled)", async () => {
      const prompt = await testPromptSnapshot("template-vars.claude.md", {
        target: "src/main.ts",
        action: "analyze",
        verbose: "true",
      });
      expect(prompt).toMatchSnapshot();
    });

    test("handles conditional blocks (dry_run enabled)", async () => {
      const prompt = await testPromptSnapshot("template-vars.claude.md", {
        target: "src/main.ts",
        action: "update",
        dry_run: "true",
      });
      expect(prompt).toMatchSnapshot();
    });
  });

  describe("Complex combined scenarios", () => {
    test("handles multiple import types with templates", async () => {
      const prompt = await testPromptSnapshot("complex-combined.claude.md", {
        feature_name: "UserAuthentication",
      });
      expect(prompt).toMatchSnapshot();
    });

    test("handles multiple import types with strict mode", async () => {
      const prompt = await testPromptSnapshot("complex-combined.claude.md", {
        feature_name: "DataValidation",
        strict_mode: "true",
      });
      expect(prompt).toMatchSnapshot();
    });
  });
});

describe("URL imports (mocked)", () => {
  // Store original fetch
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    // Mock fetch for URL import tests
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlString = typeof url === "string" ? url : url.toString();

      if (urlString.includes("example.com/docs")) {
        return new Response(
          "# Documentation\n\nThis is mocked documentation content.",
          {
            headers: { "content-type": "text/markdown" },
          }
        );
      }

      if (urlString.includes("api.example.com/config")) {
        return new Response(
          JSON.stringify({ version: "1.0.0", features: ["auth", "cache"] }),
          {
            headers: { "content-type": "application/json" },
          }
        );
      }

      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;
  });

  afterAll(() => {
    // Restore original fetch
    globalThis.fetch = originalFetch;
  });

  test("fetches and inlines markdown URL", async () => {
    const content = `---
model: sonnet
---

Documentation:

@https://example.com/docs

End of docs.`;

    const { frontmatter, body } = parseFrontmatter(content);
    const fileDir = fixturesDir;
    const expanded = await expandImports(body, fileDir, new Set());
    const prompt = substituteTemplateVars(expanded, {});

    expect(prompt).toMatchSnapshot();
  });

  test("fetches and inlines JSON URL", async () => {
    const content = `---
model: sonnet
---

Config:

@https://api.example.com/config

Use this config.`;

    const { frontmatter, body } = parseFrontmatter(content);
    const fileDir = fixturesDir;
    const expanded = await expandImports(body, fileDir, new Set());
    const prompt = substituteTemplateVars(expanded, {});

    expect(prompt).toMatchSnapshot();
  });
});

describe("processPrompt helper", () => {
  test("returns both frontmatter and prompt", async () => {
    const fixturePath = join(fixturesDir, "simple.claude.md");
    const result = await processPrompt(fixturePath);

    expect(result.frontmatter).toHaveProperty("model", "sonnet");
    expect(result.prompt).toContain("simple markdown file");
  });

  test("passes template vars correctly", async () => {
    const fixturePath = join(fixturesDir, "template-vars.claude.md");
    const result = await processPrompt(fixturePath, {
      target: "test.js",
      action: "test",
    });

    expect(result.prompt).toContain("test the file at test.js");
  });
});
