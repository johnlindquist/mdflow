import React, { useEffect, useRef, useState } from 'react';
import { shaderAudio, BPM } from './shaderAudio';

/**
 * Mario-64-style grabbable rubber sheets. StretchySheet renders arbitrary
 * artwork (drawn by a callback) onto a WebGL quad grid: grabbing drags the
 * local region of the mesh (gaussian falloff), releasing snaps it back on
 * an underdamped spring so it wobbles into place. Idle, the sheet thumps
 * with a heartbeat pulse; hovering bulges it toward the cursor.
 *
 * The canvas is oversized by PAD on every side and absolutely centered in
 * a wrapper that only occupies the artwork's rect — stretches render into
 * the slack instead of clipping at the layout box. Pointer events live on
 * the wrapper (the canvas is pointer-events-none) so only the artwork
 * area is grabbable, and they stop propagating so the page slingshot
 * never fires mid-stretch.
 *
 * Every grab/pull/release also dispatches a window 'mdflow:stretch'
 * CustomEvent, which ShaderGuide turns into background ripples & sparks.
 */

const PAD = 76; // slack around the artwork — must exceed the max stretch
const MAX_PULL = 48; // px a grab can displace the grabbed point
const FALL_R = 60; // gaussian falloff radius of a grab, px

const VERT = `
attribute vec2 a_pos;
attribute vec2 a_uv;
uniform vec2 u_size;
varying vec2 v_uv;
void main() {
  vec2 clip = (a_pos / u_size) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = a_uv;
}`;

/* u_gold flips on the holo-foil pass: the artwork's luminance is remapped
 * onto a metallic gold ramp, then layered like a special-edition trading
 * card — a hot specular glare line glides across the foil, iridescent
 * rainbow bands bloom around it, and glitter cells twinkle on their own
 * phases. u_tilt is the "viewing angle" (cursor-driven), so hovering shifts
 * the whole interference pattern exactly like tilting a foil card. */
const FRAG = `
precision mediump float;
uniform sampler2D u_tex;
uniform float u_gold;
uniform float u_time;
uniform vec2 u_tilt;
varying vec2 v_uv;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec4 c = texture2D(u_tex, v_uv);
  if (u_gold > 0.5 && c.a > 0.003) {
    vec3 art = c.rgb / c.a; // unpremultiply
    float lum = dot(art, vec3(0.299, 0.587, 0.114));

    // metallic ramp: deep amber shadows -> rich gold -> pale gold highlights
    vec3 metal = mix(vec3(0.45, 0.23, 0.04), vec3(1.0, 0.72, 0.10),
                     smoothstep(0.05, 0.62, lum));
    metal = mix(metal, vec3(1.0, 0.90, 0.48), smoothstep(0.62, 0.98, lum));

    // viewing angle: slow time drift + the card tilting toward the cursor
    float ang = u_time * 0.11 + u_tilt.x * 0.6 - u_tilt.y * 0.4;

    // iridescence: thin-film rainbow bands running across the diagonal
    float band = v_uv.x * 1.6 - v_uv.y * 1.1 + ang * 2.2;
    vec3 rainbow = 0.5 + 0.5 * cos(6.2832 * (band + vec3(0.0, 0.33, 0.67)));

    // the glare: a soft-edged specular stripe sweeping over the foil
    float sw = fract(v_uv.x * 0.75 + v_uv.y * 0.55 - ang * 1.7);
    float spec = smoothstep(0.30, 0.5, sw) * smoothstep(0.70, 0.5, sw);
    spec *= spec;

    // glitter: sparse cells flash at their own frequency and phase
    float h = hash(floor(v_uv * 30.0));
    float tw = max(sin(u_time * (1.5 + h * 5.0) + h * 44.0
                       + (u_tilt.x - u_tilt.y) * 6.0), 0.0);
    float sparkle = step(0.78, h) * pow(tw, 20.0) * smoothstep(0.05, 0.25, lum);

    vec3 foil = metal * (0.9 + 0.35 * spec);
    foil += rainbow * (0.04 + 0.30 * spec);      // rainbow lives in the glare
    foil += vec3(1.0, 0.97, 0.82) * spec * 0.5;  // white-hot glare core
    foil += vec3(1.0, 0.95, 0.75) * sparkle;     // glitter flecks
    // line-work stays deep amber so the face reads through the shine
    foil = mix(vec3(0.32, 0.17, 0.03), foil,
               0.2 + 0.8 * smoothstep(0.0, 0.35, lum));

    c = vec4(clamp(foil, 0.0, 1.0) * c.a, c.a);
  }
  gl_FragColor = c;
}`;

