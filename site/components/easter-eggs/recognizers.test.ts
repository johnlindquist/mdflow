import { describe, expect, it } from 'bun:test';
import {
  appendClick,
  appendCorner,
  appendKey,
  appendTyped,
  cornerAt,
  endsWithKeys,
  hasAllCorners,
} from './recognizers';

describe('easter egg recognizers', () => {
  it('recognizes a bounded timestamped key suffix', () => {
    let history = appendKey([], 'arrowup', 0);
    history = appendKey(history, 'arrowdown', 100);
    history = appendKey(history, 'b', 200);
    expect(endsWithKeys(history, ['arrowup', 'arrowdown', 'b'])).toBe(true);
    expect(appendTyped('xxmdflo', 'w')).toBe('xxmdflow');
  });

  it('requires click cadence to stay on one nearby surface', () => {
    const surface = {} as EventTarget;
    let clicks = appendClick([], { at: 0, x: 10, y: 10, surface });
    clicks = appendClick(clicks, { at: 200, x: 20, y: 15, surface });
    expect(clicks).toHaveLength(2);
    clicks = appendClick(clicks, { at: 300, x: 200, y: 200, surface });
    expect(clicks).toHaveLength(1);
  });

  it('collects four unique corners within the time window', () => {
    const samples = [
      cornerAt(1, 1, 1000, 800),
      cornerAt(999, 1, 1000, 800),
      cornerAt(1, 799, 1000, 800),
      cornerAt(999, 799, 1000, 800),
    ];
    let history: { corner: 'tl' | 'tr' | 'bl' | 'br'; at: number }[] = [];
    samples.forEach((corner, index) => {
      if (corner) history = appendCorner(history, corner, index * 1000);
    });
    expect(hasAllCorners(history)).toBe(true);
    expect(appendCorner(history, 'tl', 20000)).toHaveLength(1);
  });
});
