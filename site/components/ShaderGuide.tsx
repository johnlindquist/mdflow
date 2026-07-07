import React, { useEffect, useRef } from 'react';
import { shaderAudio, NOTE_COLUMNS, NOTE_ROWS } from './shaderAudio';

/**
 * Full-page WebGL overlay that guides the eye toward key conversion points —
 * and rewards play.
 *
 * Elements opt in with `data-shader-target` (+ optional `data-shader-priority`,
 * 0..1). The overlay renders:
 *  - a comet aura that trails the cursor and stretches with velocity,
 *  - guide beams flowing from the cursor toward the highest-priority visible
 *    targets, with halos that intensify on approach,
 *  - click shockwaves (chromatic double-rings),
 *  - spark particles that burst from clicks/fast flicks and get pulled into
 *    the nearest target; a landing makes that target flare ("excitement"),
 *  - and PIXEL MONSTERS (the easter-egg hunt): seeded 8-bit creatures that
 *    occasionally materialize and swim around the page. They shy away from
 *    the cursor and bounce off drawn light walls — herd one with shift+click
 *    walls, then close the shape around it to capture it.
 *
 * Physics runs on the CPU each frame and is fed to the fragment shader via
 * uniform arrays. Renders black + mix-blend-screen, so it only adds light.
 *
 * Disabled for touch-only devices, prefers-reduced-motion, and missing WebGL.
 */

const MAX_TARGETS = 4;
const MAX_SHOCKS = 20;
const MAX_PARTICLES = 32;
const MAX_PATH = 24;      // recorded drag-stroke points (light drawing)
const MAX_WALLS = 8;      // wave-blocking wall segments (tether + shift-chains)
const WALL_LIFE = 10;     // seconds a drawn wall persists (fades over last 2s)
const MAX_MONSTERS = 3;   // concurrent pixel monsters (the capture game)
const CHARGE_RANGE = 900; // px of stretch for a full slingshot charge
const SHOCK_LIFE = 4.5;   // seconds a ripple lives; long enough to exit the screen
// Everything drawn is a soft glow, so supersampling on retina buys nothing:
// render BELOW CSS resolution and let the browser upscale — at 0.75x the
// fragment workload drops to ~56% and the bloom hides the difference.
const MAX_DPR = 1;
const RENDER_SCALE = 0.75;
const IDLE_AFTER_MS = 2500; // no input for this long -> render at half rate

const VERT_SRC = `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG_SRC = `
precision highp float;

uniform float u_time;
uniform vec2  u_mouse;      // device px, y-up
uniform vec2  u_vel;        // cursor velocity, device px/s, y-up
uniform float u_energy;     // recent cursor movement, 0..1
uniform vec4  u_rect[${MAX_TARGETS}];     // center xy, half-extents zw (device px)
uniform float u_strength[${MAX_TARGETS}]; // visibility * priority, 0..1
uniform float u_excite[${MAX_TARGETS}];   // spark-landing flare, 0..1.5
uniform float u_glitch[${MAX_TARGETS}];   // click-on-target glitch, 1 -> 0
uniform vec4  u_wall[${MAX_WALLS}];       // wall segments, xy->zw device px
uniform float u_wallLife[${MAX_WALLS}];   // render strength 0..1 (0 = ghost)
uniform float u_wallVib[${MAX_WALLS}];    // struck-string vibration, 1 -> 0
uniform vec2  u_wallSpan[${MAX_WALLS}];   // (born, died) shader seconds; y<=0 = empty
uniform vec4  u_headline;   // hero headline rect: center xy, half-extents zw
uniform sampler2D u_mask;   // rasterized headline glyphs (alpha = coverage)
uniform vec4  u_credit;     // crafted-by credit rect: center xy, half-extents zw
uniform sampler2D u_mask2;  // rasterized credit glyphs + eggo silhouette (red)
uniform vec3  u_egg;        // eggo mark: center xy, radius (device px)
uniform vec4  u_shock[${MAX_SHOCKS}];     // xy device px, birth (s), amplitude
uniform vec4  u_part[${MAX_PARTICLES}];   // xy device px, size (css px), heat
uniform vec4  u_drag;       // anchor xy (device px), charge 0..1, active 0..1
uniform vec4  u_path[${MAX_PATH}];        // drag stroke: xy device px, z alive
uniform float u_trailFade;  // stroke visibility 0..1
uniform float u_tremble;    // 0..1 — every ripple shivers (workshop hover)
uniform vec4  u_mon[${MAX_MONSTERS}];     // pixel monster: xy device px, half-size css px, seed
uniform vec4  u_monPop[${MAX_MONSTERS}];  // alive fade, capture dissolve, hue, wobble phase
uniform float u_px;         // device pixel ratio

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * noise(p);
    p = p * 2.03 + 17.7;
    a *= 0.5;
  }
  return v;
}

float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

// Fraction along a->b where it crosses c->d, or -1.0 if no crossing
// (used for wave shadowing with wall-lifetime history)
float segCrossT(vec2 a, vec2 b, vec2 c, vec2 d) {
  vec2 r = b - a;
  vec2 s = d - c;
  float den = r.x * s.y - r.y * s.x;
  if (abs(den) < 1e-4) return -1.0;
  vec2 ac = c - a;
  float t = (ac.x * s.y - ac.y * s.x) / den;
  float u = (ac.x * r.y - ac.y * r.x) / den;
  return (t > 0.0 && t < 1.0 && u > 0.0 && u < 1.0) ? t : -1.0;
}

// Masked glyph treatment shared by the headline and the credit block:
// aurora + traveling light band + rim inside the alpha channel, and the
// EVOLVE-style living-organism layer (domain-warped edges, crawling veins,
// breathing teal<->amber) inside the red channel.
vec3 maskGlow(sampler2D mask, vec4 region, vec2 uv, float px, float wobPx, float evGain, float evEdge) {
  vec3 acc = vec3(0.0);
  if (region.z <= 1.0) return acc;
  vec3 MG_ORANGE = vec3(0.976, 0.510, 0.180);
  vec3 MG_AMBER  = vec3(1.000, 0.720, 0.350);
  vec2 hsize = 2.0 * region.zw;
  vec2 rel = (uv - (region.xy - region.zw)) / hsize;
  if (rel.x <= 0.0 || rel.x >= 1.0 || rel.y <= 0.0 || rel.y >= 1.0) return acc;
  vec2 tuv = vec2(rel.x, 1.0 - rel.y);
  float m = texture2D(mask, tuv).a;
  if (m > 0.01) {
    float m2 = fbm(uv / px * 0.006 + vec2(u_time * 0.10, -u_time * 0.05));
    float band = pow(0.5 + 0.5 * sin((uv.x + uv.y * 0.7) / px * 0.006 - u_time * 0.9), 8.0);
    vec3 auroraCol = mix(MG_ORANGE, vec3(0.55, 0.85, 1.0), m2 * 0.7);
    acc += m * ((0.10 + 0.22 * m2) * auroraCol
                + band * 0.5 * vec3(1.0, 0.95, 0.85))
             * (0.8 + 0.5 * u_energy);
    float mSh = texture2D(mask, tuv + vec2(-3.0, -3.0) / hsize).a;
    acc += max(m - mSh, 0.0) * (0.15 + 0.5 * m2) * MG_AMBER;
  }
  vec2 wob = vec2(
    sin(uv.y / px * 0.05 + u_time * 1.7) + sin(uv.y / px * 0.013 - u_time * 0.8),
    cos(uv.x / px * 0.04 + u_time * 1.3) + sin(uv.x / px * 0.017 + u_time * 0.9)
  ) * (wobPx * px) / hsize;
  float ev = texture2D(mask, tuv + wob).r;
  // evEdge=1: living CORONA — only where the warped sample reaches past
  // the true silhouette, so the artwork itself stays untouched and the
  // life flickers around its outline. evEdge=0: paint the full interior.
  ev = mix(ev, max(ev - texture2D(mask, tuv).r, 0.0) * 1.6, evEdge);
  if (ev > 0.02) {
    float veins = fbm(uv / px * 0.02 + vec2(u_time * 0.15, -u_time * 0.1));
    veins = 1.0 - abs(2.0 * veins - 1.0); // ridged: bright filaments
    float breathe = 0.82 + 0.18 * sin(u_time * 1.4 + uv.x / px * 0.003);
    vec3 bio = mix(vec3(0.45, 0.95, 0.70), vec3(1.0, 0.78, 0.40), 0.4 + 0.4 * sin(u_time * 0.5));
    acc += ev * breathe * (0.42 + pow(veins, 3.0) * 0.75) * bio * evGain;
  }
  return acc;
}

