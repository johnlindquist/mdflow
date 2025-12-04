#!/usr/bin/env bun
import { parseFrontmatter } from "./parse";
import { runPreCommands, buildCopilotArgs, buildPrompt, runCopilot } from "./run";

async function main() {
  const filePath = process.argv[2];

  if (!filePath) {
    console.error("Usage: handle-md <file.md>");
    process.exit(1);
  }

  const file = Bun.file(filePath);

  if (!await file.exists()) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const content = await file.text();
  const { frontmatter, body } = parseFrontmatter(content);

  // If no frontmatter, just cat the file
  if (Object.keys(frontmatter).length === 0) {
    console.log(content);
    process.exit(0);
  }

  // Run pre-commands
  const preResults = await runPreCommands(frontmatter.pre);

  // Build and run copilot
  const args = buildCopilotArgs(frontmatter);
  const prompt = buildPrompt(preResults, body);

  const exitCode = await runCopilot(args, prompt);
  process.exit(exitCode);
}

main();
