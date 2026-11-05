export const groups = ['Trails', 'Physics', 'Aliens', 'Tracks', 'Filters'] as const;
export type Group = (typeof groups)[number];
const effect = (id: string, name: string, group: Group, hint: string, color: string) => ({
  id,
  name,
  group,
  hint,
  color,
});
export const effects = [
  effect(
    'comet',
    'Comet ink',
    'Trails',
    'Flick across the page for a burning tail. Shift + sweep works too.',
    '#ff944f',
  ),
  effect(
    'ribbon',
    'Ribbon loom',
    'Trails',
    'Sweep slowly to braid two ribbons; a quick turn knots them together.',
    '#f687dd',
  ),
  effect(
    'mirror',
    'Mirror brush',
    'Trails',
    'Draw on either side. Four mirrored nibs draw with you.',
    '#7de6ff',
  ),
  effect(
    'orbit',
    'Gravity well',
    'Trails',
    'Move the well. Its satellites spiral after your pointer.',
    '#d4a1ff',
  ),
  effect(
    'harp',
    'Laser harp',
    'Trails',
    'Sweep across the strings. Higher on the page plays a higher octave.',
    '#8dffd4',
  ),
  effect(
    'peony',
    'Peony fireworks',
    'Physics',
    'Tap the page to plant another two-colour firework.',
    '#ffab78',
  ),
  effect(
    'meteors',
    'Meteor shower',
    'Physics',
    'Point the falling comets; tap to call a fresh shower.',
    '#87d9ff',
  ),
  effect(
    'bubbles',
    'Bubble choir',
    'Physics',
    'Brush through the rising bubbles to pop notes. Tap to blow more.',
    '#f69fc9',
  ),
  effect(
    'sonar',
    'Echo chamber',
    'Physics',
    'Tap to send concentric sound waves bouncing off the edges.',
    '#7dffe2',
  ),
  effect(
    'iron',
    'Iron filings',
    'Physics',
    'Drag the magnetic pole through a field of little iron needles.',
    '#ffca75',
  ),
  effect(
    'jellies',
    'Jelly invasion',
    'Aliens',
    'Three jellyfish bob through the page. Tap or sling a dart at them.',
    '#72ffdd',
  ),
  effect(
    'moths',
    'Prism moths',
    'Aliens',
    'Steer the light with your pointer. Catch the moths that circle it.',
    '#f6a4ff',
  ),
  effect(
    'crabs',
    'Shield crabs',
    'Aliens',
    'The crabs sidestep under blue shields. Fire when the shields open.',
    '#ffac65',
  ),
  effect(
    'blink',
    'Blink ghosts',
    'Aliens',
    'Watch their beacons. The ghosts jump to them on the next beat.',
    '#a4baff',
  ),
  effect(
    'hydra',
    'Split hydra',
    'Aliens',
    'Break the big dragon into little ones, then clear the hatchlings.',
    '#b6ed79',
  ),
  effect(
    'cassette',
    'Cassette dusk',
    'Tracks',
    '78 BPM · dusty swung drums and warm electric keys. Move right for the high part.',
    '#ffd69c',
  ),
  effect(
    'breaks',
    'Jetpack breaks',
    'Tracks',
    '164 BPM · chopped drums and a square-wave hook. Steer the exhaust.',
    '#ff786d',
  ),
  effect(
    'outrun',
    'Midnight drive',
    'Tracks',
    '112 BPM · octave bass and a climbing synth line on a neon highway.',
    '#ed91ff',
  ),
  effect(
    'glass',
    'Glass garden',
    'Tracks',
    '122 BPM · four-on-the-floor kicks and interlocking bell arpeggios.',
    '#90f7d9',
  ),
  effect(
    'waltz',
    'Tidal waltz',
    'Tracks',
    '92 BPM · three beats to the bar. Move the swell under the melody.',
    '#99cbff',
  ),
  effect(
    'aurora',
    'Aurora veil',
    'Filters',
    'Move to bend the green and violet curtains of light.',
    '#87ffca',
  ),
  effect(
    'prism',
    'Prism tunnel',
    'Filters',
    'Steer the vanishing point of a folded, six-sided tunnel.',
    '#ff9cea',
  ),
  effect(
    'sunset',
    'Wireframe sunset',
    'Filters',
    'Slide the sun above a scrolling perspective grid.',
    '#ffa675',
  ),
  effect(
    'crt',
    'Phosphor CRT',
    'Filters',
    'Scanlines, phosphor glow and a green tracking beam follow you.',
    '#b1ff94',
  ),
  effect(
    'chrome',
    'Liquid chrome',
    'Filters',
    'Tilt the silver interference field with the pointer.',
    '#b4dcff',
  ),
] as const;
export type Effect = (typeof effects)[number];
export const byId = (id: unknown) => effects.find((e) => e.id === id);
const originals =
  'konami type-mdflow type-egg key-b key-h arrow-dance alt-click double-click triple-click corners footer-zap v3-badge logo-disco middle-click shake circle overload monster-hunt egg-pop idle-fireflies elevator shy-volume welcome-back'.split(
    ' ',
  );
export const eggIds = new Set([...originals, ...effects.map((e) => `fx-${e.id}`)]);
export const restoreDiscoveries = (raw: unknown) =>
  new Set<string>(Array.isArray(raw) ? raw.filter((id) => eggIds.has(id)) : []);
export const fxBridge = {
  shader: 0,
  dart: null as null | ((x: number, y: number, fromX: number, fromY: number) => boolean),
  net: null as null | ((inside: (x: number, y: number) => boolean) => void),
};
