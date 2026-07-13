import React, { useEffect, useRef } from 'react';
import { TerminalLine } from '../types';
import { Terminal as TerminalIcon } from 'lucide-react';

interface TerminalProps {
  lines: TerminalLine[];
  title?: string;
  caption?: string;
  illustrative?: boolean;
  isLive?: boolean;
}

const LINE_STYLES: Record<TerminalLine['type'], string> = {
  input: 'text-zinc-100',
  continuation: 'text-zinc-100',
  label: 'text-amber-300 uppercase tracking-[0.16em] text-[0.78em] font-bold',
  info: 'text-blue-200',
  output: 'text-zinc-300',
  error: 'text-red-300',
};

export const Terminal: React.FC<TerminalProps> = ({
  lines,
  title = 'zsh',
  caption,
  illustrative = false,
  isLive = false,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !wasNearBottomRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [lines]);

  const transcriptCaption = caption ?? `${title} terminal transcript`;

  return (
    <figure
      className="terminal-shell w-full h-full flex flex-col bg-zinc-950/90 backdrop-blur-md border border-white/10 rounded-xl overflow-hidden font-mono relative group shadow-2xl"
      aria-label={transcriptCaption}
    >
      <figcaption className="sr-only">{transcriptCaption}</figcaption>

      <div aria-hidden="true" className="h-1 w-full bg-gradient-to-r from-orange-500 via-amber-500 to-blue-500" />

      <div className="flex items-center justify-between px-4 py-3 bg-white/5 border-b border-white/5 select-none">
        <div className="flex gap-2" aria-hidden="true">
          <span className="w-3 h-3 rounded-full bg-red-500/80 shadow-[0_0_8px_rgba(239,68,68,0.5)]" />
          <span className="w-3 h-3 rounded-full bg-yellow-500/80 shadow-[0_0_8px_rgba(234,179,8,0.5)]" />
          <span className="w-3 h-3 rounded-full bg-green-500/80 shadow-[0_0_8px_rgba(34,197,94,0.5)]" />
        </div>
        <div className="flex items-center gap-2 text-zinc-400 text-xs font-bold tracking-wider">
          <TerminalIcon size={12} aria-hidden="true" />
          <span>{title}</span>
          {illustrative && (
            <span className="rounded border border-amber-400/20 bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-200">
              EXAMPLE
            </span>
          )}
        </div>
        <div className="w-12" aria-hidden="true" />
      </div>

      <div
        ref={scrollRef}
        className="relative flex-1 overflow-y-auto p-4 sm:p-5"
        onScroll={(event) => {
          const element = event.currentTarget;
          const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
          wasNearBottomRef.current = remaining < 32;
        }}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-0 bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.08)_50%),linear-gradient(90deg,rgba(255,0,0,0.015),rgba(0,255,0,0.008),rgba(0,0,255,0.015))] opacity-20 bg-[length:100%_4px,3px_100%]"
        />

        <ol className="terminal-transcript relative z-10 space-y-2" aria-live="off">
          {lines.map((line) => {
            const prompt = line.type === 'input' ? '$' : line.type === 'continuation' ? '>' : '';
            const commandLike = line.type === 'input' || line.type === 'continuation';
            return (
              <li key={line.id} className={`grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2 font-medium ${LINE_STYLES[line.type]}`}>
                <span aria-hidden="true" className={commandLike ? 'text-orange-400 font-bold text-glow' : ''}>
                  {prompt}
                </span>
                <code className={commandLike ? 'terminal-command' : 'terminal-output'}>
                  <span className="sr-only">{line.ariaLabel ?? `${line.type}: `}</span>
                  {line.content}
                </code>
              </li>
            );
          })}

          {isLive && (
            <li className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2" aria-hidden="true">
              <span className="text-orange-400 font-bold text-glow">$</span>
              <span className="terminal-cursor inline-block h-5 w-3 bg-orange-500 animate-cursor-blink shadow-[0_0_8px_rgba(249,115,22,0.8)]" />
            </li>
          )}
        </ol>
      </div>
    </figure>
  );
};
