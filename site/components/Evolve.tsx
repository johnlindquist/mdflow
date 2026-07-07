import React from 'react';
import { motion } from 'framer-motion';
import { Editor } from './Editor';
import { Terminal } from './Terminal';
import { TerminalLine } from '../types';
import { ShieldCheck, Scale, Database, FileLock2, Bug, GitBranch, ArrowRight } from 'lucide-react';

/**
 * The auto-evolve section: the hero promises "MARKDOWN AGENTS THAT EVOLVE" —
 * this is where the promise becomes mechanism. The terminal replays a real
 * session (claude as maintainer, recorded during verification): the gate
 * refusing an unproven suite, the suite earning lastCleanAt, and a normal
 * run triggering a gated, measured, applied evolution.
 */

const TRANSCRIPT: TerminalLine[] = [
    { id: 'e1', type: 'input', content: 'md evolve flows/answer.md --check --auto' },
    { id: 'e2', type: 'error', content: 'no evolution: auto requires a trust-ledger lastCleanAt —' },
    { id: 'e3', type: 'error', content: 'machine diffs never auto-apply to an unproven suite.' },
    { id: 'e4', type: 'info', content: '  complaint: "way too verbose - I just want the one word"' },
    { id: 'e5', type: 'input', content: 'md eval flows/answer.md' },
    { id: 'e6', type: 'output', content: '✓ answers green — clean run recorded in trust ledger' },
    { id: 'e7', type: 'input', content: 'md flows/answer.md    # just a normal run' },
    { id: 'e8', type: 'output', content: 'The team color is GREEN. …' },
    { id: 'e9', type: 'info', content: 'evolve: auto — 1 complaint since last evolution' },
    { id: 'e10', type: 'info', content: 'evolve: auto — cost: 1 maintainer + 2 eval turns = 3 turns' },
    { id: 'e11', type: 'info', content: 'evolve: auto — baseline ✓ 1/1 · drafting candidate…' },
    { id: 'e12', type: 'info', content: 'evolve: auto — gate ✓ 1/1 · benefit: complaint addressed, zero regressions' },
    { id: 'e13', type: 'output', content: 'evolve: auto — applied. Review with: git diff flows/answer.md' },
];

const DIFF_CONTENT = `---
description: answer the team color question
evolve: auto              # opt into the loop
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
        title: 'Gated on proof',
        body: 'No eval suite, no evolution. Auto mode goes further: machine diffs only auto-apply once the trust ledger holds a lastCleanAt — proof the suite has passed clean.',
    },
    {
        icon: Scale,
        title: 'Benefit is a measurement',
        body: 'The ancestor is scored on its own suite first. The candidate must come back clean and no worse — or it reverts byte-identical and parks as <flow>.pending.md.',
    },
    {
        icon: Database,
        title: 'Real usage only',
        body: 'Eval runs execute in sandboxes with the telemetry corpus redirected. Synthetic runs can never become the evidence that triggers an evolution.',
    },
    {
        icon: FileLock2,
        title: 'Prompt-only mutation',
        body: 'The maintainer redrafts the body; frontmatter is frozen byte-for-byte. A drafted diff cannot touch config, flags, or permissions — the mutation surface is prose.',
    },
    {
        icon: Bug,
        title: 'Hostile output handled',
        body: 'Exactly one fenced block with the closing fence on its own line, or nothing is written. Interrupted mid-gate? The original auto-restores from backup.',
    },
    {
        icon: GitBranch,
        title: 'Never commits',
        body: 'Acceptance ends by pointing at git diff. You review every evolution like any other change to your repo — because it is one.',
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
                    <p className="font-mono text-xs uppercase tracking-[0.3em] text-emerald-400 mb-4">evolve: auto</p>
                    <h2 className="select-none font-display font-bold text-4xl md:text-6xl tracking-tighter text-white">
                        COMPLAINTS IN.<br />
                        <span className="text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 via-teal-200 to-white">PROVEN DIFFS OUT.</span>
                    </h2>
                    <p className="mt-6 text-lg text-zinc-400 max-w-3xl mx-auto font-light leading-relaxed">
                        Tell a flow what went wrong — <span className="text-white font-mono text-base">md complain</span>,
                        or just re-run it within two minutes and mdflow takes the hint. A maintainer engine redrafts
                        the prompt, the eval suite judges the result, and only a measured, no-regression revision
                        lands in your working tree.
                    </p>
                </motion.div>

                <motion.p
                    initial={{ opacity: 0 }}
                    whileInView={{ opacity: 1 }}
                    viewport={{ once: true }}
                    transition={{ delay: 0.2, duration: 0.6 }}
                    className="text-center text-sm text-zinc-500 max-w-2xl mx-auto mb-16 font-light leading-relaxed"
                >
                    evidence → decision → draft → gate → diff. Every arrow is refusable: no suite, no fresh
                    evidence, no proven-clean history — no evolution, zero turns spent.
                    <span className="text-zinc-400"> Cost is printed before it is spent.</span>
                </motion.p>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-stretch mb-16">
                    <motion.div
                        initial={{ opacity: 0, x: -24 }}
                        whileInView={{ opacity: 1, x: 0 }}
                        viewport={{ once: true, margin: '-80px' }}
                        transition={{ duration: 0.5 }}
                        className="rounded-xl border border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.5)] overflow-hidden"
                    >
                        <Editor filename="flows/answer.md — one evolution, reviewed in git" content={DIFF_CONTENT} />
                    </motion.div>

                    <motion.div
                        initial={{ opacity: 0, x: 24 }}
                        whileInView={{ opacity: 1, x: 0 }}
                        viewport={{ once: true, margin: '-80px' }}
                        transition={{ duration: 0.5 }}
                        className="min-h-[380px]"
                    >
                        <Terminal lines={TRANSCRIPT} title="a real session — claude as maintainer" isLive />
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
                        <span className="text-emerald-400">$</span> md complain flows/review.md <span className="text-zinc-500">"missed the race condition"</span>
                    </div>
                    <a
                        href="https://tropic-hill-p35c.here.now/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group flex items-center gap-2 text-emerald-300 hover:text-emerald-200 transition-colors font-medium"
                    >
                        Read the full deep dive: how every guarantee is verified
                        <ArrowRight size={16} className="group-hover:translate-x-1 transition-transform" />
                    </a>
                </motion.div>
            </div>
        </section>
    );
};
