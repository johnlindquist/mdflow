/**
 * Template variable substitution for markdown content
 * Uses LiquidJS for full template support including conditionals and loops
 */

import { Liquid } from "liquidjs";

export interface TemplateVars {
  [key: string]: string;
}

// Shared Liquid engine instance with lenient settings
const engine = new Liquid({
  strictVariables: false,  // Don't throw on undefined variables
  strictFilters: false,    // Don't throw on undefined filters
});

/**
 * Extract template variables from content
 * Returns array of variable names found in:
 * - {{ variable }} output patterns
 * - {% if variable %}, {% unless variable %}, {% elsif variable %} logic tags
 * Note: This only extracts simple variable names, not filter expressions or complex conditions
 */
export function extractTemplateVars(content: string): string[] {
  const vars: Set<string> = new Set();

  // Match variables in {{ variable }} output tags
  // Captures: {{ name }}, {{ name | filter }}, etc.
  const outputRegex = /\{\{\s*(\w+)\s*(?:\|[^}]*)?\}\}/g;
  let match;
  while ((match = outputRegex.exec(content)) !== null) {
    if (match[1]) vars.add(match[1]);
  }

  // Match variables in {% if/unless/elsif variable %} logic tags
  // Handles: {% if var %}, {% unless var %}, {% elsif var %}
  // Also handles comparisons: {% if var == "value" %}, {% if var != "value" %}
  // Also handles boolean operators: {% if var and other %}, {% if var or other %}
  const logicTagRegex = /\{%\s*(?:if|unless|elsif)\s+(.+?)\s*%\}/g;
  while ((match = logicTagRegex.exec(content)) !== null) {
    if (match[1]) {
      // Extract all word tokens from the condition, excluding operators and string literals
      let condition = match[1];
      // Remove string literals (both single and double quoted) to avoid extracting their contents
      condition = condition.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '');
      // Match word tokens that are not operators or keywords
      const tokenRegex = /\b(\w+)\b/g;
      const operators = new Set(['and', 'or', 'not', 'contains', 'true', 'false', 'nil', 'null', 'empty', 'blank']);
      let tokenMatch;
      while ((tokenMatch = tokenRegex.exec(condition)) !== null) {
        const token = tokenMatch[1];
        // Skip operators, keywords, and numeric values
        if (token && !operators.has(token) && !/^\d+$/.test(token)) {
          vars.add(token);
        }
      }
    }
  }

  return Array.from(vars);
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
