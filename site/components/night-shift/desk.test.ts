import { expect, test } from 'bun:test';
import { createDesk } from './desk';
import { restoreDiscoveries } from './records';
import type { Room } from './rooms';

function desk() {
  const found = restoreDiscoveries(['konami', 'konami', 1, 'unknown']);
  const notes: string[] = [];
  const { api } = createDesk(s => { found.add(s.id); }, () => found, k => notes.push(k));
  return { api, notes, turn: (command: string) => api.act(command, api.inspect().revision) };
}
const cases: [Room, string[], string][] = [
  ...['412/lunar-kettle','414/cat-numbers','417/pocket-ocean','419/ghost-traffic','422/last-cricket'].map(row => { const [n,id] = row.split('/'); return ['radio',[`tune:${n}`,'listen'],id] as [Room,string[],string]; }),
  ...['moon moon/double-moon','ink rust/ink-squid','rust moon/spare-moon','ink ink/carbon-copy','moon rust/little-saturn'].map(row => { const [stamps,id] = row.split('/'); return ['post',[...stamps.split(' ').map(k => `stamp:${k}`),'send'],id] as [Room,string[],string]; }),
  ...['tin glass tin/frog-overture','wood wood glass/termite-tap','glass tin wood/bottle-duet','tin tin wood/elevator-jazz','glass wood glass/glass-moth'].map(row => { const [phrase,id] = row.split('/'); return ['organ',phrase.split(' ').map(k => `play:${k}`),id] as [Room,string[],string]; }),
  ...['24568/sky-kite','12589/sky-ladle','13579/sky-zipper','14569/sky-chair','1234679/sky-door'].map(row => { const [bits,id] = row.split('/'); return ['sky',[...[...bits].map(n => `toggle:${n}`),'expose'],id] as [Room,string[],string]; }),
  ...['hand/spare-second','umbrella/inside-rain','bracket/lonely-bracket','thimble/knight-cap','tail/comet-tail'].map((row,i) => { const [object,id] = row.split('/'); return ['lost',[...Array(i).fill('next'),`return:${object}`],id] as [Room,string[],string]; }),
];
test('all 25 keepsakes can be earned by working the instruments; repeat visits preserve earlier finds', () => {
  const { api, turn, notes } = desk();
  for (let pass = 0; pass < 2; pass++) for (const [room, inputs, id] of cases) {
    api.open(room); for (const input of inputs) expect(turn(input).ok).toBe(true);
    expect(api.inspect().slip).toBe(`night-${id}`);
  }
  expect(api.inspect().found).toHaveLength(26); expect(api.inspect().found).toContain('konami'); expect(notes.length).toBe(30);
});
test('wrong addresses, stale commands, wrong-room commands, and closed doors cannot mint tickets', () => {
  const { api, turn } = desk(); expect(turn('listen')).toMatchObject({ error:'closed' });
  api.open('post'); const rev = api.inspect().revision; turn('stamp:moon');
  expect(api.act('stamp:rust',rev)).toMatchObject({ error:'stale' });
  expect(turn('send').state.slip).toBeNull(); expect(turn('listen')).toMatchObject({ error:'invalid_action' });
  api.open('sky'); turn('toggle:2'); turn('toggle:2'); expect(turn('expose').state.mask).toBe(0);
  api.open('lost'); expect(turn('return:tail').state.slip).toBeNull();
  expect(api.open('__proto__')).toMatchObject({ error:'unknown_room' });
  api.close(); expect(api.inspect().found).toEqual(['konami']); expect(restoreDiscoveries({ bogus:1 }).size).toBe(0);
});
