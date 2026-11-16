// Draws a floor to any 2D context. The same code serves the live canvas and all exports.
// R holds the mapping: scale is device pixels per inch, and unit multiplies line widths and
// fonts (1 on screen, more for high-resolution export).
(function (root) {
  const FP = (root.FP = root.FP || {});
  const G = FP.geom;

  // Light is also what every export uses, since plans print on white paper.
  const PALETTES = {
    light: {
      paper: '#ffffff', grid: '#e7eaef', gridMajor: '#cfd5de', axis: '#a9b3c1',
      exterior: '#47505e', interior: '#98a2b0', wallEdge: '#1e2530',
      ink: '#1e2530', soft: '#5d6775', length: '#26558f', dim: '#a3341f', guide: '#0b7f83', above: '#7b4bc4',
      newWork: '#1f8f4e', demo: '#d0342c',
      halo: 'rgba(255,255,255,0.92)',
      fixInk: '#2b323c', fixSoft: '#7c8694', fixFill: '#ffffff', fixTint: '#eef1f5',
    },
    dark: {
      paper: '#171b21', grid: '#232931', gridMajor: '#343c48', axis: '#596473',
      exterior: '#bcc4cf', interior: '#747f8d', wallEdge: '#e4e8ee',
      ink: '#e4e8ee', soft: '#a2acba', length: '#86b6f5', dim: '#f2937e', guide: '#4fd1d5', above: '#b896ff',
      newWork: '#4cc97a', demo: '#ff6b5e',
      halo: 'rgba(23,27,33,0.92)',
      fixInk: '#d5dbe3', fixSoft: '#8d97a5', fixFill: '#222830', fixTint: '#2e3640',
    },
  };
  const ROOM_TINTS = [[66, 133, 180], [214, 158, 72], [96, 164, 120], [176, 112, 160], [204, 110, 92], [110, 120, 190]];

  // On screen, labels shrink as the plan is zoomed out, down to TEXT_MIN of their size, so they
  // keep to the drawing; past that, a label that doesn't fit its room, wall or dimension line is
  // left out until you zoom in (R.fit). Exports keep full-size text and every label.
  const TEXT_FULL_AT = 2; // screen pixels per inch at which labels are full size
  const TEXT_MIN = 0.7;
  const textScale = (pxPerIn) => Math.max(TEXT_MIN, Math.min(1, pxPerIn / TEXT_FULL_AT));

  // R.text: label size multiplier. R.fit: leave out labels with no room for them.
  function makeR(ctx, scale, ox, oy, unit, colors) {
    const R = {
      ctx, scale, ox, oy, unit, text: 1, fit: false,
      colors: colors || PALETTES.light,
      world() { ctx.setTransform(scale, 0, 0, scale, ox, oy); },
      screen() { ctx.setTransform(1, 0, 0, 1, 0, 0); },
      sx: (x) => x * scale + ox,
      sy: (y) => y * scale + oy,
      px: (n) => (n * unit) / scale, // a screen thickness expressed in inches
    };
    return R;
  }

  // Grid steps in inches. Metric grids step in mm (5 mm up to 50 m) with major lines at a metre.
  const MM = 1 / 25.4;
  const GRID_STEPS = {
    imperial: { minor: [0.25, 0.5, 1, 2, 3, 6, 12, 24, 60, 120, 240, 600, 1200, 2400], major: [12, 60, 120, 240, 600, 1200, 2400, 4800] },
    metric: { minor: [1, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000].map((v) => v * MM), major: [1000, 5000, 10000, 20000, 50000, 100000].map((v) => v * MM) },
  };

  function drawGrid(R, width, height, gridSize, units) {
    const c = R.ctx;
    const pxPerIn = R.scale / R.unit;
    const steps = GRID_STEPS[FP.units.isMetric(units) ? 'metric' : 'imperial'];
    const last = (a) => a[a.length - 1];
    const minor = steps.minor.find((s) => s >= gridSize - 1e-9 && s * pxPerIn >= 8) || last(steps.minor);
    const major = steps.major.find((s) => s > minor + 1e-9 && s * pxPerIn >= 40) || last(steps.major);
    if (minor * pxPerIn < 2) return; // zoomed out too far for a grid
    const x0 = -R.ox / R.scale, y0 = -R.oy / R.scale;
    const x1 = x0 + width / R.scale, y1 = y0 + height / R.scale;
    const lines = (step, color, lw) => {
      c.beginPath();
      for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
        const sx = Math.round(R.sx(x)) + 0.5;
        c.moveTo(sx, 0); c.lineTo(sx, height);
      }
      for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
        const sy = Math.round(R.sy(y)) + 0.5;
        c.moveTo(0, sy); c.lineTo(width, sy);
      }
      c.strokeStyle = color;
      c.lineWidth = lw;
      c.stroke();
    };
    R.screen();
    lines(minor, R.colors.grid, R.unit);
    lines(major, R.colors.gridMajor, R.unit);
    c.beginPath();
    c.moveTo(R.ox, 0); c.lineTo(R.ox, height);
    c.moveTo(0, R.oy); c.lineTo(width, R.oy);
    c.strokeStyle = R.colors.axis;
    c.lineWidth = R.unit;
    c.stroke();
  }

  // Paints room areas into a small image. Colour runs slightly under the walls so the
  // pixel edge is always hidden by the crisp wall drawn on top.
  function roomImage(detected) {
    if (!detected.rooms.length || typeof document === 'undefined') return null;
    const { w, h, labels, rooms } = detected;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const c = canvas.getContext('2d');
    const img = c.createImageData(w, h);
    const colorIndex = new Map();
    rooms.forEach((r, i) => colorIndex.set(r.label, ROOM_TINTS[i % ROOM_TINTS.length]));
    const paint = (i, tint) => {
      img.data[i * 4] = tint[0];
      img.data[i * 4 + 1] = tint[1];
      img.data[i * 4 + 2] = tint[2];
      img.data[i * 4 + 3] = 34;
    };
    for (let i = 0; i < labels.length; i++) {
      const tint = colorIndex.get(labels[i]);
      if (tint) paint(i, tint);
    }
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] !== -1) continue;
      const near = [i - 1, i + 1, i - w, i + w].map((k) => colorIndex.get(labels[k])).find(Boolean);
      if (near) paint(i, near);
    }
    c.putImageData(img, 0, 0);
    return canvas;
  }

  function wallPath(c, poly) {
    c.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) c.lineTo(poly[i].x, poly[i].y);
    c.closePath();
  }

  function drawWalls(R, floor, geo) {
    const c = R.ctx;
    R.world();
    c.lineJoin = 'miter';
    // Outlines first at double width, fills on top: only the outer edge of the merged shape shows.
    c.beginPath();
    for (const j of geo.joins.values()) wallPath(c, j.poly);
    c.strokeStyle = R.colors.wallEdge;
    c.lineWidth = R.px(2.4);
    c.stroke();
    for (const type of ['interior', 'exterior']) {
      c.beginPath();
      for (const w of floor.walls) {
        const j = geo.joins.get(w.id);
        if (j && w.type === type) wallPath(c, j.poly);
      }
      c.fillStyle = type === 'exterior' ? R.colors.exterior : R.colors.interior;
      c.fill();
    }
    c.lineJoin = 'round';
  }

  // Opening glyph, in world coordinates. f: wall frame. op: { kind, d, width, flipHinge, flipSwing, panels }
  function drawOpening(R, f, op, opts) {
    const c = R.ctx;
    const color = (opts && opts.color) || R.colors.ink;
    const w = op.width;
    const at = (along, perp) => ({
      x: f.a.x + f.u.x * along + f.ns.x * perp,
      y: f.a.y + f.u.y * along + f.ns.y * perp,
    });
    const line = (p, q) => { c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(q.x, q.y); c.stroke(); };
    const s = op.d - w / 2, e = op.d + w / 2, t = f.t;
    const pad = R.px(1.5);
    c.setLineDash([]);
    c.beginPath();
    wallPath(c, [at(s, -pad), at(e, -pad), at(e, t + pad), at(s, t + pad)]);
    c.fillStyle = R.colors.paper;
    c.fill();
    c.strokeStyle = color;
    c.lineCap = 'butt';
    const thin = R.px(1), medium = R.px(1.4), thick = R.px(2.2);
    c.lineWidth = medium;
    line(at(s, 0), at(s, t));
    line(at(e, 0), at(e, t));

    if (op.kind === 'window') {
      c.lineWidth = thin;
      line(at(s, 0), at(e, 0));
      line(at(s, t), at(e, t));
      c.lineWidth = medium;
      line(at(s, t * 0.38), at(e, t * 0.38));
      line(at(s, t * 0.62), at(e, t * 0.62));
      return;
    }

    if (op.kind === 'slider') {
      // Frame lines on both faces, and two glass panels on their own tracks, overlapping in the
      // middle. The sliding panel runs on the ref-face track (inside, for a traced exterior
      // wall); flipHinge puts it on the other half.
      c.lineWidth = thin;
      line(at(s, 0), at(e, 0));
      line(at(s, t), at(e, t));
      const half = Math.min(0.75, t * 0.12);
      const lap = Math.min(2, w * 0.04);
      const panel = (lo, hi, perp) => {
        c.beginPath();
        wallPath(c, [at(lo, perp - half), at(hi, perp - half), at(hi, perp + half), at(lo, perp + half)]);
        c.fillStyle = R.colors.paper;
        c.fill();
        c.lineWidth = medium;
        c.stroke();
        c.lineWidth = thin;
        line(at(lo, perp), at(hi, perp));
      };
      const left = [s, op.d + lap], right = [op.d - lap, e];
      const [fixed, sliding] = op.flipHinge ? [left, right] : [right, left];
      panel(fixed[0], fixed[1], t * 0.64);
      panel(sliding[0], sliding[1], t * 0.36);
      return;
    }

    // A doorless (cased) opening is just the gap and its jambs.
    if (op.kind === 'cased') return;

    if (op.kind === 'pocket') {
      // The pocket is a dashed cavity inside the wall; the panel is shown partly slid out of it.
      const mid = t / 2;
      const half = Math.min(0.7, t * 0.2);
      const cavity = half + Math.min(0.5, t * 0.1);
      const rect = (lo, hi, h) => { c.beginPath(); wallPath(c, [at(lo, mid - h), at(hi, mid - h), at(hi, mid + h), at(lo, mid + h)]); };
      for (const p of FP.model.pocketSpans(op)) {
        rect(p.lo, p.hi, cavity);
        c.fillStyle = R.colors.paper;
        c.fill();
        c.lineWidth = thin;
        c.setLineDash([R.px(3), R.px(2.5)]);
        c.stroke();
        c.setLineDash([]);
        const shift = (p.hi - p.lo) * 0.35 * p.out;
        rect(p.lo + shift, p.hi + shift, half);
        c.fill();
        c.lineWidth = medium;
        c.stroke();
      }
      return;
    }

    const toFar = !!op.flipSwing;
    const face = toFar ? t : 0;
    const out = toFar ? 1 : -1; // perp direction the door opens toward

    if (op.kind === 'bifold') {
      c.lineWidth = medium;
      const zig = (from, to) => {
        const span = Math.abs(to - from);
        const depth = Math.min(span * 0.42, 14);
        c.beginPath();
        const p0 = at(from, face), p1 = at((from + to) / 2, face + out * depth), p2 = at(to, face);
        c.moveTo(p0.x, p0.y); c.lineTo(p1.x, p1.y); c.lineTo(p2.x, p2.y);
        c.stroke();
      };
      if ((op.panels || 1) >= 2) { zig(s, op.d); zig(e, op.d); }
      else if (op.flipHinge) zig(e, s);
      else zig(s, e);
      return;
    }

    const hinge = op.flipHinge ? -1 : 1;
    const pivotAlong = op.d + (hinge * w) / 2;
    const pivot = at(pivotAlong, face);
    const open = at(pivotAlong, face + out * w);
    const shut = at(pivotAlong - hinge * w, face);
    c.lineWidth = op.kind === 'door_ext' ? thick : medium;
    line(pivot, open);
    c.lineWidth = thin;
    const a1 = Math.atan2(open.y - pivot.y, open.x - pivot.x);
    const a2 = Math.atan2(shut.y - pivot.y, shut.x - pivot.x);
    let delta = a2 - a1;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    c.beginPath();
    c.arc(pivot.x, pivot.y, w, a1, a2, delta < 0);
    c.stroke();
    if (op.kind === 'door_ext') {
      c.lineWidth = thin;
      line(at(s, 0), at(e, 0));
      line(at(s, t), at(e, t));
    }
  }

  function drawFixture(R, fx, opts) {
    const c = R.ctx;
    R.world();
    c.save();
    c.translate(fx.x, fx.y);
    c.rotate((fx.rot * Math.PI) / 180);
    if (opts && opts.alpha != null) c.globalAlpha = opts.alpha;
    FP.fixtures.drawSymbol(c, fx.kind, fx.w, fx.d, R.px(1.1), R.colors);
    c.restore();
  }

  // Screen-space text centred at a point, rotated to stay readable.
  const labelFont = (R, sizePx, weight) => `${weight || 500} ${sizePx * R.unit * R.text}px system-ui, sans-serif`;

  // How wide a label will be on screen, in canvas pixels.
  function textWidth(R, text, sizePx, weight) {
    const c = R.ctx;
    c.save();
    c.font = labelFont(R, sizePx, weight);
    const w = c.measureText(text).width;
    c.restore();
    return w;
  }

  // With R.fit, each label claims its space on screen (R.taken) as it's drawn, and a later one
  // that would overlap it is left out. drawPlan draws the most useful first: room names, then
  // text, dimensions, wall lengths and construction lines. Returns whether there was room.
  function claim(R, sx, sy, w, h, angle) {
    if (!R.taken) return true;
    const cos = Math.abs(Math.cos(angle)), sin = Math.abs(Math.sin(angle));
    const pad = 1.5 * R.unit;
    const box = { hw: (cos * w + sin * h) / 2 + pad, hh: (sin * w + cos * h) / 2 + pad, x: sx, y: sy };
    for (const t of R.taken) {
      if (Math.abs(t.x - box.x) < t.hw + box.hw && Math.abs(t.y - box.y) < t.hh + box.hh) return false;
    }
    R.taken.push(box);
    return true;
  }

  function tagText(R, text, sx, sy, angle, color, sizePx, weight) {
    if (R.taken && !claim(R, sx, sy, textWidth(R, text, sizePx, weight), sizePx * R.unit * R.text * 1.15, angle)) return false;
    const c = R.ctx;
    R.screen();
    c.save();
    c.translate(sx, sy);
    let a = angle;
    if (a > Math.PI / 2 || a <= -Math.PI / 2) a += Math.PI;
    c.rotate(a);
    c.font = labelFont(R, sizePx, weight);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineJoin = 'round';
    c.lineWidth = 3.5 * R.unit * R.text;
    c.strokeStyle = R.colors.halo;
    c.strokeText(text, 0, 0);
    c.fillStyle = color;
    c.fillText(text, 0, 0);
    c.restore();
    return true;
  }

  function drawWallLengths(R, floor, geo, o) {
    const idx = geo.idx;
    const fmt = (v) => FP.units.format(v, o.units);
    const gap = 11 * R.unit * R.text;
    // A label sits in the longest clear stretch of its face, so partitions don't run through it.
    const clearSpot = (wall, len, face) => {
      const stops = floor.nodes
        .filter((n) => n.host && n.host.wallId === wall.id && n.host.face === face)
        .map((n) => n.host.d)
        .sort((p, q) => p - q);
      let best = len / 2, width = -1, from = 0;
      for (const d of [...stops, len]) {
        if (d - from > width) { width = d - from; best = (from + d) / 2; }
        from = d;
      }
      return { at: best, width };
    };
    // With R.fit, a length is only shown where there's room along the wall for it.
    const fits = (text, stretch) => !R.fit || textWidth(R, text, 11) + 6 * R.unit * R.text <= stretch * R.scale;
    for (const w of floor.walls) {
      const j = geo.joins.get(w.id);
      if (!j) continue;
      const f = G.wallFrame(w, idx);
      if (f.len * R.scale < 34 * R.unit) continue;
      const angle = Math.atan2(f.u.y, f.u.x);
      if (w.type === 'exterior' && !o.bothFaces) {
        // Outside the building, clear of fixtures. It still reads the inside-face length.
        if (!fits(fmt(f.len), f.len)) continue;
        const out = G.add(G.add(f.a, G.mul(f.u, f.len / 2)), G.mul(f.ns, f.t));
        tagText(R, fmt(f.len), R.sx(out.x) + f.ns.x * gap, R.sy(out.y) + f.ns.y * gap, angle, R.colors.length, 11);
        continue;
      }
      const refSpot = clearSpot(w, f.len, 'ref');
      if (fits(fmt(f.len), refSpot.width)) {
        const ref = G.add(f.a, G.mul(f.u, refSpot.at));
        tagText(R, fmt(f.len), R.sx(ref.x) - f.ns.x * gap, R.sy(ref.y) - f.ns.y * gap, angle, R.colors.length, 11);
      }
      if (o.bothFaces) {
        const farSpot = clearSpot(w, f.len, 'far');
        if (!fits(fmt(j.farLen), farSpot.width)) continue;
        const far = G.add(G.add(f.a, G.mul(f.u, farSpot.at)), G.mul(f.ns, f.t));
        tagText(R, fmt(j.farLen), R.sx(far.x) + f.ns.x * gap, R.sy(far.y) + f.ns.y * gap, angle, R.colors.soft, 11);
      }
    }
  }

  function dimGeometry(floor, dim, idx) {
    const e = FP.model.dimEnds(floor, dim, idx);
    const len = G.dist(e.a, e.b);
    const u = len > 1e-9 ? G.mul(G.sub(e.b, e.a), 1 / len) : { x: 1, y: 0 };
    const n = G.nrm(u);
    const off = G.mul(n, dim.offset);
    return { a: e.a, b: e.b, len, u, n, p: G.add(e.a, off), q: G.add(e.b, off) };
  }

  function drawDim(R, floor, dim, idx, o, color) {
    const c = R.ctx;
    const g = dimGeometry(floor, dim, idx);
    R.world();
    c.setLineDash([]);
    c.strokeStyle = color || R.colors.dim;
    c.lineWidth = R.px(1);
    c.beginPath();
    const sign = dim.offset >= 0 ? 1 : -1;
    const over = R.px(5);
    const ax = G.add(g.p, G.mul(g.n, sign * over)), bx = G.add(g.q, G.mul(g.n, sign * over));
    c.moveTo(g.a.x, g.a.y); c.lineTo(ax.x, ax.y);
    c.moveTo(g.b.x, g.b.y); c.lineTo(bx.x, bx.y);
    c.moveTo(g.p.x, g.p.y); c.lineTo(g.q.x, g.q.y);
    const tick = R.px(4);
    const d = { x: (g.u.x + g.n.x) * tick, y: (g.u.y + g.n.y) * tick };
    for (const p of [g.p, g.q]) { c.moveTo(p.x - d.x, p.y - d.y); c.lineTo(p.x + d.x, p.y + d.y); }
    c.stroke();
    const m = G.mul(G.add(g.p, g.q), 0.5);
    const text = FP.units.format(g.len, o.units);
    // The line is still drawn when its text has no room; the text comes back on zooming in.
    if (R.fit && textWidth(R, text, 11) + 8 * R.unit * R.text > g.len * R.scale) return;
    tagText(R, text, R.sx(m.x), R.sy(m.y), Math.atan2(g.u.y, g.u.x), color || R.colors.dim, 11);
  }

  // Construction lines: dashed, with a dot at each end and their measured length.
  function drawGuides(R, floor, o) {
    const c = R.ctx;
    for (const g of floor.guides) {
      if (g.divider) continue;
      R.world();
      c.save();
      c.setLineDash([R.px(7), R.px(4)]);
      c.lineWidth = R.px(1.3);
      c.strokeStyle = R.colors.guide;
      c.beginPath();
      c.moveTo(g.a.x, g.a.y);
      c.lineTo(g.b.x, g.b.y);
      c.stroke();
      c.restore();
      R.screen();
      c.fillStyle = R.colors.guide;
      for (const p of [g.a, g.b]) {
        c.beginPath();
        c.arc(R.sx(p.x), R.sy(p.y), 2.5 * R.unit, 0, Math.PI * 2);
        c.fill();
      }
      const len = G.dist(g.a, g.b);
      const label = FP.units.format(len, o.units);
      const room = R.fit ? textWidth(R, label, 11) + 6 * R.unit * R.text : 34 * R.unit;
      if (len * R.scale >= room) {
        const n = G.nrm(G.mul(G.sub(g.b, g.a), 1 / len));
        const gap = 9 * R.unit * R.text;
        tagText(R, FP.units.format(len, o.units), R.sx((g.a.x + g.b.x) / 2) + n.x * gap, R.sy((g.a.y + g.b.y) / 2) + n.y * gap,
          Math.atan2(g.b.y - g.a.y, g.b.x - g.a.x), R.colors.guide, 11);
      }
    }
  }

  // Room dividers: a fine dashed line where one room ends and the next begins, with no wall.
  function drawDividers(R, floor, color) {
    const c = R.ctx;
    R.world();
    c.save();
    c.setLineDash([R.px(6), R.px(4)]);
    c.lineWidth = R.px(1.2);
    c.lineCap = 'butt';
    c.strokeStyle = color || R.colors.soft;
    for (const g of floor.guides) {
      if (!g.divider) continue;
      c.beginPath();
      c.moveTo(g.a.x, g.a.y);
      c.lineTo(g.b.x, g.b.y);
      c.stroke();
    }
    c.restore();
  }

  function drawLabel(R, l, color) {
    const c = R.ctx;
    R.screen();
    c.save();
    c.translate(R.sx(l.x), R.sy(l.y));
    c.rotate((l.rot * Math.PI) / 180);
    c.font = `500 ${l.size * R.scale}px system-ui, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = color || R.colors.ink;
    c.fillText(l.text || ' ', 0, 0);
    // Text you typed is part of the drawing, so it always shows; labels drawn after it keep clear.
    if (R.taken) claim(R, R.sx(l.x), R.sy(l.y), c.measureText(l.text || ' ').width, l.size * R.scale * 1.15, (l.rot * Math.PI) / 180);
    c.restore();
  }


  // The area of the as-is room at a point, or null if there was none.
  function areaBefore(changes, p) {
    const d = changes && changes.geo.detected;
    if (!d || !d.labelAt) return null;
    const label = d.labelAt(p.x, p.y);
    const room = d.rooms.find((r) => r.label === label);
    return room ? room.area : null;
  }

  // Whether a block of text centred at screen (sx, sy), halfW wide each side and running from
  // top to bottom (screen offsets from sy), sits wholly inside room `label`. Checked against
  // room detection's grid at the corners, edge midpoints and centre.
  function blockInRoom(R, detected, label, sx, sy, halfW, top, bottom) {
    if (!detected || !detected.labelAt) return true;
    const xs = [sx - halfW, sx, sx + halfW], ys = [sy + top, sy + (top + bottom) / 2, sy + bottom];
    for (const x of xs) {
      for (const y of ys) {
        if (detected.labelAt((x - R.ox) / R.scale, (y - R.oy) / R.scale) !== label) return false;
      }
    }
    return true;
  }

  // How much of a room's label to show: 'all' (name, area and any change), 'name', or 'none'.
  // Without R.fit (exports), always 'all'.
  function roomLabelFit(R, geo, rec, region, lines) {
    if (!R.fit) return 'all';
    const tu = R.unit * R.text, pad = 3 * tu;
    const w = Math.max(...lines.map(([text, size, weight]) => textWidth(R, text, size, weight))) / 2 + pad;
    const sx = R.sx(rec.x), sy = R.sy(rec.y);
    const bottom = lines.length > 2 ? 28 * tu : 14 * tu;
    if (blockInRoom(R, geo.detected, region.label, sx, sy, w, -15 * tu, bottom)) return 'all';
    const nw = textWidth(R, lines[0][0], lines[0][1], lines[0][2]) / 2 + pad;
    return blockInRoom(R, geo.detected, region.label, sx, sy, nw, -8 * tu, 8 * tu) ? 'name' : 'none';
  }

  // changes: when showing a design option, how each room's area differs from as-is.
  function drawRoomLabels(R, floor, geo, changes, units) {
    if (!geo.shown) return;
    const tu = R.unit * R.text;
    for (const rec of floor.rooms) {
      const region = geo.shown.get(rec.id);
      if (!region) continue;
      const sx = R.sx(rec.x), sy = R.sy(rec.y);
      const name = rec.name || 'Room';
      const lines = [[name, 13, 600], [FP.units.formatArea(region.area, units), 11, 500]];
      let change = null;
      if (changes) {
        const before = areaBefore(changes, region.anchor || rec);
        const delta = region.area - (before || 0);
        if (before == null || Math.abs(delta) >= 0.05 * 144) {
          change = {
            text: before == null ? 'New room' : `${delta > 0 ? '+' : '−'}${FP.units.formatArea(Math.abs(delta), units)}`,
            color: delta >= 0 ? R.colors.newWork : R.colors.demo,
          };
          lines.push([change.text, 11, 700]);
        }
      }
      let fit = roomLabelFit(R, geo, rec, region, lines);
      // The label claims its space as one block, so its own lines never crowd each other out.
      const width = (n) => Math.max(...lines.slice(0, n).map(([t, s, w]) => textWidth(R, t, s, w)));
      if (fit === 'all' && R.taken) {
        const bottom = change ? 28 * tu : 14 * tu;
        if (!claim(R, sx, sy + (bottom - 15 * tu) / 2, width(lines.length), bottom + 15 * tu, 0)) fit = 'name';
      }
      if (fit === 'name' && R.taken && !claim(R, sx, sy, width(1), 16 * tu, 0)) fit = 'none';
      if (fit === 'none') continue;
      const taken = R.taken;
      R.taken = null; // already claimed above
      if (fit === 'name') tagText(R, name, sx, sy, 0, R.colors.ink, 13, 600);
      else {
        tagText(R, name, sx, sy - 8 * tu, 0, R.colors.ink, 13, 600);
        tagText(R, lines[1][0], sx, sy + 8 * tu, 0, R.colors.soft, 11, 500);
        if (change) tagText(R, change.text, sx, sy + 22 * tu, 0, change.color, 11, 700);
      }
      R.taken = taken;
    }
  }

  // A design option compared with as-is: what it removes or moves is outlined dashed in red
  // where it was, and what it adds or changes is tinted green. changes: { floor, geo } of as-is.
  function drawChanges(R, floor, geo, changes) {
    const c = R.ctx;
    const base = changes.floor, bgeo = changes.geo;
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const wallSig = (w, idx) => {
      const a = idx.nodes.get(w.a), b = idx.nodes.get(w.b);
      return a && b ? [r3(a.x), r3(a.y), r3(b.x), r3(b.y), w.thickness, w.side, w.type].join() : '';
    };
    const sig = (x) => JSON.stringify(x, (k, v) => (typeof v === 'number' ? r3(v) : k === 'locked' || k === 'group' ? undefined : v));
    const differs = (list, cur, baseList, sameFn) => {
      const before = new Map(baseList.map((x) => [x.id, x]));
      return { changed: cur.filter((x) => { const b = before.get(x.id); return !b || !sameFn(b, x); }), gone: baseList.filter((b) => { const x = cur.find((y) => y.id === b.id); return !x || !sameFn(b, x); }) };
    };
    const walls = differs('walls', floor.walls, base.walls, (b, x) => wallSig(b, bgeo.idx) === wallSig(x, geo.idx));
    const same = (b, x) => sig(b) === sig(x);
    const openings = differs('openings', floor.openings, base.openings, same);
    const fixtures = differs('fixtures', floor.fixtures, base.fixtures, same);
    const stairs = differs('stairs', floor.stairs || [], base.stairs || [], same);
    const shapes = differs('shapes', floor.shapes || [], base.shapes || [], same);
    const corners = (fx) => {
      const r = (fx.rot * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
      return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => ({ x: fx.x + (a * fx.w / 2) * cos - (b * fx.d / 2) * sin, y: fx.y + (a * fx.w / 2) * sin + (b * fx.d / 2) * cos }));
    };

    R.world();
    c.save();
    // New work.
    c.beginPath();
    for (const w of walls.changed) { const j = geo.joins.get(w.id); if (j) wallPath(c, j.poly); }
    c.globalAlpha = 0.6;
    c.fillStyle = R.colors.newWork;
    c.fill();
    c.globalAlpha = 1;
    c.lineWidth = R.px(1.8);
    c.strokeStyle = R.colors.newWork;
    c.beginPath();
    for (const fx of fixtures.changed) wallPath(c, corners(fx));
    for (const st of stairs.changed) for (const poly of FP.stairs.geometry(st).polys) wallPath(c, poly);
    for (const sh of shapes.changed) FP.shapes.path(c, sh);
    c.stroke();
    for (const op of openings.changed) {
      const wall = geo.idx.walls.get(op.wallId);
      if (wall) drawOpening(R, G.wallFrame(wall, geo.idx), op, { color: R.colors.newWork });
    }
    // Demolition, where it was.
    c.setLineDash([R.px(5), R.px(3)]);
    c.lineWidth = R.px(1.6);
    c.strokeStyle = R.colors.demo;
    c.beginPath();
    for (const w of walls.gone) { const j = bgeo.joins.get(w.id); if (j) wallPath(c, j.poly); }
    for (const fx of fixtures.gone) wallPath(c, corners(fx));
    for (const st of stairs.gone) for (const poly of FP.stairs.geometry(st).polys) wallPath(c, poly);
    for (const sh of shapes.gone) FP.shapes.path(c, sh);
    c.stroke();
    c.setLineDash([]);
    c.globalAlpha = 0.75;
    for (const op of openings.gone) {
      const wall = bgeo.idx.walls.get(op.wallId);
      if (wall) drawOpening(R, G.wallFrame(wall, bgeo.idx), op, { color: R.colors.demo });
    }
    c.restore();
  }

  // o: { width, height, units, showGrid, gridSize, showLengths, bothFaces, showRooms,
  //      showFixtures, showDims, showLabels, ghost: {floor, geo} | null, above: {floor, geo} | null,
  //      stairs: [{st, mode}] (every stair seen on this floor, from M.stairsSeen), stairView }
  function drawPlan(R, floor, geo, o) {
    const c = R.ctx;
    R.screen();
    c.fillStyle = R.colors.paper;
    if (o.transparent) c.clearRect(0, 0, o.width, o.height);
    else c.fillRect(0, 0, o.width, o.height);
    R.taken = R.fit ? [] : null; // labels' claimed space on screen, from the most useful down
    if (o.showGrid) drawGrid(R, o.width, o.height, o.gridSize, o.units);

    if (o.ghost) {
      R.world();
      c.save();
      c.globalAlpha = 0.28;
      c.beginPath();
      for (const j of o.ghost.geo.joins.values()) wallPath(c, j.poly);
      c.fillStyle = R.colors.interior;
      c.fill();
      c.restore();
    }

    if (o.showRooms && geo.roomImage) {
      R.world();
      c.save();
      c.imageSmoothingEnabled = false;
      const d = geo.detected;
      c.drawImage(geo.roomImage, d.ox, d.oy, d.w * d.cell, d.h * d.cell);
      c.restore();
    }

    drawWalls(R, floor, geo);

    R.world();
    for (const op of floor.openings) {
      const wall = geo.idx.walls.get(op.wallId);
      if (wall) drawOpening(R, G.wallFrame(wall, geo.idx), op);
    }

    // Stairs from the floor below arrive here, seen from the top; this floor's stairs go up.
    // The floor above, overlaid faintly so what's over this floor can be lined up with it.
    if (o.above) {
      R.world();
      c.save();
      c.beginPath();
      for (const j of o.above.geo.joins.values()) wallPath(c, j.poly);
      c.globalAlpha = 0.22;
      c.fillStyle = R.colors.above;
      c.fill();
      c.globalAlpha = 0.55;
      c.setLineDash([R.px(5), R.px(3)]);
      c.lineWidth = R.px(1);
      c.strokeStyle = R.colors.above;
      c.stroke();
      c.restore();
    }

    // stairView (on screen only): 'show', 'fade' to work under them, or 'hide'.
    if (o.stairView !== 'hide') {
      const alpha = o.stairView === 'fade' ? 0.25 : 1;
      const seen = o.stairs || (floor.stairs || []).map((st) => ({ st, mode: st.goes === 'down' ? 'down' : 'up' }));
      for (const { st, mode } of seen) FP.stairs.draw(R, st, { mode, alpha });
    }
    drawDividers(R, floor);
    if (o.showFixtures !== false) {
      for (const fx of floor.fixtures) drawFixture(R, fx);
      for (const sh of floor.shapes || []) FP.shapes.draw(R, sh);
    }
    if (o.changes) drawChanges(R, floor, geo, o.changes);
    if (o.showRooms) drawRoomLabels(R, floor, geo, o.changes, o.units);
    if (o.showLabels !== false) for (const l of floor.labels) drawLabel(R, l);
    if (o.showDims !== false) for (const dim of floor.dims) drawDim(R, floor, dim, geo.idx, o);
    if (o.showLengths) drawWallLengths(R, floor, geo, o);
    if (o.showGuides) drawGuides(R, floor, o);
  }

  // Computes everything derived from a floor's geometry.
  function buildGeo(floor, previous, allowStaleRooms) {
    const idx = G.buildIndex(floor);
    const joins = G.computeJoins(floor, idx);
    const geo = { idx, joins };
    if (allowStaleRooms && previous && previous.detected) {
      geo.detected = previous.detected;
      geo.roomImage = previous.roomImage;
      geo.shown = previous.shown;
      geo.stale = true;
      return geo;
    }
    const polys = [...joins.values()].map((j) => j.poly);
    let minT = Infinity;
    for (const w of floor.walls) minT = Math.min(minT, w.thickness);
    const dividers = floor.guides.filter((g) => g.divider).map((g) => [g.a, g.b]);
    geo.detected = FP.rooms.detect(polys, minT, dividers);
    geo.shown = FP.model.syncRoomRecords(floor, geo.detected);
    geo.roomImage = roomImage(geo.detected);
    return geo;
  }

  FP.render = { PALETTES, makeR, textScale, textWidth, roomLabelFit, drawPlan, drawOpening, drawFixture, drawDim, drawLabel, dimGeometry, tagText, buildGeo, wallPath };
})(globalThis);
