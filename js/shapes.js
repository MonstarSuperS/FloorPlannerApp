// Drawn shapes: lines, polylines, rectangles, circles and ellipses, and arcs, for custom furniture
// and anything else drawn to scale. Lengths are inches, like the rest of the plan.
//
//   line:    { kind: 'line', a: {x, y}, b: {x, y} }
//   poly:    { kind: 'poly', pts: [{x, y}...], closed }
//   rect:    { kind: 'rect', x, y, w, d, rot, r }      centre, width, depth, turn (degrees), corner radius
//   ellipse: { kind: 'ellipse', x, y, w, d, rot, circle } a circle keeps w === d
//   arc:     { kind: 'arc', a, b, m }                  start, end, and the point halfway along it
//
// Style, on every shape: stroke (null follows the theme's ink colour, or '#rrggbb'), weight (line
// width in screen pixels), dash ('solid' | 'dashed' | 'dotted'), fill (null, 'paper' for the
// background colour so it hides what's under it, or '#rrggbb'), fillAlpha (0 to 1).
(function (root) {
  const FP = (root.FP = root.FP || {});
  const G = FP.geom;

  const TAU = Math.PI * 2;
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;

  const NAMES = { line: 'Line', poly: 'Polyline', rect: 'Rectangle', ellipse: 'Ellipse', arc: 'Arc' };
  const WEIGHTS = [[0.75, 'Fine'], [1.25, 'Normal'], [2, 'Medium'], [3, 'Bold'], [5, 'Heavy']];
  const DASHES = { solid: [], dashed: [7, 4], dotted: [0.5, 3.5] };
  const DEFAULT_STYLE = { stroke: null, weight: 1.25, dash: 'solid', fill: null, fillAlpha: 1 };
  const HEX = /^#[0-9a-f]{6}$/i;

  const boxed = (s) => s.kind === 'rect' || s.kind === 'ellipse';
  const isClosed = (s) => boxed(s) || (s.kind === 'poly' && !!s.closed);
  const nameOf = (s) => (s.kind === 'ellipse' && s.circle ? 'Circle' : s.kind === 'poly' && s.closed ? 'Polygon' : NAMES[s.kind] || 'Shape');

  // A boxed shape's local point (from its centre, before turning) in plan coordinates.
  function toWorld(s, lx, ly) {
    const r = rad(s.rot || 0), cos = Math.cos(r), sin = Math.sin(r);
    return { x: s.x + lx * cos - ly * sin, y: s.y + lx * sin + ly * cos };
  }
  function toLocal(s, p) {
    const r = rad(s.rot || 0), dx = p.x - s.x, dy = p.y - s.y;
    return { x: dx * Math.cos(r) + dy * Math.sin(r), y: -dx * Math.sin(r) + dy * Math.cos(r) };
  }

  // ---------- Arcs ----------

  // The circle through three points, or null when they're in line.
  function circleThrough(a, b, c) {
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-9) return null;
    const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
    const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
    const y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
    return { x, y, r: Math.hypot(a.x - x, a.y - y) };
  }

  // An arc's circle, start angle and sweep (radians; positive turns the way angles increase).
  // Null when its points are in line or too nearly so to draw as an arc.
  function arcGeom(s) {
    const c = circleThrough(s.a, s.m, s.b);
    if (!c || c.r > 1e5) return null;
    const ang = (p) => Math.atan2(p.y - c.y, p.x - c.x);
    const norm = (v) => ((v % TAU) + TAU) % TAU;
    const a0 = ang(s.a);
    const toEnd = norm(ang(s.b) - a0), toMid = norm(ang(s.m) - a0);
    const sweep = toMid <= toEnd ? toEnd : toEnd - TAU;
    return { c: { x: c.x, y: c.y }, r: c.r, a0, sweep };
  }

  const arcAt = (g, t) => ({ x: g.c.x + g.r * Math.cos(g.a0 + g.sweep * t), y: g.c.y + g.r * Math.sin(g.a0 + g.sweep * t) });

  // The point halfway along the arc from a to b that bulges through p, or null if they're in line.
  function arcMid(a, b, p) {
    const g = arcGeom({ a, b, m: p });
    return g ? arcAt(g, 0.5) : null;
  }

  // ---------- Drawing ----------

  // Adds the shape's outline to the current path, in plan coordinates.
  function path(c, s) {
    if (s.kind === 'line') { c.moveTo(s.a.x, s.a.y); c.lineTo(s.b.x, s.b.y); return; }
    if (s.kind === 'poly') {
      s.pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      if (s.closed) c.closePath();
      return;
    }
    if (s.kind === 'rect') {
      c.save();
      c.translate(s.x, s.y);
      c.rotate(rad(s.rot || 0));
      const r = Math.min(s.r || 0, s.w / 2, s.d / 2);
      if (r > 0 && c.roundRect) c.roundRect(-s.w / 2, -s.d / 2, s.w, s.d, r);
      else c.rect(-s.w / 2, -s.d / 2, s.w, s.d);
      c.restore();
      return;
    }
    if (s.kind === 'ellipse') {
      const start = toWorld(s, s.w / 2, 0); // so the ellipse doesn't join onto anything before it
      c.moveTo(start.x, start.y);
      c.ellipse(s.x, s.y, s.w / 2, s.d / 2, rad(s.rot || 0), 0, TAU);
      return;
    }
    if (s.kind === 'arc') {
      const g = arcGeom(s);
      if (!g) { c.moveTo(s.a.x, s.a.y); c.lineTo(s.b.x, s.b.y); return; }
      c.moveTo(s.a.x, s.a.y);
      c.arc(g.c.x, g.c.y, g.r, g.a0, g.a0 + g.sweep, g.sweep < 0);
    }
  }

  // o: { color, alpha, weight, noFill }
  function draw(R, s, o) {
    o = o || {};
    const c = R.ctx;
    R.world();
    c.save();
    if (o.alpha != null) c.globalAlpha = o.alpha;
    c.beginPath();
    path(c, s);
    if (s.fill && isClosed(s) && !o.noFill) {
      c.save();
      c.globalAlpha *= s.fillAlpha == null ? 1 : s.fillAlpha;
      c.fillStyle = s.fill === 'paper' ? R.colors.paper : s.fill;
      c.fill();
      c.restore();
    }
    const weight = o.weight || s.weight || DEFAULT_STYLE.weight;
    const dash = DASHES[s.dash] || [];
    // Dashes grow with the line so a heavy dashed line still reads as dashed.
    const k = Math.max(1, weight / 1.25);
    c.setLineDash(dash.map((v) => R.px(v * k)));
    c.lineCap = s.dash === 'dotted' ? 'round' : 'butt';
    c.lineJoin = 'round';
    c.lineWidth = R.px(weight);
    c.strokeStyle = o.color || s.stroke || R.colors.ink;
    c.stroke();
    c.restore();
  }

  // ---------- Measuring ----------

  // Points that bound the shape, for boxes and selection.
  function outlinePoints(s) {
    if (s.kind === 'line') return [s.a, s.b];
    if (s.kind === 'poly') return s.pts;
    if (s.kind === 'rect') return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => toWorld(s, (a * s.w) / 2, (b * s.d) / 2));
    if (s.kind === 'ellipse') {
      const r = rad(s.rot || 0), cos = Math.cos(r), sin = Math.sin(r);
      const hx = Math.hypot((s.w / 2) * cos, (s.d / 2) * sin), hy = Math.hypot((s.w / 2) * sin, (s.d / 2) * cos);
      return [{ x: s.x - hx, y: s.y - hy }, { x: s.x + hx, y: s.y + hy }];
    }
    if (s.kind === 'arc') {
      const g = arcGeom(s);
      const out = [s.a, s.b];
      if (!g) return out;
      // The circle's extremes that the arc passes through.
      for (let q = 0; q < 4; q++) {
        const a = (q * Math.PI) / 2;
        const t = (((a - g.a0) * Math.sign(g.sweep)) % TAU + TAU) % TAU;
        if (t <= Math.abs(g.sweep)) out.push({ x: g.c.x + g.r * Math.cos(a), y: g.c.y + g.r * Math.sin(a) });
      }
      return out;
    }
    return [];
  }

  function bounds(s) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of outlinePoints(s)) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    return minX === Infinity ? null : { minX, minY, maxX, maxY };
  }

  function boundsOf(list) {
    let b = null;
    for (const s of list) {
      const k = bounds(s);
      if (!k) continue;
      b = b ? { minX: Math.min(b.minX, k.minX), minY: Math.min(b.minY, k.minY), maxX: Math.max(b.maxX, k.maxX), maxY: Math.max(b.maxY, k.maxY) } : k;
    }
    return b;
  }

  // How far a point is from the shape's outline.
  function outlineDistance(s, p) {
    if (s.kind === 'line') return G.distToSegment(p, s.a, s.b);
    if (s.kind === 'poly') {
      let best = Infinity;
      const n = s.pts.length;
      for (let i = 0; i < n - 1 + (s.closed ? 1 : 0); i++) best = Math.min(best, G.distToSegment(p, s.pts[i], s.pts[(i + 1) % n]));
      return best;
    }
    if (s.kind === 'rect') {
      const l = toLocal(s, p);
      const dx = Math.abs(l.x) - s.w / 2, dy = Math.abs(l.y) - s.d / 2;
      return dx > 0 || dy > 0 ? Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) : Math.min(-dx, -dy);
    }
    if (s.kind === 'ellipse') {
      const l = toLocal(s, p);
      const k = Math.hypot(l.x / (s.w / 2), l.y / (s.d / 2));
      if (k < 1e-9) return Math.min(s.w, s.d) / 2;
      const r = Math.hypot(l.x, l.y);
      return Math.abs(r - r / k);
    }
    if (s.kind === 'arc') {
      const g = arcGeom(s);
      if (!g) return G.distToSegment(p, s.a, s.b);
      const a = Math.atan2(p.y - g.c.y, p.x - g.c.x);
      const t = (((a - g.a0) * Math.sign(g.sweep)) % TAU + TAU) % TAU;
      if (t <= Math.abs(g.sweep)) return Math.abs(G.dist(p, g.c) - g.r);
      return Math.min(G.dist(p, s.a), G.dist(p, s.b));
    }
    return Infinity;
  }

  function contains(s, p) {
    if (s.kind === 'rect') { const l = toLocal(s, p); return Math.abs(l.x) <= s.w / 2 && Math.abs(l.y) <= s.d / 2; }
    if (s.kind === 'ellipse') { const l = toLocal(s, p); return (l.x / (s.w / 2)) ** 2 + (l.y / (s.d / 2)) ** 2 <= 1; }
    if (s.kind === 'poly' && s.closed) {
      let inside = false;
      for (let i = 0, j = s.pts.length - 1; i < s.pts.length; j = i++) {
        const a = s.pts[i], b = s.pts[j];
        if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
      return inside;
    }
    return false;
  }

  // Length along the outline.
  function length(s) {
    if (s.kind === 'line') return G.dist(s.a, s.b);
    if (s.kind === 'poly') {
      let n = 0;
      for (let i = 1; i < s.pts.length; i++) n += G.dist(s.pts[i - 1], s.pts[i]);
      return s.closed && s.pts.length > 2 ? n + G.dist(s.pts[s.pts.length - 1], s.pts[0]) : n;
    }
    if (s.kind === 'arc') { const g = arcGeom(s); return g ? g.r * Math.abs(g.sweep) : G.dist(s.a, s.b); }
    return 0;
  }

  // Points other things snap to, and dimensions attach to: { pt, x, y, ang }. `ang` is the
  // shape's turn, so a dimension can tell when the shape has been turned.
  function snapPoints(s) {
    const out = [];
    const push = (pt, p, ang) => out.push({ pt, x: p.x, y: p.y, ang });
    if (s.kind === 'line') {
      const ang = deg(Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x));
      push('e0', s.a, ang); push('e1', s.b, ang);
      push('mid', { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 }, ang);
    } else if (s.kind === 'poly') {
      const p0 = s.pts[0], p1 = s.pts[1] || p0;
      const ang = deg(Math.atan2(p1.y - p0.y, p1.x - p0.x));
      const n = s.pts.length;
      s.pts.forEach((p, i) => push(`v${i}`, p, ang));
      for (let i = 0; i < n - 1 + (s.closed && n > 2 ? 1 : 0); i++) {
        const a = s.pts[i], b = s.pts[(i + 1) % n];
        push(`s${i}`, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, ang);
      }
    } else if (s.kind === 'rect') {
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([a, b], k) => push(`c${k}`, toWorld(s, (a * s.w) / 2, (b * s.d) / 2), s.rot || 0));
      [[0, -1], [1, 0], [0, 1], [-1, 0]].forEach(([a, b], k) => push(`m${k}`, toWorld(s, (a * s.w) / 2, (b * s.d) / 2), s.rot || 0));
      push('ctr', s, s.rot || 0);
    } else if (s.kind === 'ellipse') {
      push('ctr', s, s.rot || 0);
      [[0, -1], [1, 0], [0, 1], [-1, 0]].forEach(([a, b], k) => push(`q${k}`, toWorld(s, (a * s.w) / 2, (b * s.d) / 2), s.rot || 0));
    } else if (s.kind === 'arc') {
      const ang = deg(Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x));
      push('e0', s.a, ang); push('e1', s.b, ang); push('mid', s.m, ang);
      const g = arcGeom(s);
      if (g) push('ctr', g.c, ang);
    }
    return out;
  }

  // What a snap point is called, for the marker shown while snapping.
  function pointName(s, pt) {
    if (pt === 'ctr') return 'Centre';
    if (pt === 'mid' || pt[0] === 's' || pt[0] === 'm') return 'Midpoint';
    if (pt[0] === 'q') return 'Quadrant';
    if (pt[0] === 'e') return 'End';
    return 'Corner';
  }

  // ---------- Moving, scaling and turning ----------

  // Sets `s` to `from` (an earlier copy of it) carried through `map`. With o.sx/o.sy sizes
  // scale too; with o.by it turns that many degrees.
  function place(s, from, map, o) {
    o = o || {};
    if (s.kind === 'line') { s.a = map(from.a); s.b = map(from.b); return; }
    if (s.kind === 'poly') { s.pts = from.pts.map(map); return; }
    if (s.kind === 'arc') {
      s.a = map(from.a); s.b = map(from.b);
      const m = map(from.m);
      // Stretching moves the halfway point off the middle; put it back.
      s.m = (o.sx && Math.abs(o.sx - o.sy) > 1e-9 && arcMid(s.a, s.b, m)) || m;
      return;
    }
    const c = map(from);
    s.x = c.x; s.y = c.y;
    if (o.sx) {
      const r = rad(from.rot || 0), cos = Math.cos(r), sin = Math.sin(r);
      s.w = Math.max(0.1, from.w * Math.hypot(cos * o.sx, sin * o.sy));
      s.d = Math.max(0.1, from.d * Math.hypot(sin * o.sx, cos * o.sy));
      if (s.kind === 'rect' && from.r) s.r = from.r * Math.min(o.sx, o.sy);
      if (s.circle && Math.abs(s.w - s.d) > 1e-6) delete s.circle;
    }
    if (o.by) s.rot = (((from.rot || 0) + o.by) % 360 + 360) % 360;
  }

  function translate(s, dx, dy) {
    place(s, JSON.parse(JSON.stringify(s)), (p) => ({ x: p.x + dx, y: p.y + dy }));
  }

  // ---------- Files ----------

  const LIMIT = 1e6; // inches; further out is damage, not a drawing
  const fin = (v) => Number.isFinite(v) && Math.abs(v) <= LIMIT;
  const point = (p) => p && fin(p.x) && fin(p.y);
  const pos = (v) => fin(v) && v > 0;

  // A shape from a file, repaired, or null if it can't be used.
  function clean(raw) {
    if (!raw || typeof raw !== 'object' || !NAMES[raw.kind]) return null;
    const out = { id: typeof raw.id === 'string' && raw.id && raw.id.length <= 200 ? raw.id : null, kind: raw.kind };
    if (raw.kind === 'line') {
      if (!point(raw.a) || !point(raw.b)) return null;
      Object.assign(out, { a: { x: raw.a.x, y: raw.a.y }, b: { x: raw.b.x, y: raw.b.y } });
    } else if (raw.kind === 'poly') {
      const pts = Array.isArray(raw.pts) ? raw.pts.slice(0, 10000).filter(point).map((p) => ({ x: p.x, y: p.y })) : [];
      if (pts.length < 2) return null;
      Object.assign(out, { pts, closed: raw.closed === true && pts.length > 2 });
    } else if (raw.kind === 'arc') {
      if (!point(raw.a) || !point(raw.b) || !point(raw.m)) return null;
      Object.assign(out, { a: { x: raw.a.x, y: raw.a.y }, b: { x: raw.b.x, y: raw.b.y }, m: { x: raw.m.x, y: raw.m.y } });
      if (!arcGeom(out)) return null;
    } else {
      if (!fin(raw.x) || !fin(raw.y) || !pos(raw.w) || !pos(raw.d)) return null;
      Object.assign(out, { x: raw.x, y: raw.y, w: raw.w, d: raw.d, rot: fin(raw.rot) ? ((raw.rot % 360) + 360) % 360 : 0 });
      if (raw.kind === 'rect') out.r = pos(raw.r) ? raw.r : 0;
      if (raw.kind === 'ellipse' && raw.circle === true) { out.circle = true; out.d = out.w; }
    }
    Object.assign(out, cleanStyle(raw));
    if (raw.locked === true) out.locked = true;
    if (typeof raw.group === 'string' && raw.group && raw.group.length <= 200) out.group = raw.group;
    return out;
  }

  function cleanStyle(raw) {
    return {
      stroke: HEX.test(raw.stroke || '') ? raw.stroke : null,
      weight: Number.isFinite(raw.weight) ? Math.min(10, Math.max(0.25, raw.weight)) : DEFAULT_STYLE.weight,
      dash: DASHES[raw.dash] ? raw.dash : 'solid',
      fill: raw.fill === 'paper' || HEX.test(raw.fill || '') ? raw.fill : null,
      fillAlpha: Number.isFinite(raw.fillAlpha) ? Math.min(1, Math.max(0, raw.fillAlpha)) : 1,
    };
  }

  // ---------- Furniture library ----------

  const clone = (x) => JSON.parse(JSON.stringify(x));

  // A library piece from drawn shapes: copies centred on (0, 0), with its overall size.
  function toPiece(name, shapes) {
    const b = boundsOf(shapes);
    if (!b) return null;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const out = shapes.map((s) => {
      const c = clone(s);
      delete c.id; delete c.group; delete c.locked;
      translate(c, -cx, -cy);
      return c;
    });
    return { name, shapes: out, w: b.maxX - b.minX, d: b.maxY - b.minY };
  }

  // A library piece from a file, or null.
  function cleanPiece(raw) {
    if (!raw || typeof raw.id !== 'string' || !raw.id || !Array.isArray(raw.shapes)) return null;
    const shapes = raw.shapes.slice(0, 2000).map((s) => clean({ ...s, id: 'x' })).filter(Boolean).map((s) => { delete s.id; delete s.group; delete s.locked; return s; });
    if (!shapes.length) return null;
    const b = boundsOf(shapes);
    return { id: raw.id.slice(0, 200), name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 100) : 'Furniture', shapes, w: b.maxX - b.minX, d: b.maxY - b.minY };
  }

  // Copies of a piece's shapes centred at `at`, with fresh ids.
  function fromPiece(piece, at, uid) {
    return piece.shapes.map((s) => {
      const c = clone(s);
      translate(c, at.x, at.y);
      c.id = uid('sh');
      return c;
    });
  }

  FP.shapes = {
    NAMES, WEIGHTS, DASHES, DEFAULT_STYLE, nameOf, boxed, isClosed, toWorld, toLocal,
    circleThrough, arcGeom, arcMid, path, draw, outlinePoints, bounds, boundsOf, outlineDistance, contains, length,
    snapPoints, pointName, place, translate, clean, cleanStyle, toPiece, cleanPiece, fromPiece,
  };
})(globalThis);