const emitStretch = (phase: 'grab' | 'pull' | 'release', x: number, y: number, p = 0, dx = 0, dy = 0) => {
    window.dispatchEvent(new CustomEvent('mdflow:stretch', { detail: { phase, x, y, p, dx, dy } }));
};

interface SheetProps {
    /** css px of the artwork at rest */
    artW: number;
    artH: number;
    /** draw the artwork; context is scaled so units are artwork css px */
    draw: (c2: CanvasRenderingContext2D, w: number, h: number) => void;
    /** bump to re-rasterize the texture (image loaded, fonts ready) */
    redrawKey?: number;
    /** heartbeat pulse amplitude multiplier (0 disables) */
    pulse?: number;
    className?: string;
    label: string;
    /** fired for a clean tap (no meaningful stretch) */
    onCleanClick?: () => void;
    /** clean taps "boop" the sheet: the mesh dents under the tap point as
     * if a finger pressed in, and a soft boop tone plays */
    tapBoop?: boolean;
    /** groove-synced mesh dance driven by 'mdflow:workshop-prox' events —
     * the sheet bops, leans, and bounces as the cursor nears the CTA */
    dance?: boolean;
    /** tag the wrapper as the shader's egg-ray anchor */
    dataEgg?: boolean;
    /** holo-foil trophy finish: gold metallic remap + glare sweep +
     * iridescent bands + glitter, tilt-reactive to the cursor */
    gold?: boolean;
    /** spark-impact dent radius, px (default FALL_R — a broad dimple;
     * small values keep the dent local, e.g. to a single letter) */
    hitR?: number;
    /** rendered instead when WebGL/motion is unavailable */
    fallback: React.ReactNode;
}

