#!/usr/bin/env bun
/**
 * Bundle mdflow codebase for AI upload
 * Creates a compressed markdown bundle suitable for pasting into AI models
 *
 * Usage:
 *   bun run scripts/bundle.ts           # Full bundle to stdout
 *   bun run scripts/bundle.ts -o        # Full bundle to mdflow-bundle.md
 *   bun run scripts/bundle.ts --core    # Core files only (~30k tokens)
 *   bun run bundle                       # Via npm script (full, to file)
 *   bun run bundle:core                  # Via npm script (core only)
 */

import { $ } from "bun";
import { join } from "path";
import { existsSync } from "fs";

const projectRoot = join(import.meta.dir, "..");
const outputArg = process.argv.includes("-o") || process.argv.includes("--output");
const coreOnly = process.argv.includes("--core");
const outputFile = coreOnly ? "mdflow-core-bundle.md" : "mdflow-bundle.md";

// Core files - the essential modules for understanding mdflow
const coreFiles = [
  // Entry + CLI
  "src/index.ts",
  "src/cli.ts",
  "src/cli-runner.ts",

  // Core execution
  "src/command.ts",
  "src/command-builder.ts",
  "src/runtime.ts",

  // Parsing & templates
  "src/parse.ts",
  "src/template.ts",
  "src/schema.ts",
  "src/types.ts",

  // Imports system
  "src/imports.ts",
  "src/imports-parser.ts",
  "src/imports-resolver.ts",
  "src/imports-types.ts",

  // Config & env
  "src/config.ts",
  "src/env.ts",

  // Adapters
  "src/adapters/index.ts",
  "src/adapters/claude.ts",
  "src/adapters/gemini.ts",

  // Docs
  "CLAUDE.md",
  "README.md",
  "package.json",
];

// Build the packx command
const args: string[] = [];

if (coreOnly) {
  // Core mode: specific files only
  args.push(...coreFiles);
} else {
  // Full mode: all source files except tests
  args.push("src/**/*.ts");
  args.push("-x", "*.test.ts");
  args.push("CLAUDE.md", "README.md", "package.json", "tsconfig.json");
}

// Compression options
args.push("--minify");         // Remove empty lines
args.push("--strip-comments"); // Remove comments

// Output format
args.push("-f", "markdown");

// Non-interactive for scripting
args.push("--no-interactive");

if (outputArg) {
  args.push("-o", outputFile);
}

const mode = coreOnly ? "core (~30k tokens)" : "full (~75k tokens)";
console.error("📦 Bundling mdflow codebase for AI upload...");
console.error(`   Mode: ${mode}`);
console.error(`   Output: ${outputArg ? outputFile : "stdout"}`);
console.error("");

try {
  await $`packx ${args}`.cwd(projectRoot);

  if (outputArg && existsSync(join(projectRoot, outputFile))) {
    const content = await Bun.file(join(projectRoot, outputFile)).text();
    const lines = content.split("\n").length;
    console.error(`\n✅ Bundle created: ${outputFile}`);
    console.error(`   Lines: ${lines.toLocaleString()}`);
  }
} catch (error) {
  console.error("❌ Bundle failed:", error);
  process.exit(1);
}
