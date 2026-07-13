import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Editor } from './Editor';
import { Terminal } from './Terminal';

/** Plain init turns a project into a visible, versioned roster without spending an engine turn. */
export const FlowsRoster: React.FC = () => {
    const reducedMotion = useReducedMotion();

    return (
        <section id="flows" className="relative overflow-hidden border-t border-white/5 px-4 py-24 sm:px-6 md:py-32">
            <div aria-hidden="true" className="absolute left-1/2 top-0 h-px w-full -translate-x-1/2 bg-gradient-to-r from-transparent via-orange-500 to-transparent opacity-50" />
            <div aria-hidden="true" className="pointer-events-none absolute bottom-[-30%] left-[-15%] h-[700px] w-[700px] rounded-full bg-orange-600/10 blur-[150px]" />

            <div className="relative z-10 mx-auto max-w-6xl">
                <motion.div
                    initial={reducedMotion ? false : { opacity: 0, y: 24 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: reducedMotion ? 0 : 0.6 }}
                    className="mb-14 text-center md:mb-16"
                >
                    <p className="mb-4 font-mono text-xs uppercase tracking-[0.3em] text-orange-400">./flows</p>
                    <h2 className="select-none font-display text-4xl font-bold tracking-tighter text-white md:text-6xl">
                        START WITH A ROSTER.<br />
                        <span className="bg-gradient-to-r from-orange-400 via-amber-200 to-white bg-clip-text text-transparent">
                            NOT A BLANK PROMPT.
                        </span>
                    </h2>
                    <p className="mx-auto mt-6 max-w-3xl text-base font-light leading-relaxed text-zinc-400 sm:text-lg">
                        <span className="font-mono text-white">npx mdflow init</span> creates starter flows,
                        colocated evals, a roster README, and <span className="font-mono text-white">.mdflow.yaml</span>{' '}
                        without calling an engine. Bare <span className="font-mono text-white">md</span> opens the
                        Workbench to browse, create, preview, run, and improve them.
                    </p>
                </motion.div>

                <div className="grid grid-cols-1 items-stretch gap-6 lg:grid-cols-2 lg:gap-8">
                    <motion.div
                        initial={reducedMotion ? false : { opacity: 0, x: -24 }}
                        whileInView={{ opacity: 1, x: 0 }}
                        viewport={{ once: true, margin: '-80px' }}
                        transition={{ duration: reducedMotion ? 0 : 0.5 }}
                        className="min-h-[360px] overflow-hidden rounded-xl border border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.5)]"
                    >
                        <Terminal
                            title="condensed init receipt"
                            illustrative
                            caption="Condensed receipt showing that plain init writes local starter files without invoking an engine"
                            lines={[
                                { id: '1', type: 'input', content: 'npx mdflow init', ariaLabel: 'Command: ' },
                                { id: '2', type: 'label', content: 'LOCAL WRITE' },
                                { id: '3', type: 'output', content: 'starter roster created in ./flows' },
                                { id: '4', type: 'label', content: '0 ENGINE INVOCATIONS' },
                                { id: '5', type: 'output', content: 'No agent was called.' },
                                { id: '6', type: 'info', content: 'Next: md' },
                                { id: '7', type: 'info', content: 'New flow: md create "describe the job"' },
                            ]}
                        />
                    </motion.div>

                    <motion.div
                        initial={reducedMotion ? false : { opacity: 0, x: 24 }}
                        whileInView={{ opacity: 1, x: 0 }}
                        viewport={{ once: true, margin: '-80px' }}
                        transition={{ duration: reducedMotion ? 0 : 0.5, delay: reducedMotion ? 0 : 0.08 }}
                        className="min-h-[360px] overflow-hidden rounded-xl border border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.5)]"
                    >
                        <Editor
                            filename="created by mdflow init"
                            content={`flows/\n├── README.md\n├── review.md\n├── review.eval.ts\n├── onboard.md\n├── onboard.eval.ts\n├── release.md\n├── release.eval.ts\n└── ...\n\n.mdflow.yaml`}
                        />
                    </motion.div>
                </div>

                <motion.div
                    initial={reducedMotion ? false : { opacity: 0, y: 14 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: reducedMotion ? 0 : 0.45, delay: reducedMotion ? 0 : 0.15 }}
                    className="mt-6 grid gap-3 rounded-xl border border-white/10 bg-white/[0.025] p-4 sm:grid-cols-3 sm:p-5"
                >
                    <div>
                        <p className="font-mono text-xs uppercase tracking-[0.16em] text-emerald-300">Created locally</p>
                        <p className="mt-2 text-sm leading-relaxed text-zinc-400">The command created these files. No agent was called.</p>
                    </div>
                    <div>
                        <p className="font-mono text-xs uppercase tracking-[0.16em] text-orange-300">Visible to the team</p>
                        <p className="mt-2 text-sm leading-relaxed text-zinc-400">The jobs and their behavioral checks live together in Git.</p>
                    </div>
                    <div>
                        <p className="font-mono text-xs uppercase tracking-[0.16em] text-blue-300">Improved with evidence</p>
                        <p className="mt-2 text-sm leading-relaxed text-zinc-400">Record a miss, review a case, then measure a private proposal before applying it.</p>
                    </div>
                </motion.div>
            </div>
        </section>
    );
};
