#!/usr/bin/env bun
import { parseFrontmatter } from "./parse";
import { parseCliArgs, mergeFrontmatter } from "./cli";
import { runBeforeCommands, runAfterCommands, buildCopilotArgs, buildPrompt, runCopilot, slugify } from "./run";
import { substituteTemplateVars, extractTemplateVars } from "./template";
import { promptInputs, validateInputField } from "./inputs";
import { resolveContextGlobs, formatContextAsXml, getContextStats, type ContextFile } from "./context";
import { extractOutput, isValidExtractMode, type ExtractMode } from "./extract";
import { generateCacheKey, readCache, writeCache } from "./cache";
import { validatePrerequisites, handlePrerequisiteFailure } from "./prerequisites";
import type { InputField } from "./types";
import { dirname } from "path";

/**
 * Read stdin if it's being piped (not a TTY)
 */
async function readStdin(): Promise<string> {
  // Check if stdin is a TTY (interactive terminal)
  if (process.stdin.isTTY) {
    return "";
  }

  // Read piped stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

async function main() {
  const { filePath, overrides, appendText, templateVars, noCache } = parseCliArgs(process.argv);

  if (!filePath) {
    console.error("Usage: <file.md> [text] [options]");
    console.error("Run with --help for more options");
    console.error("Stdin can be piped to include in the prompt");
    process.exit(1);
  }

  const file = Bun.file(filePath);

  if (!await file.exists()) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  // Read stdin if piped
  const stdinContent = await readStdin();

  const content = await file.text();
  const { frontmatter: baseFrontmatter, body: rawBody } = parseFrontmatter(content);

  // Handle wizard mode inputs
  let allTemplateVars = { ...templateVars };
  if (baseFrontmatter.inputs && Array.isArray(baseFrontmatter.inputs)) {
    // Validate input fields
    const validatedInputs: InputField[] = [];
    for (let i = 0; i < baseFrontmatter.inputs.length; i++) {
      try {
        const validated = validateInputField(baseFrontmatter.inputs[i], i);
        validatedInputs.push(validated);
      } catch (err) {
        console.error(`Invalid input definition: ${(err as Error).message}`);
        process.exit(1);
      }
    }

    // Prompt for inputs (skips those provided via CLI)
    try {
      allTemplateVars = await promptInputs(validatedInputs, templateVars);
    } catch (err) {
      // User cancelled (Ctrl+C)
      process.exit(130);
    }
  }

  // Check for missing template variables (after prompts)
  const requiredVars = extractTemplateVars(rawBody);
  const missingVars = requiredVars.filter(v => !(v in allTemplateVars));
  if (missingVars.length > 0) {
    console.error(`Missing template variables: ${missingVars.join(", ")}`);
    console.error(`Use --${missingVars[0]} <value> to provide values`);
    process.exit(1);
  }

  // Apply template substitution to body
  const body = substituteTemplateVars(rawBody, allTemplateVars);

  // Merge frontmatter with CLI overrides
  const frontmatter = mergeFrontmatter(baseFrontmatter, overrides);

  // If no frontmatter, just cat the file
  if (Object.keys(frontmatter).length === 0) {
    console.log(content);
    process.exit(0);
  }

  // Check prerequisites before proceeding
  if (frontmatter.requires) {
    const prereqResult = await validatePrerequisites(frontmatter.requires);
    if (!prereqResult.success) {
      handlePrerequisiteFailure(prereqResult);
    }
  }

  // Resolve context globs and include file contents
  let contextXml = "";
  let contextFiles: ContextFile[] = [];
  if (frontmatter.context) {
    const cwd = dirname(filePath);
    contextFiles = await resolveContextGlobs(frontmatter.context, cwd);
    if (contextFiles.length > 0) {
      const stats = getContextStats(contextFiles);
      console.log(`Context: ${stats.fileCount} files, ${stats.totalLines} lines`);
      contextXml = formatContextAsXml(contextFiles);
    }
  }

  // Run before-commands
  const beforeResults = await runBeforeCommands(frontmatter.before);

  // Build final body with context, stdin, and appended text
  let finalBody = body;
  if (contextXml) {
    finalBody = `${contextXml}\n\n${finalBody}`;
  }
  if (stdinContent) {
    finalBody = `<stdin>\n${stdinContent}\n</stdin>\n\n${finalBody}`;
  }
  if (appendText) {
    finalBody = `${finalBody}\n\n${appendText}`;
  }

  // Build and run copilot
  const args = buildCopilotArgs(frontmatter);
  const prompt = buildPrompt(beforeResults, finalBody);

  // Capture output if we have extract mode, after commands, or caching
  const hasAfterCommands = frontmatter.after !== undefined;
  const hasExtract = frontmatter.extract && isValidExtractMode(frontmatter.extract);
  const useCache = frontmatter.cache === true && !noCache;
  const captureOutput = hasAfterCommands || hasExtract || useCache;

  // Check cache first if enabled
  let copilotResult: { exitCode: number; output: string };
  const cacheKey = useCache
    ? generateCacheKey({ frontmatter, body: finalBody, contextFiles })
    : null;

  if (cacheKey && !noCache) {
    const cachedOutput = await readCache(cacheKey);
    if (cachedOutput !== null) {
      console.log("Cache: hit");
      console.log(cachedOutput);
      copilotResult = { exitCode: 0, output: cachedOutput };
    } else {
      console.log("Cache: miss");
      copilotResult = await runCopilot(args, prompt, captureOutput);
      // Write to cache on success
      if (copilotResult.exitCode === 0 && copilotResult.output) {
        await writeCache(cacheKey, copilotResult.output);
      }
    }
  } else {
    copilotResult = await runCopilot(args, prompt, captureOutput);
  }

  // Apply output extraction if specified
  let outputForPipe = copilotResult.output;
  if (hasExtract && copilotResult.output) {
    outputForPipe = extractOutput(copilotResult.output, frontmatter.extract as ExtractMode);
    // Print extracted output (different from full output already shown by runCopilot)
    if (outputForPipe !== copilotResult.output) {
      console.log("\n--- Extracted output ---");
      console.log(outputForPipe);
    }
  }

  // Run after-commands with (possibly extracted) output piped to first command
  const afterResults = await runAfterCommands(frontmatter.after, outputForPipe);

  // Exit with copilot's exit code (or first failed after command)
  const failedAfter = afterResults.find(r => r.exitCode !== 0);
  process.exit(failedAfter ? failedAfter.exitCode : copilotResult.exitCode);
}

main();
