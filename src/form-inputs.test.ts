import { describe, it, expect } from "bun:test";
import { PassThrough } from "node:stream";
import {
  isFormInputs,
  isLegacyInputs,
  getInputVariableNames,
  getFormInputDefaults,
  getMissingRequiredInputs,
  tabSafeNumberPrompt,
  tabSafePasswordPrompt,
  tabSafeTextPrompt,
} from "./form-inputs";
import type { FormInputs } from "./types";

describe("isFormInputs", () => {
  it("returns true for object format", () => {
    const inputs: FormInputs = {
      _name: { type: "text" },
    };
    expect(isFormInputs(inputs)).toBe(true);
  });

  it("returns false for array format", () => {
    const inputs = ["_name", "_value"];
    expect(isFormInputs(inputs)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isFormInputs(undefined)).toBe(false);
  });
});

describe("isLegacyInputs", () => {
  it("returns true for array format", () => {
    const inputs = ["_name", "_value"];
    expect(isLegacyInputs(inputs)).toBe(true);
  });

  it("returns false for object format", () => {
    const inputs: FormInputs = {
      _name: { type: "text" },
    };
    expect(isLegacyInputs(inputs)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isLegacyInputs(undefined)).toBe(false);
  });
});

describe("getInputVariableNames", () => {
  it("returns variable names from object format", () => {
    const inputs: FormInputs = {
      _name: { type: "text" },
      _env: { type: "select", options: ["dev", "prod"] },
    };
    expect(getInputVariableNames(inputs)).toEqual(["_name", "_env"]);
  });

  it("returns variable names from array format", () => {
    const inputs = ["_name", "_value"];
    expect(getInputVariableNames(inputs)).toEqual(["_name", "_value"]);
  });

  it("returns empty array for undefined", () => {
    expect(getInputVariableNames(undefined)).toEqual([]);
  });
});

describe("getFormInputDefaults", () => {
  it("extracts default values from form inputs", () => {
    const inputs: FormInputs = {
      _name: { type: "text", default: "World" },
      _count: { type: "number", default: 10 },
      _enabled: { type: "confirm", default: true },
      _noDefault: { type: "text" },
    };
    const defaults = getFormInputDefaults(inputs);
    expect(defaults).toEqual({
      _name: "World",
      _count: "10",
      _enabled: "true",
    });
  });

  it("returns empty object for inputs without defaults", () => {
    const inputs: FormInputs = {
      _name: { type: "text" },
      _value: { type: "text" },
    };
    const defaults = getFormInputDefaults(inputs);
    expect(defaults).toEqual({});
  });
});

describe("getMissingRequiredInputs", () => {
  it("returns missing required inputs", () => {
    const inputs: FormInputs = {
      _name: { type: "text" },
      _value: { type: "text" },
    };
    const values = { _name: "John" };
    const missing = getMissingRequiredInputs(inputs, values);
    expect(missing).toEqual(["_value"]);
  });

  it("does not include optional inputs as missing", () => {
    const inputs: FormInputs = {
      _name: { type: "text" },
      _optional: { type: "text", required: false },
    };
    const values = { _name: "John" };
    const missing = getMissingRequiredInputs(inputs, values);
    expect(missing).toEqual([]);
  });

  it("does not include inputs with values", () => {
    const inputs: FormInputs = {
      _name: { type: "text" },
      _value: { type: "text" },
    };
    const values = { _name: "John", _value: "Hello" };
    const missing = getMissingRequiredInputs(inputs, values);
    expect(missing).toEqual([]);
  });

  it("treats empty string as missing", () => {
    const inputs: FormInputs = {
      _name: { type: "text" },
    };
    const values = { _name: "" };
    const missing = getMissingRequiredInputs(inputs, values);
    expect(missing).toEqual(["_name"]);
  });

  it("treats inputs as required by default", () => {
    const inputs: FormInputs = {
      _name: { type: "text" },
      _requiredExplicit: { type: "text", required: true },
    };
    const values = {};
    const missing = getMissingRequiredInputs(inputs, values);
    expect(missing).toEqual(["_name", "_requiredExplicit"]);
  });
});

