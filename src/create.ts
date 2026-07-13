/**
 * Create a scoped flow from plain-language intent.
 *
 * The default path is deliberately the same one used by the Flow Workbench:
 * a canonical `flows/<slug>.md` file plus additive project support files.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import yaml from "js-yaml";
import { openInEditor } from "./file-selector";
import { parseRawFrontmatter } from "./parse";
import { contextualFlowTip } from "./tips";
import { tabSafeInput } from "./workbench-input";
import {
  applyFlowDraft,
  draftFlowFromIntent,
  resolveWorkbenchTarget,
  slugifyFlowIntent,
} from "./workbench-model";
import type { FlowDraft, WorkbenchTarget } from "./workbench-model";

export type CreateLocation = "project" | "cwd" | "user" | "custom";

export interface CreateScopeDescription {
  location: CreateLocation;
  displayPath: string;
  meaning: string;
  invocation: string;
  exactInvocation: string;
}

export interface GlobalFlowAvailability {
  flowPath: string;
  slug: string;
  userAgentsDir: string;
  invocation: string;
}

export interface CreateOptions {
  intent?: string;
  name?: string;
  engine?: string;
  model?: string;
  effort?: string;
  docs: string[];
  location: CreateLocation;
  customDir?: string;
  content?: string;
  description?: string;
  dryRun: boolean;
  open: boolean;
  help: boolean;
  /** Scaffold a sibling draft eval suite (default). --no-eval opts out. */
  withEval: boolean;
  frontmatter: Record<string, unknown>;
}

export type CreateCommandResult =
  | { status: "help" }
  | { status: "preview"; draft: FlowDraft; flowPath: string }
  | {
      status: "created";
      draft: FlowDraft;
      flowPath: string;
      created: string[];
      skipped: string[];
    }
  | { status: "conflict"; draft: FlowDraft; flowPath: string };

/** Small dependency seam used by tests and other non-process callers. */
export interface CreateRuntime {
  cwd?: string;
  homeDirectory?: string;
  userAgentsDir?: string;
  promptIntent?: () => Promise<string>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  openFile?: (path: string) => boolean;
  isStdinTTY?: boolean;
  ensureGlobalAvailability?: (receipt: GlobalFlowAvailability) => void | Promise<void>;
}

function portableRelative(from: string, to: string): string {
  return relative(from, to).split("\\").join("/");
}

function displayFrom(base: string, path: string): string {
  const pathFromBase = portableRelative(base, path);
  if (!pathFromBase || pathFromBase === ".") return "./";
  return pathFromBase.startsWith("../") ? path : `./${pathFromBase}`;
}

function displayFromHome(homeDirectory: string, path: string): string {
  const pathFromHome = portableRelative(homeDirectory, path);
  return pathFromHome && !pathFromHome.startsWith("../")
    ? `~/${pathFromHome}`
    : path;
}

/** Human-facing scope contract shared by `md create` and the Workbench. */
export function describeCreateScope(input: {
  location: CreateLocation;
  flowPath: string;
  slug: string;
  cwd: string;
  projectRoot?: string;
  homeDirectory?: string;
}): CreateScopeDescription {
  const homeDirectory = resolve(input.homeDirectory ?? homedir());
  const exactPath = input.location === "user"
    ? displayFromHome(homeDirectory, input.flowPath)
    : input.flowPath;
  if (input.location === "project") {
    const displayPath = displayFrom(input.projectRoot ?? input.cwd, input.flowPath);
    return {
      location: input.location,
      displayPath,
      meaning: `(available throughout this project as md ${input.slug})`,
      invocation: `md ${input.slug}`,
      exactInvocation: `md ${shellQuote(input.flowPath)}`,
    };
  }
  if (input.location === "cwd") {
    const displayPath = displayFrom(input.cwd, input.flowPath);
    return {
      location: input.location,
      displayPath,
      meaning: "(available here; elsewhere invoke it by path)",
      invocation: `md ${input.slug}`,
      exactInvocation: `md ${shellQuote(input.flowPath)}`,
    };
  }
  if (input.location === "user") {
    return {
      location: input.location,
      displayPath: exactPath,
      meaning: `(available from any directory as md ${input.slug})`,
      invocation: `md ${input.slug}`,
      exactInvocation: `md ${exactPath}`,
    };
  }
  return {
    location: input.location,
    displayPath: displayFrom(input.cwd, input.flowPath),
    meaning: "(invoke it by path unless this directory is on PATH)",
    invocation: `md ${shellQuote(input.flowPath)}`,
    exactInvocation: `md ${shellQuote(input.flowPath)}`,
  };
}

