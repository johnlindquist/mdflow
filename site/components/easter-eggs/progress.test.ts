import { describe, expect, it } from 'bun:test';
import { EGG_COUNT } from './catalog';
import {
  bankPuzzleProof,
  emptyProgress,
  LEGACY_EGGS_KEY,
  LEGACY_GOLDEN_KEY,
  LEGACY_MONSTERS_KEY,
  LEGACY_PUZZLE_KEY,
  PROGRESS_KEY,
  PUZZLE_PROOFS,
  readEggProgress,
  visiblePuzzleStep,
  writeEggProgress,
  type StorageLike,
} from './progress';

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe('easter egg progress', () => {
  it('migrates and deduplicates the legacy 23-id profile to 22/22', () => {
    const storage = new MemoryStorage();
    const legacy = [
      'double-click',
      'triple-click',
      'key-b',
      'key-h',
      'arrow-dance',
      'v3-badge',
      'konami',
      'type-mdflow',
      'type-egg',
      'alt-click',
      'corners',
      'footer-zap',
      'logo-disco',
      'middle-click',
      'shake',
      'circle',
      'overload',
      'monster-hunt',
      'egg-pop',
      'idle-fireflies',
      'elevator',
      'shy-volume',
      'welcome-back',
    ];
    storage.setItem(LEGACY_EGGS_KEY, JSON.stringify(legacy));
    storage.setItem(LEGACY_PUZZLE_KEY, JSON.stringify(5));
    storage.setItem(LEGACY_GOLDEN_KEY, '1');
    storage.setItem(LEGACY_MONSTERS_KEY, JSON.stringify(3));

    const progress = readEggProgress(storage);

    expect(progress.found).toHaveLength(EGG_COUNT);
    expect(progress.found).toContain('click-cadence');
    expect(progress.found).not.toContain('double-click');
    expect(progress.golden).toBe(true);
    expect(progress.puzzleProofs).toEqual(PUZZLE_PROOFS);
    expect(progress.monsterJar).toBe(3);
    expect(storage.getItem(PROGRESS_KEY)).not.toBeNull();
  });

  it('fails closed to a safe empty state for corrupt storage', () => {
    const storage = new MemoryStorage();
    storage.setItem(PROGRESS_KEY, '{bad json');
    storage.setItem(LEGACY_EGGS_KEY, 'also bad');
    expect(readEggProgress(storage)).toEqual(emptyProgress());
  });

  it('banks puzzle proofs out of order, reveals them sequentially, and turns gold atomically', () => {
    const storage = new MemoryStorage();
    let progress = bankPuzzleProof(emptyProgress(), 'four-corners');
    expect(visiblePuzzleStep(progress)).toBe(0);
    progress = bankPuzzleProof(progress, 'three-boops');
    expect(visiblePuzzleStep(progress)).toBe(1);
    for (const proof of ['workshop-volley', 'closed-shape', 'full-charge'] as const) {
      progress = bankPuzzleProof(progress, proof);
      writeEggProgress(storage, progress);
    }

    const persisted = JSON.parse(storage.getItem(PROGRESS_KEY)!);
    expect(persisted.puzzleProofs).toEqual(PUZZLE_PROOFS);
    expect(persisted.golden).toBe(true);
    expect(storage.getItem(LEGACY_GOLDEN_KEY)).toBe('1');
  });
});
