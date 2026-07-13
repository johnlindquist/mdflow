export interface TimedKey {
  key: string;
  at: number;
}

export interface ClickSample {
  at: number;
  x: number;
  y: number;
  surface: EventTarget | null;
}

export type Corner = 'tl' | 'tr' | 'bl' | 'br';

export const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'));
};

export const isInteractiveTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('button, a, input, textarea, select, summary, [contenteditable="true"], [role="button"], [role="link"], [role="textbox"]'));
};

export const appendKey = (
  history: TimedKey[],
  key: string,
  at: number,
  maxAge = 2500,
  maxLength = 12,
): TimedKey[] => [...history.filter((entry) => at - entry.at <= maxAge), { key, at }].slice(-maxLength);

export const endsWithKeys = (history: TimedKey[], sequence: readonly string[]): boolean => {
  if (history.length < sequence.length) return false;
  const start = history.length - sequence.length;
  return sequence.every((key, index) => history[start + index]?.key === key);
};

export const appendTyped = (buffer: string, key: string, maxLength = 16): string =>
  key.length === 1 ? `${buffer}${key.toLowerCase()}`.slice(-maxLength) : buffer;

export const appendClick = (
  history: ClickSample[],
  sample: ClickSample,
  maxAge = 700,
  radius = 36,
): ClickSample[] => {
  const recent = history.filter((entry) =>
    sample.at - entry.at <= maxAge
    && entry.surface === sample.surface
    && Math.hypot(entry.x - sample.x, entry.y - sample.y) <= radius);
  return [...recent, sample].slice(-3);
};

export const cornerAt = (x: number, y: number, width: number, height: number, margin = 90): Corner | null => {
  if (x < margin && y < margin) return 'tl';
  if (x > width - margin && y < margin) return 'tr';
  if (x < margin && y > height - margin) return 'bl';
  if (x > width - margin && y > height - margin) return 'br';
  return null;
};

export const appendCorner = (
  history: { corner: Corner; at: number }[],
  corner: Corner,
  at: number,
  maxAge = 12000,
): { corner: Corner; at: number }[] => {
  const recent = history.filter((entry) => at - entry.at <= maxAge && entry.corner !== corner);
  return [...recent, { corner, at }];
};

export const hasAllCorners = (history: { corner: Corner }[]): boolean =>
  new Set(history.map((entry) => entry.corner)).size === 4;

export const KONAMI = ['arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a'] as const;

export const pushTimedKey = appendKey;
export const matchesSequence = endsWithKeys;
export const pushTypedCharacter = appendTyped;

export const shouldIgnoreKey = (event: KeyboardEvent): boolean =>
  event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target);

export interface ShakeState {
  lastX: number;
  lastDirection: number;
  reversals: number[];
}

export const advanceShake = (state: ShakeState, x: number, at: number): { state: ShakeState; complete: boolean } => {
  const dx = x - state.lastX;
  const direction = Math.abs(dx) > 22 ? Math.sign(dx) : state.lastDirection;
  const reversed = state.lastDirection !== 0 && direction !== state.lastDirection;
  const reversals = reversed
    ? [...state.reversals.filter((time) => at - time < 1200), at]
    : state.reversals.filter((time) => at - time < 1200);
  const complete = reversals.length >= 6;
  return {
    state: {
      lastX: x,
      lastDirection: direction,
      reversals: complete ? [] : reversals,
    },
    complete,
  };
};

export const classifyClickCadence = (
  history: ClickSample[],
  sample: ClickSample & { pointerType?: string },
): { samples: ClickSample[]; beat: 0 | 1 | 2 | 3 } => {
  const samples = appendClick(history, sample);
  const beat = Math.min(3, samples.length) as 0 | 1 | 2 | 3;
  return { samples, beat };
};

export class TimerBag {
  private timeouts = new Set<number>();
  private intervals = new Set<number>();

  later(fn: () => void, delay: number): number {
    const id = window.setTimeout(() => {
      this.timeouts.delete(id);
      fn();
    }, delay);
    this.timeouts.add(id);
    return id;
  }

  every(fn: () => void, delay: number): number {
    const id = window.setInterval(fn, delay);
    this.intervals.add(id);
    return id;
  }

  cancel(id: number) {
    window.clearTimeout(id);
    window.clearInterval(id);
    this.timeouts.delete(id);
    this.intervals.delete(id);
  }

  clear(id?: number) {
    if (id !== undefined) {
      this.cancel(id);
      return;
    }
    for (const timeout of this.timeouts) window.clearTimeout(timeout);
    for (const interval of this.intervals) window.clearInterval(interval);
    this.timeouts.clear();
    this.intervals.clear();
  }

  dispose() {
    this.clear();
  }
}
