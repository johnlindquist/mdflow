import { expect, test } from 'bun:test';
import { effects, eggIds, groups, restoreDiscoveries } from './catalog';
import { scoreBeat, scores } from './scores';

test('25 playable additions are distinct from the 23 original discoveries and retired tickets', () => {
  expect(effects.length).toBe(25);
  expect(eggIds.size).toBe(48);
  for (const group of groups) expect(effects.filter((e) => e.group === group).length).toBe(5);
  expect([
    ...restoreDiscoveries(['konami', 'night-lunar-kettle', 'fx-comet', 'fx-comet', null, 'made-up']),
  ]).toEqual(['konami', 'fx-comet']);
});
test('each track has a complete, distinct four-bar score with percussion, melody and bass', () => {
  const signatures = new Set<string>();
  for (const e of effects.filter((e) => e.group === 'Tracks')) {
    const s = scores[e.id],
      width = s.beats * 4;
    for (const lane of [s.kick, s.snare, s.hats, s.bass]) expect(lane.length).toBe(width);
    const song = Array.from({ length: 4 * width }, (_, i) => scoreBeat(s, i, false));
    expect(song.some((s) => s.kick)).toBe(true);
    expect(song.some((s) => s.snare)).toBe(true);
    expect(new Set(song.map((s) => s.lead).filter(Boolean)).size).toBeGreaterThan(4);
    expect(song.some((s) => s.bass > 40)).toBe(true);
    expect(scoreBeat(s, 0, true).lead).toBe(song[0].lead * 2);
    signatures.add(JSON.stringify(song));
  }
  expect(signatures.size).toBe(5);
});
