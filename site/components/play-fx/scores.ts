// Each score has its own meter, harmony, drum part, bass figure and two alternating phrases.
export interface Score {
  bpm: number;
  beats: number;
  swing: number;
  roots: number[];
  lead: number[][];
  bass: string;
  kick: string;
  snare: string;
  hats: string;
  wave: OscillatorType;
  tail: number;
}
export const scores: Record<string, Score> = {
  cassette: {
    bpm: 78,
    beats: 4,
    swing: 0.16,
    roots: [50, 55, 48, 53],
    wave: 'triangle',
    tail: 0.48,
    lead: [
      [12, -1, 15, 19, -1, 17, 15, -1],
      [14, 17, -1, 21, 19, -1, 14, 12],
    ],
    bass: 'x.....x.x....x..',
    kick: 'x......x..x.....',
    snare: '....x.......x...',
    hats: 'x.x.x..xx.x.x..x',
  },
  breaks: {
    bpm: 164,
    beats: 4,
    swing: 0.035,
    roots: [45, 45, 48, 43],
    wave: 'square',
    tail: 0.115,
    lead: [
      [12, 12, -1, 19, 15, -1, 10, 12],
      [24, -1, 22, 19, -1, 15, 10, 7],
    ],
    bass: 'x..x..x...x..x.x',
    kick: 'x.....x..x...x..',
    snare: '....x..x....x..x',
    hats: 'x.x.xx.xx.xxxxxx',
  },
  outrun: {
    bpm: 112,
    beats: 4,
    swing: 0,
    roots: [45, 41, 48, 43],
    wave: 'sawtooth',
    tail: 0.2,
    lead: [
      [12, 15, 19, 24, 19, 15, 22, 19],
      [12, 17, 19, 24, 26, 24, 19, 17],
    ],
    bass: 'x.x.x.x.x.x.x.x.',
    kick: 'x...x...x...x...',
    snare: '....x.......x...',
    hats: '..x...x...x...xx',
  },
  glass: {
    bpm: 122,
    beats: 4,
    swing: 0.06,
    roots: [53, 57, 50, 55],
    wave: 'sine',
    tail: 0.64,
    lead: [
      [19, -1, 24, 16, 26, -1, 19, 28],
      [24, 16, -1, 19, 23, 26, -1, 16],
    ],
    bass: 'x.....x...x...x.',
    kick: 'x...x...x...x...',
    snare: '....x.......x...',
    hats: '..x.x.x...x.x.xx',
  },
  waltz: {
    bpm: 92,
    beats: 3,
    swing: 0,
    roots: [50, 46, 53, 48],
    wave: 'triangle',
    tail: 0.52,
    lead: [
      [12, 19, 15, -1, 17, 19],
      [22, 19, 17, 14, -1, 12],
    ],
    bass: 'x...x...x...',
    kick: 'x...........',
    snare: '........x...',
    hats: '..x...x...x.',
  },
};
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
export function scoreBeat(s: Score, step: number, high: boolean) {
  const width = s.beats * 4,
    bar = Math.floor(step / width),
    i = step % width,
    root = s.roots[bar % 4];
  const pitch = s.lead[bar % 2][Math.floor(i / 2)];
  return {
    kick: s.kick[i] === 'x',
    snare: s.snare[i] === 'x',
    hat: s.hats[i] === 'x',
    bass: s.bass[i] === 'x' ? hz(root - 12 + (i % 4 === 2 ? 12 : 0)) : 0,
    lead: i % 2 === 0 && pitch >= 0 ? hz(root + pitch + (high ? 12 : 0)) : 0,
    harmony: i === 0 ? hz(root + 7) : 0,
  };
}
