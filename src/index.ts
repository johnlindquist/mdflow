#!/usr/bin/env bun
import { parseFrontmatter } from "./parse";
import { parseCliArgs, handleMaCommands } from "./cli";
import { substituteTemplateVars, extractTemplateVars } from "./template";
import { isRemoteUrl, fetchRemote, cleanupRemote } from "./remote";
import { resolveCommand, buildArgs, runCommand, extractPositionalMappings, extractEnvVars } from "./command";
import { expandImports, hasImports } from "./imports";
import { loadEnvFiles } from "./env";
import { loadGlobalConfig, getCommandDefaults, applyDefaults } from "./config";
import { initLogger, getParseLogger, getTemplateLogger, getCommandLogger, getImportLogger } from "./logger";
import { dirname, resolve } from "path";
import { input } from "@inquirer/prompts";

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

  // Check for --command flag in CLI args (consumed, not passed to command)
  // This allows: ma generic.md --command claude
  let remainingArgs = [...passthroughArgs];
  let commandFromCli: string | undefined;

  const commandFlagIndex = remainingArgs.findIndex(arg => arg === "--command" || arg === "-c");
  if (commandFlagIndex !== -1 && commandFlagIndex + 1 < remainingArgs.length) {
    commandFromCli = remainingArgs[commandFlagIndex + 1];
    remainingArgs.splice(commandFlagIndex, 2); // Consume --command and its value
  }

  // Resolve command: CLI --command > MA_COMMAND env > filename
  let command: string;
  try {
    if (commandFromCli) {
      command = commandFromCli;
      getCommandLogger().debug({ command, source: "cli" }, "Command from --command flag");
    } else {
      command = resolveCommand(localFilePath);
      getCommandLogger().debug({ command }, "Command resolved");
    }
  } catch (err) {
    getCommandLogger().error({ error: (err as Error).message }, "Command resolution failed");
    console.error((err as Error).message);
    process.exit(1);
  }

  // Load global config and apply command defaults
  await loadGlobalConfig();
  const commandDefaults = await getCommandDefaults(command);
  const frontmatter = applyDefaults(baseFrontmatter, commandDefaults);

  // Extract and apply environment variables (object form) to process.env
  // This must happen BEFORE import expansion so !`command` inlines can use them
  const envVars = extractEnvVars(frontmatter);
  if (envVars) {
    for (const [key, value] of Object.entries(envVars)) {
      process.env[key] = value;
    }
  }

  // Consume named positional arguments from CLI
  let templateVars: Record<string, string> = {};

  if (frontmatter.args && Array.isArray(frontmatter.args)) {
    const requiredArgs = frontmatter.args;

    for (const argName of requiredArgs) {
      // Find the first non-flag argument
      const argIndex = remainingArgs.findIndex(arg => !arg.startsWith("-"));

      if (argIndex !== -1) {
        templateVars[argName] = remainingArgs[argIndex];
        // Consume it so it isn't passed to the command
        remainingArgs.splice(argIndex, 1);
      }
    }
  }

  // Extract $varname fields from frontmatter and match with --varname CLI flags
  // These are consumed (not passed to command) and become template variables
  // Frontmatter value is the default, CLI flag overrides it
  const namedVarFields = Object.keys(frontmatter)
    .filter(key => key.startsWith("$") && !/^\$\d+$/.test(key));

  for (const key of namedVarFields) {
    const varName = key.slice(1); // Remove $ prefix
    const defaultValue = frontmatter[key];

    // Look for --varname or --var-name (convert underscores to hyphens for matching)
    const flagVariants = [
      `--${varName}`,
      `--${varName.replace(/_/g, "-")}`,
    ];

    let foundInCli = false;
    for (const flag of flagVariants) {
      const flagIndex = remainingArgs.findIndex(arg => arg === flag);
      if (flagIndex !== -1 && flagIndex + 1 < remainingArgs.length) {
        templateVars[varName] = remainingArgs[flagIndex + 1];
        // Consume both flag and value
        remainingArgs.splice(flagIndex, 2);
        foundInCli = true;
        break;
      }
    }

    // Use default value from frontmatter if not provided via CLI
    if (!foundInCli && defaultValue !== undefined && defaultValue !== null && defaultValue !== "") {
      templateVars[varName] = String(defaultValue);
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
    // Check if interactive (TTY)
    if (process.stdin.isTTY) {
      console.error("Missing required variables. Please provide values:");
      for (const v of missingVars) {
        templateVars[v] = await input({ message: `${v}:` });
      }
    } else {
      // Only exit if piping/non-interactive
      console.error(`Missing template variables: ${missingVars.join(", ")}`);
      console.error(`Use 'args:' in frontmatter to map CLI arguments to variables`);
      process.exit(1);
    }
  }

  // Apply template substitution to body
  getTemplateLogger().debug({ vars: Object.keys(templateVars) }, "Substituting template variables");
  const body = substituteTemplateVars(expandedBody, templateVars);
  getTemplateLogger().debug({ bodyLength: body.length }, "Template substitution complete");

  // If no frontmatter and no command from filename, just cat the file
  if (Object.keys(baseFrontmatter).length === 0 && !commandDefaults) {
    // Check if we still have a command from filename
    try {
      resolveCommand(localFilePath);
    } catch {
      console.log(content);
      process.exit(0);
    }
  }

  // Build final prompt with stdin
  let finalBody = body;
  if (stdinContent) {
    finalBody = `<stdin>\n${stdinContent}\n</stdin>\n\n${finalBody}`;
  }

  // Build CLI args from frontmatter + remaining passthrough args
  const templateVarSet = new Set(Object.keys(templateVars));
  const args = [
    ...buildArgs(frontmatter, templateVarSet),
    ...remainingArgs,
  ];

  // Extract positional mappings ($1, $2, etc.)
  const positionalMappings = extractPositionalMappings(frontmatter);

  // Build positionals array: body is $1, any remaining unmapped CLI args would be $2+
  // For now, body is the only positional we support
  const positionals = [finalBody];

  getCommandLogger().info({ command, argsCount: args.length, promptLength: finalBody.length }, "Executing command");

  const runResult = await runCommand({
    command,
    args,
    positionals,
    positionalMappings,
    captureOutput: false,
    env: envVars,
  });

  getCommandLogger().info({ exitCode: runResult.exitCode }, "Command completed");

  // Cleanup remote temporary file
  if (isRemote) {
    await cleanupRemote(localFilePath);
  }

  logger.info({ exitCode: runResult.exitCode }, "Session ended");
  process.exit(runResult.exitCode);
}

main();
