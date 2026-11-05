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
  type ExecutionPlan,
} from "./runtime";
import { clearConfigCache } from "./config";
import { DEFAULT_ENGINE } from "./command";

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
_env:
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

      // Built-in defaults for claude add print: true (print mode by default)
      expect(context.frontmatter).toEqual({ print: true });
      expect(context.rawBody).toBe("Just body");
    });
  });

  describe("Template Phase", () => {
    it("substitutes template variables", async () => {
      const filePath = join(tempDir, "template.claude.md");
      await writeFile(filePath, `---
_name: ""
---
Hello {{ _name }}!`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);
      const context = await runtime.buildContext(resolved);
      const processed = await runtime.processTemplate(context, {
        passthroughArgs: ["--_name", "World"],
      });

      expect(processed.body).toBe("Hello World!");
      expect(processed.templateVars).toEqual({ "_name": "World" });
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

    it("handles _varname fields with CLI flags", async () => {
      const filePath = join(tempDir, "varname.claude.md");
      await writeFile(filePath, `---
_feature_name: default_feature
---
Implement {{ _feature_name }}`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);
      const context = await runtime.buildContext(resolved);
      const processed = await runtime.processTemplate(context, {
        passthroughArgs: ["--_feature_name", "custom_feature"],
      });

      expect(processed.body).toBe("Implement custom_feature");
      expect(processed.templateVars).toEqual({ "_feature_name": "custom_feature" });
    });

    it("uses default value when CLI flag not provided", async () => {
      const filePath = join(tempDir, "default.claude.md");
      await writeFile(filePath, `---
_mode: development
---
Mode: {{ _mode }}`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);
      const context = await runtime.buildContext(resolved);
      const processed = await runtime.processTemplate(context);

      expect(processed.body).toBe("Mode: development");
    });

    it("throws error for missing required variables in non-interactive mode", async () => {
      const filePath = join(tempDir, "missing.claude.md");
      await writeFile(filePath, `---\n---\nHello {{ _name }}!`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);
      const context = await runtime.buildContext(resolved);

      await expect(runtime.processTemplate(context)).rejects.toThrow("Missing template variables: _name");
    });

    it("prompts for missing variables when promptForMissing is provided", async () => {
      const filePath = join(tempDir, "prompt.claude.md");
      await writeFile(filePath, `---\n---\nHello {{ _name }}!`);

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
_name: ""
---
Hello {{ _name }}`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);
      const context = await runtime.buildContext(resolved);
      const processed = await runtime.processTemplate(context, {
        passthroughArgs: ["--_name", "World", "--extra", "flag"],
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
      expect(result.logPath).toBeNull();
    });

    it("includes stdin content via _stdin template variable", async () => {
      const filePath = join(tempDir, "stdin.claude.md");
      await writeFile(filePath, `---\n---\nInput: {{ _stdin }}\nBody content`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);
      const context = await runtime.buildContext(resolved);
      const processed = await runtime.processTemplate(context, {
        stdinContent: "stdin data",
      });

      expect(processed.body).toContain("stdin data");
      expect(processed.body).toContain("Body content");
      expect(processed.templateVars["_stdin"]).toBe("stdin data");
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
    it("resolves engine-less workflow steps to the default engine (v3)", async () => {
      const filePath = join(tempDir, "nocommand.md");
      await writeFile(filePath, `---\n---\nBody`);

      const runtime = createRuntime();
      const resolved = await runtime.resolve(filePath);

      // A step listed in a workflow is explicitly executable, so the ladder
      // applies all the way down to the built-in default.
      const context = await runtime.buildContext(resolved);
      expect(context.command).toBe(DEFAULT_ENGINE);
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

  describe("Structured Dry Run (ExecutionPlan)", () => {
    it("returns ExecutionPlan with finalPrompt when dryRun and returnPlan are true", async () => {
      const filePath = join(tempDir, "plan.claude.md");
      await writeFile(filePath, `---
model: sonnet
temperature: 0.5
---
Hello world prompt`);

      const runtime = createRuntime();
      const result = await runtime.run(filePath, { dryRun: true, returnPlan: true });

      expect(result.dryRun).toBe(true);
      expect(result.plan).toBeDefined();
      expect(result.plan!.type).toBe("dry-run");
      expect(result.plan!.finalPrompt).toBe("Hello world prompt");
      expect(result.plan!.command).toBe("claude");
      expect(result.plan!.args).toContain("--model");
      expect(result.plan!.args).toContain("sonnet");
    });

    it("includes resolved imports in ExecutionPlan", async () => {
      const includedFile = join(tempDir, "include.txt");
      await writeFile(includedFile, "Included content here");

      const mainFile = join(tempDir, "main.claude.md");
      await writeFile(mainFile, `---\n---\nBefore import\n@./include.txt\nAfter import`);

      const runtime = createRuntime();
      const result = await runtime.run(mainFile, { dryRun: true, returnPlan: true });

      expect(result.plan).toBeDefined();
      expect(result.plan!.resolvedImports).toContain("./include.txt");
      expect(result.plan!.finalPrompt).toContain("Included content here");
      expect(result.plan!.finalPrompt).toContain("Before import");
      expect(result.plan!.finalPrompt).toContain("After import");
    });

    it("includes template variables in ExecutionPlan", async () => {
      const filePath = join(tempDir, "template.claude.md");
      await writeFile(filePath, `---
_name: ""
_action: ""
---
Hello {{ _name }}, please {{ _action }}`);

      const runtime = createRuntime();
      const result = await runtime.run(filePath, {
        dryRun: true,
        returnPlan: true,
        passthroughArgs: ["--_name", "World", "--_action", "test"],
      });

      expect(result.plan).toBeDefined();
      expect(result.plan!.templateVars).toEqual({ "_name": "World", "_action": "test" });
      expect(result.plan!.finalPrompt).toBe("Hello World, please test");
    });

    it("provides accurate token estimation", async () => {
      const filePath = join(tempDir, "tokens.claude.md");
      // Create a prompt with known content
      const prompt = "This is a test prompt with some words to count tokens.";
      await writeFile(filePath, `---\n---\n${prompt}`);

      const runtime = createRuntime();
      const result = await runtime.run(filePath, { dryRun: true, returnPlan: true });

      expect(result.plan).toBeDefined();
      expect(result.plan!.estimatedTokens).toBeGreaterThan(0);
      // Token count should be reasonable (roughly 1 token per 4 chars, but varies)
      expect(result.plan!.estimatedTokens).toBeLessThan(prompt.length);
    });

    it("includes environment variables in ExecutionPlan", async () => {
      const filePath = join(tempDir, "env.claude.md");
      await writeFile(filePath, `---
_env:
  API_KEY: test-key
  DEBUG: "true"
---
Body content`);

      const runtime = createRuntime();
      const result = await runtime.run(filePath, { dryRun: true, returnPlan: true });

      expect(result.plan).toBeDefined();
      expect(result.plan!.env).toEqual({
        API_KEY: "test-key",
        DEBUG: "true",
      });
    });

    it("includes positional mappings in ExecutionPlan", async () => {
      const filePath = join(tempDir, "positional.claude.md");
      await writeFile(filePath, `---
$1: prompt
$2: context
---
Body`);

      const runtime = createRuntime();
      const result = await runtime.run(filePath, { dryRun: true, returnPlan: true });

      expect(result.plan).toBeDefined();
      expect(result.plan!.positionalMappings).toEqual({ 1: "prompt", 2: "context" });
    });

    it("includes full frontmatter in ExecutionPlan", async () => {
      const filePath = join(tempDir, "frontmatter.claude.md");
      await writeFile(filePath, `---
model: opus
verbose: true
max-tokens: 1000
---
Body`);

      const runtime = createRuntime();
      const result = await runtime.run(filePath, { dryRun: true, returnPlan: true });

      expect(result.plan).toBeDefined();
      expect(result.plan!.frontmatter.model).toBe("opus");
      expect(result.plan!.frontmatter.verbose).toBe(true);
      expect(result.plan!.frontmatter["max-tokens"]).toBe(1000);
    });

    it("includes stdin content in finalPrompt via _stdin", async () => {
      const filePath = join(tempDir, "stdin.claude.md");
      await writeFile(filePath, `---\n---\nInput: {{ _stdin }}\nProcess this input:`);

      const runtime = createRuntime();
      const result = await runtime.run(filePath, {
        dryRun: true,
        returnPlan: true,
        stdinContent: "stdin data here",
      });

      expect(result.plan).toBeDefined();
      expect(result.plan!.finalPrompt).toContain("stdin data here");
      expect(result.plan!.finalPrompt).toContain("Process this input:");
      expect(result.plan!.templateVars["_stdin"]).toBe("stdin data here");
    });

    it("tracks multiple nested imports", async () => {
      const file1 = join(tempDir, "level1.txt");
      const file2 = join(tempDir, "level2.txt");
      await writeFile(file2, "Level 2 content");
      await writeFile(file1, "Level 1 start\n@./level2.txt\nLevel 1 end");

      const mainFile = join(tempDir, "multi.claude.md");
      await writeFile(mainFile, `---\n---\nMain\n@./level1.txt\nEnd`);

      const runtime = createRuntime();
      const result = await runtime.run(mainFile, { dryRun: true, returnPlan: true });

      expect(result.plan).toBeDefined();
      expect(result.plan!.resolvedImports).toContain("./level1.txt");
      expect(result.plan!.resolvedImports).toContain("./level2.txt");
      expect(result.plan!.finalPrompt).toContain("Main");
      expect(result.plan!.finalPrompt).toContain("Level 1 start");
      expect(result.plan!.finalPrompt).toContain("Level 2 content");
      expect(result.plan!.finalPrompt).toContain("Level 1 end");
      expect(result.plan!.finalPrompt).toContain("End");
    });

    it("never executes a pre-hook to construct a dry-run plan", async () => {
      const filePath = join(tempDir, "prehook.claude.md");
      await writeFile(filePath, `---
pre: touch prehook-ran && echo "HOOK OUTPUT"
---
Body content`);

      const runtime = createRuntime();
      const result = await runtime.run(filePath, { dryRun: true, returnPlan: true });

      expect(result.plan).toBeDefined();
      expect(result.plan!.finalPrompt).toBe("Body content");
      expect(await Bun.file(join(tempDir, "prehook-ran")).exists()).toBe(false);
    });

    it("still logs to console when returnPlan is false", async () => {
      const filePath = join(tempDir, "console.claude.md");
      await writeFile(filePath, `---\n---\nTest prompt`);

      // Capture console.log output
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => logs.push(args.join(" "));

      const runtime = createRuntime();
      const result = await runtime.run(filePath, { dryRun: true, returnPlan: false });

      console.log = originalLog;

      // Should still have the plan
      expect(result.plan).toBeDefined();
      // But should also have logged to console
      expect(logs.some(l => l.includes("DRY RUN"))).toBe(true);
      expect(logs.some(l => l.includes("Test prompt"))).toBe(true);
    });
  });
});
