/**
 * Global and project-level configuration for markdown-agent
 * Loads defaults from ~/.markdown-agent/config.yaml
 * Cascades with project configs: global → git root → CWD (later overrides earlier)
 */

import { homedir } from "os";
import { join, dirname, resolve } from "path";
import { existsSync, statSync } from "fs";
import yaml from "js-yaml";
import type { AgentFrontmatter } from "./types";

const CONFIG_DIR = join(homedir(), ".markdown-agent");
const CONFIG_FILE = join(CONFIG_DIR, "config.yaml");

/** Project config file names (checked in order) */
const PROJECT_CONFIG_NAMES = ["ma.config.yaml", ".markdown-agent.yaml", ".markdown-agent.json"];

/**
 * Command-specific defaults
 * Keys starting with $ are positional mappings
 * Other keys are default flags
 */
export interface CommandDefaults {
  /** Map positional arg N to a flag (e.g., $1: "prompt" → --prompt <body>) */
  [key: `$${number}`]: string;
  /**
   * Context window limit override (in tokens)
   * Overrides model-based defaults for token limit calculations
   */
  context_window?: number;
  /** Default flag values */
  [key: string]: unknown;
}

/**
 * Global config structure
 */
export interface GlobalConfig {
  /** Default settings per command */
  commands?: Record<string, CommandDefaults>;
}

/**
 * Built-in defaults (used when no config file exists)
 */
const BUILTIN_DEFAULTS: GlobalConfig = {
  commands: {
    copilot: {
      $1: "prompt",  // Map body to --prompt for copilot
    },
  },
};

let cachedGlobalConfig: GlobalConfig | null = null;
let cachedProjectConfig: { cwd: string; config: GlobalConfig } | null = null;

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
 * Checks for ma.config.yaml, .markdown-agent.yaml, .markdown-agent.json
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
 */
export async function loadProjectConfig(cwd: string): Promise<GlobalConfig> {
  const resolvedCwd = resolve(cwd);

  // Check cache
  if (cachedProjectConfig && cachedProjectConfig.cwd === resolvedCwd) {
    return cachedProjectConfig.config;
  }

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

  // Cache the result
  cachedProjectConfig = { cwd: resolvedCwd, config: projectConfig };

  return projectConfig;
}

/**
 * Load global config from ~/.markdown-agent/config.yaml
 * Falls back to built-in defaults if file doesn't exist
 */
export async function loadGlobalConfig(): Promise<GlobalConfig> {
  if (cachedGlobalConfig) {
    return cachedGlobalConfig;
  }

  try {
    const file = Bun.file(CONFIG_FILE);
    if (await file.exists()) {
      const content = await file.text();
      const parsed = yaml.load(content) as GlobalConfig;
      // Merge with built-in defaults (user config takes priority)
      cachedGlobalConfig = mergeConfigs(BUILTIN_DEFAULTS, parsed);
    } else {
      cachedGlobalConfig = BUILTIN_DEFAULTS;
    }
  } catch {
    // Fall back to built-in defaults on parse error
    cachedGlobalConfig = BUILTIN_DEFAULTS;
  }

  return cachedGlobalConfig;
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
 * Deep merge two configs (second takes priority)
 */
function mergeConfigs(base: GlobalConfig, override: GlobalConfig): GlobalConfig {
  const result: GlobalConfig = { ...base };

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
 */
export function clearConfigCache(): void {
  cachedGlobalConfig = null;
  cachedProjectConfig = null;
}

/**
 * Clear only the project config cache (for testing)
 */
export function clearProjectConfigCache(): void {
  cachedProjectConfig = null;
}
