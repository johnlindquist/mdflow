/**
 * Interactive command to create new agent files
 * Usage: md create [options]
 */

import { input, select, confirm } from "@inquirer/prompts";
import { existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import yaml from "js-yaml";
import { getProjectAgentsDir, getUserAgentsDir } from "./cli";

interface CreateOptions {
  name?: string;
  command?: string;
  location?: "cwd" | "project" | "user" | "custom";
  customDir?: string;
  content?: string;
  frontmatter: Record<string, unknown>;
}

/**
 * Parse CLI args into create options and frontmatter
 */
function parseCreateArgs(args: string[]): CreateOptions {
  const options: CreateOptions = {
    frontmatter: {},
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Handle positional arg as name if it's the first arg and not a flag
    if (i === 0 && !arg.startsWith("-")) {
      options.name = arg;
      continue;
    }

    if (!arg.startsWith("-")) continue;

    // Handle known flags
    if (arg === "--name" || arg === "-n") {
      options.name = args[++i];
    } else if (arg === "--_command" || arg === "-_c") {
      options.command = args[++i];
    } else if (arg === "--location" || arg === "-l") {
      const loc = args[++i];
      if (["cwd", "project", "user"].includes(loc)) {
        options.location = loc as "cwd" | "project" | "user";
      }
    } else if (arg === "--dir" || arg === "-d") {
      options.location = "custom";
      options.customDir = args[++i];
    } else if (arg === "--content" || arg === "--body") {
      options.content = args[++i];
    } else if (arg === "--global" || arg === "-g") {
      options.location = "user";
    } else if (arg === "--project" || arg === "-p") {
      options.location = "project";
    } else {
      // Treat as frontmatter
      const key = arg.replace(/^-+/, "");
      // If next arg is a value (not a flag), use it. Otherwise true.
      const nextArg = args[i + 1];

      if (nextArg && !nextArg.startsWith("-")) {
        // Simple type inference for cleaner YAML
        if (nextArg === "true") options.frontmatter[key] = true;
        else if (nextArg === "false") options.frontmatter[key] = false;
        else if (!isNaN(Number(nextArg)) && nextArg.trim() !== "")
          options.frontmatter[key] = Number(nextArg);
        else options.frontmatter[key] = nextArg;
        i++;
      } else {
        options.frontmatter[key] = true;
      }
    }
  }

  return options;
}

/**
 * Run the create wizard
 */
export async function runCreate(args: string[]): Promise<void> {
  // Handle help flag specially
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: md create [name] [flags]

Create a new markdown agent. Any unknown flags are added to frontmatter.

Options:
  --name, -n         Agent name (e.g. 'task')
  --_command, -_c    Tool to run (claude, gpt, python, etc)
  --project, -p      Save to project agents (.mdflow/)
  --global, -g       Save to global agents (~/.mdflow/)
  --content          Initial prompt content

Examples:
  md create task --_command claude
  md create search -g --model perplexity
`);
    return;
  }

  const options = parseCreateArgs(args);

  // 1. Name
  if (!options.name) {
    options.name = await input({
      message: "Agent name:",
      default: "task.claude.md",
      validate: (value) => value.length > 0 || "Name is required",
    });
  }

  // Ensure extension
  if (!options.name.endsWith(".md")) {
    options.name += ".md";
  }

  // 2. Command (if not specified and not obvious from name)
  const nameParts = options.name.split(".");
  // Matches name.command.md pattern
  const inferredCommand =
    nameParts.length >= 3 ? nameParts[nameParts.length - 2] : undefined;

  if (!options.command && !inferredCommand) {
    // Check if frontmatter has a model, often implies a specific tool
    const defaultCmd = options.frontmatter.model ? "claude" : "claude";

    options.command = await input({
      message: "Command to wrap (e.g. claude, python, bash):",
      default: defaultCmd,
    });
  }

  // 3. Location
  if (!options.location) {
    options.location = await select({
      message: "Where should we create this agent?",
      choices: [
        { name: `Current Directory (${process.cwd()})`, value: "cwd" },
        {
          name: "Project (.mdflow/)",
          value: "project",
          description: "Shared with team",
        },
        {
          name: "User (~/.mdflow/)",
          value: "user",
          description: "Personal global agents",
        },
      ],
    });
  }

  // Determine target directory
  let targetDir = process.cwd();
  if (options.location === "project") {
    targetDir = getProjectAgentsDir();
  } else if (options.location === "user") {
    targetDir = getUserAgentsDir();
  } else if (options.location === "custom" && options.customDir) {
    targetDir = resolve(options.customDir);
  }

  // 4. Content - empty by default
  if (options.content === undefined) {
    options.content = "";
  }

  // Prepare frontmatter - only include what user explicitly provided
  const finalFrontmatter = { ...options.frontmatter };

  // Construct YAML
  let fileContent = "";
  if (Object.keys(finalFrontmatter).length > 0) {
    fileContent += "---\n";
    fileContent += yaml.dump(finalFrontmatter);
    fileContent += "---\n\n";
  }

  fileContent += options.content;

  // Append newline
  if (!fileContent.endsWith("\n")) {
    fileContent += "\n";
  }

  // Ensure directory exists
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  const targetPath = join(targetDir, options.name);

  if (existsSync(targetPath)) {
    const overwrite = await confirm({
      message: `File ${options.name} already exists in ${targetDir}. Overwrite?`,
      default: false,
    });
    if (!overwrite) {
      console.log("Cancelled.");
      return;
    }
  }

  await Bun.write(targetPath, fileContent);

  console.log(`\n✅ Created agent: ${targetPath}`);

  // Suggest renaming if command isn't embedded and wasn't explicit
  if (
    options.command &&
    !inferredCommand &&
    !options.name.includes(`.${options.command}.`)
  ) {
    console.log(
      `\nTip: Consider naming your file "${options.name.replace(".md", "")}.${options.command}.md" to auto-detect the command.`
    );
  }

  // Show run command
  const relativePath =
    options.location === "cwd" ? `./${options.name}` : options.name;
  let runCmd = `md ${relativePath}`;

  // If we had to supply a command explicitly and it's not in the filename
  if (
    options.command &&
    !inferredCommand &&
    !options.name.includes(`.${options.command}.`)
  ) {
    runCmd += ` --_command ${options.command}`;
  }

  console.log(`\nRun it with:\n  ${runCmd}\n`);
}
