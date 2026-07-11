/**
 * `md render <flow.md>` — the mdflow rendering system.
 *
 * Renders a flow's resolved prompt and ALL of its info — engine, argv, mode,
 * isolation, system prompt, lifecycle hooks, inputs, frontmatter layers,
 * token usage, warnings — as a single self-contained HTML page suitable for
 * publishing anywhere (here.now, gists, artifact hosts) or opening locally.
 *
 * FREE: builds on analyzeAgent, which never invokes an engine. The page
 * embeds its own machine-readable model (`<script type="application/json"
 * id="mdflow-render-model">`) so apps (e.g. Script Kit) can consume the
 * same payload they render.
 *
 * Redaction: `_env`/`env` values are ALWAYS masked (this output is meant to
 * be shared), and the raw file source section shows the redacted frontmatter
 * plus the verbatim body — never the raw frontmatter bytes.
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { analyzeAgent, explainJsonFromResult, type ExplainResult } from "./explain";
import { mdflowVersion } from "./compat";
import { parseFrontmatter } from "./parse";
import type { ProtocolInput } from "./roster";

export const RENDER_MODEL_VERSION = 1;

export interface RenderModel {
  kind: "mdflow-render";
  renderVersion: number;
  protocolVersion: number;
  generatedWith: string;
  flow: { id: string; name: string; path: string; isRemote: boolean };
  engine: { name: string; source: string };
  mode: { interactive: boolean; source: string };
  command: { argv: string[]; promptIncluded: boolean; cwd: string };
  prompt: { text: string; tokensEstimate: number; tokenLimit: number; tokenPercentage: number; exceedsLimit: boolean };
  inputs: ProtocolInput[];
  isolation: {
    isolated: boolean;
    explicit: boolean;
    supported: boolean;
    flags: Record<string, unknown>;
    warning: string | null;
  };
  systemPrompt: { replace: boolean; appendCount: number; error: string | null } | null;
  hooks: { file: string; source: string; events: string[]; error: string | null } | null;
  positionalMappings: Record<string, string>;
  envKeys: string[];
  frontmatter: {
    original: Record<string, unknown>;
    finalFlags: Record<string, unknown>;
  };
  config: {
    builtin: Record<string, unknown> | null;
    global: Record<string, unknown> | null;
    project: Record<string, unknown> | null;
    globalPath: string;
    globalExists: boolean;
    projectPath: string | null;
  };
  trust: { domain: string; trusted: boolean } | null;
  warnings: string[];
  body: { raw: string | null; note: string | null };
  configFingerprint: string;
}

/** Frontmatter keys whose values must never appear in shareable output. */
const REDACTED_KEYS = new Set(["_env", "env"]);
const SECRETISH = /(secret|token|password|api[-_]?key|credential)/i;

function redactValue(key: string, value: unknown): unknown {
  if (REDACTED_KEYS.has(key)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.keys(value).map((k) => [k, "****"]));
    }
    return "****";
  }
  if (SECRETISH.test(key)) return "****";
  return value;
}

function redactRecord(record: Record<string, unknown> | undefined | null): Record<string, unknown> | null {
  if (!record) return null;
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, redactValue(k, v)]));
}

/**
 * Mask values of secret-like flags in a rendered argv (`--api-key x`,
 * `--token=x`). The argv is display/publish output, never fed back to a run.
 */
function redactArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.startsWith("-") ? arg.indexOf("=") : -1;
    if (eq !== -1 && SECRETISH.test(arg.slice(0, eq))) {
      out.push(`${arg.slice(0, eq)}=****`);
      continue;
    }
    out.push(arg);
    const next = argv[i + 1];
    if (arg.startsWith("-") && SECRETISH.test(arg) && next !== undefined && !next.startsWith("-")) {
      out.push("****");
      i++;
    }
  }
  return out;
}

