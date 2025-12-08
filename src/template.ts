/**
 * Template variable substitution for markdown content
 * Uses LiquidJS for full template support including conditionals and loops
 */

import { Liquid, analyzeSync } from "liquidjs";

export interface TemplateVars {
  [key: string]: string;
}

// Shared Liquid engine instance with lenient settings
const engine = new Liquid({
  strictVariables: false,  // Don't throw on undefined variables
  strictFilters: false,    // Don't throw on undefined filters
});

/**
 * Extract template variables from content using LiquidJS AST parsing
 * Returns array of global variable names (root segments) found in:
 * - {{ variable }} output patterns
 * - {% if variable %}, {% unless variable %}, {% elsif variable %} logic tags
 * - {% for item in collection %} loop tags
 * - Variables with filters: {{ name | upcase }}
 * - Nested variables: {{ user.name }} (returns "user" as the root)
 *
 * Uses LiquidJS's analyzeSync for accurate AST-based extraction,
 * avoiding regex fragility with complex Liquid syntax.
 */
export function extractTemplateVars(content: string): string[] {
  try {
    // Parse the template into AST
    const templates = engine.parse(content);
    // Analyze to find all global variables (undefined in template scope)
    const analysis = analyzeSync(templates, { partials: false });
    // Return the root variable names from globals
    return Object.keys(analysis.globals);
  } catch {
    // Fallback: return empty array if template parsing fails
    // This maintains backward compatibility for malformed templates
    return [];
  }
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
  vars: TemplateVars,
  options: { strict?: boolean } = {}
): string {
  const { strict = false } = options;

  if (strict) {
    // In strict mode, check for missing variables before rendering
    const required = extractTemplateVars(content);
    const missing = required.filter(v => !(v in vars));
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
  args: string[],
  knownFlags: Set<string>
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
