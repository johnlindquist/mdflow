import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { resolveEngine } from "./command";
import { isDocument } from "./flow-kind";
import { getDeclaredFlowDirectories, loadFullConfig } from "./config";
import { getFrecencyScore, loadHistory } from "./history";
import { parseFrontmatter } from "./parse";
import { resolveProjectRoot } from "./project-root";
import { listAgents, verifiedRegistryText, type ListedAgent } from "./registry";
import { shouldOfferFirstRunSetup } from "./init";
import type { AgentFile, FlowOrigin, FlowScope } from "./cli";

export interface FlowDiscoveryDiagnostic {
	scope: FlowScope;
	path?: string;
	code:
		| "DIRECTORY_UNREADABLE"
		| "LOCKFILE_INVALID"
		| "FLOW_UNREADABLE"
		| "FLOW_INVALID"
		| "PATH_OUTSIDE_ROOT";
	message: string;
}

export interface FlowCatalog {
	cwd: string;
	projectRoot: string;
	homeDir: string;
	flows: AgentFile[];
	projectSetupAvailable: boolean;
	diagnostics: FlowDiscoveryDiagnostic[];
	counts: {
		project: number;
		global: number;
		path: number;
		unavailable: number;
	};
}

export interface DiscoverFlowCatalogOptions {
	cwd?: string;
	homeDir?: string;
	scorePath?: (path: string) => number;
}

interface FilesystemSource {
	root: string;
	recursive: boolean;
	scope: FlowScope;
	origin: FlowOrigin;
	source: string;
	provenanceLabel: string;
}

const RESERVED_NAMES = new Set([
	"auth",
	"backups",
	"cache",
	"credentials",
	"logs",
	"pending",
	"registry",
	"runtime",
	"sessions",
	"state",
	"telemetry",
	"tmp",
]);

function isReservedMarkdown(name: string): boolean {
	const lower = name.toLowerCase();
	return (
		lower === "readme.md" ||
		lower.startsWith(".#") ||
		/\.(?:bak|backup|pending|tmp|eval|hooks)\.md$/i.test(lower)
	);
}

function isContained(root: string, candidate: string): boolean {
	const path = relative(resolve(root), resolve(candidate));
	return (
		path === "" ||
		(!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep))
	);
}

function walkMarkdownFiles(
	source: FilesystemSource,
	diagnostics: FlowDiscoveryDiagnostic[],
): string[] {
	const files: string[] = [];
	const visit = (directory: string): void => {
		let entries;
		try {
			entries = readdirSync(directory, { withFileTypes: true }).sort(
				(left, right) => left.name.localeCompare(right.name),
			);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") {
				diagnostics.push({
					scope: source.scope,
					path: directory,
					code: "DIRECTORY_UNREADABLE",
					message: `Cannot read ${directory}: ${(error as Error).message}`,
				});
			}
			return;
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (source.recursive && !RESERVED_NAMES.has(entry.name.toLowerCase()))
					visit(path);
				continue;
			}
			if (
				!entry.isFile() ||
				!entry.name.toLowerCase().endsWith(".md") ||
				isReservedMarkdown(entry.name)
			)
				continue;
			files.push(path);
		}
	};
	visit(source.root);
	return files;
}

function unavailable(
	path: string,
	source: string,
	scope: FlowScope,
	origin: FlowOrigin,
	provenanceLabel: string,
	detail: string,
	reason:
		| "missing"
		| "unreadable"
		| "invalid"
		| "outside-root"
		| "not-runnable",
): AgentFile {
	return {
		name: basename(path),
		path,
		source,
		scope,
		origin,
		relativePath: basename(path),
		provenanceLabel,
		availability: { state: "unavailable", reason, detail },
	};
}

async function inspectPath(
	path: string,
	source: FilesystemSource,
	configEngine: string | undefined,
	scorePath: (path: string) => number,
	verifiedText?: string,
): Promise<AgentFile | undefined> {
	let canonical: string;
	try {
		const stats = statSync(path);
		if (!stats.isFile()) return undefined;
		canonical = realpathSync(path);
	} catch {
		return undefined;
	}
	let canonicalRoot = resolve(source.root);
	try {
		canonicalRoot = realpathSync(source.root);
	} catch {
		// The source root may disappear between enumeration and inspection.
	}
	if (!isContained(canonicalRoot, canonical)) return undefined;

	try {
		const parsed = parseFrontmatter(verifiedText ?? readFileSync(canonical, "utf8"));
		const resolved = resolveEngine(canonical, parsed.frontmatter, {
			configEngine,
		});
		if (isDocument(canonical, parsed.frontmatter, resolved.source)) return undefined;
		const relativePath =
			relative(canonicalRoot, canonical) || basename(canonical);
		return {
			name: relativePath,
			path: canonical,
			source: source.source,
			scope: source.scope,
			origin: source.origin,
			relativePath,
			provenanceLabel: source.provenanceLabel,
			availability: { state: "ready" },
			frecency: scorePath(canonical),
			engine: resolved.engine,
			engineSource: resolved.source,
			...(typeof parsed.frontmatter.description === "string"
				? { description: parsed.frontmatter.description }
				: {}),
		};
	} catch {
		return undefined;
	}
}