export const StretchySheet: React.FC<SheetProps> = ({
    artW, artH, draw, redrawKey = 0, pulse = 1, className, label, onCleanClick, tapBoop, dance, dataEgg, gold, hitR = FALL_R, fallback,
}) => {
    const wrapRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const uploadRef = useRef<() => void>(() => {});
    // ref-mirrored so the (mount-once) render loop sees live gold state
    const goldRef = useRef(!!gold);
    goldRef.current = !!gold;
    const [broken, setBroken] = useState(false);

    const W = artW + PAD * 2;
    const H = artH + PAD * 2;

    useEffect(() => {
        const wrap = wrapRef.current;
        const canvas = canvasRef.current;
        if (!wrap || !canvas) return;
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            setBroken(true);
            return;
        }
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        // NOTE: no loseContext() in cleanup — StrictMode re-runs this effect
        // on the SAME canvas, and a deliberately-lost context would make the
        // second mount fall back. Re-initializing the live context is fine.
        const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true });
        if (!gl || gl.isContextLost()) {
            setBroken(true);
            return;
        }

        const mk = (type: number, src: string) => {
            const s = gl.createShader(type)!;
            gl.shaderSource(s, src);
            gl.compileShader(s);
            return s;
        };
        const program = gl.createProgram()!;
        gl.attachShader(program, mk(gl.VERTEX_SHADER, VERT));
        gl.attachShader(program, mk(gl.FRAGMENT_SHADER, FRAG));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            setBroken(true);
            return;
        }
        gl.useProgram(program);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied
        gl.uniform2f(gl.getUniformLocation(program, 'u_size'), W, H);
        const uGold = gl.getUniformLocation(program, 'u_gold');
        const uTime = gl.getUniformLocation(program, 'u_time');
        const uTilt = gl.getUniformLocation(program, 'u_tilt');

        // ---- mesh: ~14px quads over the artwork rect ----
        const GX = Math.max(6, Math.min(26, Math.round(artW / 14)));
        const GY = Math.max(4, Math.min(26, Math.round(artH / 14)));
        const N = (GX + 1) * (GY + 1);
        const base = new Float32Array(N * 2); // rest positions, canvas css px
        const off = new Float32Array(N * 2);
        const vel = new Float32Array(N * 2);
        const pos = new Float32Array(N * 2);
        const uvs = new Float32Array(N * 2);
        for (let y = 0; y <= GY; y++) {
            for (let x = 0; x <= GX; x++) {
                const i = (y * (GX + 1) + x) * 2;
                base[i] = PAD + (x / GX) * artW;
                base[i + 1] = PAD + (y / GY) * artH;
                // canvas textures upload top-row-first and mesh y grows
                // downward — v maps straight through, no flip
                uvs[i] = x / GX;
                uvs[i + 1] = y / GY;
            }
        }
        const idx = new Uint16Array(GX * GY * 6);
        let k = 0;
        for (let y = 0; y < GY; y++) {
            for (let x = 0; x < GX; x++) {
                const a = y * (GX + 1) + x;
                idx[k++] = a; idx[k++] = a + 1; idx[k++] = a + GX + 1;
                idx[k++] = a + 1; idx[k++] = a + GX + 2; idx[k++] = a + GX + 1;
            }
        }

        const posBuf = gl.createBuffer();
        const aPos = gl.getAttribLocation(program, 'a_pos');
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
        gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

        const uvBuf = gl.createBuffer();
        const aUv = gl.getAttribLocation(program, 'a_uv');
        gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
        gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(aUv);
        gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);

        const idxBuf = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);

        // ---- texture: artwork rasterized at 2x by the draw callback ----
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
        const upload = () => {
            const t2 = document.createElement('canvas');
            t2.width = artW * 2;
            t2.height = artH * 2;
            const c2 = t2.getContext('2d');
            if (!c2) return;
            c2.setTransform(2, 0, 0, 2, 0, 0);
            draw(c2, artW, artH);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, t2);
        };
        upload();
        uploadRef.current = upload;

        // ---- interaction ----
        let grabbing = false;
        let grabX = 0, grabY = 0; // canvas-space grab origin
        let pullX = 0, pullY = 0;
        let hoverX = 0, hoverY = 0;
        let hovering = false;
        let grabT = 0;
        let lastPullEmit = 0;
        let lastTwang = 0;

        const local = (e: PointerEvent) => {
            const r = wrap.getBoundingClientRect();
            return [e.clientX - r.left + PAD, e.clientY - r.top + PAD];
        };
        const onDown = (e: PointerEvent) => {
            e.stopPropagation(); // the page slingshot must not fire
            e.preventDefault();
            try { wrap.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
            [grabX, grabY] = local(e);
            pullX = pullY = 0;
            grabbing = true;
            grabT = performance.now();
            emitStretch('grab', e.clientX, e.clientY);
        };
        const onMove = (e: PointerEvent) => {
            const [x, y] = local(e);
            if (grabbing) {
                e.stopPropagation();
                let dx = x - grabX, dy = y - grabY;
                const d = Math.hypot(dx, dy);
                if (d > MAX_PULL) {
                    // rubbery resistance past the limit rather than a hard stop
                    const soft = MAX_PULL + (d - MAX_PULL) * 0.25;
                    dx = (dx / d) * Math.min(soft, MAX_PULL * 1.4);
                    dy = (dy / d) * Math.min(soft, MAX_PULL * 1.4);
                }
                pullX = dx;
                pullY = dy;
                // the pull creaks like stretched rubber, rising with tension
                shaderAudio.stretchCreak(Math.hypot(pullX, pullY) / MAX_PULL);
                const now = performance.now();
                if (now - lastPullEmit > 90) {
                    lastPullEmit = now;
                    emitStretch('pull', e.clientX, e.clientY, Math.hypot(pullX, pullY) / MAX_PULL);
                }
            } else {
                hoverX = x;
                hoverY = y;
                hovering = true;
            }
        };
        const release = (e: PointerEvent) => {
            if (!grabbing) return;
            e.stopPropagation();
            grabbing = false;
            shaderAudio.stretchCreak(0);
            const now = performance.now();
            const p = Math.hypot(pullX, pullY) / MAX_PULL;
            if (p < 0.12 && now - grabT < 400) {
                if (tapBoop) {
                    // BOOP: the poke shoves material radially away from the
                    // tap point — a finger-press dimple — and the spring
                    // wobbles it back. Plus the obligatory boop tone.
                    for (let i = 0; i < N; i++) {
                        const ix = i * 2, iy = ix + 1;
                        const dx = base[ix] - grabX, dy = base[iy] - grabY;
                        const dd = Math.hypot(dx, dy) || 1;
                        const f = Math.exp(-(dd * dd) / (FALL_R * FALL_R));
                        vel[ix] += (dx / dd) * 540 * f;
                        vel[iy] += (dy / dd) * 540 * f;
                    }
                    shaderAudio.boop();
                    emitStretch('grab', e.clientX, e.clientY); // soft ripple
                    window.dispatchEvent(new CustomEvent('mdflow:boop')); // puzzle hook
                }
                onCleanClick?.();
                return;
            }
            emitStretch('release', e.clientX, e.clientY, Math.min(1, p), pullX, pullY);
            // elastic SNAP: noise crack + diving thwang, harder when pulled far
            if (p > 0.15 && now - lastTwang > 90) {
                lastTwang = now;
                shaderAudio.snapBack(Math.min(1, p));
            }
        };
        const onLeave = () => { hovering = false; };
        wrap.addEventListener('pointerdown', onDown);
        wrap.addEventListener('pointermove', onMove);
        wrap.addEventListener('pointerup', release);
        wrap.addEventListener('pointercancel', release);
        wrap.addEventListener('pointerleave', onLeave);

        // shader sparks that bounce off this sheet dent it: ShaderGuide
        // dispatches 'mdflow:sparkhit' at the impact point with the spark's
        // incoming velocity — kick nearby vertices along that path and let
        // the underdamped spring wobble them back.
        const onSparkHit = (ev: Event) => {
            const d = (ev as CustomEvent<{
                x: number; y: number; vx: number; vy: number; p: number;
            }>).detail;
            const r = wrap.getBoundingClientRect();
            if (d.x < r.left - 12 || d.x > r.right + 12
                || d.y < r.top - 12 || d.y > r.bottom + 12) return;
            const lx = d.x - r.left + PAD;
            const ly = d.y - r.top + PAD;
            const sp = Math.hypot(d.vx, d.vy) || 1;
            // impulse in vertex-velocity units; K=190 turns v into a dent of
            // roughly v/14 px, so this lands in the 8..30px range
            const kick = Math.min(440, 110 + sp * 0.3) * (0.6 + 0.6 * d.p);
            const ux = d.vx / sp, uy = d.vy / sp;
            for (let i = 0; i < N; i++) {
                const ix = i * 2, iy = ix + 1;
                const dx = base[ix] - lx, dy = base[iy] - ly;
                const f = Math.exp(-(dx * dx + dy * dy) / (hitR * hitR * 0.8));
                if (f < 0.01) continue;
                vel[ix] += ux * kick * f;
                vel[iy] += uy * kick * f;
            }
        };
        window.addEventListener('mdflow:sparkhit', onSparkHit);

        // dance drive: CraftedBy broadcasts cursor-to-CTA proximity; the
        // sheet eases toward it and the frame loop turns it into moves
        let danceGoal = 0;
        const onProx = (ev: Event) => {
            danceGoal = (ev as CustomEvent<{ p: number }>).detail.p;
        };
        if (dance) window.addEventListener('mdflow:workshop-prox', onProx);

        // ---- physics + render loop ----
        const cx = W / 2, cy = H / 2;
        let raf = 0;
        let last = performance.now();
        let danceP = 0; // smoothed dance intensity
        let tiltX = 0, tiltY = 0; // smoothed foil viewing angle
        // offscreen sheets skip their physics + GL draw entirely
        let onScreen = true;
        const io = new IntersectionObserver(
            entries => { onScreen = entries[0].isIntersecting; },
            { rootMargin: '80px' },
        );
        io.observe(wrap);
        const frame = (now: number) => {
            raf = requestAnimationFrame(frame);
            if (!onScreen && !grabbing) {
                last = now;
                return;
            }
            const dt = Math.min((now - last) / 1000, 0.033);
            last = now;
            const t = now / 1000;
            // heartbeat: two quick thumps per ~1.7s
            const beat = (Math.pow(Math.max(Math.sin(t * 3.7), 0), 6) * 0.030
                + Math.pow(Math.max(Math.sin(t * 3.7 - 0.9), 0), 8) * 0.016) * pulse;
            const scale = 1 + beat;
            // dance intensity eases toward the CTA proximity (never mid-grab)
            danceP += ((grabbing ? 0 : danceGoal) - danceP) * (1 - Math.exp(-dt * 5));
            // choreography clock: quarter notes at the groove's tempo
            const ph = t * Math.PI * 2 * (BPM / 60 / 2);
            for (let i = 0; i < N; i++) {
                const ix = i * 2, iy = ix + 1;
                let tx = 0, ty = 0;
                if (grabbing) {
                    const dx = base[ix] - grabX, dy = base[iy] - grabY;
                    const f = Math.exp(-(dx * dx + dy * dy) / (FALL_R * FALL_R));
                    tx = pullX * f;
                    ty = pullY * f;
                } else if (hovering) {
                    const dx = base[ix] - hoverX, dy = base[iy] - hoverY;
                    const f = Math.exp(-(dx * dx + dy * dy) / (FALL_R * FALL_R * 1.4));
                    // gentle bulge toward the cursor
                    tx = (hoverX - cx) * 0.07 * f;
                    ty = (hoverY - cy) * 0.07 * f;
                }
                if (!grabbing && danceP > 0.02) {
                    // the dance: same rubber-warp language as a drag, but
                    // choreographed — the top sways side to side (head bob),
                    // the body accordion-bounces on the offbeat, and a slow
                    // counter-twist adds sass. All spring-followed, so it
                    // reads as squishy, not mechanical.
                    const nx = (base[ix] - cx) / (artW / 2);
                    const ny = (base[iy] - cy) / (artH / 2);
                    tx += danceP * Math.sin(ph) * 9 * (0.55 - ny * 0.45) * (1 - Math.abs(nx) * 0.3);
                    ty += danceP * Math.sin(ph * 2 + 1.3) * 4.5 * (0.4 + ny * 0.6);
                    tx += danceP * Math.sin(ph * 0.5 + 0.7) * 3 * -ny;
                }
                if (grabbing) {
                    // stiff follow while held — the sheet sticks to the hand
                    const a = Math.min(1, dt * 26);
                    off[ix] += (tx - off[ix]) * a;
                    off[iy] += (ty - off[iy]) * a;
                    vel[ix] = vel[iy] = 0;
                } else {
                    // underdamped spring: snaps back with a Mario-64 wobble
                    const K = 190, C = 9.5;
                    vel[ix] += ((tx - off[ix]) * K - vel[ix] * C) * dt;
                    vel[iy] += ((ty - off[iy]) * K - vel[iy] * C) * dt;
                    off[ix] += vel[ix] * dt;
                    off[iy] += vel[iy] * dt;
                }
                pos[ix] = cx + (base[ix] - cx) * scale + off[ix];
                pos[iy] = cy + (base[iy] - cy) * scale + off[iy];
            }
            // foil viewing angle chases the pointer (grab point mid-drag,
            // cursor on hover) so the interference pattern shifts like a
            // tilting card; it drifts home when the pointer leaves
            const fx = grabbing ? grabX + pullX : hovering ? hoverX : cx;
            const fy = grabbing ? grabY + pullY : hovering ? hoverY : cy;
            const ease = 1 - Math.exp(-dt * 7);
            tiltX += ((fx - cx) / (W / 2) - tiltX) * ease;
            tiltY += ((fy - cy) / (H / 2) - tiltY) * ease;
            gl.uniform1f(uGold, goldRef.current ? 1 : 0);
            gl.uniform1f(uTime, t);
            gl.uniform2f(uTilt, tiltX, tiltY);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
            gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
            gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_SHORT, 0);
        };
        raf = requestAnimationFrame(frame);

        return () => {
            cancelAnimationFrame(raf);
            io.disconnect();
            uploadRef.current = () => {};
            wrap.removeEventListener('pointerdown', onDown);
            wrap.removeEventListener('pointermove', onMove);
            wrap.removeEventListener('pointerup', release);
            wrap.removeEventListener('pointercancel', release);
            wrap.removeEventListener('pointerleave', onLeave);
            window.removeEventListener('mdflow:sparkhit', onSparkHit);
            if (dance) window.removeEventListener('mdflow:workshop-prox', onProx);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // re-rasterize when the artwork's source becomes ready (image / fonts)
    useEffect(() => {
        uploadRef.current();
    }, [redrawKey]);

    if (broken) return <>{fallback}</>;
    return (
        <div
            ref={wrapRef}
            role="img"
            aria-label={label}
            {...(dataEgg ? { 'data-shader-egg': '' } : {})}
            className={`${className ?? ''} relative touch-none select-none cursor-grab active:cursor-grabbing`}
            style={{ width: artW, height: artH }}
        >
            <canvas
                ref={canvasRef}
                className="absolute pointer-events-none max-w-none"
                style={{
                    width: W,
                    height: H,
                    left: '50%',
                    top: '50%',
                    transform: 'translate(-50%, -50%)',
                }}
            />
        </div>
    );
};

