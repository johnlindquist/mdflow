#!/usr/bin/env bun
import { parseFrontmatter } from "./parse";
import { parseCliArgs, handleMaCommands } from "./cli";
import { substituteTemplateVars, extractTemplateVars } from "./template";
import { isRemoteUrl, fetchRemote, cleanupRemote } from "./remote";
import { resolveCommand, buildArgs, runCommand, extractPositionalMappings, extractEnvVars, killCurrentChildProcess, hasInteractiveMarker } from "./command";
import { expandImports, hasImports } from "./imports";
import { loadEnvFiles } from "./env";
import { loadGlobalConfig, getCommandDefaults, applyDefaults, applyInteractiveMode } from "./config";
import { initLogger, getParseLogger, getTemplateLogger, getCommandLogger, getImportLogger, getCurrentLogPath } from "./logger";
import { isDomainTrusted, promptForTrust, addTrustedDomain, extractDomain } from "./trust";
import { dirname, resolve } from "path";
import { input } from "@inquirer/prompts";
import { MAX_INPUT_SIZE, StdinSizeLimitError, exceedsLimit } from "./limits";
import { countTokens } from "./tokenizer";
import {
  MarkdownAgentError,
  EarlyExitRequest,
  UserCancelledError,
  FileNotFoundError,
  NetworkError,
  SecurityError,
  ConfigurationError,
  TemplateError,
  ImportError,
} from "./errors";

/**
 * Print error message with log path pointer to stderr
 */
function printErrorWithLogPath(message: string, logPath: string | null): void {
  console.error(`\n${message}`);
  if (logPath) {
    console.error(`   Detailed logs: ${logPath}`);
  }
}

