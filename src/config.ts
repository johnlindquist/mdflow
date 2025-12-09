/**
 * Global and project-level configuration for mdflow
 * Loads defaults from ~/.mdflow/config.yaml
 * Cascades with project configs: global → git root → CWD (later overrides earlier)
 *
 * This module uses pure functions without module-level state.
 * Configuration is explicitly passed through the call chain via RunContext.
 */

import { homedir } from "os";
import { join, dirname, resolve } from "path";
import { existsSync, statSync } from "fs";
import yaml from "js-yaml";
import type { AgentFrontmatter, GlobalConfig, CommandDefaults, RunContext } from "./types";

// Re-export types for convenience
export type { GlobalConfig, CommandDefaults } from "./types";

const CONFIG_DIR = join(homedir(), ".mdflow");
const CONFIG_FILE = join(CONFIG_DIR, "config.yaml");

/** Project config file names (checked in order) */
const PROJECT_CONFIG_NAMES = ["mdflow.config.yaml", ".mdflow.yaml", ".mdflow.json"];

/**
 * Built-in defaults (used when no config file exists)
 * All tools default to PRINT mode (non-interactive)
 */
export const BUILTIN_DEFAULTS: GlobalConfig = {
  commands: {
    copilot: {
      $1: "prompt",       // Map body to --prompt for copilot (print mode)
      silent: true,       // Output only the agent response (no stats)
    },
    claude: {
      print: true,        // --print flag for non-interactive mode
    },
    codex: {
      _subcommand: "exec",  // Use 'exec' subcommand for non-interactive mode
    },
    // gemini defaults to one-shot mode (no special flags needed)
  },
};

/**
 * Apply _interactive mode transformations to frontmatter
 * Converts print defaults to interactive mode per command
 *
 * @param frontmatter - The frontmatter after defaults are applied
 * @param command - The resolved command name
 * @param interactiveFromFilename - Whether .i. was detected in filename
 * @returns Transformed frontmatter for interactive mode
 */
export function applyInteractiveMode(
  frontmatter: AgentFrontmatter,
  command: string,
  interactiveFromExternal: boolean = false
): AgentFrontmatter {
  // Check if _interactive or _i is enabled
  // Can be: true, empty string (YAML key with no value), null (YAML key with explicit null), or external trigger
  // NOTE: We check key existence separately because ?? treats null as "nullish" and skips to next value
  const hasInteractiveKey = "_interactive" in frontmatter;
  const hasIKey = "_i" in frontmatter;
  const interactiveValue = hasInteractiveKey ? frontmatter._interactive : frontmatter._i;
  const interactiveMode = interactiveFromExternal ||
    interactiveValue === true ||
    interactiveValue === "" ||
    (hasInteractiveKey && interactiveValue === null) ||
    (hasIKey && interactiveValue === null) ||
    (interactiveValue !== undefined && interactiveValue !== false);

  if (!interactiveMode) {
    return frontmatter;
  }

  // Remove _interactive and _i from output (they're meta-keys, not CLI flags)
  const result = { ...frontmatter };
  delete result._interactive;
  delete result._i;

  switch (command) {
    case "copilot":
      // copilot: Change from --prompt to --interactive
      result.$1 = "interactive";
      break;

    case "claude":
      // claude: Remove --print flag (interactive is default without it)
      delete result.print;
      break;

    case "codex":
      // codex: Remove _subcommand (interactive is default without exec subcommand)
      delete result._subcommand;
      break;

    case "gemini":
      // gemini: Add --prompt-interactive flag
      result.$1 = "prompt-interactive";
      break;

    default:
      // Unknown command - just remove _interactive, no other changes
      break;
  }

  return result;
}

// NOTE: Module-level caching has been removed to enable parallel testing.
// Use loadGlobalConfig(), loadProjectConfig(), and loadFullConfig() which
// are now pure functions that return fresh config instances each call.
// For performance-sensitive code paths, cache the result in a RunContext.

