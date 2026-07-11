/** Controlled form prompts loaded only when a typed interactive form needs them. */

import {
  createPrompt,
  isEnterKey,
  makeTheme,
  type KeypressEvent,
  useKeypress,
  usePrefix,
  useState,
} from "@inquirer/core";

interface ExtendedKeypressEvent extends KeypressEvent {
  sequence?: string;
  meta?: boolean;
}

export interface TabSafeTextPromptConfig {
  message: string;
  default?: string;
  required?: boolean;
}

export interface TabSafeNumberPromptConfig {
  message: string;
  default?: number;
  min?: number;
  max?: number;
  required?: boolean;
}

interface ControlledPromptOptions<Config extends { message: string }> {
  defaultValue: (config: Config) => string;
  displayValue?: (value: string) => string;
  validate: (value: string, config: Config) => true | string;
}

function printableCharacter(key: ExtendedKeypressEvent): string | undefined {
  if (key.ctrl || key.meta) return undefined;
  const sequence = key.sequence;
  if (!sequence || [...sequence].length !== 1 || /[\u0000-\u001f\u007f]/u.test(sequence)) return undefined;
  return sequence;
}

function createTabSafeValuePrompt<Config extends { message: string }>(
  options: ControlledPromptOptions<Config>,
) {
  return createPrompt<string, Config>((config, done) => {
    const prefix = usePrefix({ status: "idle", theme: makeTheme({}) });
    const [value, setValue] = useState("");
    const [defaultValue, setDefaultValue] = useState(options.defaultValue(config));
    const [error, setError] = useState<string | undefined>(undefined);

    useKeypress((keypress, readline) => {
      const key = keypress as ExtendedKeypressEvent;

      if (key.name === "tab") {
        // readline inserts Tab into its own buffer before this handler. These
        // prompts are controlled, so discard the raw line and retain `value`.
        readline.clearLine(0);
        return;
      }
      if (isEnterKey(key)) {
        const answer = value || defaultValue;
        const validation = options.validate(answer, config);
        if (validation === true) done(answer);
        else setError(validation);
        return;
      }
      if (key.name === "backspace") {
        if (value) setValue(value.slice(0, -1));
        else setDefaultValue("");
        setError(undefined);
        return;
      }
      const character = printableCharacter(key);
      if (character) {
        setValue(value + character);
        setError(undefined);
      }
    });

    const displayValue = options.displayValue?.(value) ?? value;
    const displayedDefault = !value && defaultValue
      ? `\x1b[2m${options.displayValue?.(defaultValue) ?? defaultValue}\x1b[22m`
      : "";
    const prompt = `${prefix} ${config.message} ${displayValue || displayedDefault}\x1b[36m▏\x1b[0m`;
    return error ? [prompt, `\x1b[31m${error}\x1b[0m`] : prompt;
  });
}

/** Controlled text prompt whose buffer cannot receive a literal Tab. */
export const tabSafeTextPrompt = createTabSafeValuePrompt<TabSafeTextPromptConfig>({
  defaultValue: (config) => config.default ?? "",
  validate: (value, config) => (
    config.required !== false && !value ? "You must provide a value" : true
  ),
});

/** Controlled masked prompt whose secret buffer cannot receive a literal Tab. */
export const tabSafePasswordPrompt = createTabSafeValuePrompt<TabSafeTextPromptConfig>({
  defaultValue: (config) => config.default ?? "",
  displayValue: (value) => "*".repeat([...value].length),
  validate: (value, config) => (
    config.required !== false && !value ? "You must provide a value" : true
  ),
});

/** Controlled numeric prompt whose buffer cannot receive a literal Tab. */
export const tabSafeNumberPrompt = createTabSafeValuePrompt<TabSafeNumberPromptConfig>({
  defaultValue: (config) => config.default !== undefined ? String(config.default) : "",
  validate: (value, config) => {
    if (!value) {
      return config.required === false ? true : "You must provide a valid numeric value";
    }
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return "You must provide a valid numeric value";
    if (config.min !== undefined && numericValue < config.min) {
      return `Value must be at least ${config.min}`;
    }
    if (config.max !== undefined && numericValue > config.max) {
      return `Value must be at most ${config.max}`;
    }
    return true;
  },
});
