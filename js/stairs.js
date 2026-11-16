// Stairs: step counts from the floor height, the layout of straight, L and U stairs, and the
// plan symbol. A stair is drawn from its bottom corner along the direction of travel.
//
// A stair record: { id, x, y, rot, side, width, shape, turn, rise, maxRiser, tread,
//   risers (null = auto), split (null = auto), gap }
//   x, y   bottom corner, on the line it was drawn along
//   rot    direction of travel up the first flight, in degrees (screen angle, y down)
//   side   'right' or 'left': which side of the drawn line the stair's width is on
//   shape  'straight', 'L' or 'U'; turn: 'right' or 'left' for L and U
//   rise   floor-to-floor height; maxRiser and tread are the step limits
//   split  treads before the landing (L and U); gap is the space between U flights
//   upper  how the part beyond the break line shows: past it on the lower floor, below it on the
//          upper floor. 'dashed' (outline only, see-through, so walls and items under it show and
//          can be clicked), 'shown' (solid like the rest), or 'hidden' (left out)
//   goes   'up' or 'down': the floor it connects to from the floor it was drawn on. x, y and rot
//          always describe it from the bottom, whichever floor it belongs to.
(function (root) {
  const FP = (root.FP = root.FP || {});

  const UPPER = ['dashed', 'shown', 'hidden'];
  const DEFAULTS = {
    width: 36, shape: 'straight', turn: 'right', side: 'right', rise: 108, maxRiser: 7.75, tread: 10,
    risers: null, split: null, gap: 0, upper: 'dashed', goes: 'up',
  };
  const CUT_HEIGHT = 48; // plans are cut about 4' above the floor

  const num = (v, d) => (Number.isFinite(v) ? v : d);

  // Fills in and limits a stair's settings.
  const MAX_RISERS = 400;

  function clean(raw) {
    const s = { ...DEFAULTS, ...raw };
    s.x = num(s.x, 0); s.y = num(s.y, 0); s.rot = ((num(s.rot, 0) % 360) + 360) % 360;
    s.width = Math.min(1200, Math.max(12, num(s.width, DEFAULTS.width)));
    s.rise = Math.min(1200, Math.max(6, num(s.rise, DEFAULTS.rise)));
    s.maxRiser = Math.min(60, Math.max(3, num(s.maxRiser, DEFAULTS.maxRiser)));
    s.tread = Math.min(240, Math.max(4, num(s.tread, DEFAULTS.tread)));
    s.gap = Math.min(240, Math.max(0, num(s.gap, 0)));
    s.shape = ['straight', 'L', 'U'].includes(s.shape) ? s.shape : 'straight';
    s.turn = s.turn === 'left' ? 'left' : 'right';
    s.side = s.side === 'left' ? 'left' : 'right';
    s.risers = Number.isFinite(s.risers) && s.risers >= 2 ? Math.min(MAX_RISERS, Math.round(s.risers)) : null;
    s.split = Number.isFinite(s.split) && s.split >= 1 ? Math.min(MAX_RISERS, Math.round(s.split)) : null;
    s.upper = UPPER.includes(s.upper) ? s.upper : 'dashed';
    s.goes = s.goes === 'down' ? 'down' : 'up';
    return s;
  }

  // Risers, treads and the split between flights.
  function counts(s) {
    const risers = Math.min(MAX_RISERS, s.risers || Math.max(2, Math.ceil(s.rise / s.maxRiser - 1e-9)));
    const riserHeight = s.rise / risers;
    const landing = s.shape !== 'straight';
    // The top riser steps onto the floor above; a landing takes one tread's place.
    const treads = Math.max(landing ? 2 : 1, risers - 1 - (landing ? 1 : 0));
    let first = treads;
    let second = 0;
    if (landing) {
      first = Math.min(treads - 1, Math.max(1, s.split || Math.ceil(treads / 2)));
      second = treads - first;
    }
    return { risers, riserHeight, treads, first, second, landing };
  }

  // The stair laid out in its own frame: u along the first flight, v to the right of travel.
  function layout(s) {
    const c = counts(s);
    const W = s.width, t = s.tread;
    const v0 = s.side === 'right' ? 0 : -W;
    const L1 = c.first * t, L2 = c.second * t;
    const right = s.turn === 'right';
    const flights = [{ s: [0, v0], d: [1, 0], a: [0, 1], n: c.first, start: 0 }];
    let landing = null;
    let path;
    const mid = v0 + W / 2;
    if (s.shape === 'straight') {
      path = [[0, mid], [L1, mid]];
    } else if (s.shape === 'L') {
      landing = [[L1, v0], [L1 + W, v0], [L1 + W, v0 + W], [L1, v0 + W]];
      const lu = L1 + W / 2;
      if (right) {
        flights.push({ s: [L1, v0 + W], d: [0, 1], a: [1, 0], n: c.second, start: c.first + 1 });
        path = [[0, mid], [lu, mid], [lu, v0 + W + L2]];
      } else {
        flights.push({ s: [L1, v0], d: [0, -1], a: [1, 0], n: c.second, start: c.first + 1 });
        path = [[0, mid], [lu, mid], [lu, v0 - L2]];
      }
    } else {
      const lu = L1 + W / 2;
      if (right) {
        landing = [[L1, v0], [L1 + W, v0], [L1 + W, v0 + 2 * W + s.gap], [L1, v0 + 2 * W + s.gap]];
        const v2 = v0 + W + s.gap;
        flights.push({ s: [L1, v2], d: [-1, 0], a: [0, 1], n: c.second, start: c.first + 1 });
        path = [[0, mid], [lu, mid], [lu, v2 + W / 2], [L1 - L2, v2 + W / 2]];
      } else {
        landing = [[L1, v0 - W - s.gap], [L1 + W, v0 - W - s.gap], [L1 + W, v0 + W], [L1, v0 + W]];
        const v2 = v0 - W - s.gap;
        flights.push({ s: [L1, v2], d: [-1, 0], a: [0, 1], n: c.second, start: c.first + 1 });
        path = [[0, mid], [lu, mid], [lu, v2 + W / 2], [L1 - L2, v2 + W / 2]];
      }
    }
    return { c, W, t, flights, landing, path };
  }

  // Turns the frame into plan coordinates.
  function toPlan(s) {
    const r = (s.rot * Math.PI) / 180;
    const ux = Math.cos(r), uy = Math.sin(r);
    return ([u, v]) => ({ x: s.x + ux * u - uy * v, y: s.y + uy * u + ux * v });
  }

  // Everything needed to draw, select and measure a stair, in plan coordinates.
  function geometry(raw) {
    const s = clean(raw);
    const L = layout(s);
    const P = toPlan(s);
    const add = (p, q, k) => [p[0] + q[0] * k, p[1] + q[1] * k];
    const flights = L.flights.map((f) => {
      const len = f.n * L.t;
      const corners = [f.s, add(f.s, f.d, len), add(add(f.s, f.d, len), f.a, L.W), add(f.s, f.a, L.W)].map(P);
      const treads = [];
      for (let k = 0; k <= f.n; k++) {
        const p = add(f.s, f.d, k * L.t);
        // Tread k's nosing; numbered along the whole stair, counting the landing as one.
        treads.push({ index: f.start + k, a: P(p), b: P(add(p, f.a, L.W)) });
      }
      return { corners, treads, n: f.n, frame: f };
    });
    const landing = L.landing ? L.landing.map(P) : null;
    const path = L.path.map(P);
    // How many treads are below the cut, and where the break line crosses the stair.
    const below = Math.max(1, Math.min(L.c.treads - 1, Math.ceil(CUT_HEIGHT / L.c.riserHeight) - 1));
    let cut = null;
    L.flights.forEach((f, i) => {
      if (cut) return;
      // A cut that falls on the landing moves to the first tread after it.
      const index = Math.max(below, f.start);
      if (index < f.start + f.n) {
        const lean = Math.min(L.W * 0.35, L.t * 1.5, (f.n * L.t) / 2);
        // The slanted line stays within the flight rather than reaching onto a landing.
        const at = Math.min(Math.max((index - f.start + 0.5) * L.t, lean), f.n * L.t - lean);
        // A point that is surely on the lower side: the middle of the flight's bottom edge.
        const low = P(add(f.s, f.a, L.W / 2));
        cut = { a: P(add(f.s, f.d, at - lean)), b: P(add(add(f.s, f.d, at + lean), f.a, L.W)), index, flight: i, low };
      }
    });
    const polys = flights.map((f) => f.corners);
    if (landing) polys.push(landing);
    // The parts below and past the cut. The cut's flight is split along the break line;
    // flights and the landing before it are below, those after it are past it.
    let lowerPolys = polys, upperPolys = [], lowerPath = path, upperPath = path, lowerSide = null;
    if (cut) {
      // Signed distance from the break line, positive on the lower side.
      const len = Math.hypot(cut.b.x - cut.a.x, cut.b.y - cut.a.y) || 1;
      const side = (p) => ((cut.b.x - cut.a.x) * (p.y - cut.a.y) - (cut.b.y - cut.a.y) * (p.x - cut.a.x)) / len;
      const lowSign = Math.sign(side(cut.low)) || 1;
      lowerSide = (p) => side(p) * lowSign;
      lowerPolys = [];
      upperPolys = [];
      flights.forEach((f, i) => {
        if (i < cut.flight) lowerPolys.push(f.corners);
        else if (i > cut.flight) upperPolys.push(f.corners);
        else {
          lowerPolys.push(clipHalf(f.corners, lowerSide));
          upperPolys.push(clipHalf(f.corners, (p) => -lowerSide(p)));
        }
      });
      if (landing) (cut.flight >= 1 ? lowerPolys : upperPolys).push(landing);
      // The walking line split where it crosses the break line.
      lowerPath = [path[0]];
      for (let k = 1; k < path.length; k++) {
        const p = path[k - 1], q = path[k];
        const sp = lowerSide(p), sq = lowerSide(q);
        if (sp >= 0 && sq < 0) {
          const t = sp / (sp - sq);
          const m = { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
          lowerPath.push(m);
          upperPath = [m, ...path.slice(k)];
          break;
        }
        lowerPath.push(q);
      }
    }
    const run = L.c.first * L.t + (L.landing ? L.W : 0);
    return { s, counts: L.c, flights, landing, path, lowerPath, upperPath, lowerSide, cut, polys, lowerPolys, upperPolys, run, top: path[path.length - 1], bottom: path[0] };
  }

  // The part of a convex polygon where keep(p) >= 0.
  function clipHalf(poly, keep) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const kp = keep(p), kq = keep(q);
      if (kp >= 0) out.push(p);
      if ((kp >= 0) !== (kq >= 0)) {
        const t = kp / (kp - kq);
        out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      }
    }
    return out;
  }

  function pointInPoly(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  // The near side of the break line, seen from the floor below ('up') or above ('down').
  const nearPolys = (g, mode) => (!g.cut || g.s.upper === 'shown' ? g.polys : mode === 'down' ? g.upperPolys : g.lowerPolys);

  // The solid part of a stair on its own floor: what selects it, and what hides things under it.
  // With the part beyond the break line shown solid, that's the whole stair.
  function contains(st, p) {
    const g = geometry(st);
    return nearPolys(g, g.s.goes === 'down' ? 'down' : 'up').some((poly) => pointInPoly(p, poly));
  }

  // Draws the plan symbol. mode 'up' is the stair's own floor; 'down' is the floor above,
  // where the same stair is seen from the top. o.upper overrides the stair's own `upper`.
  function draw(R, st, o) {
    o = o || {};
    const g = geometry(st);
    const c = R.ctx;
    const ink = o.color || R.colors.ink;
    const down = o.mode === 'down';
    const upper = !g.cut ? 'shown' : (o.upper || g.s.upper);
    // Seen from below, the far side of the break line is past it; seen from above, below it.
    const far = down ? g.lowerPolys : g.upperPolys;
    const solid = upper === 'shown' ? g.polys : down ? g.upperPolys : g.lowerPolys;
    const ghost = upper === 'dashed' ? far : [];
    const dash = [R.px(4), R.px(3)];
    const onCut = (p) => g.lowerSide && Math.abs(g.lowerSide(p)) < 1e-6;
    // Polygon edges, leaving out the straight edge along the break line, which has its own zigzag.
    const edges = (poly) => {
      c.beginPath();
      poly.forEach((p, i) => {
        const q = poly[(i + 1) % poly.length];
        if (upper !== 'shown' && onCut(p) && onCut(q)) return;
        c.moveTo(p.x, p.y);
        c.lineTo(q.x, q.y);
      });
      c.stroke();
    };
    // A line split at the break line: [below, past], either of which may be null.
    const split = (a, b) => {
      if (!g.lowerSide) return [[a, b], null];
      const sa = g.lowerSide(a), sb = g.lowerSide(b);
      if (sa >= 0 && sb >= 0) return [[a, b], null];
      if (sa < 0 && sb < 0) return [null, [a, b]];
      const t = sa / (sa - sb);
      const m = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      return sa >= 0 ? [[a, m], [m, b]] : [[m, b], [a, m]];
    };
    const segment = (s) => { if (!s) return; c.beginPath(); c.moveTo(s[0].x, s[0].y); c.lineTo(s[1].x, s[1].y); c.stroke(); };
    R.world();
    c.save();
    c.globalAlpha = o.alpha == null ? 1 : o.alpha;
    c.lineJoin = 'round';
    c.fillStyle = R.colors.paper;
    for (const poly of solid) {
      c.beginPath();
      poly.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      c.closePath();
      c.fill();
    }
    c.strokeStyle = ink;
    c.lineWidth = R.px(1.6);
    for (const poly of solid) edges(poly);
    c.lineWidth = R.px(1.2);
    c.setLineDash(dash);
    for (const poly of ghost) edges(poly);
    c.setLineDash([]);
    c.lineWidth = R.px(1);
    for (const f of g.flights) {
      for (const tr of f.treads.slice(1, -1)) {
        // The near side of the break line solid; the far side dashed, or left out when hidden.
        const [lo, hi] = split(tr.a, tr.b);
        const [nearSeg, farSeg] = down ? [hi, lo] : [lo, hi];
        c.setLineDash([]);
        segment(nearSeg);
        if (upper !== 'hidden') { c.setLineDash(dash); segment(farSeg); }
      }
    }
    c.setLineDash([]);
    if (g.cut) {
      // Break line with a zigzag in the middle.
      const { a, b } = g.cut;
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len, z = Math.min(4, len * 0.08);
      c.lineWidth = R.px(1.4);
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.lineTo(m.x - ux * z, m.y - uy * z);
      c.lineTo(m.x - uy * z * 1.4, m.y + ux * z * 1.4);
      c.lineTo(m.x + uy * z * 1.4, m.y - ux * z * 1.4);
      c.lineTo(m.x + ux * z, m.y + uy * z);
      c.lineTo(b.x, b.y);
      c.stroke();
    }
    // Direction arrow along the walking line, from where you start to where you're going.
    const shown = upper === 'hidden' ? (down ? g.upperPath : g.lowerPath) : g.path;
    const path = down ? shown.slice().reverse() : shown;
    c.lineWidth = R.px(1.2);
    c.beginPath();
    path.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
    c.stroke();
    const end = path[path.length - 1], prev = path[path.length - 2];
    const ang = Math.atan2(end.y - prev.y, end.x - prev.x);
    const head = Math.min(6, g.s.width * 0.18);
    c.fillStyle = ink;
    c.beginPath();
    c.moveTo(end.x, end.y);
    c.lineTo(end.x - Math.cos(ang - 0.4) * head, end.y - Math.sin(ang - 0.4) * head);
    c.lineTo(end.x - Math.cos(ang + 0.4) * head, end.y - Math.sin(ang + 0.4) * head);
    c.closePath();
    c.fill();
    const startP = path[0];
    c.beginPath();
    c.arc(startP.x, startP.y, Math.min(1.6, head * 0.3), 0, Math.PI * 2);
    c.fill();
    c.restore();
    // UP or DN beside the start of the arrow, set back from the edge.
    const next = path[1];
    const back = Math.atan2(next.y - startP.y, next.x - startP.x);
    const tx = startP.x + Math.cos(back) * Math.min(10, g.s.tread * 0.9);
    const ty = startP.y + Math.sin(back) * Math.min(10, g.s.tread * 0.9);
    const side = 9 * R.unit;
    FP.render.tagText(R, down ? 'DN' : 'UP', R.sx(tx) - Math.sin(back) * side, R.sy(ty) + Math.cos(back) * side, back, ink, 10, 700);
  }

  FP.stairs = { DEFAULTS, UPPER, CUT_HEIGHT, clean, counts, geometry, contains, draw, pointInPoly };
})(globalThis);
