#!/usr/bin/env bun
import { parseFrontmatter, parseRawFrontmatter } from "./parse";
import { parseCliArgs, mergeFrontmatter } from "./cli";
import { safeParseFrontmatter } from "./schema";
import { substituteTemplateVars, extractTemplateVars } from "./template";
import { promptInputs, validateInputField } from "./inputs";
import { generateCacheKey, readCache, writeCache } from "./cache";
import { validatePrerequisites, handlePrerequisiteFailure } from "./prerequisites";
import { formatDryRun, type DryRunInfo } from "./dryrun";
import { isRemoteUrl, fetchRemote, cleanupRemote, printRemoteWarning } from "./remote";
import { resolveCommand, buildArgs, runCommand } from "./command";
import { runSetup } from "./setup";
import { expandImports, hasImports } from "./imports";
import { loadEnvFiles } from "./env";
import { initLogger, getLogger, getParseLogger, getTemplateLogger, getCommandLogger, getCacheLogger, getImportLogger, getLogDir, listLogDirs } from "./logger";
import type { InputField } from "./types";
import { dirname, resolve, join } from "path";

/**
 * Read stdin if it's being piped (not a TTY)
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

async function main() {
  const {
    filePath,
    overrides,
    appendText,
    templateVars,
    noCache,
    dryRun,
    verbose,
    logs,
    command: cliCommand,
    passthroughArgs,
    check,
    json,
    setup,
  } = parseCliArgs(process.argv);

  // ---------------------------------------------------------
  // LOGS MODE - show log directory
  // ---------------------------------------------------------
  if (logs) {
    const logDir = getLogDir();
    console.log(`Log directory: ${logDir}\n`);
    const dirs = listLogDirs();
    if (dirs.length === 0) {
      console.log("No agent logs yet. Run an agent to generate logs.");
    } else {
      console.log("Agent logs:");
      for (const dir of dirs) {
        console.log(`  ${dir}/`);
      }
    }
    process.exit(0);
  }

  // ---------------------------------------------------------
  // SETUP MODE
  // ---------------------------------------------------------
  if (setup) {
    await runSetup();
    process.exit(0);
  }

  if (!filePath) {
    console.error("Usage: <file.md> [text] [options]");
    console.error("Run with --help for more options");
    process.exit(1);
  }

  // Handle remote URLs
  let localFilePath = filePath;
  let isRemote = false;

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

  // Load .env files from the markdown file's directory
  const fileDir = dirname(resolve(localFilePath));
  const envLoaded = await loadEnvFiles(fileDir, verbose);

  // Initialize logger for this agent
  const logger = initLogger(localFilePath);
  logger.info({ filePath: localFilePath, verbose, envFilesLoaded: envLoaded }, "Session started");

  // Read stdin if piped
  const stdinContent = await readStdin();

  const content = await file.text();

  // Handle --check mode: validate frontmatter without executing
  if (check) {
    let rawResult;
    try {
      rawResult = parseRawFrontmatter(content);
    } catch (err) {
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

    const validation = safeParseFrontmatter(rawResult.frontmatter);

    if (json) {
      console.log(JSON.stringify({
        valid: validation.success,
        file: localFilePath,
        errors: validation.errors || [],
        content,
      }, null, 2));
    } else {
      if (validation.success) {
        console.log(`✅ ${localFilePath} is valid`);
      } else {
        console.error(`❌ ${localFilePath} has errors:`);
        validation.errors?.forEach(e => console.error(`   - ${e}`));
      }
    }
    process.exit(validation.success ? 0 : 1);
  }

  // Parse frontmatter
  const { frontmatter: baseFrontmatter, body: rawBody } = parseFrontmatter(content);
  getParseLogger().debug({ frontmatter: baseFrontmatter, bodyLength: rawBody.length }, "Frontmatter parsed");

  // Handle wizard mode inputs
  let allTemplateVars = { ...templateVars };
  if (baseFrontmatter.inputs && Array.isArray(baseFrontmatter.inputs)) {
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

    try {
      allTemplateVars = await promptInputs(validatedInputs, templateVars);
    } catch (err) {
      process.exit(130);
    }
  }

  // Expand @file imports and !`command` inlines
  const fileDir = dirname(resolve(localFilePath));
  let expandedBody = rawBody;

  if (hasImports(rawBody)) {
    try {
      getImportLogger().debug({ fileDir }, "Expanding imports");
      expandedBody = await expandImports(rawBody, fileDir, new Set(), verbose);
      getImportLogger().debug({ originalLength: rawBody.length, expandedLength: expandedBody.length }, "Imports expanded");
      if (verbose) {
        console.error("[verbose] Imports expanded");
      }
    } catch (err) {
      getImportLogger().error({ error: (err as Error).message }, "Import expansion failed");
      console.error(`Import error: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  // Check for missing template variables
  const requiredVars = extractTemplateVars(expandedBody);
  const missingVars = requiredVars.filter(v => !(v in allTemplateVars));
  if (missingVars.length > 0) {
    console.error(`Missing template variables: ${missingVars.join(", ")}`);
    console.error(`Use --${missingVars[0]} <value> to provide values`);
    process.exit(1);
  }

  // Apply template substitution to body
  getTemplateLogger().debug({ vars: Object.keys(allTemplateVars) }, "Substituting template variables");
  const body = substituteTemplateVars(expandedBody, allTemplateVars);
  getTemplateLogger().debug({ bodyLength: body.length }, "Template substitution complete");

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

  // Build final prompt with stdin and appended text
  let finalBody = body;
  if (stdinContent) {
    finalBody = `<stdin>\n${stdinContent}\n</stdin>\n\n${finalBody}`;
  }
  if (appendText) {
    finalBody = `${finalBody}\n\n${appendText}`;
  }

  // Resolve command
  let command: string;
  try {
    command = resolveCommand({
      cliCommand,
      frontmatter,
      filePath: localFilePath,
    });
    getCommandLogger().debug({ command, cliCommand, fromFilename: !cliCommand && !frontmatter.command }, "Command resolved");
  } catch (err) {
    getCommandLogger().error({ error: (err as Error).message }, "Command resolution failed");
    console.error((err as Error).message);
    process.exit(1);
  }

  // Build CLI args from frontmatter (excluding template vars)
  const templateVarSet = new Set(Object.keys(allTemplateVars));
  const args = [
    ...buildArgs(frontmatter, templateVarSet),
    ...passthroughArgs,
  ];

  // Verbose output
  if (verbose) {
    console.error(`[verbose] Command: ${command}`);
    if (args.length > 0) {
      console.error(`[verbose] Args: ${args.join(" ")}`);
    }
  }

  // Handle dry-run mode
  if (dryRun) {
    const dryRunInfo: DryRunInfo = {
      frontmatter,
      prompt: finalBody,
      harnessArgs: args,
      harnessName: command,
      templateVars: allTemplateVars,
    };
    console.log(formatDryRun(dryRunInfo));

    if (isRemote) {
      await cleanupRemote(localFilePath);
    }
    process.exit(0);
  }

  // Caching
  const useCache = frontmatter.cache === true && !noCache;
  const cacheKey = useCache
    ? generateCacheKey({ frontmatter, body: finalBody })
    : null;

  let runResult: { exitCode: number; output: string };

  if (cacheKey && !noCache) {
    const cachedOutput = await readCache(cacheKey);
    if (cachedOutput !== null) {
      getCacheLogger().debug({ cacheKey }, "Cache hit");
      if (verbose) console.error("[verbose] Cache: hit");
      console.log(cachedOutput);
      runResult = { exitCode: 0, output: cachedOutput };
    } else {
      getCacheLogger().debug({ cacheKey }, "Cache miss");
      if (verbose) console.error("[verbose] Cache: miss");
      if (verbose) {
        console.error(`[verbose] Running: ${command} ${args.join(" ")}`);
      }
      getCommandLogger().info({ command, argsCount: args.length, promptLength: finalBody.length }, "Executing command");
      runResult = await runCommand({
        command,
        args,
        prompt: finalBody,
        captureOutput: useCache,
        positionalMap: frontmatter["$1"] as string | undefined,
      });
      getCommandLogger().info({ exitCode: runResult.exitCode }, "Command completed");
      if (runResult.exitCode === 0 && runResult.output) {
        await writeCache(cacheKey, runResult.output);
        getCacheLogger().debug({ cacheKey }, "Result cached");
      }
    }
  } else {
    if (verbose) {
      console.error(`[verbose] Running: ${command} ${args.join(" ")}`);
    }
    getCommandLogger().info({ command, argsCount: args.length, promptLength: finalBody.length }, "Executing command");
    runResult = await runCommand({
      command,
      args,
      prompt: finalBody,
      captureOutput: false,
      positionalMap: frontmatter["$1"] as string | undefined,
    });
    getCommandLogger().info({ exitCode: runResult.exitCode }, "Command completed");
  }

  // Cleanup remote temporary file
  if (isRemote) {
    await cleanupRemote(localFilePath);
  }

  logger.info({ exitCode: runResult.exitCode }, "Session ended");
  process.exit(runResult.exitCode);
}

main();
