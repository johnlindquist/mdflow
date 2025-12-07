#!/usr/bin/env bun
import { parseFrontmatter, parseRawFrontmatter } from "./parse";
import { parseCliArgs, mergeFrontmatter } from "./cli";
import { safeParseFrontmatter } from "./schema";
import { substituteTemplateVars, extractTemplateVars } from "./template";
import { promptInputs, validateInputField } from "./inputs";
import { resolveContextGlobs, formatContextAsXml, getContextStats, type ContextFile } from "./context";
import { extractOutput, isValidExtractMode, type ExtractMode } from "./extract";
import { generateCacheKey, readCache, writeCache } from "./cache";
import { validatePrerequisites, handlePrerequisiteFailure } from "./prerequisites";
import { formatDryRun, type DryRunInfo } from "./dryrun";
import { isRemoteUrl, fetchRemote, cleanupRemote, printRemoteWarning } from "./remote";
import { resolveHarnessSync, type RunContext } from "./harnesses";
import { runBatch, formatBatchResults, parseBatchManifest } from "./batch";
import { runSetup } from "./setup";
import { offerRepair } from "./repair";
import { expandImports, hasImports } from "./imports";
import type { InputField } from "./types";
import { dirname, resolve } from "path";

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
  const { filePath, overrides, appendText, templateVars, noCache, dryRun, verbose, harness: cliHarness, passthroughArgs, check, json, runBatch: runBatchMode, concurrency, setup } = parseCliArgs(process.argv);

  // ---------------------------------------------------------
  // SETUP MODE
  // ---------------------------------------------------------
  if (setup) {
    await runSetup();
    process.exit(0);
  }

  // ---------------------------------------------------------
  // BATCH / SWARM MODE
  // ---------------------------------------------------------
  if (runBatchMode) {
    const stdinContent = await readStdin();
    if (!stdinContent) {
      console.error("Error: --run-batch requires a JSON manifest via stdin");
      console.error("Example: ma PLANNER.md | ma --run-batch");
      process.exit(1);
    }

    let jobs;
    try {
      jobs = parseBatchManifest(stdinContent);
    } catch (err) {
      console.error(`Error parsing batch manifest: ${(err as Error).message}`);
      process.exit(1);
    }

    if (verbose) {
      console.error(`[batch] Dispatching ${jobs.length} agents (concurrency: ${concurrency || 4})...`);
    }

    const results = await runBatch(jobs, {
      concurrency,
      verbose,
    });

    // Output batch summary
    console.log(formatBatchResults(results));

    // Summary of successful branches
    const branches = results
      .filter((r) => r.exitCode === 0 && r.branchName)
      .map((r) => r.branchName);

    if (branches.length > 0) {
      console.error("\n🌿 Worktrees committed. To merge:");
      console.error(`   git merge ${branches.join(" ")}`);
    }

    // Exit with error if any job failed
    process.exit(results.some((r) => r.exitCode !== 0) ? 1 : 0);
  }

  if (!filePath) {
    console.error("Usage: <file.md> [text] [options]");
    console.error("Run with --help for more options");
    console.error("Stdin can be piped to include in the prompt");
    process.exit(1);
  }

  // Handle remote URLs
  let localFilePath = filePath;
  let isRemote = false;
  const originalUrl = filePath;

  if (isRemoteUrl(filePath)) {
    printRemoteWarning(filePath);

    const remoteResult = await fetchRemote(filePath);
    if (!remoteResult.success) {
      console.error(`Failed to fetch remote file: ${remoteResult.error}`);
      process.exit(1);
    }
    localFilePath = remoteResult.localPath!;
    isRemote = true;
  }

  const file = Bun.file(localFilePath);

  if (!await file.exists()) {
    console.error(`File not found: ${localFilePath}`);
    process.exit(1);
  }

  // Read stdin if piped
  const stdinContent = await readStdin();

  const content = await file.text();

  // Handle --check mode: validate frontmatter without executing
  if (check) {
    let rawResult;
    try {
      rawResult = parseRawFrontmatter(content);
    } catch (err) {
      // Handle YAML syntax errors
      const errorMsg = (err as Error).message;
      if (json) {
        console.log(JSON.stringify({
          valid: false,
          file: localFilePath,
          errors: [errorMsg],
          content,
        }, null, 2));
      } else {
        console.error(`❌ ${localFilePath}: ${errorMsg}`);
      }
      process.exit(1);
    }

    // Validate against schema
    const validation = safeParseFrontmatter(rawResult.frontmatter);

    if (json) {
      // JSON output for piping to Doctor agent
      console.log(JSON.stringify({
        valid: validation.success,
        file: localFilePath,
        errors: validation.errors || [],
        content,
      }, null, 2));
    } else {
      // Human-readable output
      if (validation.success) {
        console.log(`✅ ${localFilePath} is valid`);
      } else {
        console.error(`❌ ${localFilePath} has errors:`);
        validation.errors?.forEach(e => console.error(`   - ${e}`));
      }
    }
    process.exit(validation.success ? 0 : 1);
  }

  // Parse frontmatter with interactive repair on error
  let baseFrontmatter;
  let rawBody;
  let currentContent = content;

  while (true) {
    try {
      const parsed = parseFrontmatter(currentContent);
      baseFrontmatter = parsed.frontmatter;
      rawBody = parsed.body;
      break;
    } catch (err) {
      const errorMessage = (err as Error).message;

      // Extract validation errors for repair context
      const errors = errorMessage.includes("Invalid frontmatter:")
        ? errorMessage.replace("Invalid frontmatter:\n", "").split("\n").map(e => e.trim()).filter(Boolean)
        : [errorMessage];

      // Offer interactive repair
      const shouldRetry = await offerRepair({
        filePath: resolve(localFilePath),
        content: currentContent,
        errors,
      });

      if (!shouldRetry) {
        // User declined repair or repair failed
        console.error(`\n${errorMessage}`);
        process.exit(1);
      }

      // Re-read the file after repair
      currentContent = await Bun.file(localFilePath).text();
    }
  }

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

  // Expand @file imports and !`command` inlines in the body
  const fileDir = dirname(resolve(localFilePath));
  let expandedBody = rawBody;

  if (hasImports(rawBody)) {
    try {
      expandedBody = await expandImports(rawBody, fileDir, new Set(), verbose);
      if (verbose) {
        console.error("[verbose] Imports expanded");
      }
    } catch (err) {
      console.error(`Import error: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  // Check for missing template variables (after prompts)
  const requiredVars = extractTemplateVars(expandedBody);
  const missingVars = requiredVars.filter(v => !(v in allTemplateVars));
  if (missingVars.length > 0) {
    console.error(`Missing template variables: ${missingVars.join(", ")}`);
    console.error(`Use --${missingVars[0]} <value> to provide values`);
    process.exit(1);
  }

  // Apply template substitution to body
  const body = substituteTemplateVars(expandedBody, allTemplateVars);

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
    const cwd = dirname(resolve(localFilePath));
    contextFiles = await resolveContextGlobs(frontmatter.context, cwd);
    if (contextFiles.length > 0) {
      const stats = getContextStats(contextFiles);
      console.error(`Context: ${stats.fileCount} files, ${stats.totalLines} lines`);
      contextXml = formatContextAsXml(contextFiles);
    }
  }

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

  // Resolve which harness to use
  const harness = resolveHarnessSync({ cliHarness, frontmatter });

  // Verbose output
  if (verbose) {
    console.error(`[verbose] Harness: ${harness.name}`);
    console.error(`[verbose] Model: ${frontmatter.model || "(default)"}`);
    if (contextFiles.length > 0) {
      console.error(`[verbose] Context files: ${contextFiles.length}`);
    }
    if (passthroughArgs.length > 0) {
      console.error(`[verbose] Passthrough args: ${passthroughArgs.join(" ")}`);
    }
  }

  // Handle dry-run mode - show what would be executed without running
  if (dryRun) {
    const harnessArgs = harness.buildArgs({
      prompt: finalBody,
      frontmatter,
      passthroughArgs,
      captureOutput: false,
    });
    const dryRunInfo: DryRunInfo = {
      frontmatter,
      prompt: finalBody,
      harnessArgs,
      harnessName: harness.name,
      contextFiles,
      beforeCommands: [],
      afterCommands: [],
      templateVars: allTemplateVars,
    };
    console.log(formatDryRun(dryRunInfo));

    // Cleanup remote file before exit
    if (isRemote) {
      await cleanupRemote(localFilePath);
    }
    process.exit(0);
  }

  // Capture output if we have extract mode or caching
  const hasExtract = frontmatter.extract && isValidExtractMode(frontmatter.extract);
  const useCache = frontmatter.cache === true && !noCache;
  const captureOutput = hasExtract || useCache;

  // Build run context
  const runContext: RunContext = {
    prompt: finalBody,
    frontmatter,
    passthroughArgs,
    captureOutput,
  };

  // Check cache first if enabled
  let runResult: { exitCode: number; output: string };
  const cacheKey = useCache
    ? generateCacheKey({ frontmatter, body: finalBody, contextFiles })
    : null;

  if (cacheKey && !noCache) {
    const cachedOutput = await readCache(cacheKey);
    if (cachedOutput !== null) {
      if (verbose) console.error("[verbose] Cache: hit");
      console.log(cachedOutput);
      runResult = { exitCode: 0, output: cachedOutput };
    } else {
      if (verbose) console.error("[verbose] Cache: miss");
      if (verbose) {
        const args = harness.buildArgs(runContext);
        console.error(`[verbose] Command: ${harness.getCommand()} ${args.join(" ")}`);
      }
      runResult = await harness.run(runContext);
      // Write to cache on success
      if (runResult.exitCode === 0 && runResult.output) {
        await writeCache(cacheKey, runResult.output);
      }
    }
  } else {
    if (verbose) {
      const args = harness.buildArgs(runContext);
      console.error(`[verbose] Command: ${harness.getCommand()} ${args.join(" ")}`);
    }
    runResult = await harness.run(runContext);
  }

  // Apply output extraction if specified
  if (hasExtract && runResult.output) {
    const extracted = extractOutput(runResult.output, frontmatter.extract as ExtractMode);
    // Print extracted output (different from full output already shown by runner)
    if (extracted !== runResult.output) {
      console.log("\n--- Extracted output ---");
      console.log(extracted);
    }
  }

  // Cleanup remote temporary file
  if (isRemote) {
    await cleanupRemote(localFilePath);
  }

  process.exit(runResult.exitCode);
}

main();
