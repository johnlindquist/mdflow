import type { Room } from './rooms';

export interface RecordSlip {
  room: Room; id: string; key: string; title: string; hint: string; caption: string; frames: readonly [string, string];
}
function slip(room: Room, id: string, key: string, title: string, hint: string, caption: string, a: string, b: string): RecordSlip {
  return { room, id: `night-${id}`, key, title, hint, caption, frames: [a, b] };
}

// Each detent, route, phrase, exposure and claim prints a different little flipbook.
export const slips = [
  slip('radio', 'lunar-kettle', '412', 'Lunar weather', '4.12 MHz smells faintly of tea.', 'The Sea of Tranquility is boiling. Low gravity, high chance of Earl Grey.', '   )   )       .\n  (___)   ☾     \n  |___|o  · · · ', '  (   (     .   \n  (___)     ☾   \n  |___|o  · · · '),
  slip('radio', 'cat-numbers', '414', 'The numbers cattery', 'Four point one four. The announcer has whiskers.', '“Nine. Nine. Nine.” Another perfectly healthy cat signs off.', ' /\\_/\\     009\n( o.o )   ▂▄▆▂\n > ^ <   ON AIR', ' /\\_/\\     009\n( -.- )   ▆▂▄▆\n > o <   ON AIR'),
  slip('radio', 'pocket-ocean', '417', 'Sea in a thimble', 'A very small tide comes in at 4.17 MHz.', 'A tugboat asks permission to cross the teaspoon. Permission granted.', '     __|>       \n ~~~/___\\~~    \n   \\_______/    ', '       __|>     \n   ~~~/___\\~~  \n   \\_______/    '),
  slip('radio', 'ghost-traffic', '419', 'Phantom traffic', 'There is a tailback on 4.19 MHz.', 'Three hearses are stuck behind a pedestrian who can walk through walls.', ' [oo] [oo] [oo]  ♙▏\n ════════════════▏', ' [oo] [oo] [oo]   ▏♙\n ════════════════▏'),
  slip('radio', 'last-cricket', '422', 'Sign-off cricket', 'Turn the dial all the way to the right.', 'The station goes off air. One cricket stays to read the credits.', ' TX ●    ╲╱     \n ███▇▅▃▁  /\\__  ', ' TX ○     ╲╱  ♪ \n ▁▁▁▁▁▁▁   /\\__ '),
  slip('post', 'double-moon', 'moon moon', 'Return to sender, sender', 'Stamp Moon, then Moon. Use the same side twice.', 'The capsule comes back from tomorrow with a thank-you note in your handwriting.', ' TODAY  (o)···→ ☾\n          ↶      ', ' TODAY ←···(o)  ☾\n       [thanks]  '),
  slip('post', 'ink-squid', 'ink rust', 'Squid on payroll', 'Ink goes on first. Rust pays the postage.', 'An accounts squid rubber-stamps eight expense reports at once.', '      .--.      \n  ▤  (o  o)  ▤  \n    ~∿∿∿∿~      ', '   ✓  .--.  ✓   \n ▤   (–  –)   ▤ \n    ∿~∿~∿~∿     '),
  slip('post', 'spare-moon', 'rust moon', 'One spare moon', 'Send Rust out to the Moon.', 'Stores delivers a replacement crescent. The old one goes in the cutlery drawer.', ' crate: [ ☾ ]    \n drawer: ─┬─┬─   ', ' crate: [   ]  ☾ \n drawer: ─┬─┬─   '),
  slip('post', 'carbon-copy', 'ink ink', 'Carbon copycat', 'Double-ink the envelope. Mind the paws.', 'The duplicator produces two cats. Neither claims to be the original.', ' [ /\\_/\\ ]  →  ?\n [  o.o  ]      ', '  /\\_/\\   /\\_/\\\n ( o.o ) ( o.o )'),
  slip('post', 'little-saturn', 'moon rust', 'Signed for: Saturn', 'Moon first, then the rusty ring.', 'A parcel too wide for the tube arrives anyway. The rings came flat-packed.', ' ┌──────┐  o     \n │ ==== │        \n └──────┘        ', '     _.-o-._     \n   (_  (●)  _)   \n     `-.__.-´    '),
  slip('organ', 'frog-overture', 'tin glass tin', 'Overture for one frog', 'Tin, Glass, Tin. Leave room for a croak.', 'A bullfrog taps the music stand. The entire brass section is also frogs.', ' ♪    @..@     \n     (----)  / \n   __(____)_/  ', '  ♫   @..@   / \n     ( oo ) /  \n   __(____)_   '),
  slip('organ', 'termite-tap', 'wood wood glass', 'Termite tap shoes', 'Two steps on Wood. Finish on Glass.', 'The percussionist takes a bow. There are six tiny dents in the floor.', '  •—•—•     ♫  \n  / / /        \n ───────────── ', '   •—•—•   ♪   \n    \\ \\ \\      \n ─·─·─·─·─·─·─ '),
  slip('organ', 'bottle-duet', 'glass tin wood', 'Duet for empties', 'Glass hands the tune to Tin, then Wood.', 'Two milk bottles whistle a love song in different time signatures.', '    ♪       ♫   \n   | |     | |  \n  /___\\   /___\\ ', '     ♫   ♪      \n   | |     | |  \n  /___\\   /___\\ '),
  slip('organ', 'elevator-jazz', 'tin tin wood', 'Basement jazz', 'Knock twice on Tin and once on Wood.', 'The lift refuses to go up until its upright bass has finished the solo.', '  ┌─ B ─┐   ♪   \n  │  ♩  │   ↑   \n  └─────┘       ', '  ┌─ B ─┐ ♫     \n  │ ♩♩♩ │   ·   \n  └─────┘       '),
  slip('organ', 'glass-moth', 'glass wood glass', 'The glass moth', 'Keep Wood between two panes of Glass.', 'A moth lands on middle C. For one bar, its wings keep perfect time.', '   ╲ /╲ /   ♩  \n    X  X       \n ──┬─┬─┬─┬──   ', '   /╲  /╲   ♫  \n    ╲XX╱       \n ──┬─┬─┬─┬──   '),
  slip('sky', 'sky-kite', '24568', 'Kite without a string', 'Light pins 2, 4, 5, 6, 8. Expose the plate.', 'The kite holds still. It is the whole observatory that starts drifting.', '      /\\   ·    \n      \\/        \n       ~──⌂     ', '    · /\\       \n      \\/       \n         ~──⌂   '),
  slip('sky', 'sky-ladle', '12589', 'The soup constellation', 'Pins 1, 2, 5, 8, 9 make a ladle.', 'The Big Dipper scoops up a patch of Milky Way. Supper is served.', '  *──*     ·   \n     │         \n     *──(  )   ', '  *──*         \n     │    ·    \n     *──(≈≈)   '),
  slip('sky', 'sky-zipper', '13579', 'Zipper in the sky', 'Expose the four corners and the middle: 1, 3, 5, 7, 9.', 'Someone opens the night sky an inch. Behind it: another, smaller night sky.', '    ·  >|<  .   \n       >|<      \n       >|<   ·  ', '    ·  >★<  .   \n       >·<      \n       >|<   ·  '),
  slip('sky', 'sky-chair', '14569', 'Reserved seating', 'Pins 1, 4, 5, 6, 9. A chair needs a back.', 'A very tired astronaut sits down. The chair has been waiting forty light-years.', '  ☆      o      \n  │     /|\\     \n  └───┐ / \\    ', '  ☆  o          \n  │ /|__        \n  └───┐ \\_     '),
  slip('sky', 'sky-door', '1234679', 'Door to Tuesday', 'Pins 1, 2, 3, 4, 6, 7, 9 frame a doorway.', 'Through the door it is Tuesday afternoon. Somebody is mowing the stars.', '    ┌─────┐     \n    │   • │   · \n    │     │     ', '    ┌─────┐     \n    │ TUE ╱   ✧ \n    │    ╱      '),
  slip('lost', 'spare-second', '0:hand', 'Just a second', 'Give the clock its second hand.', 'The clock takes its missing second off. The next tick sounds well rested.', '    .---.       \n   (  |  )  z   \n    `---´       ', '    .---.       \n   (  |/ ) tick \n    `---´       '),
  slip('lost', 'inside-rain', '1:umbrella', 'Indoor weather', 'The cloud left its umbrella here.', 'The cloud opens its umbrella upside down. Not a drop hits the carpet.', '    .-~~-.      \n   (______)     \n    · · ·   J   ', '    .-~~-.      \n   (______)     \n    \\___/  ☂   '),
  slip('lost', 'lonely-bracket', '2:bracket', 'Perfectly balanced', 'The parenthesis is looking for its left bracket.', 'Two mismatched symbols walk out holding hands. The parser looks the other way.', '  [          )  \n   ·        ·   ', '       [♥)      \n       · ·      '),
  slip('lost', 'knight-cap', '3:thimble', 'Knight of the needle', 'A thimble makes a fine helmet for a mouse.', 'The mouse knight lowers its visor and rides a spool of thread into the dawn.', '    __   /      \n  <:3 )~╱   [∩] \n    (ooo)       ', '   [∩]    /     \n  <:3 )~~╱      \n    (ooo)   ·   '),
  slip('lost', 'comet-tail', '4:tail', 'No loose ends', 'The comet needs its tail back.', 'With its tail buttoned on, the comet is once again legal for night flight.', '  ●     ≋≋≋     \n       lost/found', '         ≋≋≋●   \n  ·    ·      · '),
] as const;

export const deltaObjects = { hand: 'Second hand', umbrella: 'Umbrella', bracket: 'Left bracket', thimble: 'Thimble', tail: 'Comet tail' } as const;
export const visitors = [
  ['A clock', '“I can tell you the hour and minute, but then I rather lose my place.”'],
  ['A small cloud', '“I do try not to drip indoors.”'],
  ['A right parenthesis', '“We don’t quite match. I’d still know them anywhere.”'],
  ['A mouse in chain mail', '“My helmet has dimples. The seamstress calls it something else.”'],
  ['A grounded comet', '“I came in at a streak. I’ll leave as a dot unless you can help.”'],
] as const;
export const legacyIds = 'konami type-mdflow type-egg key-b key-h arrow-dance alt-click double-click triple-click corners footer-zap v3-badge logo-disco middle-click shake circle overload monster-hunt egg-pop idle-fireflies elevator shy-volume welcome-back'.split(' ');
export const eggIds = new Set([...legacyIds, ...slips.map(s => s.id)]);
export function restoreDiscoveries(saved: unknown): Set<string> {
  return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string' && eggIds.has(id)) : []);
}
