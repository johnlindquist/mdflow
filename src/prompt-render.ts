import { randomUUID } from "node:crypto";
import { Semaphore, DEFAULT_CONCURRENCY_LIMIT } from "./concurrency";
import { parseImports } from "./imports-parser";
import { injectImports } from "./imports-injector";
import { ImportBudget, executeImportActions, isExecutableImport, resolveContentAction, type ExecutableImport, type ImportContext } from "./imports";
import { createTemplateEngine, substituteTemplateVars, type TemplateVars } from "./template";

/** Only source spans in the supplied flow may introduce shell actions. Liquid
 * can select, repeat and parameterize those spans, not synthesize new ones.
 * Imported context, input values and process output are never parsed as code. */
export async function renderFlowPrompt(
  source: string, dir: string, vars: TemplateVars, ctx: ImportContext,
  mode: "run" | "dry-run" | "explain" | "source-only" = "run",
): Promise<string> {
  const actions = parseImports(source);
  if (!actions.length) return substituteTemplateVars(source, vars);

  const budget = new ImportBudget();
  budget.actions(actions.length, 0);
  ctx = { ...ctx, budget };
  const gate = new Semaphore(DEFAULT_CONCURRENCY_LIMIT);
  const data = await Promise.all(actions.map(action => isExecutableImport(action) || mode === "source-only"
    ? action.original : gate.run(() => resolveContentAction(action, dir, new Set(), false, ctx))));

  // A private Liquid tag preserves the surrounding loop/if/capture scope.
  // Its payload lives in this invocation's table, never in rendered markdown.
  const slot = `mdflow_${randomUUID().replaceAll("-", "")}`;
  const engine = createTemplateEngine();
  const bound: ExecutableImport[] = [];
  engine.registerTag(slot, {
    render(scope) {
      const i = Number(this.token.args);
      const action = actions[i]!;
      if (!isExecutableImport(action)) return data[i];
      const render = (s: string): string => engine.parseAndRenderSync(s, scope);
      if (mode === "explain" || mode === "source-only") return render(action.original);
      const id = bound.length;
      if (id >= 1024) throw new Error("Rendered prompt exceeds 1024 executable actions");
      bound.push(action.type === "command"
        ? { ...action, command: render(action.command) }
        : { ...action, shebang: render(action.shebang), code: render(action.code) });
      return `\u0000${slot}:${id}\u0000`;
    },
  });
  const template = injectImports(source, actions.map((action, i) => ({ action, content: `{% ${slot} ${i} %}` })));
  const rendered: string = engine.parseAndRenderSync(template, vars);
  // A literal tag (e.g. inside a Liquid raw block) is just its source text.
  const text = rendered.replace(new RegExp(`{% ${slot} (\\d+) %}`, "g"), (_, i: string) => actions[Number(i)]!.original);
  // Resolve references only, not markdown. Never parse text, or a quoted
  // backtick in a variable can terminate a command and introduce another.
  const selected = [...text.matchAll(new RegExp(`\u0000${slot}:(\\d+)\u0000`, "g"))].map(match => ({
    ...bound[Number(match[1])]!, index: match.index!, original: match[0],
  }));
  if (selected.length > 1024) throw new Error("Rendered prompt exceeds 1024 executable actions");
  return injectImports(text, await executeImportActions(selected, dir, false, { ...ctx, dryRun: mode === "dry-run" }));
}