/**
 * Find the git root directory starting from a given path
 * Walks up the directory tree looking for .git
 * @returns The git root path, or null if not in a git repo
 */
export function findGitRoot(startPath: string): string | null {
  let current = resolve(startPath);
  let previous = "";

  // Walk up until we hit the filesystem root (when dirname returns the same path)
  while (current !== previous) {
    const gitPath = join(current, ".git");
    if (existsSync(gitPath)) {
      // Check if .git is a directory (normal repo) or file (worktree)
      try {
        const stat = statSync(gitPath);
        if (stat.isDirectory() || stat.isFile()) {
          return current;
        }
      } catch {
        // Continue searching if stat fails
      }
    }
    previous = current;
    current = dirname(current);
  }

  return null;
}

/**
 * Find project config file in a directory
 * Checks for mdflow.config.yaml, .mdflow.yaml, .mdflow.json
 * @returns The config file path if found, null otherwise
 */
function findProjectConfigFile(dir: string): string | null {
  for (const name of PROJECT_CONFIG_NAMES) {
    const configPath = join(dir, name);
    if (existsSync(configPath)) {
      return configPath;
    }
  }
  return null;
}

/**
 * Load config from a file (yaml or json)
 */
async function loadConfigFile(filePath: string): Promise<GlobalConfig | null> {
  try {
    const file = Bun.file(filePath);
    if (!await file.exists()) {
      return null;
    }
    const content = await file.text();

    if (filePath.endsWith(".json")) {
      return JSON.parse(content) as GlobalConfig;
    } else {
      return yaml.load(content) as GlobalConfig;
    }
  } catch {
    return null;
  }
}

/**
 * Load project-level config with cascade: git root → CWD
 * Returns merged config from both locations (CWD takes priority)
 *
 * This is a pure function - no caching. For performance-sensitive code,
 * store the result in RunContext.config.
 */
export async function loadProjectConfig(cwd: string): Promise<GlobalConfig> {
  const resolvedCwd = resolve(cwd);
  let projectConfig: GlobalConfig = {};

  // 1. Load from git root (if different from CWD)
  const gitRoot = findGitRoot(resolvedCwd);
  if (gitRoot && gitRoot !== resolvedCwd) {
    const gitRootConfigFile = findProjectConfigFile(gitRoot);
    if (gitRootConfigFile) {
      const gitRootConfig = await loadConfigFile(gitRootConfigFile);
      if (gitRootConfig) {
        projectConfig = gitRootConfig;
      }
    }
  }

  // 2. Load from CWD (overrides git root)
  const cwdConfigFile = findProjectConfigFile(resolvedCwd);
  if (cwdConfigFile) {
    const cwdConfig = await loadConfigFile(cwdConfigFile);
    if (cwdConfig) {
      projectConfig = mergeConfigs(projectConfig, cwdConfig);
    }
  }

  return projectConfig;
}

/**
 * Load global config from ~/.mdflow/config.yaml
 * Falls back to built-in defaults if file doesn't exist
 *
 * This is a pure function - no caching. For performance-sensitive code,
 * store the result in RunContext.config.
 *
 * Always returns a fresh copy to ensure isolation between callers.
 */
export async function loadGlobalConfig(): Promise<GlobalConfig> {
  try {
    const file = Bun.file(CONFIG_FILE);
    if (await file.exists()) {
      const content = await file.text();
      const parsed = yaml.load(content) as GlobalConfig;
      // Merge with built-in defaults (user config takes priority)
      return mergeConfigs(BUILTIN_DEFAULTS, parsed);
    }
  } catch {
    // Fall back to built-in defaults on parse error
  }
  // Return a deep clone to ensure callers get an independent copy
  return mergeConfigs(BUILTIN_DEFAULTS, {});
}

