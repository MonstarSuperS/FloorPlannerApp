// Walking the walls: drawing a plan by going around each room with a tape measure and typing
// what it reads, one wall at a time, such as 70" or 3ft 2" R or door 28.
//
// This file is the part with no screen in it, so it can be tested on its own and reused by a
// native app later:
//   parse(text, units)         what was typed, as a list of entries, or an error
//   trace(entries, ctx)        where each wall goes: the path the walk takes
//   realize(floor, tr, opts)   that path made into walls, corners, doors and windows
// js/walker.js is the tool around it: the pad, the preview on the plan, and undo.
//
// Directions: @deg is a fixed direction on the plan, counterclockwise from right (@0 right, @90
// up, @180 left, @270 down), as are the arrows on the pad. L and R turn left or right from the
// last wall, 90 degrees unless a number follows (R45). With no direction, the next wall carries
// straight on, so "36, door 28, 40" is one wall with a door in it.
//
// Lengths are inside measurements, taken along the wall's face from corner to corner, the way a
// tape reads in a room. Corners sit on that face and each wall's thickness goes on the side away
// from the room, so the room comes out the size it was measured.
(function (root) {
  const FP = (root.FP = root.FP || {});
  const G = FP.geom;

  const ARROWS = { '→': 0, '↗': 45, '↑': 90, '↖': 135, '←': 180, '↙': 225, '↓': 270, '↘': 315 };
  const ARROW_OF = Object.fromEntries(Object.entries(ARROWS).map(([k, v]) => [v, k]));

  // Words for doors and windows, longest first so "front door" isn't read as "door".
  const OPENING_WORDS = [
    ['front door', 'door_ext'], ['exterior door', 'door_ext'], ['ext door', 'door_ext'], ['outside door', 'door_ext'],
    ['sliding door', 'slider'], ['pocket door', 'pocket'], ['bifold door', 'bifold'],
    ['door', 'door_int'], ['window', 'window'], ['opening', 'cased'], ['doorway', 'cased'],
    ['pocket', 'pocket'], ['slider', 'slider'], ['bifold', 'bifold'],
  ];
  const COMMANDS = {
    close: { cmd: 'close' },
    undo: { cmd: 'undo' },
    done: { cmd: 'done' }, finish: { cmd: 'done' }, end: { cmd: 'done' }, stop: { cmd: 'done' },
    flip: { cmd: 'flip' },
    ext: { cmd: 'type', type: 'exterior' }, exterior: { cmd: 'type', type: 'exterior' },
    int: { cmd: 'type', type: 'interior' }, interior: { cmd: 'type', type: 'interior' },
  };

  // A room that ends within this of where it started is closed by stretching its last two walls
  // to meet, which keeps every corner square. Farther off, a wall is added back to the start.
  const CLOSE_GAP = 6;
  const ON = 0.05;        // how near counts as on a wall face or corner, in inches
  const MIN_PIECE = 0.5;  // the shortest wall worth making
  const MAX_LENGTH = 12000;

  const rad = (d) => (d * Math.PI) / 180;
  const norm = (d) => ((d % 360) + 360) % 360;
  const turnOf = (from, to) => { let t = norm(to - from); if (t > 180) t -= 360; return t; }; // signed, -180..180
  const same = (a, b) => Math.abs(turnOf(a, b)) < 1e-6;
  // A heading as a direction on the plan, whose y runs down the screen.
  const vec = (h) => ({ x: Math.cos(rad(h)), y: -Math.sin(rad(h)) });
  const headingOf = (v) => norm((Math.atan2(-v.y, v.x) * 180) / Math.PI);

  // How a heading reads: an arrow for the eight pad directions, otherwise degrees.
  function headingText(h) {
    const r = Math.round(norm(h) * 100) / 100;
    return ARROW_OF[r] ? `${ARROW_OF[r]} ${r}°` : `@${r}°`;
  }

  // ---------- Reading what was typed ----------

  // One entry: a command, or an optional direction with a length, a door or window, or "to wall".
  function parseOne(raw, units) {
    const text = raw.trim();
    let s = text.toLowerCase()
      .replace(/[°º]/g, ' ').replace(/\bdeg(rees)?\b/g, ' ')
      .replace(/([→↗↑↖←↙↓↘])/g, ' $1 ')
      .replace(/\s*@\s*/g, ' @')
      .replace(/\s+/g, ' ').trim();
    if (!s) return null;
    if (COMMANDS[s]) return { ...COMMANDS[s], text };

    let dir = null;
    const setDir = (d) => { if (dir) throw new Error('Give one direction for each wall.'); dir = d; };
    let tokens = s.split(' ').filter((tok) => {
      let m;
      if (ARROWS[tok] !== undefined) { setDir({ abs: ARROWS[tok] }); return false; }
      if ((m = tok.match(/^@(-?\d+(?:\.\d+)?)$/))) { setDir({ abs: norm(parseFloat(m[1])) }); return false; }
      if ((m = tok.match(/^(l|r|left|right)(\d+(?:\.\d+)?)?$/))) {
        const by = m[2] ? parseFloat(m[2]) : 90;
        if (!(by > 0 && by < 360)) throw new Error('Turn by an angle between 0 and 360, such as R45.');
        setDir({ rel: m[1][0] === 'l' ? by : -by });
        return false;
      }
      if (tok === '@') throw new Error('Put the angle right after @, such as @90.');
      return true;
    });

    let rest = tokens.join(' ');
    let toWall = false;
    if (/(^| )to ?wall( |$)/.test(rest)) { toWall = true; rest = rest.replace(/(^| )to ?wall( |$)/, ' ').trim(); }

    let opening = null;
    for (const [words, kind] of OPENING_WORDS) {
      if (rest === words || rest.startsWith(`${words} `)) {
        opening = { kind };
        rest = rest.slice(words.length).trim();
        break;
      }
    }

    if (toWall) {
      if (opening) throw new Error('A door or window needs its width, not "to wall".');
      if (rest) throw new Error('"To wall" finds the length itself, so leave the length out.');
      return { dir, toWall: true, text };
    }
    if (opening) {
      const width = rest ? FP.units.parse(rest, { units }) : FP.model.OPENING_KINDS[opening.kind].width;
      if (!(width > 0)) throw new Error(`"${rest}" isn't a width. Try door 28 or window 3'.`);
      if (width > 1200) throw new Error('That is too wide for a door or window.');
      opening.width = width;
      return { dir, opening, text };
    }
    if (!rest) {
      if (dir) return { dir, text }; // a turn on its own
      throw new Error('Type a length, a direction, or both.');
    }
    const len = FP.units.parse(rest, { units });
    if (!(len > 0)) throw new Error(`"${rest}" isn't a length. Try 70", 3ft 2" or 5' 10 1/2".`);
    if (len > MAX_LENGTH) throw new Error('That is too long for one wall.');
    return { dir, len, text };
  }

  // Several entries can go on one line, separated by commas: 36, door 28, 40.
  // Returns { entries } or { error, part } where part is the text that couldn't be read.
  function parse(text, units) {
    const entries = [];
    for (const part of String(text || '').split(/[,;\n]/)) {
      try {
        const e = parseOne(part, units);
        if (e) entries.push(e);
      } catch (err) {
        return { error: err.message, part: part.trim(), entries };
      }
    }
    return { entries };
  }

  // ---------- Where the walls go ----------

  // The faces of a floor's walls as segments, for running "to wall" up to them and for spotting a
  // new wall laid along one that's already there. Each face runs between its mitered corners.
  function facesOf(floor) {
    const idx = G.buildIndex(floor);
    const joins = G.computeJoins(floor, idx);
    const out = [];
    for (const w of floor.walls) {
      const j = joins.get(w.id);
      if (!j) continue;
      for (const [face, p, q] of [['ref', j.refA, j.refB], ['far', j.farA, j.farB]]) {
        const len = G.dist(p, q);
        if (len > 1e-6) out.push({ wallId: w.id, face, p, u: G.mul(G.sub(q, p), 1 / len), len });
      }
    }
    return out;
  }

  // The corners of the walk: its start, then the end of each leg (a run of walls in one direction).
  function cornersOf(legs, start) {
    const pts = [{ x: start.x, y: start.y }];
    for (const leg of legs) {
      const p = pts[pts.length - 1], v = vec(leg.heading), len = legLength(leg);
      pts.push({ x: p.x + v.x * len, y: p.y + v.y * len });
    }
    return pts;
  }
  const legLength = (leg) => leg.segs.reduce((s, x) => s + x.len, 0);

  // How far `from` is from the nearest face straight ahead, or null if nothing is ahead.
  function distanceAhead(from, heading, segments) {
    const dir = vec(heading);
    let best = null;
    for (const s of segments) {
      const X = G.lineIntersect(from, dir, s.p, s.u);
      if (!X || X.t <= MIN_PIECE / 2) continue;
      const along = G.dot(G.sub(X, s.p), s.u);
      if (along < -1e-6 || along > s.len + 1e-6) continue;
      if (best == null || X.t < best) best = X.t;
    }
    return best;
  }

  // Follows the entries from ctx.start and works out every leg. ctx: { start: {x, y},
  // heading, type, faces } where faces (from facesOf) are the walls already on the floor.
  // Returns { legs, corners, pen, heading, type, side, closed, close, error, errorAt }:
  //   legs: [{ heading, type, segs: [{ len, opening, entry }] }]
  //   side: which side of each wall its thickness goes (the model's wall.side)
  //   close: how a closed room was made to meet, { gap, changes: [{ leg, by }] } or { gap, added }
  function trace(entries, ctx) {
    const st = { heading: norm(ctx.heading || 0), type: ctx.type || 'exterior', flip: false, legs: [], newLeg: true, closed: false, close: null };
    const done = (extra) => {
      const corners = cornersOf(st.legs, ctx.start);
      return {
        legs: st.legs, corners, pen: corners[corners.length - 1], heading: st.heading, type: st.type,
        flip: st.flip, side: sideOf(st, corners), closed: st.closed, close: st.close, ...(extra || {}),
      };
    };
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const fail = (error) => done({ error, errorAt: i });
      if (st.closed) return fail('This room is closed. Tap where the next walls start.');
      if (e.cmd === 'type') { if (e.type !== st.type) { st.type = e.type; st.newLeg = true; } continue; }
      if (e.cmd === 'flip') { st.flip = !st.flip; continue; }
      if (e.cmd === 'close') { const err = closeRoom(st, ctx); if (err) return fail(err); continue; }
      if (e.cmd) continue; // undo and done are for the tool, not the path
      if (e.dir) {
        const h = norm(e.dir.abs != null ? e.dir.abs : st.heading + e.dir.rel);
        if (!same(h, st.heading)) st.newLeg = true;
        st.heading = h;
      }
      let len = e.len;
      if (e.opening) len = e.opening.width;
      if (e.toWall) {
        const pen = cornersOf(st.legs, ctx.start).pop();
        // The leg being continued is collinear, so it can't be in the way; earlier legs can.
        const own = [];
        const corners = cornersOf(st.legs, ctx.start);
        st.legs.forEach((leg, k) => {
          const p = corners[k], len2 = legLength(leg);
          if (len2 > 1e-6) own.push({ p, u: vec(leg.heading), len: len2 });
        });
        len = distanceAhead(pen, st.heading, (ctx.faces || []).concat(own));
        if (len == null) return fail('There is no wall straight ahead to run to.');
      }
      if (!(len > 0)) continue; // a turn on its own
      const last = st.legs[st.legs.length - 1];
      if (last && st.newLeg && same(st.heading, last.heading + 180)) {
        return fail('That goes straight back along the last wall. Turn L or R first.');
      }
      if (!last || st.newLeg || !same(st.heading, last.heading)) {
        st.legs.push({ heading: st.heading, type: st.type, segs: [] });
        st.newLeg = false;
      }
      st.legs[st.legs.length - 1].segs.push({ len, opening: e.opening ? { ...e.opening } : null, entry: i });
    }
    return done();
  }

  // Closes the room back to its start. Returns an error message, or null once closed.
  function closeRoom(st, ctx) {
    const legs = st.legs;
    if (legs.length < 2) return 'Draw at least two walls before closing the room.';
    const pen = cornersOf(legs, ctx.start).pop();
    const gap = G.sub(ctx.start, pen);
    const g = Math.hypot(gap.x, gap.y);
    if (g < 1e-6) { st.closed = true; st.close = { gap: 0 }; return null; }

    if (g <= CLOSE_GAP) {
      // Measurements never quite meet. Stretch the last wall and the last one across it so the
      // end lands on the start: gap = a * (last direction) + b * (across direction).
      const i1 = legs.length - 1;
      const u1 = vec(legs[i1].heading);
      let i2 = -1;
      for (let k = i1 - 1; k >= 0; k--) {
        if (Math.abs(G.cross(u1, vec(legs[k].heading))) > 0.2) { i2 = k; break; }
      }
      if (i2 >= 0) {
        const u2 = vec(legs[i2].heading);
        const det = G.cross(u1, u2);
        const a = G.cross(gap, u2) / det, b = G.cross(u1, gap) / det;
        const s1 = stretchable(legs[i1]), s2 = stretchable(legs[i2]);
        if (s1 && s2 && s1.len + a >= MIN_PIECE && s2.len + b >= MIN_PIECE) {
          s1.len += a;
          s2.len += b;
          st.closed = true;
          st.close = { gap: g, changes: [{ leg: i2, by: b }, { leg: i1, by: a }].filter((c) => Math.abs(c.by) > 1e-9) };
          return null;
        }
      }
    }
    // Too far apart to be measuring error, or nothing to stretch: a wall straight back.
    const h = headingOf(gap);
    const last = legs[legs.length - 1];
    if (same(h, last.heading + 180)) return 'The start is back along the last wall, so there is nothing to close.';
    if (same(h, last.heading) && last.type === st.type) last.segs.push({ len: g, opening: null, closing: true });
    else legs.push({ heading: h, type: st.type, segs: [{ len: g, opening: null, closing: true }] });
    st.closed = true;
    st.close = { gap: g, added: g };
    return null;
  }

  // The piece of a leg that can take up a closing difference: its last plain stretch of wall.
  function stretchable(leg) {
    for (let k = leg.segs.length - 1; k >= 0; k--) if (!leg.segs[k].opening) return leg.segs[k];
    return null;
  }

  // Which side the thickness goes. A closed room keeps it outside; an open walk keeps it away
  // from the side it has been turning toward, so walking clockwise (turning right) puts the room
  // on the right. Before any turn, the room is taken to be on the right. Flip swaps it.
  function sideOf(st, corners) {
    let side;
    if (st.closed) {
      let area = 0;
      for (let i = 0; i < corners.length - 1; i++) area += G.cross(corners[i], corners[i + 1]);
      side = area > 0 ? -1 : 1; // positive is clockwise on screen, where y runs down
    } else {
      let net = 0;
      for (let i = 1; i < st.legs.length; i++) net += turnOf(st.legs[i - 1].heading, st.legs[i].heading);
      side = net > 1e-6 ? 1 : -1;
    }
    return st.flip ? -side : side;
  }

  // ---------- Making the walls ----------

  // Adds the traced walk to a floor. opts: { start: where it began (kind 'node' with nodeId,
  // 'wall' with wallId, d and face, or 'free'), thickness: { exterior, interior }, uid }.
  // A stretch laid along the face of a wall that's already there isn't doubled: the existing
  // wall stands for it, and a door there goes in that wall. Corners that land on an existing
  // corner or wall face join it. Returns { walls, nodes, openings, notes, penNodeId }.
  function realize(floor, tr, opts) {
    const M = FP.model;
    const idx = G.buildIndex(floor);
    const faces = facesOf(floor);
    const baseWalls = floor.walls.slice();
    const out = { walls: [], nodes: [], openings: [], notes: [] };
    const made = []; // corners placed so far: { x, y, id }

    const newNode = (p, host) => {
      const n = M.addNode(floor, p.x, p.y, host);
      out.nodes.push(n.id);
      return n.id;
    };
    // The node for a corner of the walk: one already placed, the start's attachment, an existing
    // corner, a point on an existing wall's face, or a new corner.
    const nodeFor = (p, isStart) => {
      for (const m of made) if (G.dist(m, p) < ON) return m.id;
      let id = null;
      const s = opts.start;
      if (isStart && s && s.kind === 'node' && idx.nodes.has(s.nodeId)) id = s.nodeId;
      else if (isStart && s && s.kind === 'wall' && idx.walls.has(s.wallId)) {
        id = newNode(p, { wallId: s.wallId, d: s.d, face: s.face === 'far' ? 'far' : 'ref', pinned: true });
      }
      if (!id) {
        for (const n of floor.nodes) if (idx.nodes.has(n.id) && G.dist(n, p) < ON) { id = n.id; break; }
      }
      if (!id) {
        for (const w of baseWalls) {
          const f = G.wallFrame(w, idx);
          const rel = G.sub(p, f.a);
          const along = G.dot(rel, f.u), across = G.dot(rel, f.ns);
          if (along < -ON || along > f.len + ON) continue;
          const face = Math.abs(across) < ON ? 'ref' : Math.abs(across - f.t) < ON ? 'far' : null;
          if (!face) continue;
          id = newNode(p, { wallId: w.id, d: Math.max(0, Math.min(f.len, along)), face, pinned: true });
          break;
        }
      }
      if (!id) id = newNode(p);
      made.push({ x: p.x, y: p.y, id });
      return id;
    };

    const thick = (type) => (opts.thickness && opts.thickness[type]) || (type === 'exterior' ? 6 : 4);
    tr.legs.forEach((leg, k) => {
      const A = tr.corners[k], u = vec(leg.heading), L = legLength(leg);
      const at = (t) => ({ x: A.x + u.x * t, y: A.y + u.y * t });

      // Stretches already covered by an existing wall's face lying along this leg.
      const covered = [];
      for (const fc of faces) {
        if (Math.abs(G.cross(u, fc.u)) > 1e-6) continue;
        if (Math.abs(G.cross(fc.u, G.sub(A, fc.p))) > ON) continue;
        const t0 = G.dot(G.sub(fc.p, A), u), t1 = t0 + G.dot(fc.u, u) * fc.len;
        const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(L, Math.max(t0, t1));
        if (hi - lo > ON) covered.push({ lo, hi, face: fc });
      }
      covered.sort((a, b) => a.lo - b.lo);
      const pieces = [];
      let t = 0;
      for (const c of covered) {
        if (c.lo - t >= MIN_PIECE) pieces.push({ t0: t, t1: c.lo });
        t = Math.max(t, c.hi);
      }
      if (L - t >= MIN_PIECE) pieces.push({ t0: t, t1: L });

      for (const pc of pieces) {
        const a = nodeFor(at(pc.t0), k === 0 && pc.t0 === 0);
        const b = nodeFor(at(pc.t1), false);
        if (a === b) continue;
        const wall = M.addWall(floor, a, b, leg.type, thick(leg.type), tr.side);
        out.walls.push(wall.id);
        pc.wallId = wall.id;
      }

      // Doors and windows, each in whichever wall holds its middle.
      let s0 = 0;
      for (const seg of leg.segs) {
        const from = s0;
        s0 += seg.len;
        if (!seg.opening) continue;
        const { kind, width } = seg.opening;
        const mid = from + width / 2;
        const name = M.OPENING_KINDS[kind].name.toLowerCase();
        const pc = pieces.find((x) => x.wallId && mid >= x.t0 - 1e-6 && mid <= x.t1 + 1e-6);
        let wallId = null, d = 0, flipSwing = false;
        if (pc) { wallId = pc.wallId; d = mid - pc.t0; }
        else {
          const c = covered.find((x) => mid >= x.lo - 1e-6 && mid <= x.hi + 1e-6);
          if (c) {
            const w = idx.walls.get(c.face.wallId);
            const f = G.wallFrame(w, idx);
            wallId = w.id;
            d = G.dot(G.sub(at(mid), f.a), f.u);
            flipSwing = c.face.face === 'far'; // opens into the room being walked
            const there = floor.openings.some((o) => o.wallId === wallId && Math.abs(o.d - d) < (o.width + width) / 2 - 1e-6);
            if (there) { out.notes.push({ kind: 'existing', name }); continue; }
          }
        }
        if (!wallId || !M.openingFits(floor, wallId, d, width)) { out.notes.push({ kind: 'noFit', name, width }); continue; }
        const op = { id: M.uid('o'), wallId, kind, d, width, flipHinge: false, flipSwing, panels: 1 };
        floor.openings.push(op);
        out.openings.push(op.id);
      }
    });
    const pen = tr.corners[tr.corners.length - 1];
    const atPen = made.find((m) => G.dist(m, pen) < ON);
    out.penNodeId = atPen ? atPen.id : null;
    return out;
  }

  FP.walk = {
    parse, trace, realize, facesOf, cornersOf, legLength, headingText, vec, norm,
    ARROWS, CLOSE_GAP, OPENING_WORDS,
  };
})(globalThis);
