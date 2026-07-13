/**
 * The workbench prompts exist for exactly one reason: readline lets Tab leak
 * into the line buffer as a literal character, and a stray "\t" inside a flow
 * intent or workbench command corrupts the downstream draft. These tests
 * drive the real prompt through real streams — the keypress path, not a
 * mock — and prove the input protocol: Tab is a no-op, control sequences
 * never type, and the pause variant accepts Enter alone.
 */

import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import { workbenchInputPrompt } from "./workbench-input";

type PromptStreams = {
  input: PassThrough;
  output: PassThrough;
};

function openStreams(): PromptStreams {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume(); // drain renders so the prompt never blocks on backpressure
  return { input, output };
}

async function type(input: PassThrough, ...sequences: string[]): Promise<void> {
  for (const sequence of sequences) {
    input.write(sequence);
    await new Promise((resolveTick) => setTimeout(resolveTick, 5));
  }
}

function ask(
  streams: PromptStreams,
  config: Parameters<typeof workbenchInputPrompt>[0]
): Promise<string> {
  return workbenchInputPrompt(config, {
    input: streams.input as unknown as NodeJS.ReadableStream,
    output: streams.output as unknown as NodeJS.WritableStream,
  });
}

describe("workbenchInputPrompt input protocol", () => {
  it("Tab is a no-op: literal tabs never enter the value", async () => {
    const streams = openStreams();
    const answer = ask(streams, { message: "Command" });
    await type(streams.input, "a", "\t", "b", "\t", "\r");
    expect(await answer).toBe("ab");
  });

  it("Tab does not clobber the default: tab then Enter returns it intact", async () => {
    const streams = openStreams();
    const answer = ask(streams, { message: "Command", default: "review" });
    await type(streams.input, "\t", "\r");
    expect(await answer).toBe("review");
  });

  it("backspace edits the controlled buffer and escape sequences never type", async () => {
    const streams = openStreams();
    const answer = ask(streams, { message: "Command" });
    // "\x1b[A" (arrow up) is a multi-character sequence; "\x7f" is backspace.
    await type(streams.input, "a", "b", "c", "\x1b[A", "\x7f", "\r");
    expect(await answer).toBe("ab");
  });

  it("pause mode (allowText: false) ignores typed text and resolves on Enter", async () => {
    const streams = openStreams();
    const answer = ask(streams, { message: "Press Enter", allowText: false });
    await type(streams.input, "x", "\t", "y", "\r");
    expect(await answer).toBe("");
  });
});
