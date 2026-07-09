import { basename, relative, resolve, sep } from "node:path";

export type WorkbenchEffect = "FREE" | "ENGINE" | "LOCAL WRITE";

export interface FlowTipContext {
  cwd: string;
  flowPath: string;
  firstSuccessfulRun?: boolean;
  created?: boolean;
  hasEval?: boolean;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Return the shortest command that still resolves to this flow. */
export function flowCommand(flowPath: string, cwd: string, executable = "md"): string {
  const absoluteFlow = resolve(flowPath);
  const rosterRoot = resolve(cwd, "flows") + sep;
  if (absoluteFlow.startsWith(rosterRoot)) {
    const name = basename(absoluteFlow).replace(/\.md$/i, "");
    return `${executable} ${shellQuote(name)}`;
  }

  const relativePath = relative(resolve(cwd), absoluteFlow);
  if (relativePath && !relativePath.startsWith("..") && !relativePath.startsWith(sep)) {
    return `${executable} ${shellQuote(relativePath)}`;
  }
  return `${executable} ${shellQuote(absoluteFlow)}`;
}

/**
 * One contextual next step, intended for TTY surfaces only. The caller decides
 * when to show it; this function never writes or persists state.
 */
export function contextualFlowTip(context: FlowTipContext): string | null {
  const command = flowCommand(context.flowPath, context.cwd);
  if (context.created) {
    return `Run it directly: ${command}  ·  Open the Flow Workbench: md`;
  }
  if (context.firstSuccessfulRun && !context.hasEval) {
    return `Next: run \`md\`, select this flow, and press i to add evidence or improve it.`;
  }
  if (context.firstSuccessfulRun) {
    return `Next time: ${command}  ·  Browse every flow with: md`;
  }
  return null;
}
