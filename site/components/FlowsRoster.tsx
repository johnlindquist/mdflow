import React from 'react';
import { motion } from 'framer-motion';
import { Editor } from './Editor';
import { Terminal } from './Terminal';

/**
 * The ./flows narrative: a directory in your repo that describes all of the
 * project's agents. This is the concrete mental model the hero's "evolve"
 * promise lands on.
 */
export const FlowsRoster: React.FC = () => {
    return (
        <section id="flows" className="py-24 md:py-32 px-6 relative overflow-hidden border-t border-white/5">
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full h-px bg-gradient-to-r from-transparent via-orange-500 to-transparent opacity-50"></div>
            <div className="absolute bottom-[-30%] left-[-15%] w-[700px] h-[700px] bg-orange-600/10 blur-[150px] rounded-full pointer-events-none"></div>

            <div className="max-w-6xl mx-auto relative z-10">
                <motion.div
                    initial={{ opacity: 0, y: 24 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6 }}
                    className="text-center mb-6"
                >
                    <p className="font-mono text-xs uppercase tracking-[0.3em] text-orange-400 mb-4">./flows</p>
                    <h2 className="select-none font-display font-bold text-4xl md:text-6xl tracking-tighter text-white">
                        EVERY REPO DESERVES<br />
                        <span className="text-transparent bg-clip-text bg-gradient-to-r from-orange-400 via-amber-200 to-white">AN AGENT ROSTER.</span>
                    </h2>
                    <p className="mt-6 text-lg text-zinc-400 max-w-3xl mx-auto font-light leading-relaxed">
                        ./flows holds one markdown agent per job: code review, release notes, issue triage.
                        They're diffable in PRs. They're provable with <span className="text-white font-mono text-base">md eval</span>.
                        And new teammates, human or AI, learn how the project actually works by reading them.
                    </p>
                </motion.div>

                <motion.p
                    initial={{ opacity: 0 }}
                    whileInView={{ opacity: 1 }}
                    viewport={{ once: true }}
                    transition={{ delay: 0.2, duration: 0.6 }}
                    className="text-center text-sm text-zinc-500 max-w-2xl mx-auto mb-16 font-light leading-relaxed"
                >
                    A flow is one markdown file: frontmatter config, prompt body, colocated evals.
                    Run it on any engine. Every rough run is raw material. Bad outputs become failing
                    eval cases. Fixes arrive as reviewable diffs. Nothing lands unless the suite passes.
                    Your agents get better because you used them.
                </motion.p>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
                    <motion.div
                        initial={{ opacity: 0, x: -24 }}
                        whileInView={{ opacity: 1, x: 0 }}
                        viewport={{ once: true, margin: '-80px' }}
                        transition={{ duration: 0.5 }}
                        className="rounded-xl border border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.5)] overflow-hidden"
                    >
                        <Editor
                            filename="flows/"
                            content={`flows/\n├── README.md          # the roster index\n├── review.md          # review staged changes\n├── review.eval.ts     # proof it catches bugs\n├── release.md         # draft release notes\n├── release.eval.ts\n├── triage.md          # label + rank new issues\n└── triage.eval.ts\n\n# .mdflow.yaml\nengine: pi             # project default`}
                        />
                    </motion.div>
                    <motion.div
                        initial={{ opacity: 0, x: 24 }}
                        whileInView={{ opacity: 1, x: 0 }}
                        viewport={{ once: true, margin: '-80px' }}
                        transition={{ duration: 0.5, delay: 0.1 }}
                        className="rounded-xl border border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.5)] overflow-hidden"
                    >
                        <Terminal
                            title="zsh"
                            lines={[
                                { id: '1', type: 'input', content: 'md flows/review.md' },
                                { id: '2', type: 'info', content: 'flows/review.md → pi (engine: config)' },
                                { id: '3', type: 'output', content: 'src/auth.ts:42 token never expires' },
                                { id: '4', type: 'input', content: 'md eval flows/review.md' },
                                { id: '5', type: 'output', content: '  ✓ flags the planted bug' },
                                { id: '6', type: 'info', content: 'clean run recorded in trust ledger' }
                            ]}
                        />
                    </motion.div>
                </div>
            </div>
        </section>
    );
};