/**
 * Read stdin if it's being piped (not a TTY)
 * Enforces MAX_INPUT_SIZE limit to prevent OOM errors
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of process.stdin) {
    totalBytes += chunk.length;
    if (exceedsLimit(totalBytes)) {
      throw new StdinSizeLimitError(totalBytes);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

async function main() {
  // Handle EPIPE gracefully when downstream closes the pipe early
  // (e.g., `md task.md | head -n 5`)
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") {
      process.exit(0);
    }
    throw err;
  });

  process.stderr.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") {
      process.exit(0);
    }
    throw err;
  });

  let logPath: string | null = null;

  try {
    const cliArgs = parseCliArgs(process.argv);

    // Handle subcommands (create, setup, logs, help)
    // These are intercepted before treating the argument as a file path
    const subcommand = cliArgs.filePath;

    if (subcommand === "create") {
      const { runCreate } = await import("./create");
      await runCreate(cliArgs.passthroughArgs);
      process.exit(0);
    }

    if (subcommand === "setup") {
      const { runSetup } = await import("./setup");
      await runSetup();
      process.exit(0);
    }

    if (subcommand === "logs") {
      const { getLogDir, listLogDirs } = await import("./logger");
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

    if (subcommand === "help") {
      cliArgs.help = true;
    }

    // Handle md's own commands when no file provided
    let filePath = cliArgs.filePath;
    if (!filePath || subcommand === "help") {
      const result = await handleMaCommands(cliArgs);
      if (result.selectedFile) {
        // User selected a file from the interactive picker
        filePath = result.selectedFile;
      } else if (!result.handled) {
        // No file selected and no command handled - show usage
        console.error("Usage: md <file.md> [flags for command]");
        console.error("       md <command> [options]");
        console.error("\nCommands: create, setup, logs, help");
        console.error("Run 'md help' for more info");
        throw new ConfigurationError("No agent file specified", 1);
      }
    }

    let { passthroughArgs } = cliArgs;

    // Check for --no-cache flag early (needed before fetchRemote call)
    // This flag forces a fresh fetch for remote URLs, bypassing the cache
    let noCacheFlag = false;
    const noCacheIndex = passthroughArgs.indexOf("--no-cache");
    if (noCacheIndex !== -1) {
      noCacheFlag = true;
      passthroughArgs = [...passthroughArgs.slice(0, noCacheIndex), ...passthroughArgs.slice(noCacheIndex + 1)];
    }

    // Handle remote URLs
    let localFilePath = filePath;
    let isRemote = false;

    if (isRemoteUrl(filePath)) {
      const remoteResult = await fetchRemote(filePath, { noCache: noCacheFlag });
      if (!remoteResult.success) {
        throw new NetworkError(`Failed to fetch remote file: ${remoteResult.error}`);
      }
      localFilePath = remoteResult.localPath!;
      isRemote = true;
    }

    // Set up graceful signal handling for SIGINT (Ctrl+C) and SIGTERM
    // This ensures cleanup of temp files and child processes on interruption
    const handleSignal = async (signal: string) => {
      // Kill child process if running
      killCurrentChildProcess();

      // Cleanup remote temporary file if applicable
      if (isRemote) {
        await cleanupRemote(localFilePath);
      }

      // Exit with appropriate code (128 + signal number)
      // SIGINT = 2, SIGTERM = 15
      const exitCode = signal === "SIGINT" ? 130 : 143;
      process.exit(exitCode);
    };

    process.on("SIGINT", () => handleSignal("SIGINT"));
    process.on("SIGTERM", () => handleSignal("SIGTERM"));

    const file = Bun.file(localFilePath);

    if (!await file.exists()) {
      throw new FileNotFoundError(`File not found: ${localFilePath}`);
    }

    // Load .env files from the markdown file's directory
    const fileDir = dirname(resolve(localFilePath));
    await loadEnvFiles(fileDir);

    // Initialize logger for this agent
    const logger = initLogger(localFilePath);
    logPath = getCurrentLogPath();
    logger.info({ filePath: localFilePath }, "Session started");

    // Read stdin if piped
    const stdinContent = await readStdin();

    const content = await file.text();

    // Parse frontmatter
    const { frontmatter: baseFrontmatter, body: rawBody } = parseFrontmatter(content);
    getParseLogger().debug({ frontmatter: baseFrontmatter, bodyLength: rawBody.length }, "Frontmatter parsed");

    // Check for --command flag in CLI args (consumed, not passed to command)
    // This allows: md generic.md --command claude
    let remainingArgs = [...passthroughArgs];
    let commandFromCli: string | undefined;

    const commandFlagIndex = remainingArgs.findIndex(arg => arg === "--command" || arg === "-c");
    if (commandFlagIndex !== -1 && commandFlagIndex + 1 < remainingArgs.length) {
      commandFromCli = remainingArgs[commandFlagIndex + 1];
      remainingArgs.splice(commandFlagIndex, 2); // Consume --command and its value
    }

    // Check for --dry-run flag (consumed by md, not passed to command)
    let dryRun = false;
    const dryRunIndex = remainingArgs.indexOf("--dry-run");
    if (dryRunIndex !== -1) {
      dryRun = true;
      remainingArgs.splice(dryRunIndex, 1); // Consume it
    }

    // Check for --trust flag (consumed by md, bypasses TOFU prompts for remote URLs)
    let trustFlag = false;
    const trustIndex = remainingArgs.indexOf("--trust");
    if (trustIndex !== -1) {
      trustFlag = true;
      remainingArgs.splice(trustIndex, 1); // Consume it
    }

    // Check for --_interactive or -_i flag (consumed by md, enables interactive mode)
    let interactiveFromCli = false;
    const interactiveIndex = remainingArgs.findIndex(arg => arg === "--_interactive" || arg === "-_i");
    if (interactiveIndex !== -1) {
      interactiveFromCli = true;
      remainingArgs.splice(interactiveIndex, 1); // Consume it
    }

    // Check for --_cwd flag (consumed by md, overrides working directory for !`cmd` inlines)
    let cwdFromCli: string | undefined;
    const cwdFlagIndex = remainingArgs.findIndex(arg => arg === "--_cwd");
    if (cwdFlagIndex !== -1 && cwdFlagIndex + 1 < remainingArgs.length) {
      cwdFromCli = remainingArgs[cwdFlagIndex + 1];
      remainingArgs.splice(cwdFlagIndex, 2); // Consume --_cwd and its value
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
      throw err; // Re-throw to be caught by outer handler
    }

    // Load global config and apply command defaults
    await loadGlobalConfig();
    const commandDefaults = await getCommandDefaults(command);
    let frontmatter = applyDefaults(baseFrontmatter, commandDefaults);

    // Check for .i. interactive marker in filename
    const interactiveFromFilename = hasInteractiveMarker(localFilePath);

    // Apply _interactive mode transformations (converts print defaults to interactive mode per command)
    // Interactive can be triggered by: CLI flag (--_interactive/-_i), filename (.i.), or frontmatter (_interactive/_i)
    frontmatter = applyInteractiveMode(frontmatter, command, interactiveFromFilename || interactiveFromCli);

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
        // Determine working directory for !`cmd` inlines:
        // Priority: CLI --_cwd > frontmatter _cwd > process.cwd()
        const commandCwd = cwdFromCli
          ?? (frontmatter._cwd as string | undefined)
          ?? process.cwd();

        getImportLogger().debug({ fileDir, commandCwd }, "Expanding imports");
        expandedBody = await expandImports(rawBody, fileDir, new Set(), false, {
          invocationCwd: commandCwd,
        });
        getImportLogger().debug({ originalLength: rawBody.length, expandedLength: expandedBody.length }, "Imports expanded");
      } catch (err) {
        getImportLogger().error({ error: (err as Error).message }, "Import expansion failed");
        // Wrap in ImportError with consistent prefix for error handling
        throw new ImportError(`Import error: ${(err as Error).message}`);
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
        // Only throw if piping/non-interactive
        throw new TemplateError(
          `Missing template variables: ${missingVars.join(", ")}. ` +
          `Use 'args:' in frontmatter to map CLI arguments to variables`
        );
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
        throw new EarlyExitRequest();
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

    // Handle dry-run mode: print what would be executed and exit
    if (dryRun) {
      console.log("═══════════════════════════════════════════════════════════");
      console.log("DRY RUN - Command will NOT be executed");
      console.log("═══════════════════════════════════════════════════════════\n");

      // Build final args with positional mappings applied (same as runCommand)
      let dryRunArgs = [...args];

      // Handle _subcommand: prepend subcommand(s) to args
      if (frontmatter._subcommand) {
        const subcommands = Array.isArray(frontmatter._subcommand)
          ? frontmatter._subcommand
          : [frontmatter._subcommand];
        dryRunArgs = [...subcommands, ...dryRunArgs];
      }

      for (let i = 0; i < positionals.length; i++) {
        const pos = i + 1;
        const value = positionals[i];
        if (positionalMappings.has(pos)) {
          const flagName = positionalMappings.get(pos)!;
          const flag = flagName.length === 1 ? `-${flagName}` : `--${flagName}`;
          dryRunArgs.push(flag, `"${value.replace(/"/g, '\\"')}"`);
        } else {
          dryRunArgs.push(`"${value.replace(/"/g, '\\"')}"`);
        }
      }

      console.log("Command:");
      console.log(`   ${command} ${dryRunArgs.join(" ")}\n`);

      console.log("Final Prompt:");
      console.log("───────────────────────────────────────────────────────────");
      console.log(finalBody);
      console.log("───────────────────────────────────────────────────────────\n");

      const estimatedTokens = countTokens(finalBody);
      console.log(`Estimated tokens: ~${estimatedTokens.toLocaleString()}`);

      // Cleanup remote temporary file if needed
      if (isRemote) {
        await cleanupRemote(localFilePath);
      }

      logger.info({ dryRun: true }, "Dry run completed");
      throw new EarlyExitRequest();
    }

    // TOFU (Trust on First Use) check for remote URLs
    if (isRemote && !trustFlag) {
      const domain = extractDomain(filePath);
      const trusted = await isDomainTrusted(filePath);

      if (!trusted) {
        // Check if we're in a TTY for interactive prompt
        if (!process.stdin.isTTY) {
          await cleanupRemote(localFilePath);
          throw new SecurityError(
            `Untrusted remote domain: ${domain}. ` +
            `Use --trust flag to bypass this check in non-interactive mode, ` +
            `or run interactively to add the domain to known_hosts.`
          );
        }

        // Interactive prompt for trust
        const trustResult = await promptForTrust(filePath, command, baseFrontmatter, rawBody);

        if (!trustResult.approved) {
          await cleanupRemote(localFilePath);
          throw new UserCancelledError("Execution cancelled by user");
        }

        if (trustResult.rememberDomain) {
          await addTrustedDomain(filePath);
          console.error(`\nDomain ${domain} added to known_hosts.\n`);
        }
      } else {
        getCommandLogger().debug({ domain }, "Domain already trusted");
      }
    }

    // Handle _subcommand: prepend subcommand(s) to args
    let finalCommand = command;
    let finalRunArgs = args;
    if (frontmatter._subcommand) {
      const subcommands = Array.isArray(frontmatter._subcommand)
        ? frontmatter._subcommand
        : [frontmatter._subcommand];
      finalRunArgs = [...subcommands, ...args];
    }

    getCommandLogger().info({ command: finalCommand, argsCount: finalRunArgs.length, promptLength: finalBody.length }, "Executing command");

    const runResult = await runCommand({
      command: finalCommand,
      args: finalRunArgs,
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

    // Report non-zero exit codes with log path
    if (runResult.exitCode !== 0) {
      printErrorWithLogPath(`Agent exited with code ${runResult.exitCode}`, logPath);
    }

    logger.info({ exitCode: runResult.exitCode }, "Session ended");
    process.exit(runResult.exitCode);

  } catch (err) {
    // Handle typed errors appropriately
    if (err instanceof EarlyExitRequest) {
      // Clean exit requested (--help, --logs, --setup, --dry-run, etc.)
      process.exit(err.code);
    }

    if (err instanceof UserCancelledError) {
      // User cancelled - exit quietly with code 0 (or 1 if appropriate)
      process.exit(err.code);
    }

    if (err instanceof MarkdownAgentError) {
      // Known error type - show message with log path
      printErrorWithLogPath(`Agent failed: ${err.message}`, logPath);
      process.exit(err.code);
    }

    // Unknown error - show message with log path
    printErrorWithLogPath(`Agent failed: ${(err as Error).message}`, logPath);
    process.exit(1);
  }
}

main();
