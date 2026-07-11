/**
 * Tiny controlled text prompts used on paths that lead into or back to the
 * Flow Workbench. @inquirer/input mirrors readline's line buffer, where Tab
 * can become a literal character; these prompts keep their own clean buffer
 * and make Tab an explicit no-op.
 */

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

export interface WorkbenchInputConfig {
  message: string;
  default?: string;
  validate?: (value: string) => boolean | string;
  /** Pause prompts accept Enter only and never build a text buffer. */
  allowText?: boolean;
}

function printableCharacter(key: ExtendedKeypressEvent): string | undefined {
  if (key.ctrl || key.meta) return undefined;
  const sequence = key.sequence;
  if (!sequence || [...sequence].length !== 1 || /[\u0000-\u001f\u007f]/u.test(sequence)) return undefined;
  return sequence;
}

export const workbenchInputPrompt = createPrompt<string, WorkbenchInputConfig>((config, done) => {
  const prefix = usePrefix({ status: "idle", theme: makeTheme({}) });
  const [value, setValue] = useState(config.default ?? "");
  const [error, setError] = useState<string | undefined>(undefined);
  const allowText = config.allowText !== false;

  useKeypress((keypress, readline) => {
    const key = keypress as ExtendedKeypressEvent;

    if (key.name === "tab") {
      // readline mutates its own line before keypress handlers run. The prompt
      // is controlled, so clear that raw line and intentionally keep `value`.
      readline.clearLine(0);
      return;
    }
    if (isEnterKey(key)) {
      const answer = value || config.default || "";
      const validation = config.validate?.(answer) ?? true;
      if (validation === true) done(answer);
      else setError(validation === false ? "Invalid value" : validation);
      return;
    }
    if (!allowText) return;
    if (key.name === "backspace") {
      setValue(value.slice(0, -1));
      setError(undefined);
      return;
    }
    const character = printableCharacter(key);
    if (character) {
      setValue(value + character);
      setError(undefined);
    }
  });

  const cursor = allowText ? "\x1b[36m▏\x1b[0m" : "";
  const prompt = `${prefix} ${config.message}${allowText ? ` ${value}${cursor}` : ""}`;
  return error ? [prompt, `\x1b[31m${error}\x1b[0m`] : prompt;
});

export function tabSafeInput(config: Omit<WorkbenchInputConfig, "allowText">): Promise<string> {
  return workbenchInputPrompt({ ...config, allowText: true });
}

export async function tabSafePause(message: string): Promise<void> {
  await workbenchInputPrompt({ message, allowText: false });
}
