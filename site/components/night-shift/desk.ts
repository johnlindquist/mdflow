import { isRoom, rooms, type Room } from './rooms';
import { deltaObjects, slips, visitors, type RecordSlip } from './records';

const commands: Record<Room, string[]> = {
  radio: ['tune:<410..422>', 'listen'], post: ['stamp:moon', 'stamp:ink', 'stamp:rust', 'send', 'clear'],
  organ: ['play:tin', 'play:glass', 'play:wood', 'clear'], sky: ['toggle:<1..9>', 'expose', 'clear'],
  lost: ['next', ...Object.keys(deltaObjects).map(key => `return:${key}`)],
};
const initial = () => ({ revision: 0, room: null as Room | null, dial: 410, marks: '', mask: 0,
  visitor: 0, slip: null as RecordSlip | null, message: '' });
export type DeskState = ReturnType<typeof initial>;
export const frequency = (value: number) => `${(value / 100).toFixed(2)} MHz`;
export const pins = (mask: number) => Array.from({ length: 9 }, (_, i) => mask & (1 << i) ? i + 1 : '').join('');

// In-page only. Operates the same instruments as the buttons, never a shell, network or award-by-ID hook.
export function createDesk(onFind: (slip: RecordSlip) => void, found: () => ReadonlySet<string>, onNote: (name: string) => void) {
  let state = initial();
  const listeners = new Set<() => void>();
  const inspect = () => ({ version: 1, rooms: rooms.map(({ id, name }) => ({ id, name })), ...state,
    slip: state.slip?.id ?? null, title: state.slip?.title ?? null, found: [...found()].sort(),
    actions: state.room ? [...commands[state.room]] : [] });
  const fail = (error: 'unknown_room' | 'stale' | 'closed' | 'invalid_action') => ({ ok: false as const, error, state: inspect() });
  const update = (next: DeskState, award?: RecordSlip) => {
    state = { ...next, revision: state.revision + 1 };
    if (award) onFind(award);
    for (const fn of listeners) fn();
    return { ok: true as const, state: inspect() };
  };
  const open = (room: unknown) => isRoom(room) ? update({ ...initial(), room }) : fail('unknown_room');
  const close = () => update(initial());
  const act = (command: string, expectedRevision: number) => {
    if (expectedRevision !== state.revision) return fail('stale');
    const { room } = state;
    if (!room) return fail('closed');
    if (typeof command !== 'string') return fail('invalid_action');
    const next = { ...state, slip: null, message: '' };
    const print = (key: string, miss: string) => {
      const slip = slips.find(s => s.room === room && s.key === key);
      return update({ ...next, slip: slip ?? null, message: slip ? slip.caption : miss }, slip);
    };
    if (room === 'radio') {
      if (/^tune:(41[0-9]|42[0-2])$/.test(command)) return update({ ...next, dial: Number(command.slice(5)) });
      if (command === 'listen') return print(String(state.dial), 'Just the soft hiss of the factory lights. Try another frequency.');
    }
    if (room === 'post') {
      if (/^stamp:(moon|ink|rust)$/.test(command)) {
        const marks = state.marks ? `${state.marks} ${command.slice(6)}` : command.slice(6);
        return update({ ...next, marks: marks.split(' ').slice(-2).join(' ') });
      }
      if (command === 'send') { next.marks = ''; return print(state.marks, 'PFFT. The capsule rolled back. That address needs two stamps in the right order.'); }
    }
    if (room === 'organ' && /^play:(tin|glass|wood)$/.test(command)) {
      const pad = command.slice(5); onNote(pad);
      const marks = state.marks ? `${state.marks} ${pad}` : pad;
      if (marks.split(' ').length === 3) { next.marks = ''; return print(marks, 'Three good notes. Somewhere, a pipe is waiting for a different tune.'); }
      return update({ ...next, marks });
    }
    if (room === 'sky') {
      if (/^toggle:[1-9]$/.test(command)) return update({ ...next, mask: state.mask ^ (1 << (Number(command.slice(7)) - 1)) });
      if (command === 'expose') return print(pins(state.mask), 'The plate came back with a few lovely dots, but no constellation.');
    }
    if (command === 'clear' && (room === 'sky' || room === 'organ' || room === 'post')) return update({ ...next, marks: '', mask: 0 });
    if (room === 'lost') {
      if (command === 'next') return update({ ...next, visitor: (state.visitor + 1) % visitors.length });
      if (command.startsWith('return:') && Object.hasOwn(deltaObjects, command.slice(7))) {
        return print(`${state.visitor}:${command.slice(7)}`, 'A polite shake of the head. That belongs to someone else.');
      }
    }
    return fail('invalid_action');
  };
  return {
    getSnapshot: () => state, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    api: Object.freeze({ inspect, open, act, close }),
  };
}
export type Desk = ReturnType<typeof createDesk>;
declare global { interface Window { mdflowNightShift?: Desk['api']; } }
