import React, { useEffect, useRef, useState } from 'react';
import { effects, groups, type Group, type Effect } from './catalog';
import { installField, type FieldApi } from './field';
import { shaderAudio } from '../shaderAudio';

export function Playground({
  found,
  discover,
  muted,
  onMuteChange,
}: {
  found: ReadonlySet<string>;
  discover: (id: string, label: string) => void;
  muted: boolean;
  onMuteChange: (m: boolean) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    api = useRef<FieldApi | null>(null),
    focusFrom = useRef<HTMLElement | null>(null),
    heading = useRef<HTMLHeadingElement>(null);
  const [open, setOpen] = useState(false),
    [group, setGroup] = useState<Group>('Trails'),
    [active, setActive] = useState<Effect | null>(null),
    [error, setError] = useState('');
  const [classic, setClassic] = useState(false);
  const onFind = useRef(discover);
  onFind.current = discover;
  const sound = (m: boolean) => {
    shaderAudio.setMuted(m);
    onMuteChange(m);
  };
  const clearHash = () => {
    if (/^(#playground$|#fx\/|#night-shift\/)/.test(location.hash))
      history.replaceState(history.state, '', location.pathname + location.search);
  };
  const close = () => {
    setOpen(false);
    clearHash();
    focusFrom.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    const field = installField(canvas.current!, setActive, (e) => onFind.current(`fx-${e.id}`, e.name));
    api.current = field.api;
    window.mdflowPlayground = field.api;
    const show = () => {
      focusFrom.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen(true);
      setError('');
    };
    const route = () => {
      const hash = location.hash;
      if (hash === '#playground' || hash.startsWith('#night-shift/')) show();
      else if (hash.startsWith('#fx/')) {
        const res = field.api.play(hash.slice(4));
        if (res.ok) setOpen(false);
        else {
          show();
          setError(
            res.error === 'unknown_effect'
              ? 'That effect isn’t on the rack. Choose one below.'
              : 'Your browser cannot draw the playground canvas.',
          );
        }
      }
    };
    const onLink = (e: MouseEvent) => {
      if (e.button || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      const a = e.target instanceof Element ? e.target.closest('a[data-fx-link]') : null;
      if (!a) return;
      const hash = a.getAttribute('href');
      if (!hash) return;
      e.preventDefault();
      if (a.hasAttribute('data-fx-listen') && hash.startsWith('#fx/')) sound(false);
      history.replaceState(history.state, '', location.pathname + location.search + hash);
      route();
    };
    window.addEventListener('hashchange', route);
    document.addEventListener('click', onLink);
    route();
    return () => {
      window.removeEventListener('hashchange', route);
      document.removeEventListener('click', onLink);
      field.dispose();
      api.current = null;
      if (window.mdflowPlayground === field.api) delete window.mdflowPlayground;
    };
  }, []);
  useEffect(() => {
    if (open) heading.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (open) {
        close();
      } else if (active) {
        api.current?.stop();
        clearHash();
      }
    };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open, active]);
  const launch = (e: Effect) => {
    const r = api.current?.play(e.id);
    if (!r?.ok) {
      setError('Your browser cannot draw the playground canvas.');
      return;
    }
    if (e.group === 'Tracks' && muted) sound(false);
    close();
  };
  return (
    <>
      <canvas ref={canvas} hidden aria-hidden="true" className="play-field" data-play-layer="" />
      {open && (
        <section id="fx-rack" aria-label="Play FX" data-fx-ui className="fx-rack">
          <header>
            <div>
              <span className="fx-eyebrow">MDFLOW / SIGNAL RACK</span>
              <h2 ref={heading} tabIndex={-1}>
                Play with the page.
              </h2>
            </div>
            <button aria-label="Close effects" className="fx-close" onClick={close}>
              ×
            </button>
          </header>
          <p>Pick a patch. The whole page is your instrument.</p>
          <div className="fx-banks" role="group" aria-label="Effect groups">
            {groups.map((g) => (
              <button
                key={g}
                aria-pressed={!classic && g === group}
                onClick={() => {
                  setGroup(g);
                  setClassic(false);
                }}
              >
                {g}
              </button>
            ))}
          </div>
          {!classic ? (
            <div className="fx-patches">
              {effects
                .filter((e) => e.group === group)
                .map((e) => (
                  <button
                    key={e.id}
                    onClick={() => launch(e)}
                    style={{ '--tone': e.color } as React.CSSProperties}
                    aria-label={`${e.group === 'Tracks' ? 'Listen to' : 'Launch'} ${e.name}`}
                  >
                    <i aria-hidden="true">
                      {e.group === 'Tracks'
                        ? '♪'
                        : e.group === 'Aliens'
                          ? '▣'
                          : e.group === 'Filters'
                            ? '◇'
                            : e.group === 'Physics'
                              ? '✺'
                              : '⌁'}
                    </i>
                    <span>
                      <strong>{e.name}</strong>
                      <small>{e.hint}</small>
                    </span>
                    <b aria-hidden="true">{found.has(`fx-${e.id}`) ? '↻' : '↗'}</b>
                  </button>
                ))}
            </div>
          ) : (
            <ul className="fx-classics">
              <li>
                Flick across a blank spot to paint comets; zigzag for ribbons. Double-click for an echo bloom.
              </li>
              <li>Hold, drag and release to sling sparks.</li>
              <li>Shift-click a loop of light around a pixel alien.</li>
              <li>
                Type <kbd>aurora</kbd> for northern lights or <kbd>moth</kbd> to call a swarm. <kbd>egg</kbd>{' '}
                still makes it rain.
              </li>
              <li>Click the five stars for the next constellation clue.</li>
            </ul>
          )}
          <footer>
            <button onClick={() => setClassic((v) => !v)}>
              {classic ? 'Back to patches' : 'Original gestures ↗'}
            </button>
            <span>
              {group === 'Tracks' && !classic ? '♪ Listen turns sound on' : 'Esc closes · no unlocks needed'}
            </span>
          </footer>
          {error && <p role="alert">{error}</p>}
        </section>
      )}
      {active && !open && (
        <aside data-fx-ui className="fx-playing" aria-label="Active playground effect">
          <div role="status">
            <b style={{ color: active.color }}>{active.name}</b>
            <span>{active.hint}</span>
          </div>
          <div className="fx-tools">
            <button onClick={() => api.current?.pulse()}>
              {active.group === 'Aliens' ? 'Fire / summon' : 'Pulse'}
            </button>
            <button onClick={() => sound(!muted)}>{muted ? 'Sound on ♪' : 'Mute ♪'}</button>
            <a href="#playground" data-fx-link>
              More FX
            </a>
            <button
              aria-label="Stop current effect"
              onClick={() => {
                api.current?.stop();
                clearHash();
              }}
            >
              Stop ×
            </button>
          </div>
        </aside>
      )}
    </>
  );
}