describe("form input types", () => {
  it("supports text type", () => {
    const inputs: FormInputs = {
      _name: {
        type: "text",
        description: "Enter your name",
        default: "World",
      },
    };
    expect(inputs._name!.type).toBe("text");
    expect(inputs._name!.description).toBe("Enter your name");
    expect(inputs._name!.default).toBe("World");
  });

  it("supports select type with options", () => {
    const inputs: FormInputs = {
      _env: {
        type: "select",
        description: "Select environment",
        options: ["dev", "staging", "prod"],
        default: "dev",
      },
    };
    const input = inputs._env!;
    expect(input.type).toBe("select");
    if (input.type !== "select") throw new Error("expected select input");
    expect(input.options).toEqual(["dev", "staging", "prod"]);
    expect(input.default).toBe("dev");
  });

  it("supports number type with min/max", () => {
    const inputs: FormInputs = {
      _count: {
        type: "number",
        description: "Enter count",
        default: 5,
        min: 1,
        max: 100,
      },
    };
    const input = inputs._count!;
    expect(input.type).toBe("number");
    if (input.type !== "number") throw new Error("expected number input");
    expect(input.min).toBe(1);
    expect(input.max).toBe(100);
    expect(input.default).toBe(5);
  });

  it("supports confirm type", () => {
    const inputs: FormInputs = {
      _proceed: {
        type: "confirm",
        description: "Do you want to proceed?",
        default: true,
      },
    };
    expect(inputs._proceed!.type).toBe("confirm");
    expect(inputs._proceed!.default).toBe(true);
  });

  it("supports password type", () => {
    const inputs: FormInputs = {
      _secret: {
        type: "password",
        description: "Enter password",
      },
    };
    expect(inputs._secret!.type).toBe("password");
  });
});

describe("Tab-safe form prompts", () => {
  function promptContext() {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk) => { rendered += chunk.toString(); });
    const press = async (
      name: string,
      sequence = name.length === 1 ? name : "",
    ) => {
      input.emit("keypress", sequence, { name, sequence, ctrl: false });
      await Bun.sleep(0);
    };
    return {
      context: { input, output, clearPromptOnDone: true },
      press,
      rendered: () => rendered,
      async waitForPrompt() {
        for (let attempt = 0; attempt < 100 && !rendered; attempt += 1) {
          await Bun.sleep(1);
        }
        if (!rendered) throw new Error("form prompt did not render");
      },
    };
  }

  it("keeps Tab out of controlled text values", async () => {
    const prompt = promptContext();
    const pending = tabSafeTextPrompt({ message: "Name", required: true }, prompt.context);
    await prompt.waitForPrompt();
    await prompt.press("a");
    await prompt.press("tab", "\t");
    await prompt.press("b");
    await prompt.press("enter");

    expect(await pending).toBe("ab");
  });

  it("keeps Tab out of masked password values", async () => {
    const prompt = promptContext();
    const pending = tabSafePasswordPrompt({ message: "Secret", required: true }, prompt.context);
    await prompt.waitForPrompt();
    for (const character of "hunter") await prompt.press(character);
    await prompt.press("tab", "\t");
    await prompt.press("2");
    await prompt.press("enter");

    expect(await pending).toBe("hunter2");
    expect(prompt.rendered()).not.toContain("hunter2");
  });

  it("keeps Tab out of controlled number values", async () => {
    const prompt = promptContext();
    const pending = tabSafeNumberPrompt(
      { message: "Count", min: 1, max: 100, required: true },
      prompt.context,
    );
    await prompt.waitForPrompt();
    await prompt.press("1");
    await prompt.press("tab", "\t");
    await prompt.press("2");
    await prompt.press("enter");

    expect(await pending).toBe("12");
  });
});