/** Build the complete render model for a flow. FREE — no engine call. */
export async function buildRenderModel(
  filePath: string,
  passthroughArgs: string[] = [],
  cwd: string = process.cwd()
): Promise<RenderModel> {
  const result: ExplainResult = await analyzeAgent(filePath, passthroughArgs, cwd);
  const protocol = await explainJsonFromResult(result, filePath, passthroughArgs, cwd);

  // Raw body (unexpanded prompt source). Remote flows were cleaned up after
  // analysis, so their source is intentionally absent.
  let rawBody: string | null = null;
  let bodyNote: string | null = null;
  if (result.isRemote) {
    bodyNote = "Remote flow: source shown is the resolved prompt only.";
  } else {
    try {
      const content = await Bun.file(resolve(filePath)).text();
      rawBody = parseFrontmatter(content).body;
    } catch {
      bodyNote = "Flow source could not be re-read.";
    }
  }

  const positionalMappings: Record<string, string> = {};
  for (const [pos, flag] of result.positionalMappings) {
    positionalMappings[`$${pos}`] = flag;
  }

  return {
    kind: "mdflow-render",
    renderVersion: RENDER_MODEL_VERSION,
    protocolVersion: protocol.protocolVersion,
    generatedWith: mdflowVersion(),
    flow: {
      id: protocol.flowId,
      name: basename(result.agentPath).replace(/\.md$/, ""),
      path: protocol.path,
      isRemote: result.isRemote,
    },
    engine: { name: result.command, source: result.commandSource },
    mode: { interactive: result.interactiveMode, source: result.interactiveModeSource },
    command: {
      argv: redactArgv([result.command, ...protocol.args]),
      promptIncluded: protocol.promptIncluded,
      cwd: protocol.cwd,
    },
    prompt: {
      text: result.finalPromptFull,
      tokensEstimate: result.tokenUsage.tokens,
      tokenLimit: result.tokenUsage.limit,
      tokenPercentage: result.tokenUsage.percentage,
      exceedsLimit: result.tokenUsage.exceeds,
    },
    inputs: protocol.inputs,
    isolation: {
      isolated: result.isolation.isolated,
      explicit: result.isolation.explicit,
      supported: result.isolation.supported,
      flags: (result.isolation.flags ?? {}) as Record<string, unknown>,
      warning: result.isolation.warning ?? null,
    },
    systemPrompt: result.systemPrompt
      ? {
          replace: result.systemPrompt.replace,
          appendCount: result.systemPrompt.appendCount,
          error: result.systemPrompt.error ?? null,
        }
      : null,
    hooks: result.hooks
      ? {
          file: result.hooks.file,
          source: result.hooks.source,
          events: result.hooks.events,
          error: result.hooks.error ?? null,
        }
      : null,
    positionalMappings,
    envKeys: result.envKeys,
    frontmatter: {
      original: redactRecord(result.originalFrontmatter as Record<string, unknown>) ?? {},
      finalFlags: redactRecord(
        Object.fromEntries(
          Object.entries(result.finalFrontmatter).filter(
            ([k]) => !k.startsWith("_") || k === "_subcommand"
          )
        )
      ) ?? {},
    },
    config: {
      builtin: redactRecord(result.builtinDefaults as Record<string, unknown> | undefined),
      global: redactRecord(result.globalDefaults as Record<string, unknown> | undefined),
      project: redactRecord(result.projectDefaults as Record<string, unknown> | undefined),
      globalPath: result.configPaths.global,
      globalExists: result.configPaths.globalExists,
      projectPath: result.configPaths.project,
    },
    trust: result.trustStatus
      ? { domain: result.trustStatus.domain, trusted: result.trustStatus.trusted }
      : null,
    warnings: protocol.warnings,
    body: { raw: rawBody, note: bodyNote },
    configFingerprint: protocol.configFingerprint,
  };
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function chip(text: string, tone: "ok" | "warn" | "info" | "muted" = "info"): string {
  return `<span class="chip chip-${tone}">${esc(text)}</span>`;
}

function kvTable(record: Record<string, unknown>): string {
  const entries = Object.entries(record);
  if (entries.length === 0) return `<p class="muted">(none)</p>`;
  const rows = entries
    .map(
      ([k, v]) =>
        `<tr><td class="key">${esc(k)}</td><td><code>${esc(JSON.stringify(v))}</code></td></tr>`
    )
    .join("");
  return `<div class="scroll-x"><table>${rows}</table></div>`;
}

function section(title: string, body: string, subtitle?: string): string {
  const sub = subtitle ? `<p class="muted subtitle">${esc(subtitle)}</p>` : "";
  return `<section class="card"><h2>${esc(title)}</h2>${sub}${body}</section>`;
}

/** Render the model as a single self-contained HTML page. */
export function renderFlowHtml(model: RenderModel): string {
  const warningsHtml = model.warnings.length
    ? `<div class="banner warn"><strong>Warnings</strong><ul>${model.warnings
        .map((w) => `<li>${esc(w)}</li>`)
        .join("")}</ul></div>`
    : "";

  const badges = [
    chip(model.engine.name, "info"),
    chip(model.mode.interactive ? "interactive" : "print mode", "muted"),
    model.isolation.isolated
      ? chip(model.isolation.supported ? "isolated" : "isolation unsupported", model.isolation.supported ? "ok" : "warn")
      : chip("ambient (_isolated: false)", "warn"),
    ...(model.hooks && !model.hooks.error ? [chip(`hooks: ${model.hooks.events.length} event${model.hooks.events.length === 1 ? "" : "s"}`, "ok")] : []),
    ...(model.hooks?.error ? [chip("hooks error", "warn")] : []),
    ...(model.flow.isRemote ? [chip("remote", "warn")] : []),
  ].join(" ");

  const argvHtml = `<pre class="argv"><code>${model.command.argv.map((a) => esc(shellQuote(a))).join(" ")}</code></pre>
    <p class="muted">cwd: <code>${esc(model.command.cwd)}</code>${model.command.promptIncluded ? "" : " · prompt submitted interactively (not in argv)"}</p>`;

  const tokenPct = Math.min(100, Math.round(model.prompt.tokenPercentage));
  const promptHtml = `
    <div class="tokenbar" role="img" aria-label="Token usage ${tokenPct}%"><div class="tokenbar-fill${model.prompt.exceedsLimit ? " over" : ""}" style="width:${tokenPct}%"></div></div>
    <p class="muted">~${model.prompt.tokensEstimate.toLocaleString()} tokens of ${model.prompt.tokenLimit.toLocaleString()} (${model.prompt.tokenPercentage.toFixed(1)}%)${model.prompt.exceedsLimit ? " — exceeds context limit" : ""}</p>
    <pre class="prompt">${esc(model.prompt.text) || '<span class="muted">(empty prompt)</span>'}</pre>`;

  const inputsHtml = model.inputs.length
    ? `<div class="scroll-x"><table><tr><th>name</th><th>type</th><th>message</th><th>default</th><th>options</th></tr>${model.inputs
        .map(
          (i) =>
            `<tr><td class="key">${esc(i.name)}</td><td>${esc(i.type)}</td><td>${esc(i.message ?? "")}</td><td><code>${esc(
              JSON.stringify(i.default)
            )}</code></td><td>${esc(i.options?.join(", ") ?? "")}</td></tr>`
        )
        .join("")}</table></div>`
    : "";

  const hooksHtml = model.hooks
    ? section(
        "Lifecycle hooks",
        `<p><code>${esc(model.hooks.file)}</code> <span class="muted">(${esc(model.hooks.source)})</span></p>` +
          (model.hooks.error
            ? `<div class="banner warn">${esc(model.hooks.error)}</div>`
            : `<p>${model.hooks.events.map((e) => chip(e, "ok")).join(" ")}</p>`)
      )
    : "";

  const systemPromptHtml = model.systemPrompt
    ? section(
        "System prompt",
        model.systemPrompt.error
          ? `<div class="banner warn">${esc(model.systemPrompt.error)}</div>`
          : `<p>${model.systemPrompt.replace ? chip("replace (_system-prompt)", "info") : ""} ${
              model.systemPrompt.appendCount > 0
                ? chip(`${model.systemPrompt.appendCount} append segment${model.systemPrompt.appendCount === 1 ? "" : "s"}`, "info")
                : ""
            }</p>`
      )
    : "";

  const isolationHtml = section(
    "Isolation",
    (model.isolation.isolated
      ? model.isolation.supported
        ? `<p>${chip(model.isolation.explicit ? "on (explicit)" : "on (default)", "ok")} — ambient engine context is disabled.</p>${kvTable(model.isolation.flags)}`
        : `<p>${chip("on, but unsupported", "warn")} — this engine has no isolation controls; runs ambient.</p>${
            model.isolation.warning ? `<p class="muted">${esc(model.isolation.warning)}</p>` : ""
          }`
      : `<p>${chip("off", "warn")} — ambient skills/MCP/context files load (<code>_isolated: false</code>).</p>`)
  );

  const configLayers = [
    { label: "1. Built-in defaults", record: model.config.builtin, note: null as string | null },
    { label: `2. Global config (${model.config.globalPath})`, record: model.config.global, note: model.config.globalExists ? null : "file not found" },
    { label: `3. Project config (${model.config.projectPath ?? "not found"})`, record: model.config.project, note: null },
    { label: "4. Flow frontmatter", record: model.frontmatter.original, note: null },
  ]
    .map(
      (layer) =>
        `<h3>${esc(layer.label)}</h3>` +
        (layer.record && Object.keys(layer.record).length
          ? kvTable(layer.record)
          : `<p class="muted">(${layer.note ?? "none"})</p>`)
    )
    .join("");

  const extrasHtml =
    (Object.keys(model.positionalMappings).length
      ? section("Positional mappings", kvTable(model.positionalMappings))
      : "") +
    (model.envKeys.length
      ? section("Environment variables", `<p>${model.envKeys.map((k) => chip(`${k}=****`, "muted")).join(" ")}</p>`, "Values are always redacted.")
      : "") +
    (model.trust
      ? section("Trust", `<p>Domain <code>${esc(model.trust.domain)}</code> — ${model.trust.trusted ? chip("trusted", "ok") : chip("not trusted", "warn")}</p>`)
      : "");

  const bodyHtml = model.body.raw !== null
    ? section("Flow source", `<details open><summary>Body (before imports/templates)</summary><pre class="prompt">${esc(model.body.raw)}</pre></details>`, model.body.note ?? undefined)
    : model.body.note
      ? section("Flow source", `<p class="muted">${esc(model.body.note)}</p>`)
      : "";

  const modelJson = JSON.stringify(model).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(model.flow.name)} · mdflow</title>
<style>
:root{--bg:#fafaf8;--fg:#1a1a1a;--muted:#6b6b6b;--card:#ffffff;--border:#e4e2dd;--accent:#4c6ef5;--ok:#2b8a3e;--warn:#b8860b;--warn-bg:#fff8e1;--code-bg:#f2f1ee}
@media (prefers-color-scheme: dark){:root{--bg:#121212;--fg:#e8e6e3;--muted:#9a9a9a;--card:#1c1c1e;--border:#333;--accent:#748ffc;--ok:#69db7c;--warn:#e6b422;--warn-bg:#332d13;--code-bg:#242426}}
*{box-sizing:border-box}
body{margin:0;padding:2rem 1rem 4rem;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:920px;margin:0 auto}
h1{font-size:1.7rem;margin:0 0 .25rem}
h2{font-size:1.05rem;margin:0 0 .75rem;letter-spacing:.02em;text-transform:uppercase;color:var(--muted)}
h3{font-size:.95rem;margin:1rem 0 .35rem}
.path{color:var(--muted);font-size:.9rem;word-break:break-all}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:1.1rem 1.25rem;margin:1rem 0}
.chip{display:inline-block;padding:.1rem .55rem;border-radius:999px;font-size:.8rem;border:1px solid var(--border);background:var(--code-bg)}
.chip-ok{color:var(--ok)}.chip-warn{color:var(--warn)}.chip-info{color:var(--accent)}.chip-muted{color:var(--muted)}
pre{background:var(--code-bg);border:1px solid var(--border);border-radius:8px;padding:.9rem 1rem;overflow-x:auto;font-size:.85rem;line-height:1.5;white-space:pre-wrap;word-break:break-word}
pre.argv{white-space:pre-wrap}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em}
table{border-collapse:collapse;width:100%;font-size:.88rem}
td,th{padding:.3rem .6rem;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
td.key{font-family:ui-monospace,Menlo,monospace;font-size:.82rem;white-space:nowrap}
.scroll-x{overflow-x:auto}
.muted{color:var(--muted)}
.subtitle{margin-top:-.5rem;font-size:.85rem}
.banner{border-radius:8px;padding:.7rem 1rem;margin:.75rem 0}
.banner.warn{background:var(--warn-bg);border:1px solid var(--warn)}
.banner ul{margin:.35rem 0 0;padding-left:1.2rem}
.tokenbar{height:6px;border-radius:3px;background:var(--code-bg);border:1px solid var(--border);overflow:hidden;margin:.25rem 0}
.tokenbar-fill{height:100%;background:var(--accent)}
.tokenbar-fill.over{background:var(--warn)}
footer{margin-top:2rem;color:var(--muted);font-size:.8rem;text-align:center}
details summary{cursor:pointer;color:var(--muted);margin-bottom:.5rem}
</style>
</head>
<body>
<main>
<header>
<h1>${esc(model.flow.name)}</h1>
<p class="path">${esc(model.flow.path)}</p>
<p>${badges}</p>
<p class="muted">engine: ${esc(model.engine.name)} <span class="muted">(${esc(model.engine.source)})</span> · mode: ${esc(model.mode.source)}</p>
</header>
${warningsHtml}
${section("Command", argvHtml, "Exactly what a run would spawn.")}
${section("Resolved prompt", promptHtml)}
${model.inputs.length ? section("Inputs", inputsHtml) : ""}
${hooksHtml}
${systemPromptHtml}
${isolationHtml}
${section("Configuration precedence", configLayers, "Later layers override earlier ones. Env-like values are redacted.")}
${section("Final flags", kvTable(model.frontmatter.finalFlags))}
${extrasHtml}
${bodyHtml}
<footer>Rendered by mdflow ${esc(model.generatedWith)} · Flow UX Protocol v${model.protocolVersion} · ${esc(model.configFingerprint.slice(0, 19))}… · free (no engine call)</footer>
</main>
<script type="application/json" id="mdflow-render-model">${modelJson}</script>
</body>
</html>
`;
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  const oneLine = arg.length <= 120 && !arg.includes("\n");
  const body = oneLine ? arg : `${arg.slice(0, 117).replace(/\n/g, " ")}…`;
  return `'${body.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

/** Default output path for --open: stable per flow path, under the OS tmpdir. */
export function defaultRenderPath(flowPath: string): string {
  const dir = join(tmpdir(), "mdflow-render");
  mkdirSync(dir, { recursive: true });
  const slug = basename(flowPath).replace(/\.md$/, "").replace(/[^A-Za-z0-9._-]/g, "_");
  const hash = createHash("sha256").update(resolve(flowPath)).digest("hex").slice(0, 8);
  return join(dir, `${slug}-${hash}.html`);
}

/** Run the render command. Returns an exit code; never invokes an engine. */
export async function runRender(args: string[], cwd: string = process.cwd()): Promise<number> {
  const jsonMode = args.includes("--json");
  const openMode = args.includes("--open");
  let outPath: string | undefined;
  const cleanArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json" || arg === "--open") continue;
    if (arg === "--out") {
      outPath = args[i + 1];
      i++;
      continue;
    }
    cleanArgs.push(arg);
  }

  const filePath = cleanArgs[0];
  if (!filePath) {
    console.error("Usage: md render <flow.md> [flags] [--json] [--out <path>] [--open]");
    console.error("\nRender a flow's resolved prompt and configuration as a self-contained");
    console.error("HTML page (FREE — no engine call). --json emits the render model instead.");
    return 1;
  }

  try {
    const model = await buildRenderModel(filePath, cleanArgs.slice(1), cwd);

    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(model)}\n`);
      return 0;
    }

    const html = renderFlowHtml(model);
    if (!outPath && !openMode) {
      process.stdout.write(html);
      return 0;
    }

    const target = outPath ?? defaultRenderPath(model.flow.path);
    await Bun.write(target, html);
    console.log(target);

    if (openMode) {
      const opener = process.platform === "darwin" ? "open" : "xdg-open";
      spawn(opener, [target], { detached: true, stdio: "ignore" }).unref();
    }
    return 0;
  } catch (err) {
    console.error(`Error rendering flow: ${(err as Error).message}`);
    return 1;
  }
}