async function inspectRegistryEntry(
	entry: ListedAgent,
	projectRoot: string,
	homeDir: string,
	configEngine: string | undefined,
	scorePath: (path: string) => number,
): Promise<AgentFile> {
	const scope: FlowScope = entry.scope === "project" ? "project" : "global";
	const origin: FlowOrigin =
		entry.scope === "project" ? "project-registry" : "global-registry";
	const provenanceLabel =
		scope === "project" ? "PROJECT · INSTALLED" : "GLOBAL · INSTALLED";
	const root = join(
		entry.scope === "project" ? projectRoot : homeDir,
		".mdflow",
		"registry",
	);
	const path = resolve(entry.installedPath);
	let canonicalRoot = resolve(root);
	try {
		canonicalRoot = realpathSync(root);
	} catch {
		// A missing registry root is handled as a missing installed flow below.
	}
	const metadata = {
		source: entry.source,
		...(entry.resolvedRef ? { resolvedRef: entry.resolvedRef } : {}),
		sha256: entry.sha256,
		installedAt: entry.installedAt,
	};
	if (!isContained(root, path) && !isContained(canonicalRoot, path)) {
		return {
			...unavailable(
				path,
				entry.lockfilePath,
				scope,
				origin,
				provenanceLabel,
				"Installed path is outside the registry",
				"outside-root",
			),
			name: entry.name,
			registry: metadata,
		};
	}
	try {
		statSync(path);
	} catch {
		return {
			...unavailable(
				path,
				entry.lockfilePath,
				scope,
				origin,
				provenanceLabel,
				"Installed flow is missing",
				"missing",
			),
			name: entry.name,
			registry: metadata,
		};
	}
	let verified: string;
	try { verified = verifiedRegistryText(path, entry); } catch (err) {
		return { ...unavailable(path, entry.lockfilePath, scope, origin, provenanceLabel, String(err), "invalid"), name: entry.name, registry: metadata };
	}
	const inspected = await inspectPath(
		path,
		{
			root,
			recursive: false,
			scope,
			origin,
			source: entry.lockfilePath,
			provenanceLabel,
		},
		configEngine,
		scorePath,
		verified,
	);
	if (!inspected) {
		return {
			...unavailable(
				path,
				entry.lockfilePath,
				scope,
				origin,
				provenanceLabel,
				"Installed flow is not runnable",
				"not-runnable",
			),
			name: entry.name,
			registry: metadata,
		};
	}
	return {
		...inspected,
		name: entry.name,
		relativePath: relative(canonicalRoot, inspected.path),
		registry: metadata,
	};
}