/** The eggo mark as a stretchy sheet (anchors the shader's yolk rays).
 * Solving the secret puzzle gilds it — golden forever (localStorage). */
export const EggoInteractive: React.FC<{ className?: string }> = ({ className }) => {
    const imgRef = useRef<HTMLImageElement | null>(null);
    const [golden, setGolden] = useState(false);
    const [ready, setReady] = useState(0);
    useEffect(() => {
        try { if (localStorage.getItem('mdflow-golden') === '1') setGolden(true); } catch { /* private mode */ }
        const img = new Image();
        img.onload = () => { imgRef.current = img; setReady(r => r + 1); };
        img.src = '/eggo.svg';
        const onGolden = () => setGolden(true);
        window.addEventListener('mdflow:golden', onGolden);
        return () => window.removeEventListener('mdflow:golden', onGolden);
    }, []);
    return (
        <StretchySheet
            artW={124}
            artH={124}
            redrawKey={ready}
            dataEgg
            tapBoop
            dance
            gold={golden}
            className={className}
            label="Eggo, the egghead.io mascot — tap to boop, grab to stretch"
            draw={(c2, w, h) => {
                const img = imgRef.current;
                if (!img) return;
                const s = Math.min(w / img.naturalWidth, h / img.naturalHeight);
                const iw = img.naturalWidth * s;
                const ih = img.naturalHeight * s;
                c2.drawImage(img, (w - iw) / 2, (h - ih) / 2, iw, ih);
            }}
            fallback={
                <img
                    src="/eggo.svg"
                    data-shader-egg
                    alt="Eggo, the egghead.io mascot"
                    className={`${className ?? ''} w-32 h-32`}
                    // static stand-in for the foil pass (no WebGL / reduced motion)
                    style={golden ? { filter: 'sepia(1) saturate(4) hue-rotate(-12deg) brightness(1.05)' } : undefined}
                    draggable={false}
                />
            }
        />
    );
};

