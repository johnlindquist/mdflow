import React from 'react';
import { FileCode } from 'lucide-react';

interface EditorProps {
  filename: string;
  content: string;
  language?: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
}

export const Editor: React.FC<EditorProps> = ({ filename, content, onChange, readOnly = true }) => {
  const lines = content.split('\n');

  return (
    <div className="w-full h-full flex flex-col bg-[#0d1117]/95 backdrop-blur-md border border-white/10 rounded-xl overflow-hidden font-mono text-sm shadow-2xl relative">
      {/* Top Gradient Line */}
      <div className="h-1 w-full bg-gradient-to-r from-blue-500 via-cyan-500 to-emerald-500"></div>
      
      {/* Editor Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-white/5 border-b border-white/5 text-zinc-300 select-none">
        <div className="flex items-center gap-2">
            <FileCode size={14} className="text-blue-400" />
            <span className="text-xs tracking-wider font-bold text-zinc-200">{filename}</span>
        </div>
      </div>

      {/* Editor Body */}
      <div className="flex-1 overflow-y-auto relative flex">
        {/* Line Numbers */}
        <div className="py-6 px-4 text-right bg-white/[0.02] border-r border-white/5 text-zinc-600 select-none min-w-[3.5rem] font-mono text-xs">
          {lines.map((_, i) => (
            <div key={i} className="leading-6">{i + 1}</div>
          ))}
        </div>

        {/* Content Area */}
        {readOnly ? (
            <div className="p-6 flex-1">
            {lines.map((line, i) => (
                <div key={i} className="leading-6 whitespace-pre-wrap break-all text-sm font-medium">
                <HighlightLine line={line} />
                </div>
            ))}
            </div>
        ) : (
            <textarea 
                value={content}
                onChange={(e) => onChange && onChange(e.target.value)}
                className="flex-1 p-6 bg-transparent text-zinc-200 resize-none focus:outline-none leading-6 font-mono font-medium"
                spellCheck={false}
            />
        )}
      </div>
    </div>
  );
};

// Neon Syntax Highlighter (Blue/Orange/Green Theme)
const HighlightLine: React.FC<{ line: string }> = ({ line }) => {
  if (line.startsWith('---')) return <span className="text-zinc-500 font-bold tracking-widest">{line}</span>;
  
  // Key-Value pairs in frontmatter
  if (line.includes(':') && !line.startsWith('#') && !line.startsWith('@') && !line.startsWith('!') && !line.trim().startsWith('-')) {
    const [key, ...val] = line.split(':');
    return (
      <>
        <span className="text-blue-400 font-bold">{key}:</span>
        <span className="text-orange-300">{val.join(':')}</span>
      </>
    );
  }

  // Markdown Headers (same size as other lines in editor)
  if (line.startsWith('#')) return <span className="text-emerald-400 font-bold">{line}</span>;
  
  // Special Import Syntax
  if (line.startsWith('@')) return <span className="text-cyan-400 font-bold border-b border-cyan-400/30 pb-0.5">{line}</span>;
  
  // Command Inlines
  if (line.startsWith('!')) return <span className="text-yellow-300 font-bold bg-yellow-500/10 px-1 rounded">{line}</span>;
  
  // Template variables
  const parts = line.split(/(\{\{.*?\}\})/g);
  return (
    <span>
      {parts.map((part, i) => 
        part.startsWith('{{') ? <span key={i} className="text-amber-400 font-bold">{part}</span> : <span key={i} className="text-zinc-300">{part}</span>
      )}
    </span>
  );
};