/**
 * Load fully merged config: built-in defaults → global → git root → CWD
 * This is the main entry point for loading config with project-level overrides
 */
export async function loadFullConfig(cwd: string = process.cwd()): Promise<GlobalConfig> {
  const globalConfig = await loadGlobalConfig();
  const projectConfig = await loadProjectConfig(cwd);

  // Merge: global → project (project takes priority)
  return mergeConfigs(globalConfig, projectConfig);
}

/**
 * Deep clone a GlobalConfig object
 * This ensures modifications to the returned config don't affect the source.
 */
function deepCloneConfig(config: GlobalConfig): GlobalConfig {
  const result: GlobalConfig = {};

  if (config.commands) {
    result.commands = {};
    for (const [cmd, defaults] of Object.entries(config.commands)) {
      result.commands[cmd] = { ...defaults };
    }
  }

  return result;
}

/**
 * Deep merge two configs (second takes priority)
 * Returns a new object - does not modify either input.
 */
export function mergeConfigs(base: GlobalConfig, override: GlobalConfig): GlobalConfig {
  // Start with a deep clone of base
  const result = deepCloneConfig(base);

  if (override.commands) {
    result.commands = result.commands ? { ...result.commands } : {};
    for (const [cmd, defaults] of Object.entries(override.commands)) {
      result.commands[cmd] = {
        ...(result.commands[cmd] || {}),
        ...defaults,
      };
    }
  }

  return result;
}

/**
 * Get defaults for a specific command
 */
export async function getCommandDefaults(command: string): Promise<CommandDefaults | undefined> {
  const config = await loadGlobalConfig();
  return config.commands?.[command];
}

/**
 * Apply command defaults to frontmatter
 * Frontmatter values take priority over defaults
 */
export function applyDefaults(
  frontmatter: AgentFrontmatter,
  defaults: CommandDefaults | undefined
): AgentFrontmatter {
  if (!defaults) {
    return frontmatter;
  }

  // Defaults go first, frontmatter overrides
  const result: AgentFrontmatter = { ...defaults };

  for (const [key, value] of Object.entries(frontmatter)) {
    result[key] = value;
  }

  return result;
}

/**
 * Get the config directory path
 */
export function getConfigDir(): string {
  return CONFIG_DIR;
}

/**
 * Get the config file path
 */
export function getConfigFile(): string {
  return CONFIG_FILE;
}

/**
 * Clear the cached config (for testing)
 * @deprecated No-op function kept for backward compatibility.
 * Module-level caching has been removed - config functions are now pure.
 */
export function clearConfigCache(): void {
  // No-op: caching has been removed from this module
}

/**
 * Clear only the project config cache (for testing)
 * @deprecated No-op function kept for backward compatibility.
 * Module-level caching has been removed - config functions are now pure.
 */
export function clearProjectConfigCache(): void {
  // No-op: caching has been removed from this module
}

// ============================================================================
// Aliases for backward compatibility
// All config functions are now pure (no caching), so these are simple aliases.
// ============================================================================

/**
 * Load global config from ~/.mdflow/config.yaml (no caching)
 * @deprecated Use loadGlobalConfig() instead - all functions are now pure.
 */
export const loadGlobalConfigFresh = loadGlobalConfig;

/**
 * Load project-level config with cascade: git root → CWD (no caching)
 * @deprecated Use loadProjectConfig() instead - all functions are now pure.
 */
export const loadProjectConfigFresh = loadProjectConfig;

/**
 * Load fully merged config: built-in defaults → global → git root → CWD (no caching)
 * @deprecated Use loadFullConfig() instead - all functions are now pure.
 */
export const loadFullConfigFresh = loadFullConfig;

/**
 * Get defaults for a specific command from a config object
 * This is the pure function version that works with RunContext
 */
export function getCommandDefaultsFromConfig(
  config: GlobalConfig,
  command: string
): CommandDefaults | undefined {
  return config.commands?.[command];
}
