export const PLAYGROUND_EVENT = 'mdflow:playground-signal';

export type PlaygroundSignal =
  | { kind: 'boop' }
  | { kind: 'full-charge' }
  | { kind: 'shape-closed'; points?: readonly { x: number; y: number }[] }
  | { kind: 'volley-complete'; target: string; landed?: number }
  | { kind: 'monster-captured'; method: 'gate' | 'darts' | 'fallback'; seed?: number }
  | {
      kind: 'spark-impact';
      target: 'eggo' | 'letter' | 'other';
      point: { x: number; y: number };
      velocity?: { x: number; y: number };
      power?: number;
    };

export const emitPlaygroundSignal = (detail: PlaygroundSignal) => {
  window.dispatchEvent(new CustomEvent<PlaygroundSignal>(PLAYGROUND_EVENT, { detail }));
};

export const isPlaygroundSignal = (value: unknown): value is PlaygroundSignal => {
  if (!value || typeof value !== 'object' || !('kind' in value)) return false;
  return ['boop', 'full-charge', 'shape-closed', 'volley-complete', 'monster-captured', 'spark-impact']
    .includes(String((value as { kind: unknown }).kind));
};
