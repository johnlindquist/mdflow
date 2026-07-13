import React from 'react';
import { motion } from 'framer-motion';
import { Editor } from './Editor';
import { Terminal } from './Terminal';
import { TerminalLine } from '../types';
import { ShieldCheck, Scale, Database, FileLock2, Bug, GitBranch, ArrowRight } from 'lucide-react';

/**
 * Proposal-first evolution: feedback becomes a private, measured change with
 * an explicit review/apply boundary.
 */

const TRANSCRIPT: TerminalLine[] = [
    { id: 'e1', type: 'input', content: 'md feedback flows/answer.md "too verbose — one word"' },
    { id: 'e2', type: 'output', content: 'Feedback fb_01J… saved — status: open, not yet proved' },
    { id: 'e3', type: 'input', content: 'md feedback distill fb_01J…' },
    { id: 'e4', type: 'info', content: 'private eval draft created — deliberately failing until reviewed' },
    { id: 'e5', type: 'input', content: 'md evolve plan flows/answer.md' },
    { id: 'e6', type: 'output', content: 'Cost  3 invocations · Writes  private artifact only' },
    { id: 'e7', type: 'output', content: 'Safety  no new command/import capabilities allowed' },
    { id: 'e8', type: 'input', content: 'md evolve propose flows/answer.md --yes' },
    { id: 'e9', type: 'info', content: 'current ✗ 0/1 · proposal ✓ 1/1 · capability delta none' },
    { id: 'e10', type: 'output', content: 'VERIFIED IMPROVEMENT — source unchanged — evr_01J…' },
    { id: 'e11', type: 'input', content: 'md evolve show evr_01J…' },
    { id: 'e12', type: 'info', content: 'review prompt diff, receipt, and planned/actual cost' },
    { id: 'e13', type: 'input', content: 'md evolve apply evr_01J…   # separate decision' },
];

const DIFF_CONTENT = `---
description: answer the team color question
evolve: suggest           # notify; never spend or apply
---
- Think step by step about the team color.
- Explain your reasoning in a few sentences
- first, considering the history of the team.
- Then, at the end, state the answer…
+ Answer directly and concisely. The team
+ color is GREEN — state it as the very
+ first line. Do not invent reasoning or
+ deliberation; padding buries the answer.`;

const GUARANTEES = [
    {
        icon: ShieldCheck,
        title: 'Claims match proof',
        body: '“Verified improvement” requires a feedback-linked red/green case. A clean uncovered change is labeled regression-safe, never “fixed.”',
    },
    {
        icon: Scale,
        title: 'Canonical source stays still',
        body: 'Current and proposal run from separate off-path snapshots. Drafting and verification never expose a half-gated candidate at the real flow path.',
    },
    {
        icon: Database,
        title: 'Evidence is durable',
        body: 'Stable feedback IDs move through open, targeted, resolved, or dismissed. Rejection and infrastructure failures leave the reported problem open.',
    },
    {
        icon: FileLock2,
        title: 'Capabilities cannot sneak in',
        body: 'The prompt body may change, but new commands, executable fences, URLs, providers, globs, or broader file access are blocked before candidate execution.',
    },
    {
        icon: Bug,
        title: 'Proof is content-bound',
        body: 'Receipts bind flow imports, suite code, merged config, engine/model, mdflow version, and cases. Timeouts and flakes are inconclusive, not passes.',
    },
    {
        icon: GitBranch,
        title: 'Apply is transactional',
        body: 'Review first. Explicit apply uses a per-flow lock, hash compare-and-swap, atomic writes, lineage, and a hash-guarded rollback command.',
    },
];

