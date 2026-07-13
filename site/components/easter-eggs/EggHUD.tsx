import React from 'react';
import { EGG_COUNT } from './catalog';

interface EggHUDProps {
  foundCount: number;
  puzzleStep: number;
  golden: boolean;
  announcement: string;
  onEggHint: () => void;
  onPuzzleHint: () => void;
  onConstellationKey: () => void;
}

export const EggHUD: React.FC<EggHUDProps> = ({
  foundCount,
  puzzleStep,
  golden,
  announcement,
  onEggHint,
  onPuzzleHint,
  onConstellationKey,
}) => (
  <div className="fixed bottom-3 left-3 z-[61] flex items-center gap-2 font-mono select-none">
    <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
    <button
      type="button"
      data-egg="constellation"
      className="egg-focus flex items-center gap-1 rounded-full border border-zinc-800/80 bg-zinc-950/80 px-2.5 py-1.5 text-zinc-700 backdrop-blur-md transition-colors hover:border-amber-500/50 hover:text-zinc-400 focus:text-zinc-300"
      aria-label={`Factory constellation: ${puzzleStep} of 5 stars${golden ? ', complete' : ''}. Activate for a clue. Focused alternatives: hold Space to charge, Shift Enter to close a shape, Shift Arrow Up to feed the Workshop, Q E Z C for corners, arrow keys clockwise for a circle.`}
      aria-keyshortcuts="Space Shift+Enter Shift+ArrowUp Q E Z C ArrowUp ArrowRight ArrowDown ArrowLeft"
      onClick={onPuzzleHint}
      onKeyDown={onConstellationKey}
    >
      {[0, 1, 2, 3, 4].map((index) => (
        <span
          key={index}
          aria-hidden="true"
          className={index < puzzleStep
            ? 'text-xs text-amber-400 drop-shadow-[0_0_5px_rgba(251,191,36,0.9)]'
            : 'text-xs text-zinc-700'}
        >★</span>
      ))}
    </button>
    <button
      type="button"
      className="egg-focus rounded-full border border-zinc-800/80 bg-zinc-950/80 px-2.5 py-1.5 text-[10px] text-zinc-500 backdrop-blur-md transition-colors hover:border-orange-500/50 hover:text-zinc-200"
      aria-label={`${foundCount} of ${EGG_COUNT} easter eggs found. Activate for a clue.`}
      onClick={onEggHint}
    >
      🥚 {foundCount}/{EGG_COUNT}
    </button>
  </div>
);
