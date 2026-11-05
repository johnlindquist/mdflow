/**
 * Template variable substitution for markdown content
 * Uses LiquidJS for full template support including conditionals and loops
 */

import { Liquid, analyzeSync } from "liquidjs";
import type { FrontmatterSystemKey } from "./types";

/** Template variable names discovered from Liquid templates. */
export type TemplateVariableName = FrontmatterSystemKey;

/** Key-value map used for template substitution. */
export interface TemplateVars {
  [key: string]: unknown;
}

/** Options for template substitution behavior. */
export interface TemplateSubstitutionOptions {
  /** When true, missing underscore-prefixed variables throw before render. */
  strict?: boolean;
}

/**
 * Cross-platform shell escaping helper
 * Prevents command injection when template variables are used in shell commands
 */
function shellEscape(str: unknown): string {
  const s = String(str ?? "");
  if (process.platform === "win32") {
    // Windows cmd.exe escaping (double-quote wrapping, escape internal quotes)
    return `"${s.replace(/"/g, '""')}"`;
  }
  // POSIX single quoting (escape single quotes by ending quote, adding escaped quote, starting new quote)
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Liquid is a renderer, not a second filesystem import mechanism. */
export function createTemplateEngine(): Liquid {
  const engine = new Liquid({ templates: Object.create(null), ownPropertyOnly: true,
    parseLimit: 10 * 1024 * 1024, memoryLimit: 10 * 1024 * 1024, renderLimit: 5_000 });
  engine.registerFilter("shell_escape", shellEscape);
  engine.registerFilter("q", shellEscape);
  return engine;
}

const engine = createTemplateEngine();

/**
 * Extract template variables from content using LiquidJS AST parsing
 *
 * STRICT MODE: Only extracts variables starting with '_' (underscore prefix).
 * This prevents {{ model }} in text from stealing the --model CLI flag.
 *
 * Returns array of global variable names (root segments) found in:
 * - {{ _variable }} output patterns
 * - {% if _variable %} logic tags
 * - {% for item in _collection %} loop tags
 * - Variables with filters: {{ _name | upcase }}
 * - Nested variables: {{ _user.name }} (returns "_user" as the root)
 *
 * Uses LiquidJS's analyzeSync for accurate AST-based extraction,
 * avoiding regex fragility with complex Liquid syntax.
 */
export function extractTemplateVars(content: string): TemplateVariableName[] {
  try {
    // Parse the template into AST
    const templates = engine.parse(content);
    // Analyze to find all global variables (undefined in template scope)
    const analysis = analyzeSync(templates, { partials: false });
    // Only return variables starting with underscore
    // This prevents {{ model }} from consuming --model flags
    return Object.keys(analysis.globals).filter(
      (k): k is TemplateVariableName => k.startsWith("_")
    );
  } catch {
    // Fallback: return empty array if template parsing fails
    // This maintains backward compatibility for malformed templates
    return [];
  }
}

/**
 * Globals referenced by the template that are NOT mdflow variables (no
 * underscore prefix). LiquidJS renders them as empty strings with no error,
 * so a flow written as `Hello {{place}}!` silently prints "Hello !" — the
 * caller uses this list to warn. Locally-defined names ({% capture %},
 * {% assign %}, loop variables) are not globals and never appear here.
 */
export function extractForeignTemplateGlobals(content: string): string[] {
  try {
    const templates = engine.parse(content);
    const analysis = analyzeSync(templates, { partials: false });
    return Object.keys(analysis.globals).filter((k) => !k.startsWith("_"));
  } catch {
    return [];
  }
}

/**
 * Referenced variables that are genuinely REQUIRED: a var whose every
 * `{{ … }}` occurrence carries a `| default:` filter is optional — the
 * filter exists precisely so the flow can run without it. Conservative on
 * anything ambiguous ({% if _v %} usage, filter-argument position, mixed
 * bare + defaulted occurrences): those stay required, same as before.
 */
export function extractRequiredTemplateVars(
  content: string
): TemplateVariableName[] {
  const all = extractTemplateVars(content);
  if (all.length === 0) return all;

  const outputs = [...content.matchAll(/\{\{([\s\S]*?)\}\}/g)].map(
    (match) => match[1] ?? ""
  );
  const tags = [...content.matchAll(/\{%([\s\S]*?)%\}/g)].map(
    (match) => match[1] ?? ""
  );

  return all.filter((name) => {
    const word = new RegExp(
      `\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`
    );
    if (tags.some((tag) => word.test(tag))) return true; // control-flow use
    let sawOptional = false;
    for (const inner of outputs) {
      if (!word.test(inner)) continue;
      const segments = inner.split("|");
      const leadsExpression = segments[0]?.trim() === name;
      const rest = segments.slice(1);
      const hasDefault = rest.some((segment) =>
        /^\s*default\s*:/.test(segment)
      );
      const usedAsFilterArg = rest.some((segment) => word.test(segment));
      if (leadsExpression && hasDefault && !usedAsFilterArg) {
        sawOptional = true;
        continue;
      }
      return true; // bare occurrence → required
    }
    return !sawOptional; // only-defaulted → optional; unseen → required
  });
}

/**
 * Substitute template variables in content using LiquidJS
 * Supports:
 * - Variable substitution: {{ variable }}
 * - Conditionals: {% if condition %}...{% endif %}
 * - Loops: {% for item in items %}...{% endfor %}
 * - Filters: {{ name | upcase }}
 * - Default values: {{ name | default: "World" }}
 */
export function substituteTemplateVars(
  content: string,
  vars: Readonly<TemplateVars>,
  options: Readonly<TemplateSubstitutionOptions> = {}
): string {
  const { strict = false } = options;

  if (strict) {
    // In strict mode, check for missing variables before rendering.
    // Vars carrying a `| default:` filter render their fallback instead.
    const required = extractRequiredTemplateVars(content);
    const missing = required.filter((v) => !(v in vars));
    if (missing.length > 0) {
      throw new Error(`Missing required template variable: ${missing[0]}`);
    }
  }

  // Use synchronous renderSync for compatibility
  return engine.parseAndRenderSync(content, vars);
}

/**
 * Parse CLI arguments into template variables
 * Extracts --key value pairs that aren't known flags
 */
export function parseTemplateArgs(
  args: readonly string[],
  knownFlags: ReadonlySet<string>
): TemplateVars {
  const vars: TemplateVars = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    // Skip non-flags
    if (!arg?.startsWith("--")) continue;

    const key = arg.slice(2); // Remove --

    // Skip known flags (handled by CLI parser)
    if (knownFlags.has(arg) || knownFlags.has(`--${key}`)) continue;

    // If next arg exists and isn't a flag, it's the value
    if (nextArg && !nextArg.startsWith("-")) {
      vars[key] = nextArg;
      i++; // Skip the value arg
    } else {
      // Boolean flag without value
      vars[key] = "true";
    }
  }

  return vars;
}