export const Evolve: React.FC = () => {
    return (
        <section id="evolve" className="py-24 md:py-32 px-6 relative overflow-hidden border-t border-white/5">
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full h-px bg-gradient-to-r from-transparent via-emerald-500 to-transparent opacity-50"></div>
            <div className="absolute top-[-25%] left-[-15%] w-[700px] h-[700px] bg-emerald-600/10 blur-[150px] rounded-full pointer-events-none"></div>

            <div className="max-w-6xl mx-auto relative z-10">
                <motion.div
                    initial={{ opacity: 0, y: 24 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6 }}
                    className="text-center mb-6"
                >
                    <p className="font-mono text-xs uppercase tracking-[0.3em] text-emerald-400 mb-4">change with proof</p>
                    <h2 className="select-none font-display font-bold text-4xl md:text-6xl tracking-tighter text-white">
                        FEEDBACK IN.<br />
                        <span className="text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 via-teal-200 to-white">REVIEWABLE PROOF OUT.</span>
                    </h2>
                    <p className="mt-6 text-lg text-zinc-400 max-w-3xl mx-auto font-light leading-relaxed">
                        Tell a flow what went wrong with <span className="text-white font-mono text-base">md feedback</span>.
                        mdflow drafts a private prompt proposal, checks its capability delta, and measures current
                        versus candidate behavior. Your working tree does not change until you explicitly apply a reviewed run.
                    </p>
                </motion.div>

                <motion.p
                    initial={{ opacity: 0 }}
                    whileInView={{ opacity: 1 }}
                    viewport={{ once: true }}
                    transition={{ delay: 0.2, duration: 0.6 }}
                    className="text-center text-sm text-zinc-500 max-w-2xl mx-auto mb-16 font-light leading-relaxed"
                >
                    feedback → reviewed eval → plan → proposal → proof → review → apply. Every transition has
                    stable status and reason codes. <span className="text-zinc-400">Cost and writes are printed before paid work begins.</span>
                </motion.p>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-stretch mb-16">
                    <motion.div
                        initial={{ opacity: 0, x: -24 }}
                        whileInView={{ opacity: 1, x: 0 }}
                        viewport={{ once: true, margin: '-80px' }}
                        transition={{ duration: 0.5 }}
                        className="rounded-xl border border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.5)] overflow-hidden"
                    >
                        <Editor filename="proposal.diff — private; source unchanged" content={DIFF_CONTENT} />
                    </motion.div>

                    <motion.div
                        initial={{ opacity: 0, x: 24 }}
                        whileInView={{ opacity: 1, x: 0 }}
                        viewport={{ once: true, margin: '-80px' }}
                        transition={{ duration: 0.5 }}
                        className="min-h-[380px]"
                    >
                        <Terminal
                            lines={TRANSCRIPT}
                            title="proposal-first evolution"
                            illustrative
                            caption="Condensed example of evidence-gated evolution; no engine or file write occurs in this browser"
                        />
                    </motion.div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 mb-14">
                    {GUARANTEES.map((g, i) => (
                        <motion.div
                            key={g.title}
                            initial={{ opacity: 0, y: 16 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true }}
                            transition={{ delay: i * 0.07, duration: 0.45 }}
                            className="rounded-xl border border-white/10 bg-white/[0.03] backdrop-blur-sm p-5 hover:border-emerald-500/30 transition-colors"
                        >
                            <g.icon size={18} className="text-emerald-400 mb-3" />
                            <h3 className="text-white font-semibold mb-1.5 tracking-tight">{g.title}</h3>
                            <p className="text-sm text-zinc-400 font-light leading-relaxed">{g.body}</p>
                        </motion.div>
                    ))}
                </div>

                <motion.div
                    initial={{ opacity: 0 }}
                    whileInView={{ opacity: 1 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6 }}
                    className="flex flex-col sm:flex-row items-center justify-center gap-6 text-sm"
                >
                    <div className="font-mono text-zinc-400 bg-white/5 border border-white/10 rounded-lg px-4 py-2.5">
                        <span className="text-emerald-400">$</span> md feedback flows/review.md <span className="text-zinc-500">"missed the race condition"</span>
                    </div>
                    <a
                        href="/evolve-deep-dive/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group flex items-center gap-2 text-emerald-300 hover:text-emerald-200 transition-colors font-medium"
                    >
                        Read the protocol: evidence, proof, review, rollback
                        <ArrowRight size={16} className="group-hover:translate-x-1 transition-transform" />
                    </a>
                </motion.div>
            </div>
        </section>
    );
};
