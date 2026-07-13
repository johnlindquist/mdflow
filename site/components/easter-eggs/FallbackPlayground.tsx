import React, { useEffect, useRef, useState } from 'react';
import { emitPlaygroundSignal } from './events';

export const FallbackPlayground: React.FC<{ active: boolean }> = ({ active }) => {
  const [open, setOpen] = useState(false);
  const [visitor, setVisitor] = useState(false);
  const holdTimer = useRef(0);

  useEffect(() => () => window.clearTimeout(holdTimer.current), []);
  if (!active) return null;

  const cancelHold = () => window.clearTimeout(holdTimer.current);
  return (
    <aside className="fixed bottom-[4.75rem] right-3 z-[58] font-mono" aria-label="Pocket playground fallback">
      <button
        type="button"
        className="egg-fallback-pixel egg-focus"
        aria-label={open ? 'Close pocket playground' : 'Open pocket playground: lightweight alternatives for the page toys'}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >✦</button>
      {open && (
        <div className="absolute bottom-10 right-0 grid w-56 gap-1.5 rounded-lg border border-zinc-700 bg-zinc-950/95 p-2.5 text-[11px] shadow-2xl backdrop-blur-md">
          <p className="m-0 text-zinc-500">Same secrets, lighter machinery.</p>
          <button
            type="button"
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-left text-zinc-300 hover:border-orange-500/70"
            onPointerDown={() => {
              cancelHold();
              holdTimer.current = window.setTimeout(() => emitPlaygroundSignal({ kind: 'full-charge' }), 1600);
            }}
            onPointerUp={cancelHold}
            onPointerCancel={cancelHold}
            onPointerLeave={cancelHold}
          >hold to reach FULL</button>
          <button type="button" className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-left text-zinc-300 hover:border-orange-500/70" onClick={() => emitPlaygroundSignal({ kind: 'shape-closed' })}>close a light loop</button>
          <button type="button" className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-left text-zinc-300 hover:border-orange-500/70" onClick={() => emitPlaygroundSignal({ kind: 'volley-complete', target: 'workshop', landed: 3 })}>feed the Workshop</button>
          {!visitor ? (
            <button type="button" className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-left text-zinc-300 hover:border-orange-500/70" onClick={() => setVisitor(true)}>invite a pixel visitor</button>
          ) : (
            <button
              type="button"
              className="rounded border border-violet-500/70 bg-violet-950/40 px-2 py-1.5 text-left text-violet-200"
              onClick={() => {
                emitPlaygroundSignal({ kind: 'monster-captured', method: 'fallback', seed: 0.618 });
                setVisitor(false);
              }}
            >close the visitor gate</button>
          )}
        </div>
      )}
    </aside>
  );
};
