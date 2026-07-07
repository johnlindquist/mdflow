import React, { useEffect, useRef } from 'react';
import { TerminalLine } from '../types';
import { Terminal as TerminalIcon } from 'lucide-react';

interface TerminalProps {
  lines: TerminalLine[];
  title?: string;
  isLive?: boolean;
}

export const Terminal: React.FC<TerminalProps> = ({ lines, title = "zsh", isLive = false }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  return (
    <div className="w-full h-full flex flex-col bg-zinc-950/90 backdrop-blur-md border border-white/10 rounded-xl overflow-hidden font-mono text-sm relative group shadow-2xl">
      {/* Top Gradient Line */}
      <div className="h-1 w-full bg-gradient-to-r from-orange-500 via-amber-500 to-blue-500"></div>

      {/* Terminal Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-white/5 border-b border-white/5 select-none">
        <div className="flex items-center gap-2">
          <div className="flex gap-2">
            <div className="w-3 h-3 rounded-full bg-red-500/80 shadow-[0_0_8px_rgba(239,68,68,0.5)]"></div>
            <div className="w-3 h-3 rounded-full bg-yellow-500/80 shadow-[0_0_8px_rgba(234,179,8,0.5)]"></div>
            <div className="w-3 h-3 rounded-full bg-green-500/80 shadow-[0_0_8px_rgba(34,197,94,0.5)]"></div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-zinc-400 text-xs font-bold tracking-wider opacity-60">
          <TerminalIcon size={12} />
          <span>{title}</span>
        </div>
        <div className="w-12"></div>
      </div>

      {/* Terminal Body */}
      <div 
        ref={scrollRef}
        className="flex-1 p-6 overflow-y-auto space-y-2 text-zinc-200 relative scroll-smooth"
      >
        {/* Scanline Effect */}
        <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.1)_50%),linear-gradient(90deg,rgba(255,0,0,0.03),rgba(0,255,0,0.01),rgba(0,0,255,0.03))] z-10 opacity-40 bg-[length:100%_4px,3px_100%]"></div>
        
        {lines.map((line) => {
          if (!line) return null;
          return (
            <div key={line.id} className={`${line.type === 'error' ? 'text-red-400' : line.type === 'info' ? 'text-blue-300' : 'text-zinc-200'} break-words font-medium`}>
              {line.type === 'input' && (
                <span className="text-orange-400 font-bold mr-3 text-glow">➜ ~</span>
              )}
              <span className={line.type === 'output' ? 'text-zinc-400' : ''}>
                {line.content}
              </span>
            </div>
          );
        })}
        
        {/* Blinking Cursor */}
        {isLive && (
          <div className="flex items-center mt-2">
             <span className="text-orange-400 font-bold mr-3 text-glow">➜ ~</span>
             <span className="inline-block w-3 h-5 bg-orange-500 animate-cursor-blink align-middle shadow-[0_0_8px_rgba(249,115,22,0.8)]"></span>
          </div>
        )}
      </div>
    </div>
  );
};