import React from 'react';

export const ManPage: React.FC = () => {
  return (
    <section className="py-20 md:py-32 bg-[#050505] px-6 border-t border-white/5 relative overflow-hidden">
      {/* Background Decoration */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full h-px bg-gradient-to-r from-transparent via-orange-500 to-transparent opacity-50"></div>

      <div className="max-w-5xl mx-auto relative z-10">
        {/* Reduced padding for mobile */}
        <div className="border border-zinc-800 bg-[#0a0a0c] p-6 md:p-16 shadow-2xl rounded-xl relative overflow-hidden">

          {/* Decorative Corner Markers - Smaller on mobile */}
          <div className="absolute top-0 left-0 w-8 h-8 md:w-16 md:h-16 border-l-2 border-t-2 border-orange-500/50 rounded-tl-xl"></div>
          <div className="absolute top-0 right-0 w-8 h-8 md:w-16 md:h-16 border-r-2 border-t-2 border-blue-500/50 rounded-tr-xl"></div>
          <div className="absolute bottom-0 left-0 w-8 h-8 md:w-16 md:h-16 border-l-2 border-b-2 border-blue-500/50 rounded-bl-xl"></div>
          <div className="absolute bottom-0 right-0 w-8 h-8 md:w-16 md:h-16 border-r-2 border-b-2 border-orange-500/50 rounded-br-xl"></div>

          <div className="flex justify-between mb-12 text-zinc-500 text-xs uppercase tracking-[0.3em] font-display border-b border-zinc-800 pb-4">
            <span>SYS.MANUAL.V3.0.0-NEXT</span>
            <span className="text-white font-bold">MDFLOW(1)</span>
          </div>

          <div className="space-y-12 font-mono text-sm md:text-base text-zinc-300">
            <div>
              <h3 className="text-transparent bg-clip-text bg-gradient-to-r from-orange-400 to-amber-400 font-bold mb-4 uppercase text-lg tracking-widest flex items-center gap-2">
                <span className="w-2 h-2 bg-orange-500 rounded-full"></span>
                NAME
              </h3>
              <p className="pl-6 border-l border-zinc-800 text-lg">mdflow - executable markdown for AI agents</p>
            </div>

            <div>
              <h3 className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-cyan-400 font-bold mb-4 uppercase text-lg tracking-widest flex items-center gap-2">
                 <span className="w-2 h-2 bg-blue-500 rounded-full"></span>
                SYNOPSIS
              </h3>
              <div className="pl-6 border-l border-zinc-800 space-y-4">
                <div className="bg-white/5 p-4 rounded text-blue-300 space-y-1">
                  <p><span className="font-bold text-orange-400">md</span> [file] [--_var value] [--engine name] [--_dry-run] [--_edit] [--_context] [flags...]</p>
                  <p><span className="font-bold text-orange-400">md</span> &lt;command&gt; [options]</p>
                  <p><span className="font-bold text-orange-400">md.ENGINE</span> "prompt" [flags] <span className="text-zinc-500 text-xs">— ad-hoc, no file needed (md.claude, md.codex, …)</span></p>
                  <p className="text-zinc-500 text-xs mt-2">(<span className="text-orange-400">md</span> and <span className="text-orange-400">mdflow</span> are the same command; no arguments = interactive flow picker)</p>
                </div>

                <div className="space-y-3 text-sm">
                  <p className="text-zinc-500 uppercase tracking-wider text-xs">Commands</p>
                  <div className="grid grid-cols-1 gap-2">
                    <p><span className="text-emerald-400">init</span> [--engine &lt;e&gt;] [-y] <span className="text-zinc-500">bootstrap a flow roster (agent-guided; -y scaffolds deterministically)</span></p>
                    <p><span className="text-emerald-400">create</span> [name] [flags] <span className="text-zinc-500">create a new flow file</span></p>
                    <p><span className="text-emerald-400">explain</span> &lt;flow.md&gt; <span className="text-zinc-500">show resolved config without executing (free)</span></p>
                    <p><span className="text-emerald-400">eval</span> &lt;flow.md&gt; <span className="text-zinc-500">run the flow's eval suite — costs engine turns</span></p>
                    <p><span className="text-emerald-400">complain</span> &lt;flow.md&gt; "msg" <span className="text-zinc-500">record evolution evidence (free)</span></p>
                    <p><span className="text-emerald-400">evolve</span> &lt;flow.md&gt; [--check] <span className="text-zinc-500">evidence-gated prompt evolution; --check is free</span></p>
                    <p><span className="text-emerald-400">install</span> &lt;url|gh:org/repo/path@ref&gt; <span className="text-zinc-500">install a flow from a registry</span></p>
                    <p><span className="text-emerald-400">remove</span> &lt;name&gt; <span className="text-zinc-500">remove an installed flow</span></p>
                    <p><span className="text-emerald-400">list</span> <span className="text-zinc-500">list installed registry flows</span></p>
                    <p><span className="text-emerald-400">setup</span> <span className="text-zinc-500">configure shell (PATH, aliases)</span></p>
                    <p><span className="text-emerald-400">logs</span> <span className="text-zinc-500">show the flow log directory</span></p>
                    <p><span className="text-emerald-400">help</span> <span className="text-zinc-500">full built-in help</span></p>
                  </div>
                </div>

                <div className="space-y-3 text-sm">
                  <p className="text-zinc-500 uppercase tracking-wider text-xs">Engine Resolution (the ladder)</p>
                  <p className="text-zinc-400 text-xs leading-relaxed mb-2">
                    Most explicit wins: <span className="text-cyan-400">--engine</span> flag →
                    <span className="text-cyan-400"> MDFLOW_ENGINE</span> env → filename
                    (<span className="text-orange-400">task.claude.md</span>) → frontmatter
                    <span className="text-cyan-400"> engine:</span> → config → default
                    (<span className="text-orange-400">pi</span>). Implicit picks are announced on stderr.
                    No frontmatter + no explicit engine = the file is a document and just prints.
                  </p>

                  <p className="text-zinc-500 uppercase tracking-wider text-xs pt-2">Flags (vary by command)</p>
                  <p className="text-zinc-400 text-xs leading-relaxed mb-2">
                    Flags in frontmatter are passed to the selected CLI. Check your AI tool's docs for available options.
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <p><span className="text-cyan-400">--model</span> <span className="text-zinc-500">model name (all CLIs)</span></p>
                    <p><span className="text-cyan-400">--add-dir</span> <span className="text-zinc-500">include directory</span></p>
                    <p><span className="text-cyan-400">--full-auto</span> <span className="text-zinc-500">codex: sandboxed auto</span></p>
                    <p><span className="text-cyan-400">--dangerously-skip-permissions</span> <span className="text-zinc-500">agy: auto-approve</span></p>
                    <p><span className="text-cyan-400">--allow-all-tools</span> <span className="text-zinc-500">copilot: auto-approve</span></p>
                    <p><span className="text-cyan-400">--allowedTools</span> <span className="text-zinc-500">claude: tool whitelist</span></p>
                  </div>

                  <p className="text-zinc-500 uppercase tracking-wider text-xs pt-2">Template Variables</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <p><span className="text-amber-400">--_varname</span> <span className="text-zinc-500">→ {"{{ _varname }}"}</span></p>
                    <p><span className="text-amber-400">{"{{ _stdin }}"}</span> <span className="text-zinc-500">piped input</span></p>
                    <p><span className="text-amber-400">{"{{ _1 }}"}, {"{{ _2 }}"}</span> <span className="text-zinc-500">positional args</span></p>
                    <p><span className="text-amber-400">_interactive:</span> <span className="text-zinc-500">live session</span></p>
                  </div>

                  <p className="text-zinc-500 uppercase tracking-wider text-xs pt-2">md-Specific Flags</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <p><span className="text-cyan-400">--_dry-run</span> <span className="text-zinc-500">preview without executing</span></p>
                    <p><span className="text-cyan-400">--_edit</span> <span className="text-zinc-500">edit prompt in $EDITOR</span></p>
                    <p><span className="text-cyan-400">--_context</span> <span className="text-zinc-500">show context tree</span></p>
                    <p><span className="text-cyan-400">--raw</span> <span className="text-zinc-500">raw output (for piping)</span></p>
                  </div>

                  <p className="text-zinc-500 uppercase tracking-wider text-xs pt-2">File Imports</p>
                  <div className="space-y-1">
                    <p><span className="text-emerald-400">@./file.ts</span> <span className="text-zinc-500">import file</span></p>
                    <p><span className="text-emerald-400">@./src/**/*.ts</span> <span className="text-zinc-500">glob pattern</span></p>
                    <p><span className="text-emerald-400">@./file.ts:10-50</span> <span className="text-zinc-500">line range</span></p>
                    <p><span className="text-emerald-400">@./file.ts#Symbol</span> <span className="text-zinc-500">extract symbol</span></p>
                  </div>

                  <p className="text-zinc-500 uppercase tracking-wider text-xs pt-2">Inline Commands</p>
                  <div className="space-y-1">
                    <p><span className="text-pink-400">!`git log -5`</span> <span className="text-zinc-500">shell command output</span></p>
                    <p><span className="text-pink-400">!`md file.md`</span> <span className="text-zinc-500">sub-agent output</span></p>
                  </div>
                </div>
              </div>
            </div>

            <div>
              <h3 className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-emerald-400 font-bold mb-4 uppercase text-lg tracking-widest flex items-center gap-2">
                 <span className="w-2 h-2 bg-cyan-500 rounded-full"></span>
                DESCRIPTION
              </h3>
              <p className="pl-6 border-l border-zinc-800 leading-relaxed text-zinc-400 max-w-2xl">
                <span className="font-bold text-white">mdflow</span> executes markdown files as AI flows.
                Frontmatter YAML becomes CLI flags; the body becomes the prompt; the engine resolves
                via the ladder (default: <span className="italic text-orange-400">pi</span>, hermetic, with your
                Codex login bridged automatically). Engines: claude, codex, copilot, pi, cursor-agent,
                agy (Antigravity), droid, opencode, or any CLI binary. Colocated
                <span className="italic text-orange-400"> .eval.ts</span> suites prove a flow's behavior.
              </p>
            </div>

            <div>
              <h3 className="text-white font-bold mb-4 uppercase text-lg tracking-widest flex items-center gap-2">
                 <span className="w-2 h-2 bg-white rounded-full"></span>
                EXAMPLES
              </h3>
              <div className="pl-6 border-l border-zinc-800 space-y-6">
                <div className="bg-[#050505] p-6 rounded-lg border border-zinc-800 shadow-inner group hover:border-orange-500/30 transition-colors">
                  <p className="text-zinc-500 mb-2 text-xs uppercase tracking-wider"># Run a basic task</p>
                  <p className="text-lg"><span className="text-orange-500 font-bold">md</span> review.claude.md</p>
                </div>
                <div className="bg-[#050505] p-6 rounded-lg border border-zinc-800 shadow-inner group hover:border-blue-500/30 transition-colors">
                  <p className="text-zinc-500 mb-2 text-xs uppercase tracking-wider"># Pipe git diff into an agent</p>
                  <p className="text-lg">git diff | <span className="text-orange-500 font-bold">md</span> explain.claude.md</p>
                </div>
                <div className="bg-[#050505] p-6 rounded-lg border border-zinc-800 shadow-inner group hover:border-cyan-500/30 transition-colors">
                  <p className="text-zinc-500 mb-2 text-xs uppercase tracking-wider"># Chain agents together (research → plan → code)</p>
                  <p className="text-lg"><span className="text-orange-500 font-bold">md</span> research.md | <span className="text-orange-500 font-bold">md</span> plan.claude.md | <span className="text-orange-500 font-bold">md</span> code.codex.md</p>
                </div>
                <div className="bg-[#050505] p-6 rounded-lg border border-zinc-800 shadow-inner group hover:border-emerald-500/30 transition-colors">
                  <p className="text-zinc-500 mb-2 text-xs uppercase tracking-wider"># Prove a flow's behavior (v3)</p>
                  <p className="text-lg"><span className="text-orange-500 font-bold">md</span> <span className="text-emerald-400">eval</span> review.md</p>
                </div>
                <div className="bg-[#050505] p-6 rounded-lg border border-zinc-800 shadow-inner group hover:border-amber-500/30 transition-colors">
                  <p className="text-zinc-500 mb-2 text-xs uppercase tracking-wider"># File evidence, then evolve the prompt (gated by the eval suite)</p>
                  <p className="text-lg"><span className="text-orange-500 font-bold">md</span> <span className="text-amber-400">complain</span> review.md <span className="text-zinc-400">"misses renamed files"</span></p>
                  <p className="text-lg"><span className="text-orange-500 font-bold">md</span> <span className="text-amber-400">evolve</span> review.md</p>
                </div>
              </div>
            </div>

            <div>
              <h3 className="text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-teal-400 font-bold mb-4 uppercase text-lg tracking-widest flex items-center gap-2">
                 <span className="w-2 h-2 bg-emerald-500 rounded-full"></span>
                INSPECT & DEBUG
              </h3>
              <p className="pl-6 border-l border-zinc-800 leading-relaxed text-zinc-400 max-w-2xl mb-6">
                Preview what your template will render to before running the agent. Use <span className="font-mono text-white">md explain</span> to see the resolved config chain,
                or <span className="text-emerald-400">--_dry-run</span> to see the fully expanded prompt with all variables and imports resolved.
              </p>
              <div className="pl-6 border-l border-zinc-800 space-y-6">
                <div className="bg-[#050505] p-6 rounded-lg border border-zinc-800 shadow-inner group hover:border-emerald-500/30 transition-colors">
                  <p className="text-zinc-500 mb-2 text-xs uppercase tracking-wider"># Analyze agent configuration</p>
                  <p className="text-lg"><span className="text-orange-500 font-bold">md</span> <span className="text-emerald-400">explain</span> review.claude.md</p>
                </div>
                <div className="bg-[#050505] p-6 rounded-lg border border-zinc-800 shadow-inner group hover:border-teal-500/30 transition-colors">
                  <p className="text-zinc-500 mb-2 text-xs uppercase tracking-wider"># Preview the rendered template</p>
                  <p className="text-lg"><span className="text-orange-500 font-bold">md</span> review.claude.md <span className="text-emerald-400">--_dry-run</span></p>
                </div>
                <div className="bg-[#050505] p-6 rounded-lg border border-zinc-800 shadow-inner group hover:border-cyan-500/30 transition-colors">
                  <p className="text-zinc-500 mb-2 text-xs uppercase tracking-wider"># Show context tree and token usage</p>
                  <p className="text-lg"><span className="text-orange-500 font-bold">md</span> review.claude.md <span className="text-cyan-400">--_context</span></p>
                </div>
              </div>
            </div>

            <div>
              <h3 className="text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-400 font-bold mb-4 uppercase text-lg tracking-widest flex items-center gap-2">
                 <span className="w-2 h-2 bg-purple-500 rounded-full"></span>
                ZSH SUFFIX ALIAS
              </h3>
              <p className="pl-6 border-l border-zinc-800 leading-relaxed text-zinc-400 max-w-2xl mb-6">
                With ZSH, you can run <span className="italic text-orange-400">.md</span> files directly. No command needed.
                The suffix alias makes markdown files executable. Inline commands like <span className="text-blue-400 font-mono">`!md file.md`</span> also
                run automatically without the <span className="font-mono text-white">md</span> prefix.
              </p>
              <div className="pl-6 border-l border-zinc-800 space-y-6">
                <div className="bg-[#050505] p-6 rounded-lg border border-zinc-800 shadow-inner group hover:border-purple-500/30 transition-colors">
                  <p className="text-zinc-500 mb-2 text-xs uppercase tracking-wider"># Add to ~/.zshrc</p>
                  <p className="text-lg font-mono"><span className="text-purple-400">alias</span> -s md=mdflow</p>
                </div>
                <div className="bg-[#050505] p-6 rounded-lg border border-zinc-800 shadow-inner group hover:border-pink-500/30 transition-colors">
                  <p className="text-zinc-500 mb-2 text-xs uppercase tracking-wider"># Then just run the file directly</p>
                  <p className="text-lg"><span className="text-orange-400">./</span>review.claude.md</p>
                </div>
              </div>
            </div>

            <div>
              <h3 className="text-transparent bg-clip-text bg-gradient-to-r from-amber-400 to-yellow-400 font-bold mb-4 uppercase text-lg tracking-widest flex items-center gap-2">
                 <span className="w-2 h-2 bg-amber-500 rounded-full"></span>
                AGENT LIBRARY
              </h3>
              <p className="pl-6 border-l border-zinc-800 leading-relaxed text-zinc-400 max-w-2xl mb-6">
                Store agents in <span className="font-mono text-amber-400">~/.mdflow/</span> for global access or <span className="font-mono text-amber-400">.mdflow/</span> per project.
                Run <span className="font-mono text-white">md</span> without arguments to pick from available agents. Add to your PATH for tab completion anywhere.
              </p>
              <div className="pl-6 border-l border-zinc-800 space-y-6">
                <div className="bg-[#050505] p-6 rounded-lg border border-zinc-800 shadow-inner group hover:border-amber-500/30 transition-colors">
                  <p className="text-zinc-500 mb-2 text-xs uppercase tracking-wider"># Global agents</p>
                  <p className="text-lg font-mono">~/.mdflow/<span className="text-amber-400">review.claude.md</span></p>
                  <p className="text-lg font-mono">~/.mdflow/<span className="text-amber-400">commit.agy.md</span></p>
                </div>
                <div className="bg-[#050505] p-6 rounded-lg border border-zinc-800 shadow-inner group hover:border-yellow-500/30 transition-colors">
                  <p className="text-zinc-500 mb-2 text-xs uppercase tracking-wider"># Interactive file picker</p>
                  <p className="text-lg"><span className="text-orange-500 font-bold">md</span> <span className="text-zinc-500">← picks from ~/.mdflow/ and .mdflow/</span></p>
                </div>
                <div className="bg-[#050505] p-6 rounded-lg border border-zinc-800 shadow-inner group hover:border-amber-500/30 transition-colors">
                  <p className="text-zinc-500 mb-2 text-xs uppercase tracking-wider"># Add to PATH for autocomplete</p>
                  <p className="text-lg font-mono"><span className="text-purple-400">export</span> PATH=<span className="text-amber-400">"$HOME/.mdflow:$PATH"</span></p>
                </div>
              </div>
            </div>

          </div>

          <div className="mt-16 pt-8 border-t border-zinc-800 flex justify-between items-end text-zinc-600 text-xs font-mono uppercase">
             <div>End of Manual</div>
             <div className="text-right">
                <div className="mb-1">Documentation</div>
                <div className="text-zinc-400">Generated by mdflow</div>
             </div>
          </div>

        </div>
      </div>
    </section>
  );
};
