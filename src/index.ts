#!/usr/bin/env bun
import { parseFrontmatter } from "./parse";
import { parseCliArgs, handleMaCommands } from "./cli";
import { substituteTemplateVars, extractTemplateVars } from "./template";
import { promptInputs, validateInputField } from "./inputs";
import { generateCacheKey, readCache, writeCache } from "./cache";
import { validatePrerequisites, handlePrerequisiteFailure } from "./prerequisites";
import { isRemoteUrl, fetchRemote, cleanupRemote, printRemoteWarning } from "./remote";
import { resolveCommand, buildArgs, runCommand } from "./command";
import { expandImports, hasImports } from "./imports";
import { loadEnvFiles } from "./env";
import { initLogger, getParseLogger, getTemplateLogger, getCommandLogger, getCacheLogger, getImportLogger } from "./logger";
import type { InputField } from "./types";
import { dirname, resolve } from "path";

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
  const cliArgs = parseCliArgs(process.argv);

  // Handle ma's own commands when no file provided
  if (!cliArgs.filePath) {
    await handleMaCommands(cliArgs);
    console.error("Usage: ma <file.md> [flags for command]");
    console.error("Run 'ma --help' for more info");
    process.exit(1);
  }

  const { filePath, passthroughArgs } = cliArgs;

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
  await loadEnvFiles(fileDir);

  // Initialize logger for this agent
  const logger = initLogger(localFilePath);
  logger.info({ filePath: localFilePath }, "Session started");

  // Read stdin if piped
  const stdinContent = await readStdin();

  const content = await file.text();

  // Parse frontmatter
  const { frontmatter: baseFrontmatter, body: rawBody } = parseFrontmatter(content);
  getParseLogger().debug({ frontmatter: baseFrontmatter, bodyLength: rawBody.length }, "Frontmatter parsed");

  // Handle wizard mode inputs
  let templateVars: Record<string, string> = {};
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
      templateVars = await promptInputs(validatedInputs, {});
    } catch (err) {
      process.exit(130);
    }
  }

  // Expand @file imports and !`command` inlines
  let expandedBody = rawBody;

  if (hasImports(rawBody)) {
    try {
      getImportLogger().debug({ fileDir }, "Expanding imports");
      expandedBody = await expandImports(rawBody, fileDir, new Set());
      getImportLogger().debug({ originalLength: rawBody.length, expandedLength: expandedBody.length }, "Imports expanded");
    } catch (err) {
      getImportLogger().error({ error: (err as Error).message }, "Import expansion failed");
      console.error(`Import error: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  // Check for missing template variables
  const requiredVars = extractTemplateVars(expandedBody);
  const missingVars = requiredVars.filter(v => !(v in templateVars));
  if (missingVars.length > 0) {
    console.error(`Missing template variables: ${missingVars.join(", ")}`);
    console.error(`Define 'inputs:' in frontmatter to prompt for values`);
    process.exit(1);
  }

  // Apply template substitution to body
  getTemplateLogger().debug({ vars: Object.keys(templateVars) }, "Substituting template variables");
  const body = substituteTemplateVars(expandedBody, templateVars);
  getTemplateLogger().debug({ bodyLength: body.length }, "Template substitution complete");

  // Use frontmatter as-is (no CLI overrides)
  const frontmatter = baseFrontmatter;

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

  // Build final prompt with stdin
  let finalBody = body;
  if (stdinContent) {
    finalBody = `<stdin>\n${stdinContent}\n</stdin>\n\n${finalBody}`;
  }

  // Resolve command
  let command: string;
  try {
    command = resolveCommand({
      frontmatter,
      filePath: localFilePath,
    });
    getCommandLogger().debug({ command, fromFilename: !frontmatter.command }, "Command resolved");
  } catch (err) {
    getCommandLogger().error({ error: (err as Error).message }, "Command resolution failed");
    console.error((err as Error).message);
    process.exit(1);
  }

  // Build CLI args from frontmatter + passthrough args
  const templateVarSet = new Set(Object.keys(templateVars));
  const args = [
    ...buildArgs(frontmatter, templateVarSet),
    ...passthroughArgs,
  ];

  // Caching
  const noCache = process.env.MA_NO_CACHE === "1";
  const useCache = frontmatter.cache === true && !noCache;
  const cacheKey = useCache
    ? generateCacheKey({ frontmatter, body: finalBody })
    : null;

  let runResult: { exitCode: number; output: string };

  if (cacheKey && !noCache) {
    const cachedOutput = await readCache(cacheKey);
    if (cachedOutput !== null) {
      getCacheLogger().debug({ cacheKey }, "Cache hit");
      console.log(cachedOutput);
      runResult = { exitCode: 0, output: cachedOutput };
    } else {
      getCacheLogger().debug({ cacheKey }, "Cache miss");
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
