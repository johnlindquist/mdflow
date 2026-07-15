/**
 * Symlink-safe containment for project writes.
 *
 * mdflow's management commands write into a project by construction
 * (`<projectRoot>/flows/...`, `<projectRoot>/AGENTS.md`, ...), so lexical
 * traversal is already impossible. What lexical paths cannot see is a
 * symlinked component: `flows -> /tmp/victim` silently redirects every
 * "project-contained" write outside the repository, and a dangling
 * `.mdflow.yaml` symlink turns a create into a write at its target.
 *
 * These helpers make that explicit: every path component below the project
 * root is lstat'ed (never followed) and must be a plain directory, and a
 * write target must be absent or a regular file. Ambiguity fails closed with
 * a ContainmentError the caller reports; nothing is ever written through a
 * symlink or junction.
 */

import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";

export class ContainmentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ContainmentError";
	}
}

/**
 * Validate that writing `segments` under `projectRoot` cannot escape the
 * project: no segment may traverse, and no existing component below the root
 * may be a symlink (or, for the final target, anything but a regular file).
 * Returns the canonical-root-based absolute path. Throws ContainmentError.
 */
export function containedWritePath(
	projectRoot: string,
	...segments: string[]
): string {
	let realRoot: string;
	try {
		realRoot = realpathSync(projectRoot);
	} catch (error) {
		throw new ContainmentError(
			`project root is not resolvable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const parts = segments
		.flatMap((segment) => segment.split(/[\\/]+/))
		.filter((part) => part.length > 0);
	if (parts.length === 0)
		throw new ContainmentError("write target has no path segments");
	let path = realRoot;
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;
		if (part === "." || part === "..")
			throw new ContainmentError(
				`write target may not traverse ('${part}' segment)`,
			);
		path = join(path, part);
		let stats: ReturnType<typeof lstatSync> | null = null;
		try {
			stats = lstatSync(path);
		} catch (error) {
			// Only genuine absence is "missing" (the caller creates it with
			// mkdir/wx). Permission errors, I/O errors, and everything else are
			// indeterminate — fail closed instead of assuming a safe write.
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR")
				throw new ContainmentError(
					`cannot inspect write path ${path}: ${error instanceof Error ? error.message : String(error)}`,
				);
			stats = null;
		}
		if (!stats) continue;
		if (stats.isSymbolicLink())
			throw new ContainmentError(
				`refusing to write through a symlink: ${path}`,
			);
		const isFinal = i === parts.length - 1;
		if (isFinal && !stats.isFile())
			throw new ContainmentError(
				`write target exists and is not a regular file: ${path}`,
			);
		if (!isFinal && !stats.isDirectory())
			throw new ContainmentError(
				`write path component is not a directory: ${path}`,
			);
	}
	return path;
}

/**
 * Assert an existing-or-absent directory the caller is about to mkdir/write
 * into is a plain directory, never a symlink or junction.
 */
export function assertPlainDirectory(path: string): void {
	let stats: ReturnType<typeof lstatSync> | null = null;
	try {
		stats = lstatSync(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return; // Caller creates it.
		throw new ContainmentError(
			`cannot inspect directory ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (stats.isSymbolicLink())
		throw new ContainmentError(
			`refusing to write through a symlink: ${path}`,
		);
	if (!stats.isDirectory())
		throw new ContainmentError(`not a directory: ${path}`);
}
