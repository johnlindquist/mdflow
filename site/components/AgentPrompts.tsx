import React from 'react';
import { CopyPrompt } from './CopyPrompt';
import { motion } from 'framer-motion';

/**
 * The agent-first section: mdflow assumes your first "user" is the coding
 * agent you already have open. Every card is a prompt (or one command) to
 * paste. The agent does the rest.
 */

const SETUP_PROMPT = `Start my repo's agent roster with mdflow:

1. Run \`npx mdflow init --yes\` in this repo. It scaffolds ./flows (starter flows, starter evals, README roster) and .mdflow.yaml with evolve.mode: suggest, spending zero engine invocations.
2. Tailor the generated flows to THIS repo: the right test command, diff scope, vocabulary, and engine.
3. Enforce this for every interactive specialist that should wait when no initial task is supplied: identity in \`_system-prompt\`, complete operating rules/stable context in \`_append-system-prompt\`, \`_task: ""\`, and a body exactly \`{{ _task }}\`. Never add \`User task:\`, headings, imports, placeholder prose, or instructions to that body; any non-empty body auto-submits a first turn.
4. Replace each generic starter eval with 1 to 3 behavioral cases that check invariants, not exact wording.
5. Verify waiting specialists with \`md explain <flow>\` and \`md <flow> --_interactive --_dry-run\`: both instruction layers present, blank final prompt, and no positional prompt. Verify eval plans separately.
6. Do NOT do a real flow or eval run until I separately approve it. Never infer consent for one from the other.`;

const SKILL_COMMAND = `npx skills add johnlindquist/mdflow`;

const EVALS_PROMPT = `Give every flow in ./flows a colocated eval suite <flow>.eval.ts that exports default an EvalCase[]:

- 1 to 3 cases, each with optional setup(dir), repetitions/quorum, and a check({ stdout, dir, exitCode, timedOut }) that returns null on pass or a failure reason.
- Check invariants (files created, numbers, names), never exact wording.
- Nonzero exits fail by default; timeouts are inconclusive; mixed repetitions are flaky and cannot mint clean proof.
- Run \`md eval <flow>.md --plan\` first. Tell me the exact paid invocation count including repetitions and wait for my go-ahead.
- Link regression cases to durable feedback with evidence: ["fb_..."]; generated Distill drafts are untrusted until reviewed.

Creed: if a guardrail isn't covered by an eval, it's a wish.`;

const MIGRATE_PROMPT = `Migrate my legacy mdflow v2 files to the current format:

1. Move loose agent .md files into ./flows and add a flows/README.md roster index.
2. Frontmatter \`tool:\` / \`_tool:\` becomes \`engine:\`. The \`--_command\` / \`--tool\` flags become \`--engine\`.
3. Rename *.gemini.md flows to *.agy.md (Google sunset the gemini CLI for individuals; agy is the successor, and --yolo is gone there).
4. For every interactive specialist that should wait without an initial task, migrate identity to \`_system-prompt\`, the complete operating contract/stable context to \`_append-system-prompt\`, declare \`_task: ""\`, and make the body exactly \`{{ _task }}\`. Delete synthetic \`User task:\` wrappers and never leave instructions/imports in the user body, because they auto-submit the first turn.
5. Verify each waiting specialist with \`md explain <file>\` and \`md <file> --_interactive --_dry-run\`: both instruction layers present, blank final prompt, and no positional prompt. Make no other changes.`;

export const AgentPrompts: React.FC = () => {
    return (
        <section id="agent-first" className="py-24 md:py-32 px-6 relative overflow-hidden border-t border-white/5">
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full h-px bg-gradient-to-r from-transparent via-blue-500 to-transparent opacity-50"></div>
            <div className="absolute top-[-30%] right-[-15%] w-[700px] h-[700px] bg-blue-600/10 blur-[150px] rounded-full pointer-events-none"></div>

            <div className="max-w-6xl mx-auto relative z-10">
                <motion.div
                    initial={{ opacity: 0, y: 24 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6 }}
                    className="text-center mb-16"
                >
                    <p className="font-mono text-xs uppercase tracking-[0.3em] text-blue-400 mb-4">Agent-first</p>
                    <h2 className="select-none font-display font-bold text-4xl md:text-6xl tracking-tighter text-white">
                        LET YOUR AGENT<br />
                        <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-cyan-300 to-white">SET IT UP.</span>
                    </h2>
                    <p className="mt-6 text-lg text-zinc-400 max-w-2xl mx-auto font-light">
                        You already have an agent open. Paste one of these and let it build your
                        ./flows roster, wire the engines, and add behavioral guardrails. You watch.
                    </p>
                </motion.div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <CopyPrompt
                        index={0}
                        accent="orange"
                        title="Start my agent roster"
                        description="Scaffolds flows, starter evals, and suggest-only evolution; then tailors them to your repo. Zero paid invocations until you say go."
                        prompt={SETUP_PROMPT}
                        shaderTarget="setup-prompt"
                        shaderPriority={0.9}
                    />
                    <CopyPrompt
                        index={1}
                        accent="blue"
                        isCommand
                        title="Install the mdflow skill"
                        description="One command teaches your agent (Claude Code, Cursor, and friends) how to build and maintain your ./flows roster, wire the engine ladder, and ship evals. Permanently."
                        prompt={SKILL_COMMAND}
                        shaderTarget="skill-install"
                        shaderPriority={0.8}
                    />
                    <CopyPrompt
                        index={2}
                        accent="emerald"
                        title="Add evals to every flow"
                        description="Behavioral suites with repetition-aware plans and content-bound receipts. Cost is quoted before a paid invocation."
                        prompt={EVALS_PROMPT}
                    />
                    <CopyPrompt
                        index={3}
                        accent="pink"
                        title="Migrate legacy flows"
                        description="Loose files move into ./flows, tool: becomes engine:, gemini becomes agy. Everything verified with free dry-runs."
                        prompt={MIGRATE_PROMPT}
                    />
                </div>
            </div>
        </section>
    );
};