/** A display-font name rendered as a stretchy sheet — pure toy, no link.
 * Every letter is its own collision body ([data-shader-bounce] overlays
 * placed at the glyphs' ink boxes), so shader dots ricochet off individual
 * letters — or fall clean through the gaps between them. Each bumper also
 * carries its letter index as [data-shader-note], turning the name into a
 * glockenspiel: a dot striking a letter rings that letter's step of the
 * groove's A-minor pentatonic, rising left to right across the name. */
export const StretchName: React.FC<{
    text: string;
    className?: string;
}> = ({ text, className }) => {
    const [ready, setReady] = useState(0);
    const [letters, setLetters] = useState<{ x: number; y: number; w: number; h: number }[]>([]);
    useEffect(() => {
        let alive = true;
        document.fonts?.ready.then(() => { if (alive) setReady(r => r + 1); }).catch(() => {});
        return () => { alive = false; };
    }, []);
    const FONT = '700 46px "Space Grotesk", sans-serif';
    const artW = 340;
    const artH = 58;
    // per-letter ink boxes, measured with the same font/pen the sheet draws
    // with (art-unit coordinates match the wrapper's css px)
    useEffect(() => {
        const c2 = document.createElement('canvas').getContext('2d');
        if (!c2) return;
        c2.font = FONT;
        c2.textBaseline = 'middle';
        const tw = c2.measureText(text).width;
        const sx = tw > artW - 4 ? (artW - 4) / tw : 1;
        const mid = artH / 2 + 2;
        const out: { x: number; y: number; w: number; h: number }[] = [];
        let pen = 2;
        for (const ch of text) {
            const m = c2.measureText(ch);
            if (ch !== ' ') {
                const left = m.actualBoundingBoxLeft ?? 0;
                const right = m.actualBoundingBoxRight ?? m.width;
                const asc = m.actualBoundingBoxAscent ?? 30;
                const desc = m.actualBoundingBoxDescent ?? 8;
                out.push({
                    x: (pen - left) * sx,
                    y: mid - asc,
                    w: (left + right) * sx,
                    h: asc + desc,
                });
            }
            pen += m.width;
        }
        setLetters(out);
    }, [ready, text]);
    return (
        <div className={`relative inline-block ${className ?? ''}`}>
            <StretchySheet
                artW={artW}
                artH={artH}
                redrawKey={ready}
                pulse={0.4}
                hitR={12}
                label={`${text} — grab and stretch it`}
                draw={(c2, w, h) => {
                    c2.font = FONT;
                    c2.textBaseline = 'middle';
                    // squeeze slightly if the rendered text runs wider than the sheet
                    const tw = c2.measureText(text).width;
                    if (tw > w - 4) {
                        c2.setTransform(2 * (w - 4) / tw, 0, 0, 2, 0, 0);
                        c2.font = FONT;
                        c2.textBaseline = 'middle';
                    }
                    c2.fillStyle = '#e4e4e7';
                    c2.fillText(text, 2, h / 2 + 2);
                }}
                fallback={
                    <span className="font-display text-4xl sm:text-5xl font-bold tracking-tight text-zinc-200">
                        {text}
                    </span>
                }
            />
            {/* invisible per-letter bumpers for the shader's dot physics —
                each carries its letter index as data-shader-note, so a dot
                striking it rings that letter's own pentatonic scale step
                (the name is a glockenspiel: low A on the J, rising rightward) */}
            {letters.map((r, i) => (
                <div
                    key={i}
                    aria-hidden
                    data-shader-bounce="rect"
                    data-shader-note={i}
                    className="absolute pointer-events-none"
                    style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
                />
            ))}
        </div>
    );
};
