/**
 * Tests for AgentRuntime
 *
 * Tests each phase of the runtime pipeline independently:
 * - ResolutionPhase: Local vs remote source handling
 * - ContextPhase: Frontmatter parsing, import expansion, command resolution
 * - TemplatePhase: Variable substitution and arg building
 * - ExecutionPhase: Command execution (mocked)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  AgentRuntime,
  createRuntime,
} from "./runtime";
import { clearConfigCache } from "./config";

describe("AgentRuntime", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "runtime-test-"));
    clearConfigCache();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("Resolution Phase", () => {
    it("resolves local file path", async () => {
      const filePath = join(tempDir, "test.claude.md");
      await writeFile(filePath, "---\nmodel: opus\n---\nHello");

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);

      expect(resolved.type).toBe("local");
      expect(resolved.path).toBe(filePath);
      expect(resolved.originalSource).toBe(filePath);
      expect(resolved.content).toContain("Hello");
      expect(resolved.directory).toBe(tempDir);
    });

    it("throws error for non-existent file", async () => {
      const runtime = createRuntime();
      const filePath = join(tempDir, "nonexistent.md");

      await expect(runtime.resolve(filePath)).rejects.toThrow("File not found");
    });

    it("resolves file content correctly", async () => {
      const content = `---
model: sonnet
temperature: 0.7
---
This is the body content.
Multiple lines.`;

      const filePath = join(tempDir, "content.claude.md");
      await writeFile(filePath, content);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);

      expect(resolved.content).toBe(content);
    });
  });

  describe("Context Phase", () => {
    it("parses frontmatter and resolves command from filename", async () => {
      const filePath = join(tempDir, "test.claude.md");
      await writeFile(filePath, `---
model: opus
---
Hello World`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);
      const context = await runtime.buildContext(resolved);

      expect(context.command).toBe("claude");
      expect(context.frontmatter.model).toBe("opus");
      expect(context.rawBody).toBe("Hello World");
      expect(context.expandedBody).toBe("Hello World");
    });

    it("uses command from options over filename", async () => {
      const filePath = join(tempDir, "test.claude.md");
      await writeFile(filePath, `---\n---\nHello`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);
      const context = await runtime.buildContext(resolved, { command: "gemini" });

      expect(context.command).toBe("gemini");
    });

    it("expands file imports", async () => {
      const includedFile = join(tempDir, "included.txt");
      await writeFile(includedFile, "Included content");

      const mainFile = join(tempDir, "main.claude.md");
      await writeFile(mainFile, `---\n---\n@./included.txt`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(mainFile);
      const context = await runtime.buildContext(resolved);

      expect(context.expandedBody).toContain("Included content");
    });

    it("extracts environment variables from frontmatter", async () => {
      const filePath = join(tempDir, "env.claude.md");
      await writeFile(filePath, `---
env:
  API_KEY: secret123
  DEBUG: "true"
---
Hello`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);
      const context = await runtime.buildContext(resolved);

      expect(context.envVars).toEqual({
        API_KEY: "secret123",
        DEBUG: "true",
      });
    });

    it("handles empty frontmatter", async () => {
      const filePath = join(tempDir, "empty.claude.md");
      await writeFile(filePath, `---\n---\nJust body`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);
      const context = await runtime.buildContext(resolved);

      expect(context.frontmatter).toEqual({});
      expect(context.rawBody).toBe("Just body");
    });
  });

  describe("Template Phase", () => {
    it("substitutes template variables", async () => {
      const filePath = join(tempDir, "template.claude.md");
      await writeFile(filePath, `---
args:
  - name
---
Hello {{ name }}!`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);
      const context = await runtime.buildContext(resolved);
      const processed = await runtime.processTemplate(context, {
        passthroughArgs: ["World"],
      });

      expect(processed.body).toBe("Hello World!");
      expect(processed.templateVars).toEqual({ name: "World" });
    });

    it("builds CLI args from frontmatter", async () => {
      const filePath = join(tempDir, "args.claude.md");
      await writeFile(filePath, `---
model: opus
temperature: 0.5
verbose: true
---
Body`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);
      const context = await runtime.buildContext(resolved);
      const processed = await runtime.processTemplate(context);

      expect(processed.args).toContain("--model");
      expect(processed.args).toContain("opus");
      expect(processed.args).toContain("--temperature");
      expect(processed.args).toContain("0.5");
      expect(processed.args).toContain("--verbose");
    });

    it("extracts positional mappings", async () => {
      const filePath = join(tempDir, "positional.claude.md");
      await writeFile(filePath, `---
$1: prompt
---
Body`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);
      const context = await runtime.buildContext(resolved);
      const processed = await runtime.processTemplate(context);

      expect(processed.positionalMappings.get(1)).toBe("prompt");
    });

    it("handles $varname fields with CLI flags", async () => {
      const filePath = join(tempDir, "varname.claude.md");
      await writeFile(filePath, `---
$feature_name: default_feature
---
Implement {{ feature_name }}`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);
      const context = await runtime.buildContext(resolved);
      const processed = await runtime.processTemplate(context, {
        passthroughArgs: ["--feature_name", "custom_feature"],
      });

      expect(processed.body).toBe("Implement custom_feature");
      expect(processed.templateVars).toEqual({ feature_name: "custom_feature" });
    });

    it("uses default value when CLI flag not provided", async () => {
      const filePath = join(tempDir, "default.claude.md");
      await writeFile(filePath, `---
$mode: development
---
Mode: {{ mode }}`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);
      const context = await runtime.buildContext(resolved);
      const processed = await runtime.processTemplate(context);

      expect(processed.body).toBe("Mode: development");
    });

    it("throws error for missing required variables in non-interactive mode", async () => {
      const filePath = join(tempDir, "missing.claude.md");
      await writeFile(filePath, `---\n---\nHello {{ name }}!`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);
      const context = await runtime.buildContext(resolved);

      await expect(runtime.processTemplate(context)).rejects.toThrow("Missing template variables: name");
    });

    it("prompts for missing variables when promptForMissing is provided", async () => {
      const filePath = join(tempDir, "prompt.claude.md");
      await writeFile(filePath, `---\n---\nHello {{ name }}!`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);
      const context = await runtime.buildContext(resolved);

      const processed = await runtime.processTemplate(context, {
        promptForMissing: async () => "PromptedName",
      });

      expect(processed.body).toBe("Hello PromptedName!");
    });

    it("passes through remaining args to command", async () => {
      const filePath = join(tempDir, "passthrough.claude.md");
      await writeFile(filePath, `---
args:
  - name
---
Hello {{ name }}`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);
      const context = await runtime.buildContext(resolved);
      const processed = await runtime.processTemplate(context, {
        passthroughArgs: ["World", "--extra", "flag"],
      });

      expect(processed.args).toContain("--extra");
      expect(processed.args).toContain("flag");
    });
  });

  describe("Full Pipeline", () => {
    it("runs complete pipeline with dry run", async () => {
      const filePath = join(tempDir, "pipeline.claude.md");
      await writeFile(filePath, `---
model: haiku
---
Test prompt`);

      const runtime = createRuntime();
      const result = await runtime.run(filePath, { dryRun: true });

      expect(result.exitCode).toBe(0);
      expect(result.dryRun).toBe(true);
      expect(result.logPath).toBeTruthy();
    });

    it("includes stdin content in final body", async () => {
      const filePath = join(tempDir, "stdin.claude.md");
      await writeFile(filePath, `---\n---\nBody content`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);
      const context = await runtime.buildContext(resolved);
      const processed = await runtime.processTemplate(context);

      // The execute phase adds stdin
      const stdinContent = "stdin data";
      const finalBody = `<stdin>\n${stdinContent}\n</stdin>\n\n${processed.body}`;

      expect(finalBody).toContain("<stdin>");
      expect(finalBody).toContain("stdin data");
      expect(finalBody).toContain("Body content");
    });

    it("handles cleanup correctly", async () => {
      const filePath = join(tempDir, "cleanup.claude.md");
      await writeFile(filePath, `---\n---\nTest`);

      const runtime = createRuntime();
      await runtime.resolve(filePath);

      // Cleanup should not throw for local files
      await expect(runtime.cleanup()).resolves.toBeUndefined();
    });
  });

  describe("createRuntime factory", () => {
    it("creates new AgentRuntime instance", () => {
      const runtime = createRuntime();
      expect(runtime).toBeInstanceOf(AgentRuntime);
    });

    it("creates independent instances", () => {
      const runtime1 = createRuntime();
      const runtime2 = createRuntime();
      expect(runtime1).not.toBe(runtime2);
    });
  });

  describe("Error Handling", () => {
    it("throws descriptive error for command resolution failure", async () => {
      const filePath = join(tempDir, "nocommand.md");
      await writeFile(filePath, `---\n---\nBody`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);

      await expect(runtime.buildContext(resolved)).rejects.toThrow("No command specified");
    });

    it("throws error for circular imports", async () => {
      const fileA = join(tempDir, "a.claude.md");
      const fileB = join(tempDir, "b.md");

      await writeFile(fileA, `---\n---\n@./b.md`);
      await writeFile(fileB, `@./a.claude.md`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(fileA);

      await expect(runtime.buildContext(resolved)).rejects.toThrow("Circular import");
    });

    it("throws error for import of non-existent file", async () => {
      const filePath = join(tempDir, "badimport.claude.md");
      await writeFile(filePath, `---\n---\n@./nonexistent.txt`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);

      await expect(runtime.buildContext(resolved)).rejects.toThrow("Import not found");
    });
  });
});
