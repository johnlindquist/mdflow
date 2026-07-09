/**
 * Shared project-boundary discovery for mdflow's creation, discovery, and
 * direct-execution surfaces. Keep this module lightweight: it is used on the
 * CLI cold path and must not pull in prompts, engines, or TUI dependencies.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const PROJECT_CONFIG_NAMES = [
  "mdflow.config.yaml",
  ".mdflow.yaml",
  ".mdflow.json",
] as const;

export type ProjectRootSource = "config" | "flows" | "git" | "cwd";

export interface ProjectRootResolution {
  projectRoot: string;
  source: ProjectRootSource;
  existingConfigPath?: string;
}

export interface AsyncProjectRootProbe {
  exists(path: string): Promise<boolean>;
  isDirectory(path: string): Promise<boolean>;
}

function syncIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function startDirectory(startPath: string): string {
  const absolute = resolve(startPath);
  try {
    return statSync(absolute).isDirectory() ? absolute : dirname(absolute);
  } catch {
    // Missing paths supplied by callers represent an intended working
    // directory. This also keeps injected/virtual test environments useful.
    return absolute;
  }
}

/** Directories from nearest to farthest, including the filesystem root. */
export function projectAncestors(startPath: string): string[] {
  const ancestors: string[] = [];
  let current = startDirectory(startPath);

  while (true) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current) return ancestors;
    current = parent;
  }
}

function configAt(directory: string): string | undefined {
  for (const name of PROJECT_CONFIG_NAMES) {
    const path = join(directory, name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/**
 * Resolve the nearest mdflow project marker, stopping at the first Git
 * boundary. Marker priority within one directory is config, flows/, then Git.
 */
export function resolveProjectRoot(startPath = process.cwd()): ProjectRootResolution {
  const ancestors = projectAncestors(startPath);

  for (const directory of ancestors) {
    const existingConfigPath = configAt(directory);
    if (existingConfigPath) {
      return { projectRoot: directory, source: "config", existingConfigPath };
    }
    if (syncIsDirectory(join(directory, "flows"))) {
      return { projectRoot: directory, source: "flows" };
    }
    if (existsSync(join(directory, ".git"))) {
      return { projectRoot: directory, source: "git" };
    }
  }

  return { projectRoot: ancestors[0]!, source: "cwd" };
}

/** Async equivalent for CliRunner's injected filesystem. */
export async function resolveProjectRootWith(
  startPath: string,
  probe: AsyncProjectRootProbe,
): Promise<ProjectRootResolution> {
  const ancestors = projectAncestors(startPath);

  for (const directory of ancestors) {
    for (const name of PROJECT_CONFIG_NAMES) {
      const path = join(directory, name);
      if (await probe.exists(path)) {
        return { projectRoot: directory, source: "config", existingConfigPath: path };
      }
    }
    if (await probe.isDirectory(join(directory, "flows"))) {
      return { projectRoot: directory, source: "flows" };
    }
    if (await probe.exists(join(directory, ".git"))) {
      return { projectRoot: directory, source: "git" };
    }
  }

  return { projectRoot: ancestors[0]!, source: "cwd" };
}
