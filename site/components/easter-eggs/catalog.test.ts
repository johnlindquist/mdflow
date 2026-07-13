import { describe, expect, it } from 'bun:test';
import { canonicalEggId, EGG_CATALOG, EGG_COUNT } from './catalog';

describe('easter egg catalog', () => {
  it('locks the public contract to 22 unique eggs and reward modalities', () => {
    expect(EGG_COUNT).toBe(22);
    expect(new Set(EGG_CATALOG.map((egg) => egg.id)).size).toBe(22);
    expect(new Set(EGG_CATALOG.map((egg) => egg.triggerKey)).size).toBe(22);
    expect(new Set(EGG_CATALOG.map((egg) => egg.rewardKey)).size).toBe(22);
    expect(EGG_CATALOG.every((egg) => egg.clue && egg.reducedMotionText)).toBe(true);
  });

  it('collapses the legacy 23-id click split into one canonical discovery', () => {
    expect(canonicalEggId('double-click')).toBe('click-cadence');
    expect(canonicalEggId('triple-click')).toBe('click-cadence');
    expect(canonicalEggId('key-b')).toBe('bass-drop');
    expect(canonicalEggId('v3-badge')).toBe('version-badge');
    expect(canonicalEggId('unknown')).toBeNull();
  });
});