void main() {
  vec2 uv = gl_FragCoord.xy;
  vec2 m = u_mouse;
  float px = u_px;
  vec3 col = vec3(0.0);

  vec3 ORANGE = vec3(0.976, 0.510, 0.180);
  vec3 BLUE   = vec3(0.290, 0.560, 0.980);
  vec3 AMBER  = vec3(1.000, 0.720, 0.350);

  // Comet aura: a capsule that trails behind the cursor along -velocity,
  // longer and hotter the faster you move.
  float speed = length(u_vel) / px; // css px/s
  vec2 vdir = u_vel / max(length(u_vel), 0.001);
  float tail = clamp(speed * 0.16, 0.0, 300.0) * px;
  vec2 pm = uv - m;
  float along = clamp(dot(pm, -vdir), 0.0, tail);
  float dcap = length(pm + vdir * along) / px;
  float n = fbm(uv / px * 0.006 + u_time * 0.10);
  float aura = exp(-dcap / (70.0 + 55.0 * n)) * (0.05 + 0.32 * u_energy);
  col += aura * mix(ORANGE, BLUE, clamp(n * 0.8 + speed * 0.00018, 0.0, 1.0));

  // Slingshot drag: taut vibrating tether from the anchor to the cursor,
  // an anchor glow, and a charge ring that grows with the stretch.
  if (u_drag.w > 0.01) {
    vec2 a2 = u_drag.xy;
    float chg = u_drag.z;
    vec2 pa2 = uv - a2;
    vec2 ba2 = m - a2;
    float tt = clamp(dot(pa2, ba2) / max(dot(ba2, ba2), 1.0), 0.0, 1.0);
    float vib = sin(tt * 34.0 - u_time * 32.0) * (1.0 + 3.0 * chg);
    float dd = abs(length(pa2 - ba2 * tt) / px + vib * tt * (1.0 - tt) * 4.0);
    float tether = exp(-(dd * dd) / 40.0) * u_drag.w;
    col += tether * (0.40 + 0.80 * chg) * mix(AMBER, vec3(1.0, 0.95, 0.85), chg);

    float da = length(pa2) / px;
    col += exp(-da / 14.0) * 0.5 * u_drag.w * ORANGE;

    float dmc = length(pm) / px;
    float rr = 16.0 + chg * 32.0;
    float angg = atan(pm.y, pm.x);
    float dash = 0.5 + 0.5 * sin(angg * 3.0 + u_time * 9.0);
    col += exp(-abs(dmc - rr) / 3.5) * dash * u_drag.w * (0.2 + 0.8 * chg)
         * mix(ORANGE, BLUE, chg);

    // aim ray: dashed trajectory from the pouch (cursor) through the
    // anchor and beyond — where the volley will fly. Grows and brightens
    // with charge, dashes race along the launch direction.
    vec2 rd = -ba2 / max(length(ba2), 1.0);
    float alongR = dot(pm, rd);
    float rayLen = (260.0 + chg * 1500.0) * px;
    if (alongR > 0.0 && alongR < rayLen) {
      float dRay = length(pm - rd * alongR) / px;
      float dashR = step(0.45, fract(alongR / px / 46.0 - u_time * 2.4));
      float fadeR = 1.0 - alongR / rayLen;
      col += exp(-(dRay * dRay) / 18.0) * dashR * fadeR * u_drag.w
           * (0.2 + 0.8 * chg) * mix(AMBER, vec3(1.0, 0.55, 0.25), chg);
    }
  }

  // Light drawing: the drag stroke renders as a glowing ribbon; it lingers
  // briefly after release while it ignites into sparks.
  if (u_trailFade > 0.01) {
    float trail = 0.0;
    for (int i = 0; i < ${MAX_PATH - 1}; i++) {
      vec4 p0 = u_path[i];
      vec4 p1 = u_path[i + 1];
      if (p0.z < 0.5 || p1.z < 0.5) break;
      vec2 sa = p0.xy;
      vec2 sb = p1.xy - sa;
      vec2 sp = uv - sa;
      float st = clamp(dot(sp, sb) / max(dot(sb, sb), 1.0), 0.0, 1.0);
      float sdd = length(sp - sb * st) / px;
      trail += exp(-(sdd * sdd) / 34.0);
    }
    trail = min(trail, 1.3);
    float shimmer = 0.8 + 0.2 * sin(u_time * 7.0 + uv.x * 0.01);
    col += trail * u_trailFade * shimmer * 0.40
         * mix(BLUE, AMBER, clamp(trail * 0.8, 0.0, 1.0));
  }

  // Ripples as signed water waves: each is a cos carrier under a Gaussian
  // envelope riding the expanding front. Heights SUM, so overlapping ripples
  // genuinely interfere — constructive fringes flare, destructive ones
  // cancel — crests render orange, troughs blue. (Compacted; break early.)
  // Amplitude is SIGNED: negative ripples (snare hits) lead with a trough.
  float wave = 0.0;
  for (int i = 0; i < ${MAX_SHOCKS}; i++) {
    vec4 sk = u_shock[i];
    if (abs(sk.w) <= 0.001) break;
    float age = u_time - sk.z;
    if (age < 0.0 || age > ${SHOCK_LIFE}) continue;
    vec2 relS = uv - sk.xy;
    float r = length(relS) / px;
    float d = r - (26.0 + age * 500.0);
    // anticipation tremble: the ring fronts turn into shaking SAWTOOTH
    // waves — 16 jagged teeth per revolution racing around each ring while
    // the whole serration judders, each ripple phased by its birth time
    if (u_tremble > 0.003) {
      float th = atan(relS.y, relS.x);
      float sawW = fract(th * 2.5465 + u_time * 2.3 + sk.z) * 2.0 - 1.0;
      d += u_tremble * sawW * (6.0 + 2.5 * sin(u_time * 41.0 + sk.z * 9.0));
    }
    float w = 9.0 + age * 30.0;
    // linger: stays visible until the front has crossed the screen
    float fade = pow(max(1.0 - age / ${SHOCK_LIFE}, 0.0), 1.6);
    float env = exp(-(d * d) / (2.0 * w * w)) * fade * sk.w;
    if (abs(env) > 0.004) {
      // walls cast wave shadows — but only if the wall was ALIVE when this
      // ripple's front actually crossed it. Dead walls keep shadowing the
      // waves they blocked (ghost slots), so removing a wall never
      // resurrects a wave that already hit it.
      float open = 1.0;
      for (int j = 0; j < ${MAX_WALLS}; j++) {
        vec2 span = u_wallSpan[j];
        if (span.y <= 0.0) break;
        float hitT = segCrossT(sk.xy, uv, u_wall[j].xy, u_wall[j].zw);
        if (hitT < 0.0) continue;
        float passT = sk.z + max(hitT * r - 26.0, 0.0) / 500.0;
        if (passT > span.x && passT < span.y) open *= 0.15;
      }
      wave += cos(d * 0.12) * env * open;
    }
    // bright flash at the very start
    col += exp(-r / 40.0) * exp(-age * 14.0) * abs(sk.w) * 0.8 * AMBER;
  }
  vec3 CYAN = vec3(0.30, 0.80, 1.00);
  float crest = max(wave, 0.0);
  float trough = max(-wave, 0.0);
  col += crest * 0.55 * ORANGE + trough * 0.60 * CYAN
       + crest * crest * 0.22 * AMBER   // constructive collisions run hot
       + trough * trough * 0.15 * vec3(0.8, 0.95, 1.0);

  // The walls themselves: bright humming light barriers with a hot core
  for (int j = 0; j < ${MAX_WALLS}; j++) {
    if (u_wallSpan[j].y <= 0.0) break;
    float wl = u_wallLife[j];
    if (wl <= 0.003) continue; // ghost: still shadows, no longer drawn
    vec2 wa = u_wall[j].xy;
    vec2 wb = u_wall[j].zw - wa;
    vec2 wp = uv - wa;
    float wt = clamp(dot(wp, wb) / max(dot(wb, wb), 1.0), 0.0, 1.0);
    // struck by a spark: the line rings as a standing wave (three
    // antinodes pinned at the endpoints), then settles
    float vib = u_wallVib[j];
    float wlen = max(length(wb), 1.0);
    float sd2 = (wb.x * wp.y - wb.y * wp.x) / wlen / px; // signed perp dist
    float dotv = dot(wp, wb);
    float over = max(max(-dotv, dotv - dot(wb, wb)), 0.0) / (wlen * px);
    float disp = sin(wt * 9.42) * sin(u_time * 55.0 + float(j) * 1.7) * 7.0 * vib;
    float wd = length(vec2(sd2 - disp, over));
    float hum = 0.75 + 0.25 * sin(u_time * 6.0 + wt * 14.0 + float(j) * 2.1);
    float bright = wl * (1.0 + vib * 1.3);
    col += exp(-(wd * wd) / 46.0) * bright * hum * 0.85 * mix(AMBER, vec3(0.95, 1.0, 1.0), 0.3 + vib * 0.4);
    col += exp(-(wd * wd) / 5.0) * bright * 0.5 * vec3(1.0, 0.98, 0.9); // hot core
    // endpoint nodes
    float dn = min(length(uv - u_wall[j].xy), length(uv - u_wall[j].zw)) / px;
    col += exp(-(dn * dn) / 40.0) * wl * 0.6 * AMBER;
  }

  // Masked glyph effects: hero headline (EVOLVE lives in its red channel)
  // and the crafted-by credit block (the eggo mark lives in its red channel)
  col += maskGlow(u_mask, u_headline, uv, px, 2.5, 1.0, 0.0);
  // the eggo stays crisp white — its life is an undulating corona that
  // licks outward from the silhouette's edge (evEdge=1), never over it
  col += maskGlow(u_mask2, u_credit, uv, px, 9.0, 2.2, 1.0);

  // Egg radiance: slow-turning golden yolk rays behind the eggo mark
  if (u_egg.z > 1.0) {
    vec2 pe = uv - u_egg.xy;
    float de = length(pe) / px;
    float eggR = u_egg.z / px;
    float ang = atan(pe.y, pe.x);
    float rays = pow(0.5 + 0.5 * sin(ang * 9.0 + u_time * 0.55), 3.0);
    col += rays * exp(-de / (eggR * 1.7)) * 0.24
         * vec3(1.0, 0.85, 0.45) * (0.75 + 0.25 * sin(u_time * 1.4));
    col += exp(-(de * de) / (2.0 * eggR * eggR * 0.5)) * 0.14 * vec3(1.0, 0.8, 0.4);
  }

  // Spark particles: hot cores with a faint outer halo (compacted).
  for (int i = 0; i < ${MAX_PARTICLES}; i++) {
    vec4 pp = u_part[i];
    if (pp.w <= 0.003) break;
    float d = length(uv - pp.xy) / px;
    float core = exp(-(d * d) / (2.0 * pp.z * pp.z));
    col += core * pp.w * mix(ORANGE, vec3(1.0, 0.92, 0.75), pp.w) * 0.95;
    col += exp(-d / (pp.z * 7.0)) * pp.w * 0.10 * AMBER;
  }

  // Pixel monsters: 8x8 bilaterally-mirrored sprites grown from a seed —
  // little invader-like creatures made of light. They breathe, blink, and
  // swim with a squash-and-stretch wobble. Capture (u_monPop.y) inflates
  // the sprite while its cells wink out one by one, brightest last.
  for (int i = 0; i < ${MAX_MONSTERS}; i++) {
    vec4 mn = u_mon[i];
    if (mn.z <= 0.5) break; // slots are packed; nothing follows
    vec4 st = u_monPop[i];  // x alive, y pop, z hue, w phase
    float hs = mn.z * (1.0 + st.y * 1.6) * px;
    vec2 rel = uv - mn.xy;
    if (abs(rel.x) > hs * 1.4 || abs(rel.y) > hs * 1.4) continue;
    float wob = sin(u_time * 2.6 + st.w);
    rel /= vec2(1.0 + 0.07 * wob, 1.0 - 0.07 * wob); // swim squash
    vec2 gpos = (rel / hs + 1.0) * 4.0;              // 0..8 across the body
    vec2 g = floor(gpos);
    if (g.x < 0.0 || g.x > 7.0 || g.y < 0.0 || g.y > 7.0) continue;
    float gx = g.x < 4.0 ? g.x : 7.0 - g.x;          // bilateral symmetry
    float cell = hash(vec2(gx, g.y) * 7.31 + mn.w * 291.7);
    float on = step(0.46, cell);
    // eyes: fixed sockets every creature shares, so they all read as alive
    float eye = (g.y == 4.0 && gx == 2.0) ? 1.0 : 0.0;
    on = max(on, eye);
    // capture dissolve: cells wink out in seeded order as the pop advances
    on *= step(st.y, 1.0 - cell * 0.99);
    // soft-edged cells so the sprite reads as made of light, not LEGO
    vec2 cf = fract(gpos);
    float pixm = smoothstep(0.0, 0.18, cf.x) * smoothstep(1.0, 0.82, cf.x)
               * smoothstep(0.0, 0.18, cf.y) * smoothstep(1.0, 0.82, cf.y);
    vec3 body = 0.55 + 0.45 * cos(6.2832 * (st.z + vec3(0.0, 0.33, 0.67)));
    float breathe = 0.8 + 0.2 * sin(u_time * 2.2 + st.w * 2.0);
    vec3 pcol = body * (0.6 + 0.4 * hash(vec2(gx, g.y) + floor(mn.w * 100.0)));
    if (eye > 0.5) {
      float blink = step(0.94, fract(u_time * 0.35 + mn.w * 7.0));
      pcol = mix(vec3(1.0), body * 0.15, blink);
    }
    col += on * pixm * pcol * breathe * st.x * (0.85 + st.y * 1.5);
  }

  for (int i = 0; i < ${MAX_TARGETS}; i++) {
    float s = u_strength[i];
    if (s <= 0.003) break; // sorted by strength, so nothing follows
    vec2 c = u_rect[i].xy;
    vec2 b = u_rect[i].zw;
    float exc = u_excite[i];

    float distMT = length(m - c) / px;
    float prox = 1.0 - smoothstep(180.0, 950.0, distMT);

    // Guide beam: tapered ribbon from cursor to target, pinned at both ends.
    // prox is uniform per target, so this branch is coherent — the whole
    // beam block (incl. its noise call) is skipped when the cursor is far.
    if (prox > 0.005) {
      vec2 pa = uv - m;
      vec2 ba = c - m;
      float t = clamp(dot(pa, ba) / max(dot(ba, ba), 1.0), 0.0, 1.0);
      float d = length(pa - ba * t) / px;
      float wob = (noise(vec2(t * 7.0 - u_time * 1.4, float(i) * 13.1)) - 0.5)
                * 60.0 * t * (1.0 - t);
      d = abs(d + wob);
      float width = mix(26.0, 6.0, t);
      float beam = exp(-(d * d) / (2.0 * width * width));
      // energy pulses drifting toward the target
      float pulse = 0.6 + 0.4 * sin(t * 24.0 - u_time * 5.0);
      col += beam * pulse * s * prox * (0.08 + 0.55 * u_energy)
           * mix(ORANGE, BLUE, t * 0.8);
    }

    // Click-on-target: a glitch absorb — chromatic ghost outlines, a scan
    // bar sweeping down as the effect decays, and static inside the rect.
    float gli = u_glitch[i];
    if (gli > 0.02) {
      vec2 off = vec2(14.0 * px * gli, 0.0);
      float sdr = sdBox(uv - c - off, b) / px;
      float sdl = sdBox(uv - c + off, b) / px;
      col += exp(-abs(sdr) / 3.0) * gli * 0.55 * vec3(1.0, 0.30, 0.22);
      col += exp(-abs(sdl) / 3.0) * gli * 0.55 * vec3(0.25, 0.60, 1.0);
      float scanY = c.y + b.y - 2.0 * b.y * gli; // sweeps as the glitch decays
      // full brightness through the sweep, and wings that reach well past
      // the rect — screen-blend adds nothing over white buttons, so the bar
      // must be visible on the dark background beside them
      float wing = 1.0 - smoothstep(b.x, b.x * 1.9 + 60.0 * px, abs(uv.x - c.x));
      float scan = exp(-abs(uv.y - scanY) / (7.0 * px)) * wing;
      col += scan * smoothstep(0.03, 0.15, gli) * 0.95 * vec3(0.70, 1.0, 0.92);
      float inside = 1.0 - step(0.0, sdBox(uv - c, b));
      col += inside * hash(uv + floor(u_time * 40.0)) * gli * 0.14 * vec3(0.8);
    }

    // Halo: breathing ring + glow hugging the target's rounded rect.
    // Spark landings ("excitement") make it breathe faster and flare.
    float sd = sdBox(uv - c, b) / px;
    float breathe = (3.0 + 7.0 * exc) * sin(u_time * (2.2 + 4.0 * exc) + float(i) * 1.7);
    float ring = exp(-abs(sd - 10.0 - breathe) / 5.0);
    float glow = exp(-max(sd, 0.0) / 60.0);
    col += (ring * 0.7 + glow * (0.25 + 0.45 * exc)) * s
         * (0.10 + 0.60 * prox + 0.55 * exc)
         * mix(AMBER, ORANGE, glow);
  }

  // dither to avoid banding on the dark background
  col += (hash(uv + u_time) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
`;

interface TrackedTarget {
  el: HTMLElement;
  priority: number;
  gravity: number;  // spark-pull multiplier (data-shader-gravity, default 1)
  strength: number; // smoothed toward priority * visibility
  excite: number;   // flares when a spark lands, decays
  glitch: number;   // click-on-target glitch effect, decays fast
}

interface Wall {
  x1: number; y1: number; x2: number; y2: number; // css px, viewport space
  born: number; // shader seconds
  die: number;  // shader seconds; kept as a "ghost" past this so the waves
                // it already blocked stay blocked
  vib: number;  // struck-string vibration, decays after a spark hits
}

interface Monster {
  x: number; y: number;   // css px, viewport space
  vx: number; vy: number; // css px/s
  seed: number;           // 0..1 identity: sprite cells, color, voice
  size: number;           // half-size, css px
  wander: number;         // current wander heading, radians
  alive: number;          // smoothed fade toward `fade`
  fade: number;           // 1 while living, 0 once fleeing
  pop: number;            // capture dissolve 0..1 (0 = free)
  dieAt: number;          // performance.now() when it gives up and leaves
  chirpAt: number;        // next idle chirp
  fleeing: boolean;
}

interface Particle {
  active: boolean;
  x: number; y: number;   // css px, viewport space
  vx: number; vy: number; // css px/s
  life: number;           // seconds remaining
  maxLife: number;
  size: number;           // css px
  seed: number;
  freq: number;           // chord tone / click note it carries (0 = none)
  volleyId: number;       // chord volley it belongs to (0 = none)
  grace: number;          // seconds airborne before it may land (fountains)
}

interface Volley {
  id: number;
  freqs: number[];        // the drag chord
  remaining: number;      // sparks still in flight
  landed: number;
  cx: number; cy: number; // last landing spot (celebration shock)
  t: TrackedTarget | null;
}

function compileShader(gl: WebGLRenderingContext, type: number, src: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('ShaderGuide compile error:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export const ShaderGuide: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // touch devices run the full layer too — with a scroll-driven virtual
    // cursor, tap/hold/long-press gestures, and two-finger wall taps
    const coarse = !window.matchMedia('(pointer: fine)').matches;

    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power',
    });
    // A lost context can linger on the canvas across StrictMode re-mounts;
    // a dead WebGL canvas composites as garbage, so bail (and try to restore
    // for the next mount) rather than render it.
    if (!gl) return;
    if (gl.isContextLost()) {
      gl.getExtension('WEBGL_lose_context')?.restoreContext();
      return;
    }

    const vert = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
    const frag = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vert || !frag) return;
    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('ShaderGuide link error:', gl.getProgramInfoLog(program));
      return;
    }
    gl.useProgram(program);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uTime = gl.getUniformLocation(program, 'u_time');
    const uMouse = gl.getUniformLocation(program, 'u_mouse');
    const uVel = gl.getUniformLocation(program, 'u_vel');
    const uEnergy = gl.getUniformLocation(program, 'u_energy');
    const uRect = gl.getUniformLocation(program, 'u_rect');
    const uStrength = gl.getUniformLocation(program, 'u_strength');
    const uExcite = gl.getUniformLocation(program, 'u_excite');
    const uGlitch = gl.getUniformLocation(program, 'u_glitch');
    const uWall = gl.getUniformLocation(program, 'u_wall');
    const uWallLife = gl.getUniformLocation(program, 'u_wallLife');
    const uWallVib = gl.getUniformLocation(program, 'u_wallVib');
    const uWallSpan = gl.getUniformLocation(program, 'u_wallSpan');
    const uHeadline = gl.getUniformLocation(program, 'u_headline');
    const uMask = gl.getUniformLocation(program, 'u_mask');
    const uMask2 = gl.getUniformLocation(program, 'u_mask2');
    const uCredit = gl.getUniformLocation(program, 'u_credit');
    const uEgg = gl.getUniformLocation(program, 'u_egg');

    // glyph mask textures: headline on unit 0, crafted-by credit on unit 1
    // (each unit keeps its texture bound; uploads re-select the unit)
    const makeMaskTex = (unit: number) => {
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      return tex;
    };
    const maskTex = makeMaskTex(0);
    const maskTex2 = makeMaskTex(1);
    gl.useProgram(program);
    gl.uniform1i(uMask, 0);
    gl.uniform1i(uMask2, 1);

    // shader layer is live: lets CSS hand glyph-painting duties over to it
    // (EVOLVE's translucent-window fill only applies with this class on)
    document.documentElement.classList.add('shader-fx');
    const uShock = gl.getUniformLocation(program, 'u_shock');
    const uPart = gl.getUniformLocation(program, 'u_part');
    const uDrag = gl.getUniformLocation(program, 'u_drag');
    const uPath = gl.getUniformLocation(program, 'u_path');
    const uTrailFade = gl.getUniformLocation(program, 'u_trailFade');
    const uTremble = gl.getUniformLocation(program, 'u_tremble');
    const uMon = gl.getUniformLocation(program, 'u_mon');
    const uMonPop = gl.getUniformLocation(program, 'u_monPop');
    const uPx = gl.getUniformLocation(program, 'u_px');

    // "device px per css px" for every coordinate conversion — includes the
    // sub-native render scale, so all math stays consistent automatically
    let dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR) * RENDER_SCALE;
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR) * RENDER_SCALE;
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform1f(uPx, dpr); // only changes with the canvas size
    };
    resize();
    window.addEventListener('resize', resize);

    // ---- Cursor state: smoothed position, velocity, movement energy ----
    const mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const smooth = { x: mouse.x, y: mouse.y };
    const prevSmooth = { x: smooth.x, y: smooth.y };
    const vel = { x: 0, y: 0 }; // smoothed, css px/s
    let energy = 0;
    let energyTarget = 0;
    let shedDist = 0; // distance accumulator for fast-flick spark shedding
    let lastEventT = performance.now(); // for the idle half-rate throttle
    let frameCount = 0;
    let anyParticles = false;
    let anyShocks = false;
    let anyMonsters = false;
    let targetProx = 0; // 0..1 cursor proximity to the best guide target
    let tremble = 0;    // smoothed 0..1 — hovering the workshop button
    let hoverRippleAcc = 0.5; // anticipation-pulse timer while hovered

    const start = performance.now();
    const shaderNow = () => (performance.now() - start) / 1000;

    // ---- Shockwaves (ring buffer) ----
    const shockData = new Float32Array(MAX_SHOCKS * 4);
    const shockUpload = new Float32Array(MAX_SHOCKS * 4);
    // Evict by importance (|amp| x remaining life), never round-robin — a
    // burst of landing pops must not cancel a big ripple mid-expansion.
    const addShock = (x: number, y: number, amp: number) => {
      const now = shaderNow();
      let slot = 0;
      let worst = Infinity;
      for (let i = 0; i < MAX_SHOCKS; i++) {
        const a = Math.abs(shockData[i * 4 + 3]);
        const remain = a <= 0.001 ? -1 : a * Math.max(0, SHOCK_LIFE - (now - shockData[i * 4 + 2]));
        if (remain < worst) {
          worst = remain;
          slot = i;
          if (remain < 0) break; // empty/expired slot — take it
        }
      }
      const o = slot * 4;
      shockData[o + 0] = x * dpr;
      shockData[o + 1] = canvas.height - y * dpr;
      shockData[o + 2] = now;
      shockData[o + 3] = amp;
    };

    // ---- Spark particles (fixed pool) + chord volley bookkeeping ----
    const particles: Particle[] = Array.from({ length: MAX_PARTICLES }, () => ({
      active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 3, seed: 0,
      freq: 0, volleyId: 0, grace: 0,
    }));
    const partData = new Float32Array(MAX_PARTICLES * 4);
    let partIdx = 0;
    let volley: Volley | null = null;
    let volleySeq = 0;

    // Every carrier spark of the volley has resolved: replay the chord as a
    // celebration — bells in reverb + a big ring and full flare at the target.
    const finishVolley = () => {
      if (!volley) return;
      if (volley.landed >= 2) {
        if (volley.t) {
          volley.t.excite = 1.5;
          // the puzzle listens for volleys delivered to specific buttons
          window.dispatchEvent(new CustomEvent('mdflow:volley', {
            detail: { target: volley.t.el.dataset.shaderTarget || '' },
          }));
        }
        if (volley.cx || volley.cy) addShock(volley.cx, volley.cy, 1.3);
        shaderAudio.celebrate(volley.freqs);
      }
      volley = null;
    };
    const volleySparkResolved = (p: Particle, landed: boolean) => {
      if (!volley || p.volleyId !== volley.id) return;
      volley.remaining--;
      if (landed) volley.landed++;
      if (volley.remaining <= 0) finishVolley();
    };

    const spawnSpark = (
      x: number, y: number, vx: number, vy: number,
      life?: number, freq = 0, volleyId = 0, grace = 0, sizeScale = 1,
    ) => {
      // prefer an empty slot; only if the pool is full, evict the spark
      // with the least remaining life (volley carriers get a bonus) — so
      // rapid clicking never wipes out dots already in flight
      let idx = -1;
      for (let i = 0; i < MAX_PARTICLES; i++) {
        const j = (partIdx + i) % MAX_PARTICLES;
        if (!particles[j].active) { idx = j; break; }
      }
      if (idx < 0) {
        let worst = Infinity;
        for (let i = 0; i < MAX_PARTICLES; i++) {
          const cand = particles[i].life + (particles[i].volleyId ? 0.6 : 0);
          if (cand < worst) { worst = cand; idx = i; }
        }
      }
      const p = particles[idx];
      partIdx = (idx + 1) % MAX_PARTICLES;
      // recycling a live volley spark counts it as resolved (not landed)
      if (p.active) volleySparkResolved(p, false);
      p.active = true;
      p.x = x; p.y = y; p.vx = vx; p.vy = vy;
      p.maxLife = life ?? 1.6 + Math.random() * 1.2;
      p.life = p.maxLife;
      p.size = (2.2 + Math.random() * 2.2) * sizeScale;
      p.seed = Math.random() * 100;
      p.freq = freq;
      p.volleyId = volleyId;
      p.grace = grace;
    };
    // power (0..1, from holding the press): bigger + slower + heavier dots,
    // and the note drops up to two octaves. heldMs shapes ripple DEPTH from
    // the very first millisecond: a quick tap barely dents the surface, a
    // long press digs a deep swell — no two clicks ripple the same.
    const burst = (x: number, y: number, power = 0, heldMs = 250) => {
      const tap = Math.min(1, heldMs / 250); // sub-250ms taps stay shallow
      addShock(x, y, 0.35 + tap * 0.55 + power * 1.25);
      // held clicks dig: a chasing trough follows, deeper the longer held
      if (power > 0.2) {
        window.setTimeout(() => addShock(x, y, -1.0 * power), 140);
      }
      if (power > 0.5) energyTarget = 1;
      // pluck sounds a tone relative to the target harmony (chord tone at
      // the cursor; chord ROOT dropped low when charged) and the sparks
      // carry that exact note to re-ring it on arrival
      const octave = power > 0.66 ? 0.25 : power > 0.33 ? 0.5 : 1;
      const clickNote = shaderAudio.pluck(
        x / window.innerWidth, y / window.innerHeight, octave);
      const count = 10 + Math.floor(Math.random() * 4) + Math.round(power * 8);
      for (let k = 0; k < count; k++) {
        const a = Math.random() * Math.PI * 2;
        const s = (260 + Math.random() * 420) * (1 - 0.35 * power);
        spawnSpark(
          x, y,
          Math.cos(a) * s + vel.x * 0.3, Math.sin(a) * s + vel.y * 0.3,
          undefined, clickNote, 0, 0, 1 + power * 1.6,
        );
      }
      energyTarget = Math.min(1, energyTarget + 0.6);
    };

    // ---- Walls: light barriers that shadow ripples and bounce sparks ----
    // Built from the live tether and from shift+click chains.
    let walls: Wall[] = [];
    const wallData = new Float32Array(MAX_WALLS * 4);
    const wallLifeData = new Float32Array(MAX_WALLS);
    const wallSpanData = new Float32Array(MAX_WALLS * 2);
    const wallVibData = new Float32Array(MAX_WALLS);
    let dragVib = 0;      // tether's own struck-string vibration
    let lastTwangT = 0;   // rate limit for wall-hit tones
    let lastBounceFxT = 0; // rate limit for eggo/name bumper hits
    let lastLetterT = 0;    // rate limit for letter-note pings...
    let lastLetterNote = -1; // ...relaxed when the next hit is a NEW letter,
    // so a dot skipping across the name still plays the run
    // segments this frame (walls incl. ghosts + active tether), css px;
    // used for uniform upload and (life > 0 only) particle bouncing
    let liveSegs: {
      x1: number; y1: number; x2: number; y2: number;
      born: number; die: number; life: number; vib: number; w?: Wall;
    }[] = [];
    const addWall = (x1: number, y1: number, x2: number, y2: number) => {
      if (walls.length >= MAX_WALLS - 1) walls.shift(); // keep a slot for the tether
      const b = shaderNow();
      walls.push({ x1, y1, x2, y2, born: b, die: b + WALL_LIFE, vib: 0 });
    };

    // ---- Pixel monsters: the shift-gate capture game ----
    // Every so often a seeded 8-bit creature materializes and swims around
    // the page. It shies away from the cursor and bounces off drawn walls,
    // so pointing at it never works: build a shift+click pen around it and
    // CLOSE the shape — any monster inside the gate dissolves into light.
    const monsters: Monster[] = [];
    let nextMonsterAt = performance.now() + 12000 + Math.random() * 18000;
    const spawnMonster = () => {
      if (monsters.length >= MAX_MONSTERS) return;
      const W = window.innerWidth;
      const H = window.innerHeight;
      let x = W / 2;
      let y = H / 2;
      // materialize away from the cursor so the hunt is always a journey
      for (let tries = 0; tries < 8; tries++) {
        x = W * (0.12 + Math.random() * 0.76);
        y = H * (0.15 + Math.random() * 0.6);
        if (Math.hypot(x - smooth.x, y - smooth.y) > 260) break;
      }
      const seed = Math.random();
      monsters.push({
        x, y, vx: 0, vy: 0, seed,
        size: 15 + seed * 10,
        wander: Math.random() * Math.PI * 2,
        alive: 0, fade: 1, pop: 0,
        dieAt: performance.now() + 30000 + Math.random() * 25000,
        chirpAt: performance.now() + 1500 + Math.random() * 3000,
        fleeing: false,
      });
      addShock(x, y, 0.35);
      shaderAudio.monsterSpawn(seed);
      // teleport shimmer: a ring of sparks collapses into the arrival point
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + Math.random() * 0.5;
        spawnSpark(x + Math.cos(a) * 70, y + Math.sin(a) * 70,
          -Math.cos(a) * 300, -Math.sin(a) * 300, 0.35, 0, 0, 1, 0.6);
      }
    };
    const captureMonster = (mn: Monster) => {
      mn.pop = 0.001; // the dissolve animation takes it from here
      addShock(mn.x, mn.y, 1.1);
      energyTarget = 1;
      shaderAudio.monsterCaught(mn.seed);
      // the creature bursts into chord-tone sparks that ring on landing
      const chord = shaderAudio.currentChord();
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2 + Math.random() * 0.3;
        const s = 320 + Math.random() * 380;
        spawnSpark(mn.x, mn.y, Math.cos(a) * s, Math.sin(a) * s,
          undefined, chord[k % chord.length] * 2, 0, 0.5, 1.1);
      }
      // the easter-egg layer counts the hunt
      window.dispatchEvent(new CustomEvent('mdflow:monster', {
        detail: { x: mn.x, y: mn.y, seed: mn.seed },
      }));
    };
    // even-odd ray cast: is the point inside the closed gate polygon?
    const inPoly = (x: number, y: number, pts: { x: number; y: number }[]) => {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[i];
        const b = pts[j];
        if ((a.y > y) !== (b.y > y)
            && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
      return inside;
    };

    // shift+click chain: consecutive shift-clicks connect into shapes
    let chain: { pts: { x: number; y: number }[]; lastAt: number } | null = null;
    const onShiftClick = (x: number, y: number) => {
      lastEventT = performance.now();
      const now = performance.now();
      if (!chain || now - chain.lastAt > 8000) {
        chain = { pts: [{ x, y }], lastAt: now };
        addShock(x, y, 0.3);
        shaderAudio.gliss(x / window.innerWidth, y / window.innerHeight);
        return;
      }
      const prev = chain.pts[chain.pts.length - 1];
      const start = chain.pts[0];
      addWall(prev.x, prev.y, x, y);
      chain.lastAt = now;
      // closing the loop near the start point completes the shape:
      // flash, a ripple from the centroid, and an arpeggio of the vertices
      if (chain.pts.length >= 2 && Math.hypot(x - start.x, y - start.y) < 44) {
        addWall(x, y, start.x, start.y);
        const cx = chain.pts.reduce((s, p) => s + p.x, x) / (chain.pts.length + 1);
        const cy = chain.pts.reduce((s, p) => s + p.y, y) / (chain.pts.length + 1);
        addShock(cx, cy, 1.2);
        window.dispatchEvent(new CustomEvent('mdflow:shape')); // puzzle hook
        // THE GATE: the closed shape is a capture net — every pixel
        // monster inside the polygon dissolves; near-misses bolt away
        const poly = [...chain.pts, { x, y }];
        for (const mn of monsters) {
          if (mn.pop > 0 || mn.fleeing) continue;
          if (inPoly(mn.x, mn.y, poly)) {
            captureMonster(mn);
          } else if (Math.hypot(mn.x - cx, mn.y - cy) < 420) {
            // startled: it yelps and bolts from the snapping gate
            const a = Math.atan2(mn.y - cy, mn.x - cx);
            mn.vx += Math.cos(a) * 520;
            mn.vy += Math.sin(a) * 520;
            shaderAudio.monsterChirp(mn.seed);
          }
        }
        // the whole shape gets a fresh lease of life (born stays put so the
        // wave-blocking history is preserved)
        const fresh = shaderNow() + WALL_LIFE;
        for (const w of walls) w.die = Math.max(w.die, fresh);
        shaderAudio.arpeggio(
          [...chain.pts, { x, y }].map(p =>
            shaderAudio.noteAt(p.x / window.innerWidth, p.y / window.innerHeight)),
        );
        chain = null;
      } else {
        chain.pts.push({ x, y });
        shaderAudio.gliss(x / window.innerWidth, y / window.innerHeight);
      }
    };

    // clicking directly on a target: the glitch absorb (its own language —
    // chromatic split + scanline + static + sparks sucked inward + data zap)
    const targetClickFX = (t: TrackedTarget, r: DOMRect) => {
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      t.glitch = 1;
      addShock(cx, cy, -0.5);
      const f = shaderAudio.noteAt(cx / window.innerWidth, cy / window.innerHeight);
      const rad = Math.max(r.width, r.height) / 2 + 130;
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const sx = cx + Math.cos(a) * rad;
        const sy = cy + Math.sin(a) * rad;
        spawnSpark(sx, sy, -Math.cos(a) * 560, -Math.sin(a) * 560, 0.9, f);
      }
      shaderAudio.targetHit(
        t.el.dataset.shaderTarget || '',
        cx / window.innerWidth, cy / window.innerHeight);
    };

    // ---- Slingshot drag: press anchors a tether, release fires a volley ----
    const drag = { held: false, moved: false, full: false, x0: 0, y0: 0, t0: 0, ts0: 0 };
    let dragActiveSm = 0; // smoothed 0..1 for tether fade in / snap out
    let dribbleAcc = 0;   // timer for charging sparks along the tether
    let holdPulseAcc = 0; // timer for held-click charge pulses
    let lastCol = -1;     // pentatonic column under the cursor (glissando)
    let lastRow = -1;     // octave row under the cursor (glissando)

    // ---- Light drawing: the drag stroke is recorded and rendered ----
    const pathPts: { x: number; y: number }[] = [];
    const pathData = new Float32Array(MAX_PATH * 4);
    let trailFade = 0;

    // While a drag is live, keep the page still: no text selection
    // (selection drag also auto-scrolls the page) and no wheel scrolling.
    const setDragGuards = (on: boolean) => {
      document.body.style.userSelect = on ? 'none' : '';
      (document.body.style as any).webkitUserSelect = on ? 'none' : '';
    };
    // Selection can get STUCK while playing: shift+click (the wall gesture)
    // is also the browser's extend-selection gesture, and once the drag
    // guards make the body non-selectable a plain click no longer collapses
    // an existing selection — the page ends up fully highlighted with no way
    // out. Suppress the cause and always clear on the next gesture. Editable
    // targets (the editor textarea) keep native selection behavior.
    const isEditable = (t: EventTarget | null) =>
      t instanceof Element && !!t.closest('input, textarea, [contenteditable]');
    const clearSelection = () => {
      if (isEditable(document.activeElement)) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) sel.removeAllRanges();
    };
    // mousedown preventDefault stops selection anchoring/extending but still
    // lets click events through (the pointerdown listener is passive, so the
    // wall handler itself can't do this)
    const onShiftMouseDown = (e: MouseEvent) => {
      if (e.shiftKey && !isEditable(e.target)) e.preventDefault();
    };
    // belt and braces: some engines ignore a user-select flip mid-gesture
    const onSelectStart = (e: Event) => {
      if (drag.held && !isEditable(e.target)) e.preventDefault();
    };
    // Attached only for the duration of a drag so normal scrolling keeps a
    // fully passive path.
    const onWheel = (e: WheelEvent) => {
      if (drag.held && drag.moved) e.preventDefault();
    };

    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - mouse.x;
      const dy = e.clientY - mouse.y;
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      if (e.pointerType === 'touch' && touchPts.has(e.pointerId)) {
        touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      energyTarget = Math.min(1, energyTarget + Math.hypot(dx, dy) / 120);
      shedDist += Math.hypot(dx, dy);
      lastEventT = performance.now();
      if (drag.held && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 12) {
        drag.moved = true;
      }
    };
    const onLeave = () => { energyTarget = 0; };
    // touch bookkeeping: a second finger while one is down = a wall node
    // (the touch analog of shift+click); their pointerups fire no bursts
    const touchPts = new Map<number, { x: number; y: number }>();
    let suppressTouchUp = false;
    const onDown = (e: PointerEvent) => {
      // presses in the editor belong to the editor: no burst, no drag guards
      // (guards would block selecting text inside the textarea)
      if (isEditable(e.target)) return;
      clearSelection(); // restore click-collapses-selection, which the
      // guards' user-select:none otherwise suppresses
      if (e.shiftKey) {
        onShiftClick(e.clientX, e.clientY);
        return;
      }
      if (e.pointerType === 'touch') {
        touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touchPts.size === 2) {
          const pts = [...touchPts.values()];
          onShiftClick((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
          drag.held = false;
          shaderAudio.holdCharge(0);
          setDragGuards(false);
          window.removeEventListener('wheel', onWheel);
          suppressTouchUp = true;
          return;
        }
      }
      drag.held = true;
      drag.moved = false;
      drag.full = false;
      drag.x0 = e.clientX;
      drag.y0 = e.clientY;
      drag.t0 = performance.now();
      drag.ts0 = shaderNow();
      lastCol = Math.floor((e.clientX / window.innerWidth) * NOTE_COLUMNS);
      lastRow = Math.floor((e.clientY / window.innerHeight) * NOTE_ROWS);
      pathPts.length = 0;
      pathPts.push({ x: e.clientX, y: e.clientY });
      setDragGuards(true);
      window.addEventListener('wheel', onWheel, { passive: false });
      lastEventT = performance.now();
      addShock(e.clientX, e.clientY, 0.22); // light press feedback — the
      // release ripple carries the real depth (scaled by how long you held)
      // ignition: the instant the button goes down (hold OR drag — both
      // charges start here), energy visibly GATHERS: a ring of sparks
      // collapses into the press point while a soft rising blip sounds.
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * Math.PI * 2 + Math.random() * 0.6;
        const rr = 60 + Math.random() * 50;
        spawnSpark(
          e.clientX + Math.cos(a) * rr, e.clientY + Math.sin(a) * rr,
          -Math.cos(a) * 470, -Math.sin(a) * 470,
          0.32, 0, 0, 1, 0.7,
        );
      }
      shaderAudio.ignite();
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        touchPts.delete(e.pointerId);
        if (suppressTouchUp) {
          if (touchPts.size === 0) suppressTouchUp = false;
          drag.held = false;
          return;
        }
      }
      if (!drag.held) return;
      drag.held = false;
      shaderAudio.holdCharge(0);
      setDragGuards(false);
      window.removeEventListener('wheel', onWheel);
      if (drag.moved) clearSelection();
      lastEventT = performance.now();
      const dx = drag.x0 - e.clientX;
      const dy = drag.y0 - e.clientY;
      const stretch = Math.hypot(dx, dy);
      if (drag.moved && stretch > 24) {
        // slingshot: power comes from stretch PLUS how long it was held —
        // patience charges the shot
        const holdBoost = Math.min(0.5, (performance.now() - drag.t0) / 8000);
        const charge = Math.min(1, stretch / CHARGE_RANGE + holdBoost);
        // click-hold power carries INTO the sling: charge up first (the
        // grinding saw), then pull — the volley fires the big heavy dots
        const holdPower = Math.min(1, Math.max(0, (performance.now() - drag.t0 - 250) / 4000));
        const baseAngle = Math.atan2(dy, dx);
        addShock(e.clientX, e.clientY, 0.5 + 0.6 * charge);

        // the drag defines a chord: root at the anchor, top voice at the
        // release point. Every spark in this volley carries one chord tone.
        // HOW you use the slingshot shapes the sound: a gentle flick fires
        // delicate darts an octave UP, a full-power pull launches heavy
        // artillery an octave DOWN.
        const w = window.innerWidth;
        const h = window.innerHeight;
        const octMul = charge > 0.7 ? 0.5 : charge > 0.35 ? 1 : 2;
        const chord = shaderAudio.chordFrom(
          drag.x0 / w, drag.y0 / h, e.clientX / w, e.clientY / h,
          charge > 0.5 ? 4 : 3,
        ).map(f => f * octMul);
        volleySeq++;
        volley = { id: volleySeq, freqs: chord, remaining: 0, landed: 0, cx: 0, cy: 0, t: null };

        // the sim damps velocity at 1.5/s (glide distance = v0/1.5), so
        // launch with the speed whose glide matches the pull: flight
        // distance scales with the stretch and the charge
        const glide = Math.min(2300, stretch * (1.6 + 2.6 * charge));
        const count = 6 + Math.round(charge * 10);
        for (let k = 0; k < count; k++) {
          const a = baseAngle + (Math.random() - 0.5) * (0.7 - 0.35 * charge);
          const s = glide * 1.5 * (0.7 + 0.5 * Math.random());
          spawnSpark(
            e.clientX, e.clientY, Math.cos(a) * s, Math.sin(a) * s,
            undefined, chord[k % chord.length], volleySeq, 0, 1 + holdPower * 1.6,
          );
          volley.remaining++;
        }
        // the drawn stroke ignites: chord-tone sparks rise from along it
        // (step keeps the whole volley within the particle pool)
        const step = Math.max(2, Math.ceil(pathPts.length / 8));
        for (let i = 0; i < pathPts.length; i += step) {
          const pt = pathPts[i];
          spawnSpark(
            pt.x, pt.y,
            (Math.random() - 0.5) * 160,
            -60 - Math.random() * 160,
            1.0 + Math.random() * 0.6,
            chord[(i / step) % chord.length], volleySeq, 0, 1 + holdPower * 1.2,
          );
          volley.remaining++;
        }
        energyTarget = Math.min(1, energyTarget + 0.4 + 0.4 * charge);
        shaderAudio.slingRelease(charge, chord);
        // the tether leaves a ghost wall so waves it already blocked stay
        // blocked after release instead of popping back in
        if (walls.length >= MAX_WALLS - 1) walls.shift();
        walls.push({
          x1: drag.x0, y1: drag.y0, x2: e.clientX, y2: e.clientY,
          born: drag.ts0, die: shaderNow(), vib: 0,
        });
      } else {
        // quick click: on a target it's the glitch absorb, elsewhere a burst
        let hit: { t: TrackedTarget; r: DOMRect } | null = null;
        for (const t of targets) {
          if (t.strength < 0.15) continue;
          const r = t.el.getBoundingClientRect();
          if (e.clientX >= r.left && e.clientX <= r.right
              && e.clientY >= r.top && e.clientY <= r.bottom) {
            hit = { t, r };
            break;
          }
        }
        // holding before release charges the click (first 250ms is free so
        // ordinary clicks stay ordinary); raw held time still shapes depth.
        // The ramp is long — 4s to full power, where the saw turns feral.
        const heldMs = performance.now() - drag.t0;
        const power = Math.min(1, Math.max(0, (heldMs - 250) / 4000));
        if (hit) targetClickFX(hit.t, hit.r);
        else burst(e.clientX, e.clientY, power, heldMs);
      }
    };
    const onCancel = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        touchPts.delete(e.pointerId);
        if (touchPts.size === 0) suppressTouchUp = false;
      }
      drag.held = false;
      shaderAudio.holdCharge(0);
      setDragGuards(false);
      window.removeEventListener('wheel', onWheel);
    };

    // long-press slingshot on touch: for the first ~280ms the browser owns
    // the gesture (scroll cancels the drag via pointercancel); after a
    // still hold we claim it, so dragging becomes the sling, not a scroll
    const onTouchMove = (e: TouchEvent) => {
      if (drag.held && performance.now() - drag.t0 > 280) e.preventDefault();
    };
    if (coarse) window.addEventListener('touchmove', onTouchMove, { passive: false });
    // scrolling keeps the page feeling alive (and resets the idle clock)
    const onScrollEnergy = () => {
      lastEventT = performance.now();
      energyTarget = Math.min(1, energyTarget + 0.08);
    };
    window.addEventListener('scroll', onScrollEnergy, { passive: true });

    // The copy-button payoff: Hero and CopyPrompt dispatch this when the
    // user actually copies — the biggest moment on the page. Triple mega
    // ripple (last one trough-led), a chord-tone spark fountain that rains
    // back onto the button, max flare, and the audio drop.
    const onCopied = (ev: Event) => {
      const { x, y } = (ev as CustomEvent<{ x: number; y: number }>).detail;
      lastEventT = performance.now();
      energyTarget = 1;
      shaderAudio.payoff();
      addShock(x, y, 1.6);
      window.setTimeout(() => addShock(x, y, 1.2), 150);
      window.setTimeout(() => addShock(x, y, -1.0), 300);
      const chord = shaderAudio.currentChord();
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const s = 500 + Math.random() * 500;
        spawnSpark(
          x, y, Math.cos(a) * s, Math.sin(a) * s,
          1.4 + Math.random() * 0.8,
          chord[k % chord.length] * 2, 0, 0.5,
        );
      }
      for (const t of targets) {
        const r = t.el.getBoundingClientRect();
        if (Math.abs(r.left + r.width / 2 - x) < r.width && Math.abs(r.top + r.height / 2 - y) < r.height * 2) {
          t.excite = 1.5;
        }
      }
    };
    window.addEventListener('mdflow:copied', onCopied);

    // ---- Rubber-sheet play (eggo / name): the background joins in ----
    // grab -> a dimple; pulling -> energy climbs and light gathers into the
    // grab; release -> a snap ripple + sparks flung opposite the pull, with
    // a chasing trough on big stretches.
    const onStretch = (ev: Event) => {
      const d = (ev as CustomEvent<{
        phase: 'grab' | 'pull' | 'release';
        x: number; y: number; p: number; dx: number; dy: number;
      }>).detail;
      lastEventT = performance.now();
      if (d.phase === 'grab') {
        addShock(d.x, d.y, 0.3);
      } else if (d.phase === 'pull') {
        energyTarget = Math.min(1, energyTarget + 0.1 + d.p * 0.2);
        const a = Math.random() * Math.PI * 2;
        const r = 110 + Math.random() * 130;
        spawnSpark(
          d.x + Math.cos(a) * r, d.y + Math.sin(a) * r,
          -Math.cos(a) * 300, -Math.sin(a) * 300,
          0.4, 0, 0, 0, 0.7 + d.p,
        );
      } else {
        addShock(d.x, d.y, 0.45 + d.p * 1.0);
        if (d.p > 0.6) window.setTimeout(() => addShock(d.x, d.y, -0.6 * d.p), 120);
        const ang = Math.atan2(-d.dy, -d.dx);
        const note = shaderAudio.chordToneAt(
          d.x / window.innerWidth, d.y / window.innerHeight);
        const count = 4 + Math.round(d.p * 8);
        for (let k = 0; k < count; k++) {
          const a2 = ang + (Math.random() - 0.5) * 0.9;
          const s = (300 + Math.random() * 500) * (0.5 + d.p);
          spawnSpark(d.x, d.y, Math.cos(a2) * s, Math.sin(a2) * s,
            undefined, note, 0, 0.2, 0.8 + d.p);
        }
        energyTarget = Math.min(1, energyTarget + 0.3 + d.p * 0.4);
      }
    };
    window.addEventListener('mdflow:stretch', onStretch);

    // ---- mdflow:fx — the easter-egg layer's remote control ----
    // Small vocabulary of primitives the egg triggers compose: ripples,
    // spark bursts/rain/fountains, screen quakes, lightning columns,
    // vertical sweeps, a temporary gravity flip, and target flares.
    let repelUntil = 0; // gravity-flip: sparks flee targets until this time
    const fxTimers: number[] = [];
    const later = (fn: () => void, ms: number) => {
      fxTimers.push(window.setTimeout(fn, ms));
    };
    const onFx = (ev: Event) => {
      const d = (ev as CustomEvent<Record<string, any>>).detail ?? {};
      lastEventT = performance.now();
      const W = window.innerWidth;
      const H = window.innerHeight;
      switch (d.type) {
        case 'shock':
          addShock(d.x ?? W / 2, d.y ?? H / 2, d.amp ?? 0.6);
          break;
        case 'burst': {
          const n = d.n ?? 10;
          addShock(d.x, d.y, d.amp ?? 0.5);
          for (let k = 0; k < n; k++) {
            const a = (k / n) * Math.PI * 2 + Math.random() * 0.4;
            const s = (d.speed ?? 420) * (0.7 + Math.random() * 0.6);
            spawnSpark(d.x, d.y, Math.cos(a) * s, Math.sin(a) * s, undefined,
              d.freqs ? d.freqs[k % d.freqs.length] : 0, 0, d.grace ?? 0.4, d.size ?? 1);
          }
          break;
        }
        case 'rain': {
          const n = d.n ?? 10;
          for (let k = 0; k < n; k++) {
            later(() => spawnSpark(
              Math.random() * W, -20,
              (Math.random() - 0.5) * 60, 180 + Math.random() * (d.speed ?? 240),
              d.life ?? 2.4, d.freqs ? d.freqs[k % d.freqs.length] : 0, 0, d.grace ?? 1.4, d.size ?? 1,
            ), k * (d.stagger ?? 130));
          }
          break;
        }
        case 'fountain': {
          const n = d.n ?? 14;
          for (let k = 0; k < n; k++) {
            later(() => spawnSpark(
              (d.x ?? W / 2) + (Math.random() - 0.5) * 30, d.y ?? H / 2,
              (Math.random() - 0.5) * 280, -(500 + Math.random() * 420),
              1.6, d.freqs ? d.freqs[k % d.freqs.length] : 0, 0, 0.8, d.size ?? 1.1,
            ), k * 60);
          }
          break;
        }
        case 'quake': {
          for (let k = 0; k < 6; k++) {
            later(() => {
              addShock(Math.random() < 0.5 ? -10 : W + 10, Math.random() * H, 0.5 + Math.random() * 0.5);
              addShock(Math.random() * W, Math.random() < 0.5 ? -10 : H + 10, -(0.4 + Math.random() * 0.4));
            }, k * 160);
          }
          energyTarget = 1;
          break;
        }
        case 'lightning': {
          const x = d.x ?? W / 2;
          for (let k = 0; k < 7; k++) {
            later(() => addShock(x + (Math.random() - 0.5) * 60, (k / 6) * H, k === 6 ? 1.3 : 0.5), k * 40);
          }
          break;
        }
        case 'sweep': {
          const down = d.dir === 'down';
          for (let k = 0; k < 6; k++) {
            later(() => addShock(W / 2, down ? (k / 5) * H : H - (k / 5) * H, 0.55), k * 90);
          }
          break;
        }
        case 'flip':
          repelUntil = performance.now() + (d.ms ?? 5000);
          break;
        case 'excite':
          for (const t of targets) t.excite = 1.5;
          break;
      }
    };
    window.addEventListener('mdflow:fx', onFx);
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onDown, { passive: true });
    window.addEventListener('pointerup', onUp, { passive: true });
    window.addEventListener('pointercancel', onCancel, { passive: true });
    window.addEventListener('mousedown', onShiftMouseDown);
    document.addEventListener('selectstart', onSelectStart);
    document.documentElement.addEventListener('pointerleave', onLeave);

    // ---- Targets: discover, re-scan occasionally in case the DOM changes ----
    let targets: TrackedTarget[] = [];
    let headlineEl: HTMLElement | null = null;
    let creditEl: HTMLElement | null = null;
    let eggEl: HTMLElement | null = null;
    // physical bodies sparks bounce off ([data-shader-bounce="circle"|"rect"]);
    // a body may also carry data-shader-note (the name's letter bumpers do):
    // its index into the pentatonic scale, rung when a spark strikes it
    let bounceEls: { el: HTMLElement; circle: boolean; note: number }[] = [];
    const scan = () => {
      headlineEl = document.querySelector<HTMLElement>('[data-shader-headline]');
      creditEl = document.querySelector<HTMLElement>('[data-shader-credit]');
      // any element works for the ray anchor (the eggo is a <canvas> now)
      eggEl = document.querySelector<HTMLElement>('[data-shader-egg]');
      bounceEls = Array.from(document.querySelectorAll<HTMLElement>('[data-shader-bounce]'))
        .map(el => ({
          el,
          circle: el.dataset.shaderBounce === 'circle',
          note: el.dataset.shaderNote !== undefined
            ? parseInt(el.dataset.shaderNote, 10) : -1,
        }));
      const els = Array.from(document.querySelectorAll<HTMLElement>('[data-shader-target]'));
      targets = els.map(el => {
        const prev = targets.find(t => t.el === el);
        return {
          el,
          priority: Math.min(1, Math.max(0, parseFloat(el.dataset.shaderPriority || '1') || 1)),
          gravity: Math.max(0, parseFloat(el.dataset.shaderGravity || '1') || 1),
          strength: prev ? prev.strength : 0,
          excite: prev ? prev.excite : 0,
          glitch: prev ? prev.glitch : 0,
        };
      });
    };
    scan();

    // Rasterize a region's glyphs into a mask texture. Each character is
    // drawn at its own Range rect, so soft wrapping, kerning, and
    // letter-spacing match the DOM exactly. Coordinates are rect-local, so
    // the mask stays valid while the page scrolls. Text tagged
    // [data-shader-evolve] and img[data-shader-egg] silhouettes go into the
    // red channel (the living-organism layer); everything else is
    // alpha-only (#00ffff keeps red clean).
    const maskCanvas = document.createElement('canvas');
    const maskWidths = [0, 0];
    const rasterizeRegion = (el: HTMLElement | null, tex: WebGLTexture | null, unit: number, slot: number) => {
      if (!el) return;
      const hr = el.getBoundingClientRect();
      if (hr.width < 10 || hr.height < 10) return;
      maskWidths[slot] = hr.width;
      maskCanvas.width = Math.ceil(hr.width * dpr);
      maskCanvas.height = Math.ceil(hr.height * dpr);
      const c2 = maskCanvas.getContext('2d');
      if (!c2) return;
      c2.setTransform(dpr, 0, 0, dpr, 0, 0);
      const range = document.createRange();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.textContent || '';
        const parent = node.parentElement;
        if (!parent || !text.trim()) continue;
        c2.fillStyle = parent.closest('[data-shader-evolve]') ? '#ffffff' : '#00ffff';
        const cs = getComputedStyle(parent);
        // the rim/aurora offsets are ~3px — on small text that reads as a
        // ghost box, so only display-scale lettering joins the mask
        if (parseFloat(cs.fontSize) < 26) continue;
        c2.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const met = c2.measureText('Mg');
        const asc = met.fontBoundingBoxAscent ?? parseFloat(cs.fontSize) * 0.8;
        const desc = met.fontBoundingBoxDescent ?? parseFloat(cs.fontSize) * 0.2;
        for (let i = 0; i < text.length; i++) {
          if (text[i] === ' ' || text[i] === '\n') continue;
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const cr = range.getBoundingClientRect();
          if (cr.width === 0) continue;
          // the line box may be shorter than the em box (leading < 1), so
          // recover the baseline from the box's vertical center
          const baseline = cr.top + (cr.height - (asc + desc)) / 2 + asc;
          c2.fillText(text[i], cr.left - hr.left, baseline - hr.top);
        }
      }
      // eggo (and any tagged image): draw its SILHOUETTE into the red
      // channel — the living layer breathes inside the mark's shape
      for (const img of Array.from(el.querySelectorAll<HTMLImageElement>('img[data-shader-egg]'))) {
        if (!img.complete || !img.naturalWidth) {
          img.addEventListener('load', () => rasterizeRegion(el, tex, unit, slot), { once: true });
          continue;
        }
        const ir = img.getBoundingClientRect();
        const tmp = document.createElement('canvas');
        tmp.width = Math.max(1, Math.ceil(ir.width * dpr));
        tmp.height = Math.max(1, Math.ceil(ir.height * dpr));
        const tc = tmp.getContext('2d');
        if (!tc) continue;
        tc.drawImage(img, 0, 0, tmp.width, tmp.height);
        tc.globalCompositeOperation = 'source-in';
        tc.fillStyle = '#ffffff';
        tc.fillRect(0, 0, tmp.width, tmp.height);
        c2.drawImage(tmp, ir.left - hr.left, ir.top - hr.top, ir.width, ir.height);
      }
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
    };
    const rasterizeAll = () => {
      rasterizeRegion(headlineEl, maskTex, 0, 0);
      rasterizeRegion(creditEl, maskTex2, 1, 1);
    };
    rasterizeAll();
    // the display font swaps in late — redraw the masks once it's ready
    document.fonts?.ready.then(rasterizeAll).catch(() => {});
    window.addEventListener('resize', rasterizeAll);

    const scanAndMask = () => {
      scan();
      // re-rasterize if a region changed size (e.g. breakpoint shift)
      if (headlineEl && Math.abs(headlineEl.getBoundingClientRect().width - maskWidths[0]) > 2) {
        rasterizeRegion(headlineEl, maskTex, 0, 0);
      }
      if (creditEl && Math.abs(creditEl.getBoundingClientRect().width - maskWidths[1]) > 2) {
        rasterizeRegion(creditEl, maskTex2, 1, 1);
      }
    };
    const scanInterval = window.setInterval(scanAndMask, 1000);

    const rectData = new Float32Array(MAX_TARGETS * 4);
    const strengthData = new Float32Array(MAX_TARGETS);
    const exciteData = new Float32Array(MAX_TARGETS);
    const glitchData = new Float32Array(MAX_TARGETS);
    const monData = new Float32Array(MAX_MONSTERS * 4);
    const monPopData = new Float32Array(MAX_MONSTERS * 4);

    let raf = 0;
    let last = performance.now();
    let lastAttractT = 0; // idle guide-comet timer

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      // Nothing but the halos breathe when idle — drop to a third of the
      // rate (20fps). Live particles, ripples, and the trail keep full rate
      // via the flags below.
      frameCount++;
      const idle = now - lastEventT > IDLE_AFTER_MS
        && !anyParticles && !anyShocks && !anyMonsters && !drag.held && trailFade < 0.02
        && !liveSegs.some(s => s.life > 0) // humming walls animate (ghosts don't)
        && targetProx < 0.3;               // groove playing → halo throbs on the beat
      if (idle && frameCount % 3 !== 0) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (dt <= 0) return;

      // touch has no hover: between touches the virtual cursor rests at
      // the viewport's focal point, so SCROLLING drives proximity — halos,
      // the groove, the train, the tremble all build as targets approach it
      if (coarse && !drag.held) {
        mouse.x = window.innerWidth / 2;
        mouse.y = window.innerHeight * 0.42;
      }
      // ease cursor, derive smoothed velocity, decay movement energy
      const k = 1 - Math.exp(-dt * 10);
      smooth.x += (mouse.x - smooth.x) * k;
      smooth.y += (mouse.y - smooth.y) * k;
      const kv = 1 - Math.exp(-dt * 8);
      vel.x += ((smooth.x - prevSmooth.x) / dt - vel.x) * kv;
      vel.y += ((smooth.y - prevSmooth.y) / dt - vel.y) * kv;
      prevSmooth.x = smooth.x;
      prevSmooth.y = smooth.y;
      energyTarget = Math.max(0, energyTarget - dt * 1.2);
      energy += (energyTarget - energy) * (1 - Math.exp(-dt * 6));

      // fast flicks shed sparks from the cursor
      const speed = Math.hypot(vel.x, vel.y);
      if (speed > 900 && shedDist > 70) {
        shedDist = 0;
        spawnSpark(
          smooth.x, smooth.y,
          vel.x * 0.22 + (Math.random() - 0.5) * 240,
          vel.y * 0.22 + (Math.random() - 0.5) * 240,
        );
      }

      // drag tether: smooth its appearance and dribble charging sparks;
      // holding longer keeps charging beyond the stretch alone
      const stretching = drag.held && drag.moved;
      const stretch = stretching ? Math.hypot(smooth.x - drag.x0, smooth.y - drag.y0) : 0;
      const holdBoost = stretching ? Math.min(0.5, (performance.now() - drag.t0) / 8000) : 0;
      const dragCharge = Math.min(1, stretch / CHARGE_RANGE + holdBoost);
      dragActiveSm += ((stretching ? 1 : 0) - dragActiveSm) * (1 - Math.exp(-dt * 16));
      shaderAudio.slingCharge(
        stretching ? dragCharge : 0,
        shaderAudio.noteAt(drag.x0 / window.innerWidth, drag.y0 / window.innerHeight));
      // drive the hum with cursor energy + last frame's target proximity;
      // proximity alone drives the pad/groove build-up
      shaderAudio.tick(speed, Math.min(1, energy * 0.7 + targetProx * 0.7), targetProx);

      // light drawing + harp glissando while stretching
      trailFade += ((stretching ? 1 : 0) - trailFade) * (1 - Math.exp(-dt * (stretching ? 14 : 4)));
      if (stretching) {
        const lastPt = pathPts[pathPts.length - 1];
        if (pathPts.length < MAX_PATH && Math.hypot(smooth.x - lastPt.x, smooth.y - lastPt.y) > 28) {
          pathPts.push({ x: smooth.x, y: smooth.y });
        }
        // X columns = scale run, Y rows = octave arpeggio
        const col = Math.floor((smooth.x / window.innerWidth) * NOTE_COLUMNS);
        const row = Math.floor((smooth.y / window.innerHeight) * NOTE_ROWS);
        if (col !== lastCol || row !== lastRow) {
          lastCol = col;
          lastRow = row;
          shaderAudio.gliss(smooth.x / window.innerWidth, smooth.y / window.innerHeight);
          spawnSpark(
            smooth.x, smooth.y,
            (Math.random() - 0.5) * 120,
            -40 - Math.random() * 100,
            0.45,
          );
        }
      } else if (trailFade < 0.02 && pathPts.length > 0 && !drag.held) {
        pathPts.length = 0;
      }

      // rebuild this frame's wall list: live shift-chain walls (fading over
      // their last 2s), dead ones lingering as invisible ghosts until the
      // ripples they blocked have died, plus the live tether
      const shaderTNow = shaderNow();
      walls = walls.filter(wl => shaderTNow < wl.die + SHOCK_LIFE);
      liveSegs.length = 0;
      for (const wl of walls) {
        wl.vib *= Math.exp(-dt * 3);
        liveSegs.push({
          x1: wl.x1, y1: wl.y1, x2: wl.x2, y2: wl.y2,
          born: wl.born, die: wl.die, vib: wl.vib, w: wl,
          life: shaderTNow < wl.die ? Math.min(1, (wl.die - shaderTNow) / 2) : 0,
        });
      }
      dragVib *= Math.exp(-dt * 3);
      if (stretching && liveSegs.length < MAX_WALLS) {
        liveSegs.push({
          x1: drag.x0, y1: drag.y0, x2: smooth.x, y2: smooth.y,
          born: drag.ts0, die: shaderTNow + 1000, // open-ended while held
          life: 0.55 + 0.45 * dragCharge, vib: dragVib,
        });
      }
      // holding a press without moving charges the click — a dark rumble
      // swells, the anchor pulses harder and faster, and stray energy
      // spirals IN toward the point as the charge builds
      if (drag.held && !drag.moved) {
        const holdP = Math.min(1, Math.max(0, (performance.now() - drag.t0 - 250) / 4000));
        shaderAudio.holdCharge(holdP);
        if (holdP >= 1 && !drag.full) {
          drag.full = true; // puzzle hook: a click held to FULL charge
          window.dispatchEvent(new CustomEvent('mdflow:fullcharge'));
        }
        holdPulseAcc += dt;
        if (holdP > 0 && holdPulseAcc > 0.55 - holdP * 0.35) {
          holdPulseAcc = 0;
          addShock(drag.x0, drag.y0, 0.18 + holdP * 0.45);
          const a = Math.random() * Math.PI * 2;
          const r = 150 + holdP * 160;
          const sp = 320 + holdP * 420;
          spawnSpark(
            drag.x0 + Math.cos(a) * r, drag.y0 + Math.sin(a) * r,
            -Math.cos(a) * sp, -Math.sin(a) * sp,
            0.4, 0, 0, 0, 0.8 + holdP,
          );
          energyTarget = Math.min(1, energyTarget + holdP * 0.35);
        }
      }
      if (stretching && dragCharge > 0.15) {
        dribbleAcc += dt;
        if (dribbleAcc > 0.09) {
          dribbleAcc = 0;
          // short-lived spark drifting along the tether toward the cursor
          const tt = Math.random();
          const sx = drag.x0 + (smooth.x - drag.x0) * tt;
          const sy = drag.y0 + (smooth.y - drag.y0) * tt;
          spawnSpark(
            sx, sy,
            (smooth.x - drag.x0) * 1.2 + (Math.random() - 0.5) * 90,
            (smooth.y - drag.y0) * 1.2 + (Math.random() - 0.5) * 90,
            0.5,
          );
        }
      }

      // measure targets, fade strength by viewport visibility, decay excitement
      const vh = window.innerHeight;
      const measured = targets.map(t => {
        const r = t.el.getBoundingClientRect();
        const visible = r.bottom > -80 && r.top < vh + 80 && r.width > 0 && r.height > 0;
        const goal = visible ? t.priority : 0;
        t.strength += (goal - t.strength) * (1 - Math.exp(-dt * 6));
        t.excite *= Math.exp(-dt * 1.8);
        t.glitch *= Math.exp(-dt * 1.8);
        return { t, r };
      });
      measured.sort((a, b) => b.t.strength - a.t.strength);
      const shown = measured.slice(0, MAX_TARGETS);

      // attract mode: after 9s of stillness a quiet comet sails in from a
      // screen edge and rings the most important visible target — guiding
      // the eye there and demonstrating the dots-seek-the-target mechanic.
      // With no target on screen (top of page, install below the fold), it
      // streaks toward the important one just below the viewport instead,
      // pulling the eye downward.
      if (now - lastEventT > 9000 && now - lastAttractT > 6500) {
        let tgt = shown.length > 0 && shown[0].t.strength > 0.3 ? shown[0] : null;
        if (!tgt) {
          for (const m of measured) {
            if (m.t.priority > 0.8 && m.r.top >= vh && m.r.top < vh + 900) { tgt = m; break; }
          }
        }
        if (tgt) {
          lastAttractT = now;
          const tr = tgt.r;
          const cx = tr.left + tr.width / 2;
          const cy = tr.top + tr.height / 2;
          const sx = Math.random() < 0.5 ? -30 : window.innerWidth + 30;
          const sy = window.innerHeight * (0.15 + Math.random() * 0.55);
          const dist = Math.hypot(cx - sx, cy - sy) || 1;
          // the sim damps velocity at 1.5/s, so total glide ≈ v0/1.5 —
          // launch with exactly the speed whose glide ends at the target:
          // the comet streaks in hot and decelerates to rest on the button
          const v0 = Math.min(2600, dist * 1.5 * 1.15);
          spawnSpark(
            sx, sy,
            ((cx - sx) / dist) * v0, ((cy - sy) / dist) * v0,
            2.6,
            shaderAudio.chordToneAt(
              Math.min(0.99, cx / window.innerWidth),
              Math.min(0.99, cy / window.innerHeight)),
            0, 0.4, 1.5,
          );
        }
      }

      // measure the bounce bodies (eggo mark, per-letter bumpers) — only
      // when sparks are actually alive, so idle frames skip ~14 rect reads.
      // A shared AABB lets each particle reject the whole set in one test.
      const bounceBodies: {
        cx: number; cy: number; hw: number; hh: number; r: number; circle: boolean;
        note: number;
      }[] = [];
      let bbMinX = Infinity, bbMinY = Infinity, bbMaxX = -Infinity, bbMaxY = -Infinity;
      const haveParticles = particles.some(p => p.active);
      if (haveParticles) {
        for (const b of bounceEls) {
          const r = b.el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4 || r.bottom < -40 || r.top > vh + 40) continue;
          bounceBodies.push({
            cx: r.left + r.width / 2,
            cy: r.top + r.height / 2,
            hw: r.width / 2,
            hh: r.height / 2,
            r: Math.max(r.width, r.height) / 2,
            circle: b.circle,
            note: b.note,
          });
          bbMinX = Math.min(bbMinX, r.left);
          bbMinY = Math.min(bbMinY, r.top);
          bbMaxX = Math.max(bbMaxX, r.right);
          bbMaxY = Math.max(bbMaxY, r.bottom);
        }
      }

      // ---- particle physics: swirl + damped pull into the best target ----
      for (const p of particles) {
        if (!p.active) continue;
        p.life -= dt;
        if (p.life <= 0) {
          p.active = false;
          volleySparkResolved(p, false);
          continue;
        }

        let best: { t: TrackedTarget; cx: number; cy: number; hw: number; hh: number } | null = null;
        let bestScore = 0;
        for (const { t, r } of shown) {
          if (t.strength < 0.15) continue;
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const dist = Math.hypot(cx - p.x, cy - p.y);
          const score = t.strength * t.gravity / (140 + dist);
          if (score > bestScore) {
            bestScore = score;
            best = { t, cx, cy, hw: r.width / 2, hh: r.height / 2 };
          }
        }

        if (best) {
          const dx = best.cx - p.x;
          const dy = best.cy - p.y;
          const dist = Math.max(Math.hypot(dx, dy), 1);
          const nx = dx / dist, ny = dy / dist;
          // gravity flip (easter egg): sparks flee the targets instead
          const flip = performance.now() < repelUntil ? -0.7 : 1;
          const pull = 2600 * Math.min(1, best.t.strength) * best.t.gravity * flip;
          // swirl perpendicular to the pull so sparks orbit in, not beeline
          const sw = Math.sin(p.life * 6 + p.seed) * 520;
          p.vx += (nx * pull - ny * sw) * dt;
          p.vy += (ny * pull + nx * sw) * dt;

          // landed on the target: flare it and pop a mini-ripple
          if (p.maxLife - p.life >= p.grace
              && Math.abs(p.x - best.cx) < best.hw + 14 && Math.abs(p.y - best.cy) < best.hh + 14) {
            best.t.excite = Math.min(1.5, best.t.excite + 0.4);
            addShock(p.x, p.y, 0.35);
            if (p.freq > 0) {
              // ring the tone this spark carried (chord tone or click note)
              shaderAudio.ringNote(p.freq);
            } else {
              shaderAudio.chime(best.cx / window.innerWidth, best.cy / window.innerHeight);
            }
            if (volley && p.volleyId === volley.id) {
              volley.cx = best.cx;
              volley.cy = best.cy;
              volley.t = best.t;
            }
            p.active = false;
            volleySparkResolved(p, true);
            continue;
          }
        }

        const damp = Math.exp(-1.5 * dt);
        p.vx *= damp;
        p.vy *= damp;
        const ox = p.x;
        const oy = p.y;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        // walls are physical: sparks bounce off them (bank shots!)
        for (const s of liveSegs) {
          if (s.life <= 0) continue; // ghosts don't bounce
          const rx = p.x - ox, ry = p.y - oy;
          const sx = s.x2 - s.x1, sy = s.y2 - s.y1;
          const den = rx * sy - ry * sx;
          if (Math.abs(den) < 1e-6) continue;
          const tt = ((s.x1 - ox) * sy - (s.y1 - oy) * sx) / den;
          const uu = ((s.x1 - ox) * ry - (s.y1 - oy) * rx) / den;
          if (tt <= 0 || tt >= 1 || uu <= 0 || uu >= 1) continue;
          const wlen = Math.hypot(sx, sy) || 1;
          const nx = -sy / wlen, ny = sx / wlen;
          const vdot = p.vx * nx + p.vy * ny;
          p.vx = (p.vx - 2 * vdot * nx) * 0.75;
          p.vy = (p.vy - 2 * vdot * ny) * 0.75;
          p.x = ox;
          p.y = oy;
          // the wall is a struck string: it rings visually and sounds a
          // note pitched by its length (longer wall = lower note)
          if (s.w) s.w.vib = 1;
          else dragVib = 1;
          const nowHit = performance.now();
          if (nowHit - lastTwangT > 70) {
            lastTwangT = nowHit;
            shaderAudio.twang(shaderAudio.noteAt(
              Math.min(0.95, Math.max(0, 1 - wlen / 1100)), 0.6));
          }
          break;
        }
        // the eggo mark and the name sheet are bumpers: a spark that flew
        // into one this frame reflects off it. Sparks that STARTED inside
        // (e.g. shed by a rubber-sheet stretch) are left alone so they
        // escape instead of rattling around trapped. One AABB test rejects
        // the whole set for sparks nowhere near the credit card.
        if (bounceBodies.length > 0
            && p.x > bbMinX - 4 && p.x < bbMaxX + 4
            && p.y > bbMinY - 4 && p.y < bbMaxY + 4)
        for (const B of bounceBodies) {
          let hit = false;
          const ivx = p.vx, ivy = p.vy; // incoming velocity, pre-reflection
          if (B.circle) {
            if (Math.hypot(p.x - B.cx, p.y - B.cy) >= B.r) continue;
            const dox = ox - B.cx, doy = oy - B.cy;
            const dn = Math.hypot(dox, doy);
            if (dn < B.r) continue; // started inside
            const nx = dox / Math.max(dn, 1), ny = doy / Math.max(dn, 1);
            const vdot = p.vx * nx + p.vy * ny;
            p.vx = (p.vx - 2 * vdot * nx) * 0.75;
            p.vy = (p.vy - 2 * vdot * ny) * 0.75;
            hit = true;
          } else {
            if (Math.abs(p.x - B.cx) >= B.hw || Math.abs(p.y - B.cy) >= B.hh) continue;
            const wasInX = Math.abs(ox - B.cx) < B.hw;
            const wasInY = Math.abs(oy - B.cy) < B.hh;
            if (wasInX && wasInY) continue; // started inside
            if (!wasInX) p.vx = -p.vx * 0.75;
            if (!wasInY) p.vy = -p.vy * 0.75;
            hit = true;
          }
          if (hit) {
            p.x = ox;
            p.y = oy;
            // the rubber sheet takes the hit: StretchySheet listens and
            // dents its mesh at the impact point, along the incoming path
            window.dispatchEvent(new CustomEvent('mdflow:sparkhit', {
              detail: {
                x: ox, y: oy, vx: ivx, vy: ivy,
                p: Math.min(1, Math.hypot(ivx, ivy) / 900),
              },
            }));
            const nowHit = performance.now();
            if (B.note >= 0) {
              // the name is a glockenspiel: each letter bumper rings its own
              // scale step (in the groove's key). Same-letter rattles are
              // throttled, but a NEW letter always sounds, so a dot skating
              // across "John Lindquist" plays an actual melodic run.
              if (B.note !== lastLetterNote || nowHit - lastLetterT > 90) {
                lastLetterT = nowHit;
                lastLetterNote = B.note;
                addShock(p.x, p.y, 0.14);
                shaderAudio.letterPing(B.note);
              }
            } else if (nowHit - lastBounceFxT > 90) {
              lastBounceFxT = nowHit;
              addShock(p.x, p.y, 0.14);
              // bigger bumper = deeper boing (the eggo thunks)
              shaderAudio.twang(B.circle ? 180 : 300);
            }
            break;
          }
        }
      }

      // ---- pixel monsters: spawn, swim, herd, flee, dissolve ----
      const nowMs = performance.now();
      if (nowMs > nextMonsterAt && !document.hidden) {
        nextMonsterAt = nowMs + 35000 + Math.random() * 35000;
        spawnMonster();
      }
      for (let i = monsters.length - 1; i >= 0; i--) {
        const mn = monsters[i];
        if (mn.pop > 0) {
          // captured: the shader dissolves it; fade the light out under it
          mn.pop = Math.min(1, mn.pop + dt * 1.3);
          mn.alive = Math.max(0, mn.alive - dt * 1.1);
          if (mn.pop >= 1 && mn.alive <= 0.01) monsters.splice(i, 1);
          continue;
        }
        if (!mn.fleeing && nowMs > mn.dieAt) {
          mn.fleeing = true;
          mn.fade = 0;
          shaderAudio.monsterFlee(mn.seed);
        }
        mn.alive += (mn.fade - mn.alive) * (1 - Math.exp(-dt * (mn.fleeing ? 2.5 : 4)));
        if (mn.fleeing && mn.alive <= 0.02) {
          monsters.splice(i, 1);
          continue;
        }
        // wander: the heading drifts and the creature paddles along it
        mn.wander += (Math.random() - 0.5) * dt * 4;
        mn.vx += Math.cos(mn.wander) * 260 * dt;
        mn.vy += Math.sin(mn.wander) * 260 * dt;
        // shy: it slips away from the cursor, so pointing never catches it
        const dc = Math.hypot(mn.x - smooth.x, mn.y - smooth.y);
        if (dc < 240) {
          const push = (1 - dc / 240) * 950 * dt;
          mn.vx += ((mn.x - smooth.x) / Math.max(dc, 1)) * push;
          mn.vy += ((mn.y - smooth.y) / Math.max(dc, 1)) * push;
        }
        const W = window.innerWidth;
        const H = window.innerHeight;
        if (mn.fleeing) {
          // bolts for the nearest side and phases out
          mn.vx += (mn.x < W / 2 ? -1 : 1) * 700 * dt;
        } else {
          // soft walls keep it on the page while it lives
          const mrg = 60;
          if (mn.x < mrg) mn.vx += (mrg - mn.x) * 8 * dt;
          if (mn.x > W - mrg) mn.vx -= (mn.x - (W - mrg)) * 8 * dt;
          if (mn.y < mrg) mn.vy += (mrg - mn.y) * 8 * dt;
          if (mn.y > H - mrg) mn.vy -= (mn.y - (H - mrg)) * 8 * dt;
        }
        const mdamp = Math.exp(-2.2 * dt);
        mn.vx *= mdamp;
        mn.vy *= mdamp;
        const mox = mn.x;
        const moy = mn.y;
        mn.x += mn.vx * dt;
        mn.y += mn.vy * dt;
        // drawn walls pen it in — the creature reflects off light barriers,
        // so shift+click walls HERD it toward the shape you're closing
        for (const s of liveSegs) {
          if (s.life <= 0) continue;
          const rx = mn.x - mox, ry = mn.y - moy;
          const sx = s.x2 - s.x1, sy = s.y2 - s.y1;
          const den = rx * sy - ry * sx;
          if (Math.abs(den) < 1e-6) continue;
          const tt = ((s.x1 - mox) * sy - (s.y1 - moy) * sx) / den;
          const uu = ((s.x1 - mox) * ry - (s.y1 - moy) * rx) / den;
          if (tt <= 0 || tt >= 1 || uu <= 0 || uu >= 1) continue;
          const wlen = Math.hypot(sx, sy) || 1;
          const nx = -sy / wlen, ny = sx / wlen;
          const vdot = mn.vx * nx + mn.vy * ny;
          mn.vx -= 2 * vdot * nx;
          mn.vy -= 2 * vdot * ny;
          mn.x = mox;
          mn.y = moy;
          if (s.w) s.w.vib = 1;
          else dragVib = 1;
          break;
        }
        // idle chirps — each creature speaks its own scale degree
        if (nowMs > mn.chirpAt && mn.alive > 0.5) {
          mn.chirpAt = nowMs + 4000 + Math.random() * 6000;
          shaderAudio.monsterChirp(mn.seed);
        }
      }
      anyMonsters = monsters.length > 0;

      // ---- pack uniforms ----
      rectData.fill(0);
      strengthData.fill(0);
      exciteData.fill(0);
      glitchData.fill(0);
      targetProx = 0;
      let bestProxIdx = -1;
      let bestCx = 0;
      let bestCy = 0;
      let trembleGoal = 0;
      let wcx = 0;
      let wcy = 0;
      for (let i = 0; i < shown.length; i++) {
        const { t, r } = shown[i];
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        // hovering the workshop button: the whole wave field gets nervous
        if (t.el.dataset.shaderTarget === 'workshop'
            && smooth.x >= r.left && smooth.x <= r.right
            && smooth.y >= r.top && smooth.y <= r.bottom) {
          trembleGoal = 1;
          wcx = cx;
          wcy = cy;
        }
        rectData[i * 4 + 0] = cx * dpr;
        rectData[i * 4 + 1] = canvas.height - cy * dpr;
        rectData[i * 4 + 2] = (r.width / 2) * dpr;
        rectData[i * 4 + 3] = (r.height / 2) * dpr;
        strengthData[i] = t.strength;
        exciteData[i] = t.excite;
        glitchData[i] = Math.min(1, t.glitch);
        const prox = t.strength * (1 - Math.min(1, Math.hypot(smooth.x - cx, smooth.y - cy) / 900));
        if (prox > targetProx) {
          targetProx = prox;
          bestProxIdx = i;
          bestCx = cx;
          bestCy = cy;
        }
      }
      // the groove's kick throbs the halo of the target driving it, and
      // every drum hit radiates its own ripple from that target — kicks
      // lead with a crest (orange), snares with a trough (blue)
      const hits = shaderAudio.consumeHits();
      if (bestProxIdx >= 0) {
        exciteData[bestProxIdx] = Math.min(2, exciteData[bestProxIdx] + shaderAudio.beatPulse());
        for (const type of hits) {
          addShock(bestCx, bestCy, type === 'kick' ? 0.45 : -0.4);
        }
        // the button you're approaching picks the tune: its own drums and
        // bassline take over at the next bar line
        shaderAudio.setGrooveStyle(shown[bestProxIdx].t.el.dataset.shaderTarget || '');
      }
      // anticipation: while hovering the workshop button, every live ripple
      // shivers (u_tremble) — and the button keeps pumping fresh ripples out
      // so there is always a wavefront trembling on screen
      tremble += (trembleGoal - tremble) * (1 - Math.exp(-dt * 10));
      if (trembleGoal > 0) {
        hoverRippleAcc += dt;
        if (hoverRippleAcc > 0.65) {
          hoverRippleAcc = 0;
          addShock(wcx, wcy, 0.35);
        }
      } else {
        hoverRippleAcc = 0.5; // primed: the first ripple fires right away
      }

      // compact active particles to the front so the shader can break early
      partData.fill(0);
      let np = 0;
      for (let i = 0; i < MAX_PARTICLES; i++) {
        const p = particles[i];
        if (!p.active) continue;
        // quick fade-in, slow fade-out
        const heat = Math.min(1, p.life / 0.5) * Math.min(1, (p.maxLife - p.life) / 0.08);
        if (heat <= 0.003) continue;
        partData[np * 4 + 0] = p.x * dpr;
        partData[np * 4 + 1] = canvas.height - p.y * dpr;
        partData[np * 4 + 2] = p.size;
        partData[np * 4 + 3] = heat;
        np++;
      }
      anyParticles = np > 0;

      // compact live shockwaves the same way
      const shaderT = shaderNow();
      shockUpload.fill(0);
      let ns = 0;
      for (let i = 0; i < MAX_SHOCKS; i++) {
        const amp = shockData[i * 4 + 3];
        if (Math.abs(amp) <= 0.001 || shaderT - shockData[i * 4 + 2] > SHOCK_LIFE) continue;
        shockUpload[ns * 4 + 0] = shockData[i * 4 + 0];
        shockUpload[ns * 4 + 1] = shockData[i * 4 + 1];
        shockUpload[ns * 4 + 2] = shockData[i * 4 + 2];
        shockUpload[ns * 4 + 3] = amp;
        ns++;
      }
      anyShocks = ns > 0;

      gl.uniform1f(uTime, shaderT);
      gl.uniform2f(uMouse, smooth.x * dpr, canvas.height - smooth.y * dpr);
      gl.uniform2f(uVel, vel.x * dpr, -vel.y * dpr);
      gl.uniform1f(uEnergy, energy);
      gl.uniform4fv(uRect, rectData);
      gl.uniform1fv(uStrength, strengthData);
      gl.uniform1fv(uExcite, exciteData);
      gl.uniform1fv(uGlitch, glitchData);
      wallData.fill(0);
      wallLifeData.fill(0);
      wallSpanData.fill(0);
      for (let i = 0; i < Math.min(liveSegs.length, MAX_WALLS); i++) {
        const s = liveSegs[i];
        wallData[i * 4 + 0] = s.x1 * dpr;
        wallData[i * 4 + 1] = canvas.height - s.y1 * dpr;
        wallData[i * 4 + 2] = s.x2 * dpr;
        wallData[i * 4 + 3] = canvas.height - s.y2 * dpr;
        wallLifeData[i] = s.life;
        wallVibData[i] = s.vib;
        wallSpanData[i * 2 + 0] = s.born;
        wallSpanData[i * 2 + 1] = s.die;
      }
      gl.uniform4fv(uWall, wallData);
      gl.uniform1fv(uWallLife, wallLifeData);
      gl.uniform1fv(uWallVib, wallVibData);
      gl.uniform2fv(uWallSpan, wallSpanData);
      // headline aurora rect (zeros hide it when scrolled away)
      let hcx = 0, hcy = 0, hhw = 0, hhh = 0;
      if (headlineEl) {
        const hr = headlineEl.getBoundingClientRect();
        if (hr.bottom > -60 && hr.top < vh + 60 && hr.width > 0) {
          hcx = (hr.left + hr.width / 2) * dpr;
          hcy = canvas.height - (hr.top + hr.height / 2) * dpr;
          hhw = (hr.width / 2) * dpr;
          hhh = (hr.height / 2) * dpr;
        }
      }
      gl.uniform4f(uHeadline, hcx, hcy, hhw, hhh);
      // crafted-by credit rect + eggo mark center/radius (zeros hide both)
      let ccx = 0, ccy = 0, chw = 0, chh = 0;
      let ex = 0, ey = 0, er = 0;
      if (creditEl) {
        const cr2 = creditEl.getBoundingClientRect();
        if (cr2.bottom > -60 && cr2.top < vh + 60 && cr2.width > 0) {
          ccx = (cr2.left + cr2.width / 2) * dpr;
          ccy = canvas.height - (cr2.top + cr2.height / 2) * dpr;
          chw = (cr2.width / 2) * dpr;
          chh = (cr2.height / 2) * dpr;
          if (eggEl) {
            const ir = eggEl.getBoundingClientRect();
            ex = (ir.left + ir.width / 2) * dpr;
            ey = canvas.height - (ir.top + ir.height / 2) * dpr;
            er = (Math.max(ir.width, ir.height) / 2) * dpr;
          }
        }
      }
      gl.uniform4f(uCredit, ccx, ccy, chw, chh);
      gl.uniform3f(uEgg, ex, ey, er);
      gl.uniform4fv(uShock, shockUpload);
      gl.uniform4fv(uPart, partData);
      gl.uniform4f(uDrag, drag.x0 * dpr, canvas.height - drag.y0 * dpr, dragCharge, dragActiveSm);
      pathData.fill(0);
      for (let i = 0; i < Math.min(pathPts.length, MAX_PATH); i++) {
        pathData[i * 4 + 0] = pathPts[i].x * dpr;
        pathData[i * 4 + 1] = canvas.height - pathPts[i].y * dpr;
        pathData[i * 4 + 2] = 1;
      }
      gl.uniform4fv(uPath, pathData);
      gl.uniform1f(uTrailFade, trailFade);
      gl.uniform1f(uTremble, tremble);
      monData.fill(0);
      monPopData.fill(0);
      for (let i = 0; i < Math.min(monsters.length, MAX_MONSTERS); i++) {
        const mn = monsters[i];
        // gentle bob so even a resting creature treads water
        const bob = Math.sin(shaderT * 1.8 + mn.seed * 31) * 5;
        monData[i * 4 + 0] = mn.x * dpr;
        monData[i * 4 + 1] = canvas.height - (mn.y + bob) * dpr;
        monData[i * 4 + 2] = mn.size;
        monData[i * 4 + 3] = mn.seed;
        monPopData[i * 4 + 0] = mn.alive;
        monPopData[i * 4 + 1] = mn.pop;
        monPopData[i * 4 + 2] = mn.seed * 0.9 + 0.05; // hue
        monPopData[i * 4 + 3] = mn.seed * 40;         // wobble phase
      }
      gl.uniform4fv(uMon, monData);
      gl.uniform4fv(uMonPop, monPopData);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(scanInterval);
      window.removeEventListener('resize', resize);
      window.removeEventListener('resize', rasterizeAll);
      document.documentElement.classList.remove('shader-fx');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('mousedown', onShiftMouseDown);
      document.removeEventListener('selectstart', onSelectStart);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('mdflow:copied', onCopied);
      window.removeEventListener('mdflow:stretch', onStretch);
      window.removeEventListener('mdflow:fx', onFx);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('scroll', onScrollEnergy);
      for (const id of fxTimers) window.clearTimeout(id);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      setDragGuards(false);
      // Do NOT lose the context here: getContext() returns the same context
      // after a StrictMode re-mount, and a lost one never comes back.
      gl.deleteProgram(program);
      gl.deleteShader(vert);
      gl.deleteShader(frag);
      gl.deleteBuffer(buf);
      gl.deleteTexture(maskTex);
      gl.deleteTexture(maskTex2);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="fixed inset-0 w-full h-full z-[5] pointer-events-none mix-blend-screen"
    />
  );
};
