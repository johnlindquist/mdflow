#!/usr/bin/env bun
import { parseFrontmatter } from "./parse";
import { parseCliArgs, mergeFrontmatter } from "./cli";
import { runBeforeCommands, runAfterCommands, buildCopilotArgs, buildPrompt, runCopilot, slugify } from "./run";

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
  const { filePath, overrides } = parseCliArgs(process.argv);

  if (!filePath) {
    console.error("Usage: <file.md> [options]");
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
  const { frontmatter: baseFrontmatter, body } = parseFrontmatter(content);

  // Merge frontmatter with CLI overrides
  const frontmatter = mergeFrontmatter(baseFrontmatter, overrides);

  // If no frontmatter, just cat the file
  if (Object.keys(frontmatter).length === 0) {
    console.log(content);
    process.exit(0);
  }

  // Run before-commands
  const beforeResults = await runBeforeCommands(frontmatter.before);

  // Include stdin content in the prompt if provided
  let finalBody = body;
  if (stdinContent) {
    finalBody = `<stdin>\n${stdinContent}\n</stdin>\n\n${body}`;
  }

  // Build and run copilot
  const args = buildCopilotArgs(frontmatter);
  const prompt = buildPrompt(beforeResults, finalBody);

  // Capture output if we have after commands to pipe to
  const hasAfterCommands = frontmatter.after !== undefined;
  const copilotResult = await runCopilot(args, prompt, hasAfterCommands);

  // Run after-commands with copilot output piped to first command
  const afterResults = await runAfterCommands(frontmatter.after, copilotResult.output);

  // Exit with copilot's exit code (or first failed after command)
  const failedAfter = afterResults.find(r => r.exitCode !== 0);
  process.exit(failedAfter ? failedAfter.exitCode : copilotResult.exitCode);
}

main();
