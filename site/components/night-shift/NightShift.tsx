import React, { useEffect, useRef, useState, type CSSProperties } from 'react';
import { frequency, pins, type Desk, type DeskState } from './desk';
import { deltaObjects, slips, visitors } from './records';
import { rooms } from './rooms';
import './night-shift.css';

export function NightShift({ desk, state, found }: { desk: Desk; state: DeskState; found: ReadonlySet<string> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [hint, setHint] = useState(false);
  const room = rooms.find(r => r.id === state.room)!;
  const records = slips.filter(s => s.room === room.id);
  const collected = records.filter(s => found.has(s.id)).length;
  const target = room.id === 'lost' ? records[state.visitor] : records.find(s => !found.has(s.id)) ?? records[0];
  const act = (command: string) => desk.api.act(command, desk.getSnapshot().revision);
  const controls = (prefix: string, names: string[]) => names.map(name =>
    <button key={name} type="button" onClick={() => act(`${prefix}:${name}`)}>{name}</button>);
  useEffect(() => {
    const el = dialog.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    el.showModal(); document.body.style.overflow = 'hidden';
    return () => { el.close(); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => setHint(false), [room.id]);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const activePins = pins(state.mask);
  return <dialog ref={dialog} className="night-desk" style={{ '--phosphor': room.accent } as CSSProperties}
    aria-labelledby="night-name" onCancel={e => { e.preventDefault(); desk.api.close(); }}
    onClick={stop} onAuxClick={stop} onKeyDown={stop} onKeyUp={stop} onPointerDown={stop} onPointerUp={stop} onPointerMove={stop}>
    <div className="night-lid"><span><b aria-hidden="true">◐</b> MDF / NIGHT SHIFT</span><button type="button" autoFocus aria-label="Close night shift" onClick={() => desk.api.close()}>Clock out ×</button></div>
    <nav className="night-doors" aria-label="Factory rooms">{rooms.map((r, i) => <button type="button" key={r.id} aria-pressed={r.id === room.id} onClick={() => desk.api.open(r.id)}><small>0{i + 1} / {r.tag}</small>{r.name}</button>)}</nav>
    <div className="night-body">
      <div className="night-plate"><span className="night-kicker">SERVICE HATCH {room.tag} / {String(rooms.indexOf(room) + 1).padStart(2, '0')}</span><span title={`${collected} tickets punched here`} aria-label={`${collected} of 5 found here`} className="night-punch">{records.map(s => found.has(s.id) ? '●' : '○').join(' ')}</span></div>
      <h2 id="night-name">{room.name}</h2><p className="night-task">{room.task}</p>
      <div className="night-instrument" aria-label={`${room.name} instrument`}>
        {room.id === 'radio' && <><div className="night-readout"><span>LOCAL BAND</span><strong>{frequency(state.dial)}</strong></div><div className="night-dial"><button aria-label="Tune down" disabled={state.dial <= 410} onClick={() => act(`tune:${state.dial - 1}`)}>−</button><input aria-label="Shortwave frequency" aria-valuetext={frequency(state.dial)} type="range" min={410} max={422} value={state.dial} onChange={e => act(`tune:${e.target.value}`)} /><button aria-label="Tune up" disabled={state.dial >= 422} onClick={() => act(`tune:${state.dial + 1}`)}>+</button></div><button className="night-run" onClick={() => act('listen')}>Listen ↗</button></>}
        {room.id === 'post' && <><div className="night-readout"><span>ROUTE STAMPS</span><strong>{state.marks.toUpperCase().split(' ').filter(Boolean).concat(['···','···']).slice(0, 2).join(' → ')}</strong></div><div role="group" aria-label="Postage stamps" className="night-buttons">{controls('stamp', ['moon','ink','rust'])}</div><div className="night-actions"><button className="night-run" onClick={() => act('send')}>Send capsule ↑</button><button onClick={() => act('clear')}>Wipe stamps</button></div></>}
        {room.id === 'organ' && <><div className="night-readout"><span>THREE-BEAT LOOP</span><strong>{state.marks.toUpperCase().split(' ').filter(Boolean).concat(['·','·','·']).slice(0, 3).join(' / ')}</strong></div><div role="group" aria-label="Organ keys" className="night-buttons organ-keys">{controls('play', ['tin','glass','wood'])}</div><div className="night-actions"><small>Plays silently when the site is muted.</small><button onClick={() => act('clear')}>Rest</button></div></>}
        {room.id === 'sky' && <div className="night-sky"><div role="group" aria-label="Nine star pins" className="night-pins">{Array.from({ length: 9 }, (_, i) => <button key={i} aria-label={`Star pin ${i + 1}`} aria-pressed={Boolean(state.mask & (1 << i))} onClick={() => act(`toggle:${i + 1}`)}>{i + 1}</button>)}</div><div><span className="night-kicker">GLASS NEGATIVE</span><p>{activePins.length} pins lit</p><div className="night-actions"><button className="night-run" onClick={() => act('expose')}>Expose ◇</button><button onClick={() => act('clear')}>Clear</button></div></div></div>}
        {room.id === 'lost' && <><div className="night-readout"><span>CLAIM Nº {state.visitor + 1}</span><strong>{visitors[state.visitor][0]}</strong></div><p className="night-claim">{visitors[state.visitor][1]}</p><div role="group" aria-label="Return an object" className="night-buttons">{Object.entries(deltaObjects).map(([key, name]) => <button key={key} onClick={() => act(`return:${key}`)}>{name}</button>)}</div><button className="night-run" onClick={() => act('next')}>Next claimant →</button></>}
      </div>
      <div role="status" aria-live="polite" aria-atomic="true" className={`night-receipt ${state.slip ? 'punched' : ''}`}>
        {state.slip ? <><div className="night-film" aria-hidden="true" key={`${state.slip.id}:${state.revision}`}>{state.slip.frames.map((frame, i) => <pre key={i}>{frame}</pre>)}</div><div><div className="night-kicker">PUNCH Nº {String(slips.indexOf(state.slip) + 1).padStart(2, '0')} / 25</div><h3>{state.slip.title}</h3><p>{state.slip.caption}</p></div></> : <p>{state.message || 'The ticket slot is empty.'}</p>}
      </div>
      <div className="night-foot"><button aria-expanded={hint} onClick={() => setHint(v => !v)}>{hint ? 'Fold the desk note ↑' : 'Unfold a desk note ↗'}</button><span>{slips.filter(s => found.has(s.id)).length} / 25 punched</span></div>
      {hint && <p className="night-note">{target.hint}</p>}
    </div>
  </dialog>;
}
