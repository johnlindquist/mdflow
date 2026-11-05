import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalFlowPath, findRepositoryRoot } from "./evolution-core";

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

// Never copy common credential files, even when tracked or reached by a
// differently named symlink. This is a filename policy, not secret detection.
function excluded(path: string): boolean {
  return path.split(/[\\/]/).some(name => [".git", ".mdflow", ".artifacts", "node_modules", ".ssh", ".gnupg", ".npmrc", ".pypirc"].includes(name) || /^\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$/i.test(name));
}

function copyEntry(root: string, destination: string, relativePath: string): void {
  if (excluded(relativePath)) return;
  const source = join(root, relativePath);
  const target = join(destination, relativePath);
  if (!existsSync(source)) return;
  const canonical = realpathSync(source);
  if (!inside(root, canonical)) throw new Error(`Workspace snapshot refused symlink escaping the repository: ${relativePath}`);
  if (excluded(relative(root, canonical))) return;
  const stat = lstatSync(source);
  mkdirSync(dirname(target), { recursive: true });
  if (stat.isSymbolicLink()) {
    const link = readlinkSync(source);
    const resolvedTarget = realpathSync(resolve(dirname(source), link));
    if (!inside(root, resolvedTarget)) {
      throw new Error(`Workspace snapshot refused symlink escaping the repository: ${relativePath}`);
    }
    if (lstatSync(resolvedTarget).isDirectory()) {
      throw new Error(`Workspace snapshot refuses directory symlinks: ${relativePath}`);
    } else {
      if (!lstatSync(resolvedTarget).isFile()) throw new Error("Workspace snapshot requires regular files: " + relativePath);
      copyFileSync(resolvedTarget, target);
    }
    return;
  }
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true });
    return;
  }
  if (!stat.isFile()) throw new Error("Workspace snapshot requires regular files: " + relativePath);
  copyFileSync(source, target);
}

function gitFiles(root: string): string[] | undefined {
  try {
    const result = Bun.spawnSync(
      ["git", "-C", root, "ls-files", "-co", "--exclude-standard", "-z"],
      { stdout: "pipe", stderr: "ignore" }
    );
    if (result.exitCode !== 0) return undefined;
    return result.stdout.toString().split("\0").filter(Boolean);
  } catch {
    return undefined;
  }
}

function copyTree(root: string, destination: string, current = root): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (excluded(entry.name)) continue;
    const source = join(current, entry.name);
    const rel = relative(root, source);
    if (entry.isDirectory()) {
      mkdirSync(join(destination, rel), { recursive: true });
      copyTree(root, destination, source);
    } else {
      copyEntry(root, destination, rel);
    }
  }
}

/**
 * Create an off-path snapshot of the flow's repository and return the matching
 * flow path inside it. Ignored build products and secrets are deliberately not
 * copied. Symlinks are dereferenced only when they remain inside the repo.
 */
export function createEvolutionWorkspace(
  sourceFlowPath: string,
  workspaceRoot: string,
  flowContent: string
): { root: string; flowPath: string } {
  const sourceFlow = canonicalFlowPath(sourceFlowPath);
  const repoRoot = findRepositoryRoot(sourceFlow) ?? dirname(sourceFlow);
  mkdirSync(dirname(workspaceRoot), { recursive: true, mode: 0o700 });
  const destination = join(realpathSync(dirname(workspaceRoot)), basename(workspaceRoot));
  if (inside(repoRoot, destination)) throw new Error("Evolution workspace must be outside the source tree; set MDFLOW_EVOLUTION_HOME to a private external directory");
  mkdirSync(workspaceRoot, { mode: 0o700 }); // create-only: never write through an existing destination


  const files = gitFiles(repoRoot);
  if (files) {
    for (const file of files) copyEntry(repoRoot, workspaceRoot, file);
  } else {
    if (existsSync(join(repoRoot, ".git"))) throw new Error("Cannot enumerate git snapshot; refusing an unfiltered fallback");
    copyTree(repoRoot, workspaceRoot);
  }

  const flowRelative = relative(repoRoot, sourceFlow);
  const flowPath = join(workspaceRoot, flowRelative);
  mkdirSync(dirname(flowPath), { recursive: true });
  writeFileSync(flowPath, flowContent, { mode: 0o600 });
  return { root: workspaceRoot, flowPath };
}
