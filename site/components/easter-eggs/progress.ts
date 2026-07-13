import { canonicalEggId, type EggId } from './catalog';

export const PROGRESS_KEY = 'mdflow:easter-eggs:v2';
export const LEGACY_EGGS_KEY = 'mdflow-eggs';
export const LEGACY_PUZZLE_KEY = 'mdflow-puzzle';
export const LEGACY_GOLDEN_KEY = 'mdflow-golden';
export const LEGACY_MONSTERS_KEY = 'mdflow-monsters';

export const PUZZLE_PROOFS = [
  'three-boops',
  'full-charge',
  'closed-shape',
  'workshop-volley',
  'four-corners',
] as const;

export type PuzzleProof = (typeof PUZZLE_PROOFS)[number];

export interface EggProgress {
  version: 2;
  found: EggId[];
  puzzleProofs: PuzzleProof[];
  golden: boolean;
  monsterJar: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const emptyProgress = (): EggProgress => ({
  version: 2,
  found: [],
  puzzleProofs: [],
  golden: false,
  monsterJar: 0,
});

const parse = (storage: StorageLike, key: string): unknown => {
  try {
    const raw = storage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
};

const orderedUniqueEggs = (value: unknown): EggId[] => {
  if (!Array.isArray(value)) return [];
  const found = new Set<EggId>();
  for (const entry of value) {
    const canonical = canonicalEggId(entry);
    if (canonical) found.add(canonical);
  }
  return [...found];
};

const orderedProofs = (value: unknown): PuzzleProof[] => {
  if (!Array.isArray(value)) return [];
  const supplied = new Set(value.filter((proof): proof is PuzzleProof =>
    typeof proof === 'string' && PUZZLE_PROOFS.includes(proof as PuzzleProof)));
  return PUZZLE_PROOFS.filter((proof) => supplied.has(proof));
};

const safeCount = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;

const normalize = (value: unknown): EggProgress | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<EggProgress>;
  if (candidate.version !== 2) return null;
  const puzzleProofs = orderedProofs(candidate.puzzleProofs);
  return {
    version: 2,
    found: orderedUniqueEggs(candidate.found),
    puzzleProofs,
    golden: candidate.golden === true || puzzleProofs.length === PUZZLE_PROOFS.length,
    monsterJar: safeCount(candidate.monsterJar),
  };
};

const legacyProgress = (storage: StorageLike): EggProgress => {
  const found = orderedUniqueEggs(parse(storage, LEGACY_EGGS_KEY));
  const rawStep = parse(storage, LEGACY_PUZZLE_KEY);
  const step = typeof rawStep === 'number'
    ? Math.max(0, Math.min(PUZZLE_PROOFS.length, Math.floor(rawStep)))
    : 0;
  const golden = storage.getItem(LEGACY_GOLDEN_KEY) === '1' || step === PUZZLE_PROOFS.length;
  const rawMonsters = parse(storage, LEGACY_MONSTERS_KEY);
  return {
    version: 2,
    found,
    puzzleProofs: PUZZLE_PROOFS.slice(0, step),
    golden,
    monsterJar: safeCount(rawMonsters),
  };
};

export const writeEggProgress = (storage: StorageLike, progress: EggProgress) => {
  storage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  // Keep the mascot's old read path compatible while the event updates live tabs.
  if (progress.golden) storage.setItem(LEGACY_GOLDEN_KEY, '1');
};

export const readEggProgress = (storage: StorageLike): EggProgress => {
  const current = normalize(parse(storage, PROGRESS_KEY));
  if (current) {
    try { writeEggProgress(storage, current); } catch { /* private mode */ }
    return current;
  }
  const migrated = legacyProgress(storage);
  try { writeEggProgress(storage, migrated); } catch { /* private mode */ }
  return migrated;
};

export const discoverEgg = (progress: EggProgress, id: EggId): EggProgress =>
  progress.found.includes(id)
    ? progress
    : { ...progress, found: [...progress.found, id] };

export const addMonster = (progress: EggProgress): EggProgress => ({
  ...progress,
  monsterJar: progress.monsterJar + 1,
});

export const bankPuzzleProof = (progress: EggProgress, proof: PuzzleProof): EggProgress => {
  if (progress.puzzleProofs.includes(proof)) return progress;
  const supplied = new Set([...progress.puzzleProofs, proof]);
  const puzzleProofs = PUZZLE_PROOFS.filter((candidate) => supplied.has(candidate));
  return {
    ...progress,
    puzzleProofs,
    golden: puzzleProofs.length === PUZZLE_PROOFS.length,
  };
};

export const nextPuzzleProof = (progress: EggProgress): PuzzleProof | null =>
  PUZZLE_PROOFS.find((proof) => !progress.puzzleProofs.includes(proof)) ?? null;

// Public orchestration helpers keep storage optional so private-mode failures
// degrade to an in-memory session instead of taking down the page.
export const loadProgress = (storage?: StorageLike): EggProgress =>
  storage ? readEggProgress(storage) : emptyProgress();

export const saveProgress = (storage: StorageLike | undefined, progress: EggProgress) => {
  if (!storage) return;
  try { writeEggProgress(storage, progress); } catch { /* private mode */ }
};

export const addEgg = discoverEgg;
export const addPuzzleProof = bankPuzzleProof;

// Stars illuminate sequentially even though proofs are banked out of order.
export const visiblePuzzleStep = (progress: EggProgress): number => {
  let step = 0;
  for (const proof of PUZZLE_PROOFS) {
    if (!progress.puzzleProofs.includes(proof)) break;
    step++;
  }
  return step;
};