export function formatCreateScope(
  scope: CreateScopeDescription,
  phase: "creating" | "created" | "preview" = "creating",
): string {
  const verb = phase === "creating" ? "Creating" : phase === "created" ? "Created" : "Would create";
  const place = scope.location === "project"
    ? "in THIS PROJECT"
    : scope.location === "cwd"
      ? "in CURRENT DIRECTORY"
      : scope.location === "user"
        ? "GLOBALLY"
        : "in CUSTOM DIRECTORY";
  return `${verb} ${place} → ${scope.displayPath} ${scope.meaning}`;
}

/**
 * Global flow discovery is native: the CLI resolver reads ~/.mdflow/*.md.
 * This post-write assertion protects that invariant without inventing a shim
 * or linking the mdflow package itself.
 */
export function ensureGlobalFlowAvailable(receipt: GlobalFlowAvailability): void {
  const expected = resolve(receipt.userAgentsDir, `${receipt.slug}.md`);
  if (resolve(receipt.flowPath) !== expected || !existsSync(expected)) {
    throw new Error(
      `Global flow availability check failed: expected ${expected} for ${receipt.invocation}`,
    );
  }
}

function flagValue(
  args: readonly string[],
  index: number,
  inlineValue: string | undefined,
  flag: string
): { value: string; nextIndex: number } {
  if (inlineValue !== undefined) return { value: inlineValue, nextIndex: index };
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${flag} requires a value.`);
  }
  return { value, nextIndex: index + 1 };
}

function inferredValue(value: string): string | number | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
  return value;
}

/** Parse both the intent-first command and the useful v2 create aliases. */
export function parseCreateArgs(args: readonly string[]): CreateOptions {
  const options: CreateOptions = {
    location: "project",
    docs: [],
    dryRun: false,
    open: false,
    help: false,
    withEval: true,
    frontmatter: {},
  };
  const intentParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    if (!raw) continue;
    if (raw === "--") {
      intentParts.push(...args.slice(i + 1));
      break;
    }
    if (!raw.startsWith("-")) {
      intentParts.push(raw);
      continue;
    }

    const equals = raw.indexOf("=");
    const flag = equals === -1 ? raw : raw.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : raw.slice(equals + 1);

    if (flag === "--help" || flag === "-h") {
      options.help = true;
    } else if (flag === "--dry-run" || flag === "--preview" || flag === "--_dry-run") {
      options.dryRun = true;
    } else if (flag === "--no-eval") {
      options.withEval = false;
    } else if (flag === "--open") {
      options.open = true;
    } else if (flag === "--yes" || flag === "-y" || flag === "--json") {
      // `create <intent>` is already an explicit apply action. Keep these
      // automation/global-output flags consumable without leaking them into
      // flow frontmatter.
    } else if (flag === "--project" || flag === "-p") {
      options.location = "project";
    } else if (flag === "--global" || flag === "-g") {
      options.location = "user";
    } else if (flag === "--name" || flag === "-n" || flag === "--slug") {
      const parsed = flagValue(args, i, inlineValue, flag);
      options.name = parsed.value;
      i = parsed.nextIndex;
    } else if (
      flag === "--engine" ||
      flag === "--command" ||
      flag === "--tool" ||
      flag === "--_command" ||
      flag === "-_c"
    ) {
      const parsed = flagValue(args, i, inlineValue, flag);
      options.engine = parsed.value;
      i = parsed.nextIndex;
    } else if (flag === "--model") {
      const parsed = flagValue(args, i, inlineValue, flag);
      options.model = parsed.value;
      i = parsed.nextIndex;
    } else if (flag === "--effort") {
      const parsed = flagValue(args, i, inlineValue, flag);
      options.effort = parsed.value;
      i = parsed.nextIndex;
    } else if (flag === "--docs" || flag === "--doc") {
      const parsed = flagValue(args, i, inlineValue, flag);
      options.docs.push(parsed.value);
      i = parsed.nextIndex;
    } else if (flag === "--location" || flag === "-l") {
      const parsed = flagValue(args, i, inlineValue, flag);
      if (!(["cwd", "project", "user"] as string[]).includes(parsed.value)) {
        throw new Error(`Unknown create location: ${parsed.value}`);
      }
      options.location = parsed.value as Exclude<CreateLocation, "custom">;
      i = parsed.nextIndex;
    } else if (flag === "--dir" || flag === "-d") {
      const parsed = flagValue(args, i, inlineValue, flag);
      options.location = "custom";
      options.customDir = parsed.value;
      i = parsed.nextIndex;
    } else if (flag === "--content" || flag === "--body") {
      const parsed = flagValue(args, i, inlineValue, flag);
      options.content = parsed.value;
      i = parsed.nextIndex;
    } else if (flag === "--description") {
      const parsed = flagValue(args, i, inlineValue, flag);
      options.description = parsed.value;
      i = parsed.nextIndex;
    } else {
      // Preserve the old create command's convenient "unknown flags become
      // frontmatter" contract.
      const key = flag.replace(/^-+/, "");
      const next = args[i + 1];
      if (inlineValue !== undefined) {
        options.frontmatter[key] = inferredValue(inlineValue);
      } else if (next !== undefined && !next.startsWith("-")) {
        options.frontmatter[key] = inferredValue(next);
        i++;
      } else {
        options.frontmatter[key] = true;
      }
    }
  }

  if (intentParts.length === 1 && /\.md$/i.test(intentParts[0]!) && !options.name) {
    // v2 accepted a filename as its sole positional argument. Treat it as a
    // naming hint while still producing the v3 engine-neutral flow shape.
    options.name = intentParts[0];
  } else if (intentParts.length > 0) {
    options.intent = intentParts.join(" ").trim();
  }

  return options;
}

interface LegacyName {
  intent: string;
  slug: string;
  engine?: string;
  interactive: boolean;
}

function interpretName(name: string): LegacyName {
  const stem = basename(name.trim()).replace(/\.md$/i, "");
  const pieces = stem.split(".").filter(Boolean);
  let engine: string | undefined;
  let interactive = false;
  if (pieces.length > 1) {
    engine = pieces.pop();
    if (pieces.at(-1) === "i") {
      pieces.pop();
      interactive = true;
    }
  }
  const subject = pieces.join(" ") || stem || "new flow";
  return {
    intent: subject.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim(),
    slug: slugifyFlowIntent(pieces.join("-") || stem),
    ...(engine ? { engine } : {}),
    interactive,
  };
}

function mergeFrontmatter(draft: FlowDraft, extra: Record<string, unknown>): FlowDraft {
  if (Object.keys(extra).length === 0) return draft;
  const parsed = parseRawFrontmatter(draft.markdown);
  const existing =
    typeof parsed.frontmatter === "object" && parsed.frontmatter !== null && !Array.isArray(parsed.frontmatter)
      ? (parsed.frontmatter as Record<string, unknown>)
      : {};
  const frontmatter = yaml.dump({ ...existing, ...extra }, { lineWidth: -1, noRefs: true }).trimEnd();
  const body = parsed.body.trimEnd();
  return {
    ...draft,
    markdown: `---\n${frontmatter}\n---\n\n${body}${body.endsWith("\n") ? "" : "\n"}`,
  };
}

function applyCommand(draft: FlowDraft, options: CreateOptions, engine: string | undefined): string {
  const parts = ["md create", shellQuote(draft.intent)];
  if (options.name) parts.push("--name", shellQuote(draft.slug));
  if (engine) parts.push("--engine", shellQuote(engine));
  if (options.model) parts.push("--model", shellQuote(options.model));
  if (options.effort) parts.push("--effort", shellQuote(options.effort));
  for (const doc of options.docs) parts.push("--docs", shellQuote(doc));
  if (options.location === "project") parts.push("--project");
  else if (options.location === "cwd") parts.push("--location", "cwd");
  else if (options.location === "user") parts.push("--global");
  else parts.push("--dir", shellQuote(options.customDir!));
  return parts.join(" ");
}

function previewMessage(
  draft: FlowDraft,
  flowPath: string,
  options: CreateOptions,
  engine: string | undefined,
  scope: CreateScopeDescription,
): string {
  return [
    "",
    "Flow preview",
    formatCreateScope(scope, "preview"),
    `  Intent: ${draft.intent}`,
    `  File:   ${flowPath}`,
    ...(options.withEval
      ? [
          `  Eval:   ${flowPath.replace(/\.md$/i, ".eval.ts")} (fail-closed draft; --no-eval skips it)`,
        ]
      : []),
    `  Engine: ${engine ?? "project default (pi if unset)"}`,
    "  Effect: FREE — no files written",
    "",
    draft.markdown.trimEnd(),
    "",
    `Apply it: ${applyCommand(draft, options, engine)}`,
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function applyLegacyLocation(draft: FlowDraft, directory: string): "created" | "conflict" {
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(join(directory, draft.filename), draft.markdown, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    return "created";
  } catch (error) {
    if (isAlreadyExists(error)) return "conflict";
    throw error;
  }
}

function helpText(): string {
  return `
Usage: md create [intent...] [options]

Create a runnable Markdown flow in the nearest project's flows/ roster.
An intent on the command line applies immediately; --dry-run is read-only.

Options:
  --name, -n <slug>       Override the suggested short filename
  --engine <name>         Persist an engine choice (default: project config / pi)
  --model <name>          Persist a model choice for the engine
  --effort <level>        Persist a reasoning-effort level (claude/codex/pi)
  --docs <entry>          Preload docs into the body (repeatable): a command
                          ("gog --help"), URL, path, or bare tool name (runs
                          its --help)
  --content, --body       Override the Markdown prompt body
  --description <text>    Override the roster description
  --dry-run, --preview    Print the exact draft and target; write nothing
  --no-eval               Skip the sibling draft eval suite (created by default;
                          it is fail-closed and free until its assertions are real)
  --open                  Open the new flow in $EDITOR
  --project, -p           Use the canonical project flows/ roster (default)
  --global, -g            Create in ~/.mdflow/; md <name> works everywhere
  --location cwd          Create directly in the current directory
  --dir, -d <path>        Legacy: create directly in a custom directory

Unknown flags are retained as flow frontmatter for compatibility.
Deprecated --_command/-_c and --tool aliases still select --engine.

Examples:
  md create Review staged changes for correctness
  md create "Draft release notes from recent commits" --engine codex --effort high
  md create "Summarize gog output" --engine codex --docs "gog --help"
  md create "Turn meeting notes into an action plan" --global
  md create "Summarize this repo" --name repo-summary --dry-run
`;
}

/**
 * Create a flow. The returned receipt is useful to embedded callers; the CLI
 * continues to ignore it and relies on the human-readable output.
 */
export async function runCreate(
  args: string[],
  runtime: CreateRuntime = {}
): Promise<CreateCommandResult> {
  const options = parseCreateArgs(args);
  const log = runtime.log ?? console.log;
  const warn = runtime.warn ?? console.error;
  const cwd = resolve(runtime.cwd ?? process.cwd());
  const homeDirectory = resolve(runtime.homeDirectory ?? homedir());
  const userAgentsDir = resolve(
    runtime.userAgentsDir ?? join(homeDirectory, ".mdflow"),
  );

  if (options.help) {
    log(helpText());
    return { status: "help" };
  }

  const retainedFlags = Object.keys(options.frontmatter);
  if (retainedFlags.length > 0) {
    // A typo'd or hallucinated option would otherwise become silent
    // frontmatter; the retention contract stays, but visibly.
    warn(
      `Note: unknown flag(s) retained as flow frontmatter: ${retainedFlags
        .map((key) => `--${key}`)
        .join(", ")} (run 'md create --help' for known options)`
    );
  }

  const legacyName = options.name ? interpretName(options.name) : undefined;
  const isStdinTTY = runtime.isStdinTTY ?? Boolean(process.stdin.isTTY);
  if (!options.intent?.trim() && !legacyName && !runtime.promptIntent && !isStdinTTY) {
    throw new Error(
      'Flow intent required (INTENT_REQUIRED): stdin is not a TTY, so md create cannot prompt.\n' +
        'Pass the intent as an argument, e.g.: md create "Review staged changes for correctness"'
    );
  }
  const promptIntent =
    runtime.promptIntent ??
    (() =>
      tabSafeInput({
        message: "What should this flow do?",
        validate: (value) => value.trim().length > 0 || "Describe the flow in a few words",
      }));
  const intent = options.intent?.trim() || legacyName?.intent || (await promptIntent()).trim();
  if (!intent) throw new Error("Flow intent cannot be empty.");

  const engine = options.engine?.trim() || legacyName?.engine;
  if (options.engine !== undefined && !engine) throw new Error("Create engine cannot be empty.");

  let draft = draftFlowFromIntent(intent, {
    ...(legacyName ? { slug: legacyName.slug } : {}),
    ...(options.description ? { description: options.description } : {}),
    ...(options.content !== undefined ? { body: options.content } : {}),
    ...(engine ? { engine } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    docs: options.docs,
  });
  draft = mergeFrontmatter(draft, {
    ...options.frontmatter,
    ...(legacyName?.interactive ? { _interactive: true } : {}),
  });

  const canonical = options.location === "project";
  let target: WorkbenchTarget | undefined;
  let legacyDirectory: string | undefined;
  if (canonical) {
    target = resolveWorkbenchTarget(cwd);
  } else if (options.location === "cwd") {
    legacyDirectory = cwd;
  } else if (options.location === "user") {
    legacyDirectory = userAgentsDir;
  } else {
    legacyDirectory = resolve(cwd, options.customDir!);
  }
  const flowPath = canonical
    ? join(target!.flowsDir, draft.filename)
    : join(legacyDirectory!, draft.filename);
  const scope = describeCreateScope({
    location: options.location,
    flowPath,
    slug: draft.slug,
    cwd,
    ...(target ? { projectRoot: target.projectRoot } : {}),
    homeDirectory,
  });

  const suitePath = flowPath.replace(/\.md$/i, ".eval.ts");

  if (options.dryRun) {
    log(previewMessage(draft, flowPath, options, engine, scope));
    return { status: "preview", draft, flowPath };
  }

  // Orphaned sibling sidecars are executable TypeScript this command did not
  // write. Pairing a brand-new flow with them silently would let unknown code
  // run on the flow's first `md eval` (suite) or first run (hooks) — surface
  // them as conflicts instead.
  const hooksPath = flowPath.replace(/\.md$/i, ".hooks.ts");
  if (!existsSync(flowPath)) {
    for (const orphan of [suitePath, hooksPath]) {
      if (existsSync(orphan)) {
        log(
          `\nA sidecar file already exists for this name: ${orphan}\n` +
            `Nothing was changed. Choose another name with --name <slug>, or remove the orphaned file first.`
        );
        return { status: "conflict", draft, flowPath };
      }
    }
  }

  // Scope is printed before the first write so there is no ambiguity about
  // which namespace this command is about to mutate.
  log(`\n${formatCreateScope(scope, "creating")}`);

  let created: string[];
  let skipped: string[];
  let conflict = false;
  if (canonical) {
    const result = applyFlowDraft(draft, {
      target: target!,
      withEval: options.withEval,
      ...(engine ? { engine } : {}),
    });
    conflict = result.status === "conflict";
    created = result.created;
    skipped = result.skipped;
  } else {
    const status = applyLegacyLocation(draft, legacyDirectory!);
    conflict = status === "conflict";
    created = status === "created" ? [flowPath] : [];
    skipped = [];
  }

  if (conflict) {
    log(`\nFlow already exists: ${flowPath}\nNothing was changed. Choose another name with --name <slug>.`);
    return { status: "conflict", draft, flowPath };
  }

  if (options.withEval && !created.includes(suitePath)) {
    try {
      const { inferEvalRecipes, renderEvalTemplate } = await import("./eval-convention");
      // "wx" (O_EXCL) never follows symlinks: a dangling symlink planted at
      // the suite path fails here instead of redirecting the write. It also
      // fails on a suite that APPEARED after the orphan precheck (a race) —
      // adopting executable code this command did not write is never ok, so
      // that failure rolls the whole creation back below.
      writeFileSync(suitePath, renderEvalTemplate(inferEvalRecipes(draft.markdown)), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o644,
      });
      created.push(suitePath);
    } catch (error) {
      // A flow without its promised suite would silently dodge the coverage
      // ratchet; undo EVERYTHING this command created (flow and any project
      // support files) so the command is all-or-nothing.
      try {
        const { unlinkSync } = await import("node:fs");
        for (const path of [flowPath, ...created.filter((item) => item !== flowPath)]) {
          try { unlinkSync(path); } catch {}
        }
      } catch {}
      throw new Error(
        `Failed to write the eval suite (${suitePath}); rolled the new flow back: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (options.location === "user") {
    const availability = {
      flowPath,
      slug: draft.slug,
      userAgentsDir,
      invocation: scope.invocation,
    } satisfies GlobalFlowAvailability;
    await (runtime.ensureGlobalAvailability ?? ensureGlobalFlowAvailable)(availability);
  }

  log(`\n${formatCreateScope(scope, "created")}`);
  log(`Created flow: ${flowPath}`);
  if (created.includes(suitePath)) {
    log(`Created draft eval: ${suitePath}`);
    log(
      `The suite is a fail-closed draft — replace its MDFLOW_DRAFT_CASE assertions, ` +
        `delete each case's draft: true line, then verify with: md eval ${basename(flowPath)} --plan`
    );
  }
  const supportFiles = created.filter((path) => path !== flowPath && path !== suitePath);
  if (supportFiles.length > 0) log(`Added project support: ${supportFiles.join(", ")}`);
  if (options.location === "user") {
    log(`Run from any directory: ${scope.invocation}`);
    log(`Exact global path (bypasses a same-named project flow): ${scope.exactInvocation}`);
  } else if (options.location === "cwd") {
    log(`Run from this directory: ${scope.invocation}`);
    log(`From elsewhere: ${scope.exactInvocation}`);
  } else if (options.location === "custom") {
    log(`Run by path: ${scope.exactInvocation}`);
  } else {
    const tip = contextualFlowTip({ cwd, flowPath, created: true });
    if (tip) log(`Tip: ${tip}`);
  }

  if (options.open) (runtime.openFile ?? openInEditor)(flowPath);

  return { status: "created", draft, flowPath, created, skipped };
}