export async function discoverFlowCatalog(
	options: DiscoverFlowCatalogOptions = {},
): Promise<FlowCatalog> {
	const cwd = resolve(options.cwd ?? process.cwd());
	const homeDir = resolve(options.homeDir ?? homedir());
	const projectRoot = resolveProjectRoot(cwd).projectRoot;
	const scorePath = options.scorePath ?? getFrecencyScore;
	const diagnostics: FlowDiscoveryDiagnostic[] = [];
	const byPath = new Map<string, AgentFile>();
	await loadHistory();

	let configEngine: string | undefined;
	try {
		configEngine = (await loadFullConfig(cwd)).engine;
	} catch (error) {
		diagnostics.push({
			scope: "project",
			code: "FLOW_INVALID",
			message: `Config load failed: ${(error as Error).message}`,
		});
	}

	// Roster directories are standardized: <project>/flows and
	// ~/.mdflow/flows are canonical, the flat legacy dirs keep scanning so
	// existing setups never break, and anything else must be declared via
	// `flows.directories` in config (declared dirs are rosters too, so they
	// scan recursively). PATH is deliberately NOT scanned: an executable's
	// location says nothing about which flows belong in the launcher.
	const declared = await getDeclaredFlowDirectories({ cwd, homeDir });
	const sources: FilesystemSource[] = [
		{
			root: join(projectRoot, "flows"),
			recursive: true,
			scope: "project",
			origin: "project-flows",
			source: "flows",
			provenanceLabel: "PROJECT",
		},
		{
			root: join(projectRoot, ".mdflow"),
			recursive: false,
			scope: "project",
			origin: "project-legacy",
			source: ".mdflow",
			provenanceLabel: "PROJECT · LEGACY",
		},
		...declared.project.map(
			(directory): FilesystemSource => ({
				root: directory,
				recursive: true,
				scope: "project",
				origin: "project-config",
				source: directory,
				provenanceLabel: "PROJECT · CONFIG",
			}),
		),
		{
			root: join(homeDir, ".mdflow", "flows"),
			recursive: true,
			scope: "global",
			origin: "global-flows",
			source: "~/.mdflow/flows",
			provenanceLabel: "GLOBAL",
		},
		{
			root: join(homeDir, ".mdflow"),
			recursive: false,
			scope: "global",
			origin: "global-personal",
			source: "~/.mdflow",
			provenanceLabel: "GLOBAL · LEGACY",
		},
		...declared.global.map(
			(directory): FilesystemSource => ({
				root: directory,
				recursive: true,
				scope: "global",
				origin: "global-config",
				source: directory,
				provenanceLabel: "GLOBAL · CONFIG",
			}),
		),
	];

	// A declared directory that does not exist is a config mistake worth
	// surfacing (unreadable dirs are reported by the walk itself).
	for (const source of sources) {
		if (source.origin !== "project-config" && source.origin !== "global-config")
			continue;
		try {
			if (!statSync(source.root).isDirectory()) {
				diagnostics.push({
					scope: source.scope,
					path: source.root,
					code: "DIRECTORY_UNREADABLE",
					message: `Declared flows directory is not a directory: ${source.root}`,
				});
			}
		} catch {
			diagnostics.push({
				scope: source.scope,
				path: source.root,
				code: "DIRECTORY_UNREADABLE",
				message: `Declared flows directory does not exist: ${source.root}`,
			});
		}
	}

	for (const source of sources) {
		for (const path of walkMarkdownFiles(source, diagnostics)) {
			const candidate = await inspectPath(
				path,
				source,
				configEngine,
				scorePath,
			);
			// First source wins for a given path: a declared directory that
			// overlaps a standard roster must not relabel the flow's provenance.
			if (candidate && !byPath.has(candidate.path))
				byPath.set(candidate.path, candidate);
		}
	}

	for (const registryScope of ["project", "user"] as const) {
		try {
			for (const entry of await listAgents({
				scope: registryScope,
				cwd: projectRoot,
				homeDir,
			})) {
				const candidate = await inspectRegistryEntry(
					entry,
					projectRoot,
					homeDir,
					configEngine,
					scorePath,
				);
				const existing = byPath.get(candidate.path);
				byPath.set(
					candidate.path,
					existing
						? { ...existing, ...candidate, registry: candidate.registry }
						: candidate,
				);
			}
		} catch (error) {
			const scope: FlowScope =
				registryScope === "project" ? "project" : "global";
			diagnostics.push({
				scope,
				code: "LOCKFILE_INVALID",
				message: `${scope} registry could not be read: ${(error as Error).message}`,
			});
		}
	}

	const flows = [...byPath.values()].sort((left, right) => {
		const readyDifference =
			Number(left.availability?.state === "unavailable") -
			Number(right.availability?.state === "unavailable");
		if (readyDifference) return readyDifference;
		const frecencyDifference = (right.frecency ?? 0) - (left.frecency ?? 0);
		if (frecencyDifference) return frecencyDifference;
		if (left.scope !== right.scope) return left.scope === "project" ? -1 : 1;
		return (
			left.name.localeCompare(right.name) || left.path.localeCompare(right.path)
		);
	});

	const projectSetupAvailable =
		(await shouldOfferFirstRunSetup({ cwd, homeDir })) &&
		!flows.some((flow) => flow.scope === "project") &&
		!diagnostics.some((diagnostic) => diagnostic.scope === "project");

	return {
		cwd,
		projectRoot,
		homeDir,
		flows,
		projectSetupAvailable,
		diagnostics,
		counts: {
			project: flows.filter((flow) => flow.scope === "project").length,
			global: flows.filter((flow) => flow.scope === "global").length,
			// PATH directories are no longer scanned; retained for payload shape.
			path: 0,
			unavailable: flows.filter(
				(flow) => flow.availability?.state === "unavailable",
			).length,
		},
	};
}
