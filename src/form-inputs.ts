/**
 * Form inputs module - handles typed interactive prompts
 *
 * Renders appropriate inquirer prompts based on input definitions
 * in the _inputs frontmatter field.
 */

import type { InputDefinition, FormInputs } from "./types";

// Lazy-load the remaining stock prompts to avoid cold start penalty.
let _select: typeof import("@inquirer/prompts").select | null = null;
let _confirm: typeof import("@inquirer/prompts").confirm | null = null;

async function getPrompts() {
  if (!_select || !_confirm) {
    const mod = await import("@inquirer/prompts");
    _select = mod.select;
    _confirm = mod.confirm;
  }
  return { select: _select!, confirm: _confirm! };
}

type FormPromptModule = typeof import("./form-input-prompts");
type TabSafeTextConfig = Parameters<FormPromptModule["tabSafeTextPrompt"]>[0];
type TabSafeNumberConfig = Parameters<FormPromptModule["tabSafeNumberPrompt"]>[0];
type TabSafePromptContext = Parameters<FormPromptModule["tabSafeTextPrompt"]>[1];

let _formPrompts: Promise<FormPromptModule> | null = null;
function getFormPrompts(): Promise<FormPromptModule> {
  _formPrompts ??= import("./form-input-prompts");
  return _formPrompts;
}

/** Lazy wrapper around the controlled text prompt. */
export async function tabSafeTextPrompt(
  config: TabSafeTextConfig,
  context?: TabSafePromptContext,
): Promise<string> {
  return (await getFormPrompts()).tabSafeTextPrompt(config, context);
}

/** Lazy wrapper around the controlled masked prompt. */
export async function tabSafePasswordPrompt(
  config: TabSafeTextConfig,
  context?: TabSafePromptContext,
): Promise<string> {
  return (await getFormPrompts()).tabSafePasswordPrompt(config, context);
}

/** Lazy wrapper around the controlled numeric prompt. */
export async function tabSafeNumberPrompt(
  config: TabSafeNumberConfig,
  context?: TabSafePromptContext,
): Promise<string> {
  return (await getFormPrompts()).tabSafeNumberPrompt(config, context);
}

/**
 * Check if _inputs is using the new object format (FormInputs)
 * or the legacy array format
 */
export function isFormInputs(inputs: string[] | FormInputs | undefined): inputs is FormInputs {
  return inputs !== undefined && !Array.isArray(inputs) && typeof inputs === "object";
}

/**
 * Check if _inputs is using the legacy array format
 */
export function isLegacyInputs(inputs: string[] | FormInputs | undefined): inputs is string[] {
  return Array.isArray(inputs);
}

/**
 * Get all variable names defined in _inputs (works for both formats)
 */
export function getInputVariableNames(inputs: string[] | FormInputs | undefined): string[] {
  if (!inputs) return [];
  if (isLegacyInputs(inputs)) return inputs;
  return Object.keys(inputs);
}

/**
 * Prompt for a single input value based on its definition
 */
async function promptForInput(
  name: string,
  definition: InputDefinition,
): Promise<string> {
  const message = definition.description || `${name}:`;

  switch (definition.type) {
    case "text": {
      const result = await tabSafeTextPrompt({
        message,
        default: definition.default !== undefined ? String(definition.default) : undefined,
        required: definition.required !== false,
      });
      return result;
    }

    case "password": {
      const result = await tabSafePasswordPrompt({
        message,
        default: definition.default,
        required: definition.required !== false,
      });
      return result;
    }

    case "select": {
      if (!definition.options || definition.options.length === 0) {
        throw new Error(`Select input "${name}" requires options array`);
      }
      const { select } = await getPrompts();
      const result = await select({
        message,
        choices: definition.options.map((opt) => ({ value: opt, name: opt })),
        default: definition.default !== undefined ? String(definition.default) : undefined,
      });
      return result;
    }

    case "number": {
      const result = await tabSafeNumberPrompt({
        message,
        default: definition.default !== undefined ? Number(definition.default) : undefined,
        min: definition.min,
        max: definition.max,
        required: definition.required !== false,
      });
      return result;
    }

    case "confirm": {
      const defaultValue = definition.default !== undefined ? Boolean(definition.default) : undefined;
      const { confirm } = await getPrompts();
      const result = await confirm({
        message,
        default: defaultValue,
      });
      return String(result);
    }

    default:
      throw new Error(`Unknown input type: ${(definition as InputDefinition).type}`);
  }
}

/**
 * Collect all form inputs interactively
 *
 * @param inputs - The _inputs definition from frontmatter (object format)
 * @param existingVars - Template variables already provided (via CLI or frontmatter defaults)
 * @returns Record of variable names to their string values
 */
export async function collectFormInputs(
  inputs: FormInputs,
  existingVars: Record<string, string> = {},
): Promise<Record<string, string>> {
  const result: Record<string, string> = { ...existingVars };

  for (const [name, definition] of Object.entries(inputs)) {
    // Skip if already provided via CLI
    if (name in existingVars && existingVars[name] !== undefined && existingVars[name] !== "") {
      continue;
    }

    // Skip if not required and has a default (use the default)
    if (definition.required === false && definition.default !== undefined) {
      if (!(name in result)) {
        result[name] = String(definition.default);
      }
      continue;
    }

    // Check if there's a default value we can use without prompting
    // Only skip prompting if required is explicitly false
    if (definition.default !== undefined && definition.required === false) {
      result[name] = String(definition.default);
      continue;
    }

    // Prompt for the value
    result[name] = await promptForInput(name, definition);
  }

  return result;
}

/**
 * Get default values from form inputs without prompting
 * Used for non-interactive mode or when values are provided via CLI
 */
export function getFormInputDefaults(inputs: FormInputs): Record<string, string> {
  const defaults: Record<string, string> = {};

  for (const [name, definition] of Object.entries(inputs)) {
    if (definition.default !== undefined) {
      defaults[name] = String(definition.default);
    }
  }

  return defaults;
}

/**
 * Validate that required inputs have values
 *
 * @param inputs - The form inputs definition
 * @param values - The collected/provided values
 * @returns Array of missing required input names
 */
export function getMissingRequiredInputs(
  inputs: FormInputs,
  values: Record<string, string>,
): string[] {
  const missing: string[] = [];

  for (const [name, definition] of Object.entries(inputs)) {
    const isRequired = definition.required !== false;
    const hasValue = name in values && values[name] !== undefined && values[name] !== "";

    if (isRequired && !hasValue) {
      missing.push(name);
    }
  }

  return missing;
}
