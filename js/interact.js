// Canvas interaction: tools, snapping, hit testing, dragging, keyboard shortcuts and overlays.
(function (root) {
  const FP = (root.FP = root.FP || {});
  const G = FP.geom, M = FP.model, Rn = FP.render, app = FP.app;

  const SNAP_PX = 12;
  const SHAPE_TOOLS = ['line', 'poly', 'rect', 'circle', 'ellipse', 'arc'];
  const HANDLE_PX = 8;
  const DRAG_START_PX = 3;
  const MIN_FIXTURE = 6;
  const MIN_WALL = 0.5;
  const ACCENT = '#1f6feb';
  const BAD = '#cf3a24';

  let canvas, ctx;
  const mouse = { sx: 0, sy: 0, x: 0, y: 0, inside: false, shift: false, alt: false };
  let press = null;
  let panning = null;
  let spaceHeld = false;
  let buffer = ''; // length being typed while drawing a wall

  const scale = () => app.view.scale;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;

  function roundGrid(v, force) {
    const s = app.settings();
    if ((!s.snap && !force) || mouse.alt) return v;
    return Math.round(v / s.gridSize) * s.gridSize;
  }

  function toLocal(fx, p) {
    const r = rad(fx.rot), dx = p.x - fx.x, dy = p.y - fx.y;
    return { x: dx * Math.cos(r) + dy * Math.sin(r), y: -dx * Math.sin(r) + dy * Math.cos(r) };
  }
  function toWorld(fx, p) {
    const r = rad(fx.rot);
    return { x: fx.x + p.x * Math.cos(r) - p.y * Math.sin(r), y: fx.y + p.x * Math.sin(r) + p.y * Math.cos(r) };
  }

  // ---------- Snapping ----------

  function wallHit(world, thr, exclude) {
    const geo = app.geo();
    let best = null;
    for (const w of app.floor().walls) {
      if (exclude && exclude.has(w.id)) continue;
      const f = G.wallFrame(w, geo.idx);
      if (f.len < 1e-6) continue;
      const rel = G.sub(world, f.a);
      const along = G.dot(rel, f.u), perp = G.dot(rel, f.ns);
      if (along < -thr || along > f.len + thr || perp < -thr || perp > f.t + thr) continue;
      const inside = perp >= 0 && perp <= f.t;
      const score = inside ? 0 : Math.min(Math.abs(perp), Math.abs(perp - f.t));
      if (!best || score < best.score) {
        best = { wall: w, f, along: clamp(along, 0, f.len), face: Math.abs(perp) <= Math.abs(perp - f.t) ? 'ref' : 'far', score };
      }
    }
    return best;
  }

  function wallPoint(hit, d) {
    let p = G.add(hit.f.a, G.mul(hit.f.u, d));
    if (hit.face === 'far') p = G.add(p, hit.f.off);
    return p;
  }

  function nodeAt(world, thr, exclude) {
    let best = null, bestD = thr;
    for (const n of app.floor().nodes) {
      if (exclude && exclude.has(n.id)) continue;
      const d = G.dist(world, n);
      if (d <= bestD) { best = n; bestD = d; }
    }
    return best;
  }

  // ---------- Construction lines ----------

  // Construction lines while they're shown, and room dividers always.
  const guideList = (exclude) => {
    const all = app.settings().showGuides;
    return app.floor().guides.filter((g) => (all || g.divider) && (!exclude || !exclude.has(g.id)));
  };

  function segmentCross(p1, p2, q1, q2) {
    const u = G.sub(p2, p1), v = G.sub(q2, q1);
    const X = G.lineIntersect(p1, u, q1, v);
    if (!X || X.t < 0 || X.t > 1) return null;
    const l2 = G.dot(v, v);
    const s = l2 ? G.dot(G.sub(X, q1), v) / l2 : -1;
    return s >= 0 && s <= 1 ? { x: X.x, y: X.y } : null;
  }

  // Snap points from construction lines: their ends, midpoints, and where they cross
  // each other or a wall face. Ends win over crossings, and crossings over midpoints.
  function guidePointAt(world, thr, exclude) {
    const list = guideList(exclude);
    if (!list.length) return null;
    const ends = [], crossings = [], mids = [];
    list.forEach((g, i) => {
      ends.push({ ...g.a, guideId: g.id }, { ...g.b, guideId: g.id });
      mids.push({ x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2, guideId: g.id });
      for (let j = i + 1; j < list.length; j++) {
        const X = segmentCross(g.a, g.b, list[j].a, list[j].b);
        if (X) crossings.push({ ...X, guideId: g.id });
      }
    });
    const idx = app.geo().idx;
    for (const w of app.floor().walls) {
      const f = G.wallFrame(w, idx);
      for (const g of list) {
        for (const off of [{ x: 0, y: 0 }, f.off]) {
          const X = segmentCross(g.a, g.b, G.add(f.a, off), G.add(f.b, off));
          if (X) crossings.push({ ...X, guideId: g.id });
        }
      }
    }
    for (const [kind, pts] of [['guide-end', ends], ['guide-cross', crossings], ['guide-mid', mids]]) {
      let best = null, bestD = thr;
      for (const p of pts) {
        const d = G.dist(world, p);
        if (d <= bestD) { best = p; bestD = d; }
      }
      if (best) return { kind, x: best.x, y: best.y, guideId: best.guideId };
    }
    return null;
  }

  function guideLineAt(world, thr, exclude) {
    let best = null, bestD = thr;
    for (const g of guideList(exclude)) {
      const d = G.distToSegment(world, g.a, g.b);
      if (d > bestD) continue;
      const ab = G.sub(g.b, g.a), l2 = G.dot(ab, ab);
      if (!l2) continue;
      const t = Math.max(0, Math.min(1, G.dot(G.sub(world, g.a), ab) / l2));
      best = { kind: 'guide-on', guideId: g.id, x: g.a.x + ab.x * t, y: g.a.y + ab.y * t };
      bestD = d;
    }
    return best;
  }

  // Directions of whatever is attached at a point, so Shift can lock parallel or square to it.
  function directionsAt(point) {
    const dirs = [];
    const idx = app.geo().idx;
    if (point.nodeId) {
      for (const w of idx.byNode.get(point.nodeId) || []) {
        const u = G.wallFrame(w, idx).u;
        dirs.push(Math.atan2(u.y, u.x));
      }
    }
    if (point.wallId && idx.walls.has(point.wallId)) {
      const u = G.wallFrame(idx.walls.get(point.wallId), idx).u;
      dirs.push(Math.atan2(u.y, u.x));
    }
    for (const g of guideList()) {
      if (G.dist(g.a, point) < 0.01 || G.dist(g.b, point) < 0.01) dirs.push(Math.atan2(g.b.y - g.a.y, g.b.x - g.a.x));
    }
    return dirs;
  }

  function lockAngle(raw, stepRad, dirs) {
    let best = Math.round(raw / stepRad) * stepRad;
    const gap = (a) => Math.abs(Math.atan2(Math.sin(a - raw), Math.cos(a - raw)));
    for (const d of dirs) {
      for (let k = 0; k < 4; k++) {
        const a = d + (k * Math.PI) / 2;
        if (gap(a) < gap(best)) best = a;
      }
    }
    return best;
  }

  // Finds where a circle of the typed length around `start` meets the line the mouse is on.
  // This is what turns "I know the hypotenuse and the rise" into an exact point.
  function solveLength(start, len, t, world) {
    const lines = [];
    if (t.kind === 'guide-on') {
      const g = app.floor().guides.find((x) => x.id === t.guideId);
      if (g) lines.push({ q: g.a, v: G.sub(g.b, g.a) });
    } else if (t.guides) {
      // Level with a construction line's end. Wall corners don't count: being level with one
      // is usually a coincidence, and typed lengths should otherwise keep to standard angles.
      if (t.guides[0] && t.guides[0].isGuide) lines.push({ q: { x: t.x, y: t.y }, v: { x: 0, y: 1 } });
      if (t.guides[1] && t.guides[1].isGuide) lines.push({ q: { x: t.x, y: t.y }, v: { x: 1, y: 0 } });
    }
    if (!lines.length) return null;
    let best = null, nearestReach = Infinity;
    for (const { q, v } of lines) {
      const m = Math.hypot(v.x, v.y);
      if (m < 1e-9) continue;
      const u = { x: v.x / m, y: v.y / m };
      const foot = G.add(q, G.mul(u, G.dot(G.sub(start, q), u)));
      const rise = G.dist(start, foot);
      if (rise > len + 1e-9) { nearestReach = Math.min(nearestReach, rise); continue; }
      const run = Math.sqrt(Math.max(0, len * len - rise * rise));
      for (const sign of [1, -1]) {
        const p = G.add(foot, G.mul(u, sign * run));
        const d = G.dist(p, world);
        if (!best || d < best.d) best = { d, point: p, foot, rise, run };
      }
    }
    return best || { reach: nearestReach };
  }

  // The corners where wall edges meet: both faces at each wall's ends, and each mitered corner.
  // A point on a wall's face attaches to that face; a mitered corner outside it is only a position.
  function junctionAt(world, thr, o) {
    const geo = app.geo();
    let best = null, bestD = thr;
    const excluded = (w) => (o.excludeWalls && o.excludeWalls.has(w.id))
      || (o.excludeNodes && (o.excludeNodes.has(w.a) || o.excludeNodes.has(w.b)));
    for (const w of app.floor().walls) {
      if (excluded(w)) continue;
      const f = G.wallFrame(w, geo.idx);
      const j = geo.joins.get(w.id);
      if (!j || f.len < 1e-6) continue;
      for (const p of [G.add(f.a, f.off), G.add(f.b, f.off), j.refA, j.farA, j.refB, j.farB]) {
        const gap = G.dist(p, world);
        if (gap >= bestD || (o.from && G.dist(p, o.from) < 0.01)) continue;
        bestD = gap;
        const rel = G.sub(p, f.a);
        const along = G.dot(rel, f.u), across = G.dot(rel, f.ns);
        const face = Math.abs(across) < 1e-6 ? 'ref' : Math.abs(across - f.t) < 1e-6 ? 'far' : null;
        best = face && along > -1e-6 && along < f.len + 1e-6
          ? { kind: 'wall', wallId: w.id, d: clamp(along, 0, f.len), face, pinned: true, x: p.x, y: p.y }
          : { kind: 'corner', x: p.x, y: p.y };
      }
    }
    return best;
  }

  // The closest attachable point: a wall's own node, or a junction on its edges.
  function pointSnap(world, thr, o) {
    const n = nodeAt(world, thr, o.excludeNodes);
    const j = junctionAt(world, thr, o);
    if (j && (!n || G.dist(j, world) < G.dist(n, world) - 1e-6)) return j;
    return n ? { kind: 'node', nodeId: n.id, x: n.x, y: n.y } : null;
  }

  // o: { from, shift, angles, excludeNodes, excludeWalls, excludeGuides, noWalls }
  function snap(world, o) {
    o = o || {};
    const thr = SNAP_PX / scale();
    const s = app.settings();
    const guides = [];

    if (o.from && o.shift) {
      const a = lockAngle(Math.atan2(world.y - o.from.y, world.x - o.from.x), rad(s.angleStep), o.angles || []);
      const dir = { x: Math.cos(a), y: Math.sin(a) };
      const rawLen = Math.max(0, G.dot(G.sub(world, o.from), dir));
      const p = G.add(o.from, G.mul(dir, roundGrid(rawLen)));
      const n = pointSnap(p, thr * 0.6, o);
      if (n) return n;
      const gp = guidePointAt(p, thr * 0.6, o.excludeGuides);
      if (gp && G.dist(gp, o.from) > 0.01) return gp;
      for (const g of guideList(o.excludeGuides)) {
        const X = G.lineIntersect(o.from, dir, g.a, G.sub(g.b, g.a));
        if (X && X.t > 0 && G.dist(X, p) <= thr && G.distToSegment(X, g.a, g.b) < 1e-6) {
          return { kind: 'guide-on', guideId: g.id, x: X.x, y: X.y };
        }
      }
      if (!o.noWalls) {
        const hit = wallHit(p, thr, o.excludeWalls);
        if (hit) {
          const base = hit.face === 'far' ? G.add(hit.f.a, hit.f.off) : hit.f.a;
          const X = G.lineIntersect(o.from, dir, base, hit.f.u);
          if (X && X.t > 0) {
            const d = clamp(G.dot(G.sub(X, hit.f.a), hit.f.u), 0, hit.f.len);
            return { kind: 'wall', wallId: hit.wall.id, d, face: hit.face, x: X.x, y: X.y };
          }
        }
      }
      return { kind: 'angle', x: p.x, y: p.y };
    }

    const n = pointSnap(world, thr, o);
    if (n) return n;

    const gp = guidePointAt(world, thr, o.excludeGuides);
    if (gp) return gp;

    if (!o.noWalls) {
      const hit = wallHit(world, thr, o.excludeWalls);
      if (hit) {
        // Anywhere on the end of a wall means that wall's end, so clicking a corner attaches to it.
        const endZone = Math.max(thr, hit.f.t);
        for (const [node, along] of [[hit.f.a, hit.along], [hit.f.b, hit.f.len - hit.along]]) {
          if (along <= endZone && !(o.excludeNodes && o.excludeNodes.has(node.id))) {
            return { kind: 'node', nodeId: node.id, x: node.x, y: node.y };
          }
        }
        const d = clamp(roundGrid(hit.along), 0, hit.f.len);
        const p = wallPoint(hit, d);
        return { kind: 'wall', wallId: hit.wall.id, d, face: hit.face, x: p.x, y: p.y };
      }
    }

    const onLine = guideLineAt(world, thr, o.excludeGuides);
    if (onLine) return onLine;

    let x = roundGrid(world.x), y = roundGrid(world.y);
    if (!mouse.alt) {
      const g = 7 / scale();
      let bestX = g, bestY = g;
      const align = [];
      for (const m of app.floor().nodes) if (!(o.excludeNodes && o.excludeNodes.has(m.id))) align.push(m);
      for (const l of guideList(o.excludeGuides)) align.push({ ...l.a, isGuide: true }, { ...l.b, isGuide: true });
      for (const m of align) {
        if (o.from && G.dist(m, o.from) < 0.01) continue;
        if (Math.abs(world.x - m.x) < bestX) { bestX = Math.abs(world.x - m.x); x = m.x; guides[0] = m; }
        if (Math.abs(world.y - m.y) < bestY) { bestY = Math.abs(world.y - m.y); y = m.y; guides[1] = m; }
      }
    }
    return { kind: s.snap ? 'grid' : 'free', x, y, guides };
  }

  // The nearest point on a fixture, door, window or stair within `thr`: a dimension end
  // attaches to it and follows the item.
  function itemPointAt(world, thr, excludeId) {
    const floor = app.floor(), idx = app.geo().idx;
    let best = null, bestD = thr;
    for (const [t, list] of [['fixture', floor.fixtures], ['opening', floor.openings], ['stair', floor.stairs], ['shape', floor.shapes || []]]) {
      for (const item of list) {
        if (item.id === excludeId) continue;
        for (const p of M.itemPoints(floor, t, item, idx)) {
          const gap = G.dist(p, world);
          if (gap < bestD) { bestD = gap; best = { kind: 'item', ref: { t, id: item.id, pt: p.pt }, x: p.x, y: p.y, ang: p.ang }; }
        }
      }
    }
    return best;
  }

  // Snapping for dimensions: points on items as well as everything walls and lines offer. An
  // item point wins unless a wall corner or line point is closer.
  function dimSnap(world, excludeId) {
    const t = snap(world);
    const it = itemPointAt(world, SNAP_PX / scale(), excludeId);
    if (it && (!isSnapPoint(t) || t.kind === 'wall' || G.dist(it, world) <= G.dist(t, world) + 1e-9)) return it;
    return t;
  }

  // How far the dimension line sits from what it measures, for a cursor at `world`: its
  // perpendicular distance from the measured line, signed by side and rounded to the grid.
  function dimOffsetAt(draft, world) {
    const u = G.sub(draft.b, draft.a), len = Math.hypot(u.x, u.y) || 1;
    const n = G.nrm({ x: u.x / len, y: u.y / len });
    const off = G.dot(G.sub(world, draft.a), n);
    return mouse.alt ? off : roundGrid(off);
  }

  // The dimension end a snap result makes.
  function dimEndFor(t) {
    if (t.kind === 'node') return { nodeId: t.nodeId, x: t.x, y: t.y };
    if (t.kind === 'item') return M.itemEnd(t.ref, t);
    return { x: t.x, y: t.y };
  }

  // Exact match for a typed endpoint, so a typed length that lands on a wall still attaches.
  function exactSnap(p, excludeNodes) {
    const n = nodeAt(p, 1 / 16, excludeNodes);
    if (n) return { kind: 'node', nodeId: n.id, x: n.x, y: n.y };
    const hit = wallHit(p, 1 / 16);
    if (hit && Math.min(Math.abs(G.dot(G.sub(p, hit.f.a), hit.f.ns)), Math.abs(G.dot(G.sub(p, hit.f.a), hit.f.ns) - hit.f.t)) <= 1 / 16) {
      return { kind: 'wall', wallId: hit.wall.id, d: hit.along, face: hit.face, x: p.x, y: p.y };
    }
    return { kind: 'free', x: p.x, y: p.y };
  }

  // ---------- Wall drawing ----------

  function drawStart(target) {
    const st = app.draw.start;
    if (st.kind !== 'wall' || st.pinned) return st; // a chosen junction keeps the edge it was on
    const geo = app.geo();
    const wall = geo.idx.walls.get(st.wallId);
    const f = G.wallFrame(wall, geo.idx);
    const face = target && G.dot(G.sub(target, f.a), f.ns) > f.t / 2 ? 'far' : 'ref';
    let p = G.add(f.a, G.mul(f.u, st.d));
    if (face === 'far') p = G.add(p, f.off);
    return { ...st, face, x: p.x, y: p.y };
  }

  function drawTarget() {
    const world = { x: mouse.x, y: mouse.y };
    const d = app.draw;
    const probe = drawStart(world);
    const excludeNodes = new Set();
    if (probe.nodeId) excludeNodes.add(probe.nodeId);
    const excludeWalls = probe.wallId ? new Set([probe.wallId]) : null;
    const t = snap(world, { from: probe, shift: mouse.shift, angles: directionsAt(probe), excludeNodes, excludeWalls });
    const start = drawStart(t);
    if (buffer) {
      const len = app.parse(buffer);
      if (len > 0) {
        const typed = (dir) => {
          const tee = teeStart(start, dir);
          if (tee) {
            return { start: tee, target: { kind: 'typed', x: tee.x + dir.x * len, y: tee.y + dir.y * len }, fromTee: true };
          }
          const add = app.tool === 'wall' && !mouse.alt ? extensionOffset(start, dir) : null;
          const total = add != null && len + add >= MIN_WALL ? len + add : len;
          return {
            start,
            target: { kind: 'typed', x: start.x + dir.x * total, y: start.y + dir.y * total },
            extension: total !== len ? { room: len, total } : null,
          };
        };
        if (d.lockDir) return typed(d.lockDir);
        const solved = mouse.shift ? null : solveLength(start, len, t, world);
        if (solved && solved.point) {
          return { start, target: { kind: 'typed', x: solved.point.x, y: solved.point.y }, solved };
        }
        return { ...typed(typedDirection(start, t)), reach: solved ? solved.reach : null };
      }
    }
    const run = G.dist(start, t);
    if (run > 1e-6) {
      const tee = teeStart(start, G.mul(G.sub(t, start), 1 / run));
      if (tee && run - tee.along >= MIN_WALL) return { start: tee, target: t, fromTee: true };
    }
    return { start, target: t };
  }

  // A typed length follows the mouse only roughly: it snaps to the standard angles, or square
  // to what it starts from. Hold Alt to keep the exact mouse angle.
  function typedDirection(start, t) {
    const dx = t.x - start.x, dy = t.y - start.y;
    if (Math.hypot(dx, dy) < 1e-6) return { x: 1, y: 0 };
    const raw = Math.atan2(dy, dx);
    const a = mouse.alt ? raw : lockAngle(raw, rad(app.settings().angleStep), directionsAt(start));
    return { x: Math.cos(a), y: Math.sin(a) };
  }

  // The wall at `nodeId` that travelling along `dir` would continue straight on from.
  function continuedWall(nodeId, dir, idx) {
    return (idx.byNode.get(nodeId) || []).find((w) => {
      if (w.type !== app.wallType) return false; // a new wall only continues its own kind
      const f = G.wallFrame(w, idx);
      const out = w.a === nodeId ? f.u : G.neg(f.u); // points back along the wall
      return G.dot(out, dir) < -0.999;
    });
  }

  // A wall continued straight past a wall T'd off its end belongs to the next room, so it starts
  // at that room's inside corner on the T wall's far face, not at the old wall's end. Returns
  // that start point, or null when this isn't such an extension or the corner isn't on the T wall.
  function teeStart(start, dir) {
    if (app.tool !== 'wall' || mouse.alt || !start.nodeId) return null;
    const idx = app.geo().idx;
    const extended = continuedWall(start.nodeId, dir, idx);
    if (!extended) return null;
    let best = null;
    for (const w of idx.byNode.get(start.nodeId) || []) {
      if (w === extended) continue;
      const f = G.wallFrame(w, idx);
      const out = w.a === start.nodeId ? f.u : G.neg(f.u);
      if (G.dot(out, dir) > 0.999) return null; // a wall already carries on this way
      if (Math.abs(G.dot(f.u, dir)) > 0.99) continue; // runs alongside, not across
      for (const face of ['ref', 'far']) {
        const X = G.lineIntersect(start, dir, face === 'far' ? G.add(f.a, f.off) : f.a, f.u);
        if (X && X.t > 1 / 16 && (!best || X.t > best.along)) best = { wall: w, f, face, X, along: X.t };
      }
    }
    if (!best) return null;
    const d = G.dot(G.sub(best.X, best.f.a), best.f.u);
    if (d < -1e-6 || d > best.f.len + 1e-6) return null;
    return {
      kind: 'wall', wallId: best.wall.id, d: clamp(d, 0, best.f.len), face: best.face,
      x: best.X.x, y: best.X.y, along: best.along,
    };
  }

  // When a wall is extended past a wall T'd off of it and can't start on that wall (it already
  // runs past the T), the new length is still the next room's inside measurement. Returns how
  // far along the travel direction the T wall's far face is from `start` (negative if the wall
  // already runs past it), or null when this isn't such an extension.
  function extensionOffset(start, dir) {
    if (!start.nodeId) return null;
    const geo = app.geo();
    const idx = geo.idx;
    const atStart = idx.byNode.get(start.nodeId) || [];
    const extended = continuedWall(start.nodeId, dir, idx);
    if (!extended) return null;
    const attachments = atStart.filter((w) => w !== extended).map((w) => ({ wall: w, nodeId: start.nodeId }));
    for (const n of app.floor().nodes) {
      if (n.host && n.host.wallId === extended.id) {
        for (const w of idx.byNode.get(n.id) || []) attachments.push({ wall: w, nodeId: n.id });
      }
    }
    let best = null;
    for (const { wall, nodeId } of attachments) {
      if (Math.abs(G.dot(G.wallFrame(wall, idx).u, dir)) > 0.99) continue; // runs alongside, not across
      const j = geo.joins.get(wall.id);
      if (!j) continue;
      const corners = wall.a === nodeId ? [j.refA, j.farA] : [j.refB, j.farB];
      for (const c of corners) {
        const along = G.dot(G.sub(c, start), dir);
        if (best == null || along > best) best = along;
      }
    }
    return best;
  }

  // ---------- Shapes ----------

  // New shapes take the style last chosen in the Inspector.
  let shapeStyle = { ...FP.shapes.DEFAULT_STYLE };
  function rememberShapeStyle(style) { shapeStyle = { ...shapeStyle, ...style }; }

  // Snapping while drawing or reshaping a shape: walls, construction lines, and points on
  // fixtures, doors, stairs and other shapes. Shift locks the angle from the previous point.
  function shapeSnap(world, from, excludeId) {
    if (from && mouse.shift) return snap(world, { from, shift: true, angles: [] });
    return dimSnap(world, excludeId);
  }

  // A typed size: "36 x 20" (width by depth) or a single length.
  function typedPair() {
    const parts = buffer.split(/\s*[x×*,]\s*/i).filter((t) => t.trim());
    const vals = parts.map((t) => app.parse(t));
    if (!vals.length || vals.length > 2 || vals.some((v) => !(v > 0))) return null;
    return vals;
  }
  const typedOk = () => (/[x×*,]/i.test(buffer) ? !!typedPair() : app.parse(buffer) > 0);

  // The point the next click would place, after snapping or a typed length.
  function shapeTarget() {
    const d = app.shapeDraft;
    const last = d && d.pts[d.pts.length - 1];
    const t = shapeSnap({ x: mouse.x, y: mouse.y }, last);
    const kind = app.shapeKind;
    if (last && buffer && (kind === 'line' || kind === 'poly' || (kind === 'arc' && d.pts.length === 1))) {
      const len = app.parse(buffer);
      if (len > 0) {
        const dir = typedDirection(last, t);
        return { kind: 'typed', x: last.x + dir.x * len, y: last.y + dir.y * len };
      }
    }
    return t;
  }

  // Whether the polyline's next click lands on its first point, closing it.
  function closesPoly(d, t) {
    return app.shapeKind === 'poly' && d && d.pts.length >= 3 && G.dist(t, d.pts[0]) <= SNAP_PX / scale();
  }

  // The shape the draft would make now.
  function shapeDraftShape() {
    const d = app.shapeDraft;
    if (!d) return null;
    const t = shapeTarget();
    const a = d.pts[0];
    const kind = app.shapeKind;
    if (kind === 'line') return { kind: 'line', a, b: { x: t.x, y: t.y } };
    if (kind === 'poly') {
      if (closesPoly(d, t)) return { kind: 'poly', pts: d.pts.slice(), closed: true };
      return { kind: 'poly', pts: [...d.pts, { x: t.x, y: t.y }], closed: false };
    }
    if (kind === 'arc') {
      if (d.pts.length === 1) return { kind: 'line', a, b: { x: t.x, y: t.y } };
      const b = d.pts[1];
      const m = FP.shapes.arcMid(a, b, t);
      return m ? { kind: 'arc', a, b, m } : { kind: 'line', a, b };
    }
    const pair = buffer ? typedPair() : null;
    const sx = t.x >= a.x ? 1 : -1, sy = t.y >= a.y ? 1 : -1;
    if (kind === 'rect') {
      let w = Math.abs(t.x - a.x), dd = Math.abs(t.y - a.y);
      if (pair) { w = pair[0]; dd = pair[1] || pair[0]; }
      return { kind: 'rect', x: a.x + (sx * w) / 2, y: a.y + (sy * dd) / 2, w, d: dd, rot: 0, r: 0 };
    }
    if (kind === 'circle') {
      const dia = pair ? pair[0] : 2 * G.dist(a, t);
      return { kind: 'ellipse', x: a.x, y: a.y, w: dia, d: dia, rot: 0, circle: true };
    }
    // Ellipse: from its centre to a corner of the box around it, or a typed width x depth.
    let w = 2 * Math.abs(t.x - a.x), dd = 2 * Math.abs(t.y - a.y);
    if (pair) { w = pair[0]; dd = pair[1] || pair[0]; }
    return { kind: 'ellipse', x: a.x, y: a.y, w, d: dd, rot: 0 };
  }

  function addShape(shape) {
    const sh = { id: M.uid('sh'), ...shape, ...shapeStyle };
    app.floor().shapes.push(sh);
    clearTyping();
    app.shapeDraft = null;
    app.commit();
    return sh;
  }

  // Ends a polyline being drawn, keeping it if it has a segment.
  function finishPoly() {
    const d = app.shapeDraft;
    if (!d || app.shapeKind !== 'poly') return false;
    const pts = d.pts.filter((p, i) => !i || G.dist(p, d.pts[i - 1]) >= MIN_WALL);
    app.shapeDraft = null;
    clearTyping();
    if (pts.length >= 2) { addShape({ kind: 'poly', pts, closed: false }); return true; }
    return false;
  }

  // A click (or Enter with a typed size) while drawing a shape.
  function shapeStep() {
    const d = app.shapeDraft;
    const kind = app.shapeKind;
    if (buffer && !typedOk()) {
      app.toast(`"${buffer}" is not a size. Try 36, or 36 x 20 for width by depth.`, true);
      clearTyping();
      return;
    }
    if (!d) {
      const t = shapeSnap({ x: mouse.x, y: mouse.y }, null);
      app.shapeDraft = { pts: [{ x: t.x, y: t.y }] };
      return;
    }
    const t = shapeTarget();
    const last = d.pts[d.pts.length - 1];
    if (kind === 'poly') {
      if (closesPoly(d, t)) { app.shapeDraft = null; clearTyping(); addShape({ kind: 'poly', pts: d.pts.slice(), closed: true }); return; }
      if (G.dist(t, last) >= MIN_WALL) d.pts.push({ x: t.x, y: t.y });
      clearTyping();
      return;
    }
    if (kind === 'arc' && d.pts.length === 1) {
      if (G.dist(t, last) >= MIN_WALL) d.pts.push({ x: t.x, y: t.y });
      clearTyping();
      return;
    }
    const shape = shapeDraftShape();
    if (kind === 'arc' && shape.kind !== 'arc') { app.toast('Move away from the line between the ends to bend the arc.', true); return; }
    const size = shape.kind === 'line' || shape.kind === 'arc' ? FP.shapes.length(shape) : Math.min(shape.w, shape.d);
    if (!(size >= MIN_WALL)) return;
    addShape(shape);
  }

  // ---------- Stairs ----------

  // New stairs start from the settings of the last stair drawn or edited.
  let stairDefaults = { ...FP.stairs.DEFAULTS };
  function rememberStair(st) {
    const { width, shape, turn, side, rise, maxRiser, tread, gap, upper } = st;
    stairDefaults = { ...stairDefaults, width, shape, turn, side, rise, maxRiser, tread, gap, upper };
  }

  // The stair being drawn: from the clicked bottom corner toward the mouse, on the standard
  // angles unless Alt is held. A typed length is the first flight's run, which sets the tread.
  function stairDraftStair() {
    const d = app.stairDraft;
    const dx = mouse.x - d.start.x, dy = mouse.y - d.start.y;
    let a = Math.hypot(dx, dy) > 1e-6 ? Math.atan2(dy, dx) : 0;
    if (!mouse.alt) a = lockAngle(a, rad(app.settings().angleStep), []);
    // A stair drawn on the top floor goes down to the floor below; otherwise up.
    const goes = !M.floorOver(app.doc, app.floor()) && M.floorUnder(app.doc, app.floor()) ? 'down' : 'up';
    const st = FP.stairs.clean({ ...stairDefaults, x: d.start.x, y: d.start.y, rot: deg(a), side: d.side, risers: null, split: null, goes });
    const len = buffer ? app.parse(buffer) : null;
    if (len > 0) st.tread = len / FP.stairs.counts(st).first;
    return st;
  }

  function commitStair() {
    const st = { ...stairDraftStair(), id: M.uid('s') };
    if (buffer && !(app.parse(buffer) > 0)) {
      app.toast(`"${buffer}" is not a length. Try 120 or 10'.`, true);
      clearTyping();
      return;
    }
    app.floor().stairs.push(st);
    rememberStair(st);
    clearTyping();
    app.stairDraft = null;
    setTool('select');
    app.sel = [{ t: 'stair', id: st.id }];
    app.commit();
    app.emit('selection');
  }

  // Turns a stair about its middle.
  function rotateStair(st, by) {
    const g = FP.stairs.geometry(st);
    const pts = g.polys.flat();
    const cx = (Math.min(...pts.map((p) => p.x)) + Math.max(...pts.map((p) => p.x))) / 2;
    const cy = (Math.min(...pts.map((p) => p.y)) + Math.max(...pts.map((p) => p.y))) / 2;
    const r = rad(by), dx = st.x - cx, dy = st.y - cy;
    st.x = cx + dx * Math.cos(r) - dy * Math.sin(r);
    st.y = cy + dx * Math.sin(r) + dy * Math.cos(r);
    st.rot = (((st.rot + by) % 360) + 360) % 360;
  }

  // Remembers a Shift-locked direction when typing begins, since Shift+digit types a symbol
  // and most people let go of Shift to type.
  function typeChar(ch) {
    if (!buffer && mouse.shift && app.draw && app.tool !== 'shape') {
      const { start, target } = drawTarget();
      const m = G.dist(start, target);
      app.draw.lockDir = m > 1e-6 ? G.mul(G.sub(target, start), 1 / m) : null;
    }
    buffer += ch;
    app.requestRender();
  }

  function clearTyping() {
    buffer = '';
    if (app.draw) app.draw.lockDir = null;
    app.requestRender();
  }

  function commitGuide() {
    const { start, target } = drawTarget();
    if (G.dist(start, target) < MIN_WALL) return false;
    const floor = app.floor();
    const line = { id: M.uid('g'), a: { x: start.x, y: start.y }, b: { x: target.x, y: target.y } };
    const divider = app.lineKind === 'divider';
    if (divider) line.divider = true;
    floor.guides.push(line);
    clearTyping();
    // A divider ends when it reaches a wall; construction lines keep chaining.
    if (divider && (target.kind === 'node' || target.kind === 'wall' || target.kind === 'corner')) app.draw = null;
    else app.draw.start = { kind: 'free', x: target.x, y: target.y };
    app.commit();
    return true;
  }

  const commitDraw = () => (app.tool === 'guide' ? commitGuide() : commitSegment());

  function beginChain(t) {
    let side = app.wallSide;
    if (t.kind === 'node') {
      // Continuing off a single wall keeps the thickness on the same side as that wall.
      // With a partition also at this corner, the wall of the same type is the one being continued.
      const all = app.geo().idx.byNode.get(t.nodeId) || [];
      const walls = all.length > 1 ? all.filter((w) => w.type === app.wallType) : all;
      if (walls.length === 1) side = walls[0].b === t.nodeId ? walls[0].side : -walls[0].side;
    }
    app.draw = { start: t, chain: [], chainNodes: [], side, userFlipped: app.wallSide !== -1 };
    buffer = '';
  }

  function ensureNode(floor, t) {
    if (t.kind === 'node') return t.nodeId;
    if (t.kind === 'wall') {
      const host = { wallId: t.wallId, d: t.d, face: t.face };
      if (t.pinned) host.pinned = true;
      return M.addNode(floor, t.x, t.y, host).id;
    }
    return M.addNode(floor, t.x, t.y).id;
  }

  function commitSegment() {
    const d = app.draw;
    const floor = app.floor();
    const { start, target: raw } = drawTarget();
    const target = raw.kind === 'typed' ? exactSnap(raw, start.nodeId ? new Set([start.nodeId]) : null) : raw;
    if (G.dist(start, target) < MIN_WALL) return false;
    if (start.nodeId && start.nodeId === target.nodeId) return false;
    if (start.kind === 'wall' && target.kind === 'wall' && start.wallId === target.wallId) {
      app.toast('A wall cannot start and end on the same wall.', true);
      return false;
    }
    if (start.nodeId && target.nodeId && floor.walls.some((w) =>
      (w.a === start.nodeId && w.b === target.nodeId) || (w.b === start.nodeId && w.a === target.nodeId))) {
      app.toast('Those two corners are already connected.', true);
      return false;
    }
    const s = app.settings();
    const a = ensureNode(floor, start);
    const b = ensureNode(floor, target);
    const thickness = app.wallType === 'exterior' ? s.exteriorThickness : s.interiorThickness;
    const wall = M.addWall(floor, a, b, app.wallType, thickness, d.side);
    if (!d.chainNodes.length) d.chainNodes.push(a);
    d.chainNodes.push(b);
    d.chain.push(wall.id);

    const closed = d.chain.length >= 3 && b === d.chainNodes[0];
    if (closed && !d.userFlipped) orientLoopOutward(floor, d);

    const stop = target.kind === 'node' || target.kind === 'wall' || target.kind === 'corner';
    clearTyping();
    if (stop) app.draw = null;
    else d.start = { kind: 'node', nodeId: b, x: target.x, y: target.y };
    app.commit();
    return true;
  }

  // A traced room's thickness belongs outside it, whichever direction the room was traced.
  function orientLoopOutward(floor, d) {
    const idx = G.buildIndex(floor);
    let area = 0;
    for (let i = 0; i < d.chainNodes.length - 1; i++) {
      const p = idx.nodes.get(d.chainNodes[i]), q = idx.nodes.get(d.chainNodes[i + 1]);
      area += p.x * q.y - q.x * p.y;
    }
    const side = area > 0 ? -1 : 1; // positive area is clockwise on screen, where y points down
    for (const id of d.chain) idx.walls.get(id).side = side;
  }

  function endDrawing(switchToSelect) {
    if (app.tool === 'shape') finishPoly();
    app.draw = null;
    app.dimDraft = null;
    app.stairDraft = null;
    app.shapeDraft = null;
    buffer = '';
    if (switchToSelect) setTool('select');
    app.requestRender();
    app.emit('tool');
  }

  // kind: the wall type for 'wall', 'divider' for 'guide' to draw room dividers, or for
  // 'shape' which one: line, poly, rect, circle, ellipse or arc.
  function setTool(tool, kind) {
    if (app.place) app.place = null;
    if (app.tool === 'shape') finishPoly();
    app.draw = null;
    app.dimDraft = null;
    app.stairDraft = null;
    app.shapeDraft = null;
    buffer = '';
    app.tool = tool;
    if (tool === 'shape') app.shapeKind = SHAPE_TOOLS.includes(kind) ? kind : 'line';
    if (tool === 'wall' && kind) app.wallType = kind;
    if (tool === 'guide') app.lineKind = kind === 'divider' ? 'divider' : 'guide';
    if (tool === 'wall') app.wallSide = -1;
    if (tool !== 'select') app.select([]);
    app.emit('tool');
    updateCursor();
    app.requestRender();
  }

  // ---------- Fixtures and openings: placement rules ----------

  // Every wall face, with m pointing away from the wall.
  function wallFaces() {
    const geo = app.geo();
    const faces = [];
    for (const w of app.floor().walls) {
      const f = G.wallFrame(w, geo.idx);
      if (f.len < 1e-6) continue;
      faces.push({ base: f.a, u: f.u, m: G.neg(f.ns), f });
      faces.push({ base: G.add(f.a, f.off), u: f.u, m: f.ns, f });
    }
    return faces;
  }

  // Corners where wall edges meet, and construction line ends: points edges can line up with.
  function alignPoints() {
    const geo = app.geo();
    const pts = [];
    for (const w of app.floor().walls) {
      const j = geo.joins.get(w.id);
      if (j) pts.push(j.refA, j.refB, j.farA, j.farB);
    }
    for (const g of guideList()) pts.push(g.a, g.b);
    return pts;
  }

  const closestOnSegment = (p, a, b) => {
    const ab = G.sub(b, a), l2 = G.dot(ab, ab);
    const t = l2 ? clamp(G.dot(G.sub(p, a), ab) / l2, 0, 1) : 0;
    return G.add(a, G.mul(ab, t));
  };

  // Lines a fixture up along its own two axes: a side against a wall face square to it, or a
  // side or its centre on a construction line or level with a wall corner. With `back`, the
  // face it is flush against, it only slides along that face.
  function alignFixture(fx, faces, back) {
    const thr = SNAP_PX / scale();
    const faceReach = Math.max(8, thr);
    const c = { x: fx.x, y: fx.y };
    const r = rad(fx.rot);
    const axes = [
      { dir: { x: Math.cos(r), y: Math.sin(r) }, half: fx.w / 2 },
      { dir: { x: -Math.sin(r), y: Math.cos(r) }, half: fx.d / 2 },
    ].filter((ax) => !back || Math.abs(G.dot(ax.dir, back.u)) > 0.99);
    const span = Math.hypot(fx.w, fx.d) / 2;
    const points = alignPoints().filter((p) => G.dist(p, c) <= span + thr);
    const guides = guideList();
    const hints = [];
    let shift = { x: 0, y: 0 };
    for (const ax of axes) {
      let best = null;
      const consider = (delta, p, limit) => {
        if (Math.abs(delta) <= limit && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, p };
      };
      for (const face of faces) {
        if (face === back || Math.abs(G.dot(face.u, ax.dir)) > 0.01) continue;
        const end = G.add(face.base, G.mul(face.u, face.f.len));
        if (G.distToSegment(c, face.base, end) > span + faceReach) continue;
        // The side nearest the face meets it, keeping the fixture out of the wall.
        const side = G.dot(face.m, ax.dir) > 0 ? -1 : 1;
        consider(G.dot(G.sub(face.base, c), ax.dir) - side * ax.half, closestOnSegment(c, face.base, end), faceReach);
      }
      for (const g of guides) {
        const len = G.dist(g.a, g.b);
        if (len < 1e-6 || Math.abs(G.dot(G.sub(g.b, g.a), ax.dir)) / len > 0.01) continue;
        if (G.distToSegment(c, g.a, g.b) > span + thr) continue;
        const s = G.dot(G.sub(g.a, c), ax.dir);
        const on = closestOnSegment(c, g.a, g.b);
        for (const e of [-ax.half, 0, ax.half]) consider(s - e, on, thr);
      }
      for (const p of points) {
        const s = G.dot(G.sub(p, c), ax.dir);
        for (const e of [-ax.half, 0, ax.half]) consider(s - e, p, thr);
      }
      if (best) {
        shift = G.add(shift, G.mul(ax.dir, best.delta));
        hints.push(best.p);
      }
    }
    fx.x = c.x + shift.x;
    fx.y = c.y + shift.y;
    return hints;
  }

  // Snaps a fixture flush to the nearest wall face it backs onto, turning it to match, then
  // lines its sides up with nearby walls, corners and construction lines. Alt places freely.
  function snapFixtureToWalls(fx) {
    app.snapHint = null;
    if (mouse.alt) return false;
    const reach = Math.max(8, SNAP_PX / scale());
    const faces = wallFaces();
    let best = null;
    for (const face of faces) {
      const rel = G.sub(fx, face.base);
      const along = G.dot(rel, face.u);
      if (along < 0 || along > face.f.len) continue;
      const gap = G.dot(rel, face.m) - fx.d / 2;
      if (Math.abs(gap) > reach) continue;
      if (!best || Math.abs(gap) < Math.abs(best.gap)) best = { face, gap, along };
    }
    if (best) {
      const { face } = best;
      fx.rot = (deg(Math.atan2(-face.m.x, face.m.y)) + 360) % 360;
      const c = G.add(G.add(face.base, G.mul(face.u, best.along)), G.mul(face.m, fx.d / 2));
      fx.x = c.x;
      fx.y = c.y;
    }
    const hints = alignFixture(fx, faces, best ? best.face : null);
    app.snapHint = hints.length ? hints : null;
    return !!best;
  }

  // Places along a wall that a door or window's edges or centre can line up with: where wall
  // edges meet its faces (its corners and T walls) and where construction lines cross it.
  function openingStops(wall) {
    const geo = app.geo();
    const f = G.wallFrame(wall, geo.idx);
    const stops = [];
    for (const p of alignPoints()) {
      const rel = G.sub(p, f.a);
      const across = G.dot(rel, f.ns);
      if (Math.abs(across) > 1e-3 && Math.abs(across - f.t) > 1e-3) continue;
      const along = G.dot(rel, f.u);
      if (along >= -1e-3 && along <= f.len + 1e-3) stops.push({ d: along, p });
    }
    for (const g of guideList()) {
      for (const off of [{ x: 0, y: 0 }, f.off]) {
        const X = segmentCross(g.a, g.b, G.add(f.a, off), G.add(f.b, off));
        if (X) stops.push({ d: G.dot(G.sub(X, f.a), f.u), p: X });
      }
    }
    return stops;
  }

  // Where along the wall a door or window goes: an edge or its centre snaps to a stop nearby,
  // otherwise it follows the grid. Alt places it freely.
  function snapOpening(wall, along, width) {
    app.snapHint = null;
    if (mouse.alt) return along;
    const thr = SNAP_PX / scale();
    let best = null;
    for (const s of openingStops(wall)) {
      for (const off of [-width / 2, 0, width / 2]) {
        const delta = s.d - (along + off);
        if (Math.abs(delta) <= thr && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, p: s.p };
      }
    }
    if (!best) return roundGrid(along);
    app.snapHint = [best.p];
    return along + best.delta;
  }

  function updatePlacement() {
    const place = app.place;
    if (!place) return;
    const world = { x: mouse.x, y: mouse.y };
    if (place.cat === 'furniture') {
      place.at = { x: roundGrid(world.x), y: roundGrid(world.y) };
      place.preview = FP.shapes.fromPiece(place.piece, place.at, () => 'preview');
      app.snapHint = null;
    } else if (place.cat === 'fixture') {
      const fx = place.preview;
      fx.x = roundGrid(world.x);
      fx.y = roundGrid(world.y);
      fx.rot = place.baseRot || 0;
      snapFixtureToWalls(fx);
    } else {
      const hit = wallHit(world, 30 / scale());
      app.snapHint = null;
      if (hit) {
        const halfW = place.preview.width / 2;
        const d = clamp(snapOpening(hit.wall, hit.along, place.preview.width), halfW, Math.max(halfW, hit.f.len - halfW));
        place.preview.wallId = hit.wall.id;
        place.preview.d = d;
        place.lockedWall = !!hit.wall.locked;
        place.valid = !place.lockedWall && M.openingFits(app.floor(), hit.wall.id, d, place.preview.width);
      } else {
        place.preview.wallId = null;
        place.valid = false;
      }
    }
    app.requestRender();
  }

  function beginPlace(desc, e) {
    setTool('select');
    if (desc.cat === 'furniture') {
      desc.piece = (app.doc.furniture || []).find((x) => x.id === desc.pieceId);
      if (!desc.piece) return;
      desc.preview = [];
    } else if (desc.cat === 'fixture') {
      desc.preview = { kind: desc.kind, name: desc.name, customId: desc.customId, x: 0, y: 0, rot: 0, w: desc.w, d: desc.d };
    } else {
      const info = M.OPENING_KINDS[desc.kind];
      const width = desc.width || info.width;
      desc.preview = { kind: desc.kind, width, d: 0, wallId: null, flipHinge: false, flipSwing: false, panels: desc.kind === 'bifold' && width >= 48 ? 2 : 1 };
    }
    desc.pressed = !!e;
    desc.startX = e ? e.clientX : 0;
    desc.startY = e ? e.clientY : 0;
    desc.moved = false;
    app.place = desc;
    document.body.classList.add('placing');
    updatePlacement();
    if (!e) app.toast('Click on the plan to place it. Right-click cancels.');
  }

  function endPlace() {
    app.place = null;
    document.body.classList.remove('placing');
    app.requestRender();
  }

  function finishPlace() {
    const place = app.place;
    const floor = app.floor();
    if (place.cat === 'furniture') {
      // A piece of several shapes lands as a group, so it moves and turns as one.
      const shapes = FP.shapes.fromPiece(place.piece, place.at, M.uid);
      const gid = shapes.length > 1 ? M.uid('grp') : null;
      for (const sh of shapes) { if (gid) sh.group = gid; floor.shapes.push(sh); }
      endPlace();
      app.sel = shapes.map((sh) => ({ t: 'shape', id: sh.id }));
      app.commit();
      app.emit('selection');
      return;
    }
    if (place.cat === 'fixture') {
      const fx = { ...place.preview, id: M.uid('x') };
      floor.fixtures.push(fx);
      endPlace();
      app.sel = [{ t: 'fixture', id: fx.id }];
      app.commit();
      app.emit('selection');
      return;
    }
    if (!place.valid) {
      app.toast(place.lockedWall ? 'That wall is locked. Unlock it (Ctrl+L) to add doors or windows.'
        : place.preview.wallId ? 'That opening does not fit there.' : 'Doors and windows must be dropped on a wall.', true);
      endPlace();
      return;
    }
    const op = { ...place.preview, id: M.uid('o') };
    floor.openings.push(op);
    endPlace();
    app.sel = [{ t: 'opening', id: op.id }];
    app.commit();
    app.emit('selection');
  }

  // ---------- Hit testing ----------

  function fixtureHandles(fx) {
    const list = [];
    for (const hx of [-1, 0, 1]) {
      for (const hy of [-1, 0, 1]) {
        if (hx || hy) list.push({ hx, hy, p: toWorld(fx, { x: (hx * fx.w) / 2, y: (hy * fx.d) / 2 }) });
      }
    }
    return list;
  }
  const isSnapPoint = (t) => !!t && !['grid', 'free', 'angle', 'typed'].includes(t.kind);
  const rotateHandlePos = (fx) => toWorld(fx, { x: 0, y: fx.d / 2 + 26 / scale() });

  const byId = (list, id) => list.find((x) => x.id === id);

  function selectedSingle(type) {
    if (app.sel.length !== 1 || app.sel[0].t !== type) return null;
    return M.itemOf(app.floor(), app.sel[0]);
  }

  // A selected line, polyline or arc's draggable points.
  function shapePointHandles(sh) {
    if (sh.kind === 'line') return [{ key: 'a', p: sh.a }, { key: 'b', p: sh.b }];
    if (sh.kind === 'arc') return [{ key: 'a', p: sh.a }, { key: 'b', p: sh.b }, { key: 'm', p: sh.m }];
    if (sh.kind === 'poly') return sh.pts.map((p, i) => ({ key: i, p }));
    return [];
  }

  // ---------- Locks and groups ----------

  const itemWord = (n) => `${n} item${n === 1 ? '' : 's'}`;
  const lockedItem = (s) => M.isLocked(app.floor(), s);

  // The items an edit may change. When some of the selection is locked, the edit is refused
  // with an explanation, unless `override` (Ctrl) is held: then only the unlocked items change.
  // how: how to override, e.g. 'hold Ctrl while you drag'.
  function editableSel(verb, override, how, list) {
    const sel = list || app.sel;
    const floor = app.floor();
    const locked = sel.filter((s) => M.holdsLocked(floor, s));
    if (!locked.length) return sel;
    const free = sel.filter((s) => !M.holdsLocked(floor, s));
    if (override && free.length) return free;
    if (!free.length) {
      const what = sel.length === 1 ? (locked[0].t === 'wall' && !M.isLocked(floor, locked[0]) ? 'A door or window in this wall is' : locked[0].t === 'node' ? 'This corner\'s walls are' : 'This is') : 'The selection is';
      app.toast(`${what} locked. Unlock it (Ctrl+L) to ${verb} it.`, true);
    } else {
      const n = locked.length;
      app.toast(`${n} of the selected items ${n === 1 ? 'is' : 'are'} locked. Unlock ${n === 1 ? 'it' : 'them'} (Ctrl+L), or ${how} to ${verb} only the unlocked ones.`, true);
    }
    return null;
  }

  // The group id when the selection is exactly one whole group, otherwise null.
  function selectedGroup() {
    if (app.sel.length < 2) return null;
    const floor = app.floor();
    const first = M.itemOf(floor, app.sel[0]);
    const gid = first && first.group;
    if (!gid || !app.sel.every((s) => { const x = M.itemOf(floor, s); return x && x.group === gid; })) return null;
    return M.groupMembers(floor, gid).length === app.sel.length ? gid : null;
  }

  // The selected group's box and its handles, or null when no whole group is selected or
  // every member is locked.
  function groupFrame() {
    if (!selectedGroup() || app.sel.every(lockedItem)) return null;
    const b = FP.groups.bounds(app.floor(), app.geo(), app.sel);
    if (!b) return null;
    const pad = 6 / scale();
    const box = { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
    const cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2;
    const handles = [];
    for (const hx of [-1, 0, 1]) {
      for (const hy of [-1, 0, 1]) {
        if (!hx && !hy) continue;
        handles.push({ hx, hy, p: { x: hx < 0 ? box.minX : hx > 0 ? box.maxX : cx, y: hy < 0 ? box.minY : hy > 0 ? box.maxY : cy } });
      }
    }
    return { b, box, center: { x: cx, y: cy }, handles, rotate: { x: cx, y: box.minY - 26 / scale() } };
  }

  function setLocked(lock, items) {
    const floor = app.floor();
    let n = 0;
    for (const s of items || app.sel) {
      if (!M.LOCKABLE.has(s.t)) continue;
      const x = M.itemOf(floor, s);
      if (!x) continue;
      if (lock) x.locked = true; else delete x.locked;
      n++;
    }
    if (!n) { app.toast(app.sel.length ? 'Corners lock with their walls. Select a wall to lock it.' : 'Select something to lock first.'); return; }
    app.commit();
    app.emit('selection');
    app.toast(`${lock ? 'Locked' : 'Unlocked'} ${itemWord(n)}.`);
  }

  // Ctrl+L: unlocks when everything selected is locked, otherwise locks it all.
  function toggleLock() {
    const items = app.sel.filter((s) => M.LOCKABLE.has(s.t));
    setLocked(!(items.length && items.every(lockedItem)), items.length ? items : app.sel);
  }

  function groupSelection() {
    const floor = app.floor();
    const items = app.sel.filter((s) => M.GROUPABLE.has(s.t) && M.itemOf(floor, s));
    if (items.length < 2) {
      app.toast('Select two or more items to group. Doors, windows and rooms go with their walls.');
      return;
    }
    const gid = M.uid('grp');
    for (const s of items) M.itemOf(floor, s).group = gid;
    app.sel = items;
    app.commit();
    app.emit('selection');
    app.toast(`Grouped ${itemWord(items.length)}.`);
  }

  // Ungroups whatever groups the selection is in. With one member picked out of a group,
  // only that member leaves it.
  function ungroupSelection() {
    const floor = app.floor();
    const items = app.sel.map((s) => M.itemOf(floor, s)).filter((x) => x && x.group);
    if (!items.length) { app.toast('Nothing selected is in a group.'); return; }
    for (const x of items) delete x.group;
    app.commit();
    app.emit('selection');
    app.toast(items.length === 1 ? 'Removed from its group.' : 'Ungrouped.');
  }

  // Ctrl+M: merges the selected wall segments into one wall. Other selected items are ignored.
  function mergeSelection() {
    const ids = app.sel.filter((s) => s.t === 'wall').map((s) => s.id);
    if (ids.length < 2) {
      app.toast('Select two or more wall segments that form one straight wall, then merge them (Ctrl+M).');
      return;
    }
    const res = FP.merge.mergeWalls(app.floor(), ids);
    if (!res.ok) {
      if (res.wallId) { app.sel = [{ t: 'wall', id: res.wallId }]; app.emit('selection'); }
      app.toast(res.msg, true);
      return;
    }
    app.sel = [{ t: 'wall', id: res.wallId }];
    app.commit();
    app.emit('selection');
    app.toast(`Merged ${FP.merge.segWord(res.count)} into one wall.`);
  }

  // Merges every straight run of segments on the floor.
  function mergeAllWalls() {
    const res = FP.merge.mergeAll(app.floor());
    if (!res.runs) { app.toast('No walls on this floor are drawn in separate in-line segments.'); return; }
    app.sel = [];
    app.commit();
    app.emit('selection');
    app.toast(`Merged ${FP.merge.segWord(res.segments)} into ${res.runs} wall${res.runs === 1 ? '' : 's'}. Undo (Ctrl+Z) to put them back.`);
  }

  function fixtureContains(fx, p, pad) {
    const l = toLocal(fx, p);
    return Math.abs(l.x) <= fx.w / 2 + pad && Math.abs(l.y) <= fx.d / 2 + pad;
  }

  function labelBox(l) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = `500 ${l.size}px system-ui, sans-serif`;
    const w = ctx.measureText(l.text || ' ').width;
    ctx.restore();
    return { hw: w / 2, hh: l.size * 0.6 };
  }

  function hitTest(world) {
    const floor = app.floor();
    const geo = app.geo();
    const px = 1 / scale();

    const gf = groupFrame();
    if (gf) {
      if (G.dist(world, gf.rotate) <= HANDLE_PX * px) return { t: 'group-rotate' };
      for (const h of gf.handles) {
        if (G.dist(world, h.p) <= HANDLE_PX * px) return { t: 'group-scale', hx: h.hx, hy: h.hy };
      }
    }

    const fxSel = selectedSingle('fixture');
    if (fxSel) {
      if (!fxSel.locked) {
        if (G.dist(world, rotateHandlePos(fxSel)) <= HANDLE_PX * px) return { t: 'fixture-rotate', id: fxSel.id };
        for (const h of fixtureHandles(fxSel)) {
          if (G.dist(world, h.p) <= HANDLE_PX * px) return { t: 'fixture-resize', id: fxSel.id, hx: h.hx, hy: h.hy };
        }
      }
      if (fixtureContains(fxSel, world, 0)) return { t: 'fixture', id: fxSel.id };
    }

    const shSel = selectedSingle('shape');
    if (shSel && !shSel.locked) {
      if (FP.shapes.boxed(shSel)) {
        if (G.dist(world, rotateHandlePos(shSel)) <= HANDLE_PX * px) return { t: 'shape-rotate', id: shSel.id };
        for (const h of fixtureHandles(shSel)) {
          if (G.dist(world, h.p) <= HANDLE_PX * px) return { t: 'shape-resize', id: shSel.id, hx: h.hx, hy: h.hy };
        }
      } else {
        for (const h of shapePointHandles(shSel)) {
          if (G.dist(world, h.p) <= HANDLE_PX * px) return { t: 'shape-pt', id: shSel.id, key: h.key };
        }
      }
    }

    const dimSel = selectedSingle('dim');
    if (dimSel && !dimSel.locked) {
      const e = Rn.dimGeometry(floor, dimSel, geo.idx);
      if (G.dist(world, e.a) <= HANDLE_PX * px) return { t: 'dim-end', id: dimSel.id, end: 'a' };
      if (G.dist(world, e.b) <= HANDLE_PX * px) return { t: 'dim-end', id: dimSel.id, end: 'b' };
    }

    const guideSel = selectedSingle('guide');
    if (guideSel && !guideSel.locked) {
      if (G.dist(world, guideSel.a) <= HANDLE_PX * px) return { t: 'guide-end', id: guideSel.id, end: 'a' };
      if (G.dist(world, guideSel.b) <= HANDLE_PX * px) return { t: 'guide-end', id: guideSel.id, end: 'b' };
    }

    for (const op of floor.openings) {
      const wall = geo.idx.walls.get(op.wallId);
      if (!wall) continue;
      const f = G.wallFrame(wall, geo.idx);
      const rel = G.sub(world, f.a);
      const along = G.dot(rel, f.u), perp = G.dot(rel, f.ns);
      if (Math.abs(along - op.d) <= op.width / 2 && perp >= -4 * px && perp <= f.t + 4 * px) return { t: 'opening', id: op.id };
    }

    for (let i = floor.labels.length - 1; i >= 0; i--) {
      const l = floor.labels[i];
      const r = rad(l.rot), dx = world.x - l.x, dy = world.y - l.y;
      const lx = dx * Math.cos(r) + dy * Math.sin(r), ly = -dx * Math.sin(r) + dy * Math.cos(r);
      const box = labelBox(l);
      if (Math.abs(lx) <= box.hw && Math.abs(ly) <= box.hh) return { t: 'label', id: l.id };
    }

    const n = nodeAt(world, HANDLE_PX * px);
    if (n) return { t: 'node', id: n.id };

    // A shape's outline, then (after fixtures, dimensions and lines) inside a closed one.
    const shapes = floor.shapes || [];
    for (let i = shapes.length - 1; i >= 0; i--) {
      if (FP.shapes.outlineDistance(shapes[i], world) <= 5 * px) return { t: 'shape', id: shapes[i].id };
    }

    for (let i = floor.fixtures.length - 1; i >= 0; i--) {
      if (fixtureContains(floor.fixtures[i], world, 0)) return { t: 'fixture', id: floor.fixtures[i].id };
    }

    for (const dim of floor.dims) {
      const e = Rn.dimGeometry(floor, dim, geo.idx);
      if (G.distToSegment(world, e.p, e.q) <= 6 * px) return { t: 'dim', id: dim.id };
    }

    for (const g of guideList()) {
      if (G.distToSegment(world, g.a, g.b) <= 5 * px) return { t: 'guide', id: g.id };
    }

    for (let i = shapes.length - 1; i >= 0; i--) {
      if (FP.shapes.contains(shapes[i], world)) return { t: 'shape', id: shapes[i].id };
    }

    // Faded or hidden stairs let clicks through to what's under them.
    const stairsLive = !app.view.stairs || app.view.stairs === 'show';
    for (let i = stairsLive ? (floor.stairs || []).length - 1 : -1; i >= 0; i--) {
      if (FP.stairs.contains(floor.stairs[i], world)) return { t: 'stair', id: floor.stairs[i].id };
    }

    if (geo.shown) {
      for (const rec of floor.rooms) {
        if (!geo.shown.get(rec.id)) continue;
        if (Math.abs(world.x - rec.x) <= 45 * px && Math.abs(world.y - rec.y) <= 18 * px) return { t: 'room-label', id: rec.id };
      }
    }

    const hit = wallHit(world, 3 * px);
    if (hit) return { t: 'wall', id: hit.wall.id };

    if (geo.shown && geo.detected.labelAt) {
      const label = geo.detected.labelAt(world.x, world.y);
      for (const rec of floor.rooms) {
        const region = geo.shown.get(rec.id);
        if (region && region.label === label) return { t: 'room', id: rec.id };
      }
    }
    return null;
  }

  const selectionKind = (hit) => {
    if (hit.t === 'group-scale' || hit.t === 'group-rotate') return null;
    if (hit.t === 'room-label') return 'room';
    if (hit.t === 'fixture-rotate' || hit.t === 'fixture-resize') return 'fixture';
    if (hit.t === 'dim-end') return 'dim';
    if (hit.t === 'guide-end') return 'guide';
    if (hit.t.startsWith('shape-')) return 'shape';
    return hit.t;
  };

  // ---------- Dragging ----------

  function setNodePos(floor, idx, node, p) {
    if (node.host) {
      const wall = idx.walls.get(node.host.wallId);
      if (wall) {
        const f = G.wallFrame(wall, idx);
        node.host.d = clamp(G.dot(G.sub(p, f.a), f.u), 0, f.len);
        return;
      }
    }
    node.x = p.x;
    node.y = p.y;
  }

  function groupSnapshot(list) {
    const floor = app.floor();
    const idx = G.buildIndex(floor);
    const nodeIds = new Set();
    const group = { nodes: [], fixtures: [], labels: [], dims: [], guides: [], stairs: [], shapes: [] };
    for (const s of list || app.sel) {
      if (s.t === 'stair') {
        const st = byId(floor.stairs, s.id);
        if (st) group.stairs.push({ st, x: st.x, y: st.y });
      } else if (s.t === 'wall') {
        const w = idx.walls.get(s.id);
        if (w) { nodeIds.add(w.a); nodeIds.add(w.b); }
      } else if (s.t === 'node') nodeIds.add(s.id);
      else if (s.t === 'fixture') {
        const fx = byId(floor.fixtures, s.id);
        if (fx) group.fixtures.push({ fx, x: fx.x, y: fx.y });
      } else if (s.t === 'label') {
        const l = byId(floor.labels, s.id);
        if (l) group.labels.push({ l, x: l.x, y: l.y });
      } else if (s.t === 'dim') {
        const dim = byId(floor.dims, s.id);
        if (dim) group.dims.push({ dim, a: { ...dim.a }, b: { ...dim.b } });
      } else if (s.t === 'guide') {
        const g = byId(floor.guides, s.id);
        if (g) group.guides.push({ g, a: { ...g.a }, b: { ...g.b } });
      } else if (s.t === 'shape') {
        const sh = byId(floor.shapes, s.id);
        if (sh) group.shapes.push({ sh, from: clone(sh) });
      }
    }
    for (const id of nodeIds) {
      const n = idx.nodes.get(id);
      group.nodes.push({ n, x: n.x, y: n.y });
    }
    return group;
  }

  function applyGroupDelta(group, dx, dy) {
    const floor = app.floor();
    const idx = G.buildIndex(floor);
    for (const g of group.nodes) setNodePos(floor, idx, g.n, { x: g.x + dx, y: g.y + dy });
    for (const g of group.fixtures) { g.fx.x = g.x + dx; g.fx.y = g.y + dy; }
    for (const g of group.labels) { g.l.x = g.x + dx; g.l.y = g.y + dy; }
    for (const g of group.stairs) { g.st.x = g.x + dx; g.st.y = g.y + dy; }
    for (const g of group.shapes) FP.shapes.place(g.sh, g.from, (p) => ({ x: p.x + dx, y: p.y + dy }));
    for (const g of group.guides) {
      g.g.a = { x: g.a.x + dx, y: g.a.y + dy };
      g.g.b = { x: g.b.x + dx, y: g.b.y + dy };
    }
    for (const g of group.dims) {
      for (const end of ['a', 'b']) {
        const e = g[end];
        if (e.item) {
          // Moving a dimension along with its item: its starting point moves too, so it stays.
          if (e.base && movesWith(group, idx, e.item)) g.dim[end].base = { ...e.base, x: e.base.x + dx, y: e.base.y + dy };
        } else if (!e.nodeId) { g.dim[end].x = e.x + dx; g.dim[end].y = e.y + dy; }
      }
    }
    app.touch();
  }

  // Whether the item a dimension is attached to is part of a selection being moved.
  function movesWith(group, idx, ref) {
    if (ref.t === 'fixture') return group.fixtures.some((g) => g.fx.id === ref.id);
    if (ref.t === 'stair') return group.stairs.some((g) => g.st.id === ref.id);
    if (ref.t === 'shape') return group.shapes.some((g) => g.sh.id === ref.id);
    const op = app.floor().openings.find((o) => o.id === ref.id);
    const wall = op && idx.walls.get(op.wallId);
    return !!wall && [wall.a, wall.b].every((id) => group.nodes.some((g) => g.n.id === id));
  }

  function beginDrag(hit, world) {
    const floor = app.floor();
    const geo = app.geo();
    const verb = ['group-scale', 'fixture-resize', 'shape-resize', 'shape-pt'].includes(hit.t) ? 'resize' : ['group-rotate', 'fixture-rotate', 'shape-rotate'].includes(hit.t) ? 'rotate' : 'move';
    const sel = editableSel(verb, mouse.ctrl, 'hold Ctrl while you drag');
    if (!sel) { if (press) press.blocked = true; return; }
    if (hit.t === 'group-scale' || hit.t === 'group-rotate') {
      const gf = groupFrame();
      if (!gf) return;
      const snap = FP.groups.snapshot(floor, sel);
      if (hit.t === 'group-scale') app.drag = { type: 'group-scale', snap, b: gf.b, hx: hit.hx, hy: hit.hy };
      else app.drag = { type: 'group-rotate', snap, center: gf.center, a0: deg(Math.atan2(world.y - gf.center.y, world.x - gf.center.x)), angle: 0 };
      return;
    }
    // Ctrl held over a partly locked selection: only the unlocked items move.
    if (sel !== app.sel) { app.drag = { type: 'group', group: groupSnapshot(sel), from: world }; return; }
    switch (hit.t) {
      case 'fixture': {
        if (app.sel.length > 1) { app.drag = { type: 'group', group: groupSnapshot(), from: world }; return; }
        const fx = byId(floor.fixtures, hit.id);
        app.drag = { type: 'fixture', fx, dx: fx.x - world.x, dy: fx.y - world.y };
        return;
      }
      case 'fixture-resize': {
        const fx = byId(floor.fixtures, hit.id);
        app.drag = { type: 'resize', fx, hx: hit.hx, hy: hit.hy, w0: fx.w, d0: fx.d, cx: fx.x, cy: fx.y };
        return;
      }
      case 'fixture-rotate':
        app.drag = { type: 'rotate', fx: byId(floor.fixtures, hit.id) };
        return;
      case 'opening':
        app.drag = { type: 'opening', op: byId(floor.openings, hit.id) };
        return;
      case 'stair': {
        if (app.sel.length > 1) { app.drag = { type: 'group', group: groupSnapshot(), from: world }; return; }
        const st = byId(floor.stairs, hit.id);
        app.drag = { type: 'stair', st, dx: st.x - world.x, dy: st.y - world.y };
        return;
      }
      case 'label': {
        if (app.sel.length > 1) { app.drag = { type: 'group', group: groupSnapshot(), from: world }; return; }
        const l = byId(floor.labels, hit.id);
        app.drag = { type: 'label', l, dx: l.x - world.x, dy: l.y - world.y };
        return;
      }
      case 'node': {
        // Locked walls at this corner keep a corner of their own and stay put.
        const walls = M.detachLocked(floor, hit.id);
        app.rev++;
        const idx = G.buildIndex(floor);
        const node = idx.nodes.get(hit.id);
        const excludeWalls = new Set(floor.walls.filter((w) => G.wouldCycle(idx, node.id, w.id)).map((w) => w.id));
        walls.forEach((w) => excludeWalls.add(w.id));
        app.drag = { type: 'node', node, walls, originalHost: node.host ? { ...node.host } : null, excludeWalls, target: null };
        return;
      }
      case 'wall': {
        if (!app.isSelected('wall', hit.id)) app.select([{ t: 'wall', id: hit.id }]);
        if (app.sel.length > 1) { app.drag = { type: 'group', group: groupSnapshot(), from: world }; return; }
        const wall = geo.idx.walls.get(hit.id);
        const f = G.wallFrame(wall, geo.idx);
        app.drag = { type: 'wall', group: groupSnapshot(), from: world, normal: f.n };
        return;
      }
      case 'guide':
      case 'shape':
        app.drag = { type: 'group', group: groupSnapshot(), from: world };
        return;
      case 'shape-pt':
        app.drag = { type: 'shape-pt', sh: byId(floor.shapes, hit.id), key: hit.key };
        return;
      case 'shape-resize': {
        const sh = byId(floor.shapes, hit.id);
        app.drag = { type: 'resize', fx: sh, hx: hit.hx, hy: hit.hy, w0: sh.w, d0: sh.d, cx: sh.x, cy: sh.y, min: MIN_WALL, circle: !!sh.circle };
        return;
      }
      case 'shape-rotate':
        app.drag = { type: 'rotate', fx: byId(floor.shapes, hit.id) };
        return;
      case 'guide-end':
        app.drag = { type: 'guide-end', g: byId(floor.guides, hit.id), end: hit.end };
        return;
      case 'dim':
        app.drag = { type: 'dim-offset', dim: byId(floor.dims, hit.id) };
        return;
      case 'dim-end':
        app.drag = { type: 'dim-end', dim: byId(floor.dims, hit.id), end: hit.end };
        return;
      case 'room-label': {
        const rec = byId(floor.rooms, hit.id);
        const region = geo.shown.get(rec.id);
        app.drag = { type: 'room-label', rec, label: region.label, dx: rec.x - world.x, dy: rec.y - world.y };
        return;
      }
      default:
    }
  }

  function updateDrag(world) {
    const d = app.drag;
    switch (d.type) {
      case 'fixture': {
        const fx = d.fx;
        fx.x = roundGrid(world.x + d.dx);
        fx.y = roundGrid(world.y + d.dy);
        snapFixtureToWalls(fx);
        app.requestRender();
        break;
      }
      case 'resize': {
        const fx = d.fx;
        const probe = { x: d.cx, y: d.cy, rot: fx.rot };
        const l = toLocal(probe, world);
        const min = d.min || MIN_FIXTURE;
        let w = d.hx ? Math.max(min, roundGrid((l.x + (d.hx * d.w0) / 2) * d.hx)) : d.w0;
        let dd = d.hy ? Math.max(min, roundGrid((l.y + (d.hy * d.d0) / 2) * d.hy)) : d.d0;
        // Shift on a corner keeps the proportions; a circle always does.
        if ((mouse.shift && d.hx && d.hy) || d.circle) {
          const k = d.hx && d.hy ? Math.max(w / d.w0, dd / d.d0) : d.hx ? w / d.w0 : dd / d.d0;
          w = d.w0 * k;
          dd = d.d0 * k;
        }
        const center = toWorld(probe, {
          x: d.hx ? (-d.hx * d.w0) / 2 + (d.hx * w) / 2 : 0,
          y: d.hy ? (-d.hy * d.d0) / 2 + (d.hy * dd) / 2 : 0,
        });
        fx.w = w; fx.d = dd; fx.x = center.x; fx.y = center.y;
        app.requestRender();
        break;
      }
      case 'stair': {
        // The bottom corner snaps like a wall end, so stairs sit tight against walls.
        const p = { x: world.x + d.dx, y: world.y + d.dy };
        const t = mouse.alt ? p : snap(p);
        d.st.x = t.x;
        d.st.y = t.y;
        app.rev++;
        app.requestRender();
        break;
      }
      case 'rotate': {
        const fx = d.fx;
        let a = deg(Math.atan2(world.y - fx.y, world.x - fx.x)) - 90;
        a = mouse.shift ? Math.round(a / 15) * 15 : Math.round(a);
        if (!mouse.shift && Math.abs(a - Math.round(a / 90) * 90) <= 3) a = Math.round(a / 90) * 90;
        fx.rot = ((a % 360) + 360) % 360;
        app.requestRender();
        break;
      }
      case 'opening': {
        const floor = app.floor();
        const op = d.op;
        let near = wallHit(world, 20 / scale());
        if (near && near.wall.locked && near.wall.id !== op.wallId) near = null; // locked walls take no new doors
        const geo = app.geo();
        const wall = near ? near.wall : geo.idx.walls.get(op.wallId);
        const f = G.wallFrame(wall, geo.idx);
        const along = near ? near.along : G.dot(G.sub(world, f.a), f.u);
        const nd = clamp(snapOpening(wall, along, op.width), op.width / 2, Math.max(op.width / 2, f.len - op.width / 2));
        if (M.openingFits(floor, wall.id, nd, op.width, op.id)) {
          op.wallId = wall.id;
          op.d = nd;
          app.rev++;
          app.requestRender();
        }
        break;
      }
      case 'label':
        d.l.x = roundGrid(world.x + d.dx);
        d.l.y = roundGrid(world.y + d.dy);
        app.requestRender();
        break;
      case 'node': updateNodeDrag(world); break;
      case 'wall': {
        let dx = world.x - d.from.x, dy = world.y - d.from.y;
        if (mouse.shift) {
          const k = G.dot({ x: dx, y: dy }, d.normal);
          dx = d.normal.x * k; dy = d.normal.y * k;
        }
        const first = d.group.nodes[0];
        const snapDx = first ? roundGrid(first.x + dx) - first.x : dx;
        const snapDy = first ? roundGrid(first.y + dy) - first.y : dy;
        applyGroupDelta(d.group, snapDx, snapDy);
        break;
      }
      case 'group':
        applyGroupDelta(d.group, roundGrid(world.x - d.from.x), roundGrid(world.y - d.from.y));
        break;
      case 'group-scale': {
        // Scales from the opposite side or corner. Shift on a corner keeps the proportions.
        const b = d.b, w0 = b.maxX - b.minX, h0 = b.maxY - b.minY;
        const ax = d.hx > 0 ? b.minX : b.maxX, ay = d.hy > 0 ? b.minY : b.maxY;
        let sx = 1, sy = 1;
        if (d.hx && w0 > 1e-6) sx = Math.max(MIN_FIXTURE, roundGrid(d.hx > 0 ? world.x - ax : ax - world.x)) / w0;
        if (d.hy && h0 > 1e-6) sy = Math.max(MIN_FIXTURE, roundGrid(d.hy > 0 ? world.y - ay : ay - world.y)) / h0;
        if (mouse.shift && d.hx && d.hy) { const k = Math.max(sx, sy); sx = k; sy = k; }
        FP.groups.scale(app.floor(), d.snap, { x: ax, y: ay }, sx, sy);
        d.size = { w: w0 * sx, h: h0 * sy };
        app.touch();
        break;
      }
      case 'group-rotate': {
        let a = deg(Math.atan2(world.y - d.center.y, world.x - d.center.x)) - d.a0;
        a = mouse.shift ? Math.round(a / 15) * 15 : Math.round(a);
        if (!mouse.shift && Math.abs(a - Math.round(a / 90) * 90) <= 3) a = Math.round(a / 90) * 90;
        a = ((a % 360) + 360) % 360;
        FP.groups.rotate(app.floor(), d.snap, d.center, a);
        d.angle = a;
        app.touch();
        break;
      }
      case 'guide-end': {
        const other = d.end === 'a' ? d.g.b : d.g.a;
        const t = snap(world, { from: other, shift: mouse.shift, excludeGuides: new Set([d.g.id]) });
        d.target = t;
        d.g[d.end] = { x: t.x, y: t.y };
        app.requestRender();
        break;
      }
      case 'shape-pt': {
        // A point of a line, polyline or arc. It snaps like a new shape's points, but not to its own.
        const sh = d.sh, k = d.key;
        let from = null;
        if (sh.kind === 'poly') from = sh.pts[k - 1] || sh.pts[k + 1] || null;
        else if (k !== 'm') from = k === 'a' ? sh.b : sh.a;
        const t = shapeSnap(world, from, sh.id);
        d.target = t;
        const p = { x: t.x, y: t.y };
        if (sh.kind === 'poly') sh.pts[k] = p;
        else if (sh.kind === 'arc') {
          // The middle bends the arc; an end moves and the arc keeps passing near its old middle.
          if (k === 'm') { const m = FP.shapes.arcMid(sh.a, sh.b, p); if (m) sh.m = m; }
          else {
            const was = sh[k];
            sh[k] = p;
            const m = FP.shapes.arcMid(sh.a, sh.b, sh.m);
            if (m && G.dist(sh.a, sh.b) >= MIN_WALL) sh.m = m; else sh[k] = was;
          }
        } else sh[k] = p;
        app.requestRender();
        break;
      }
      case 'dim-offset': {
        const e = Rn.dimGeometry(app.floor(), d.dim, app.geo().idx);
        d.dim.offset = roundGrid(G.dot(G.sub(world, e.a), e.n));
        app.requestRender();
        break;
      }
      case 'dim-end': {
        d.dim[d.end] = dimEndFor(dimSnap(world));
        app.requestRender();
        break;
      }
      case 'room-label': {
        const geo = app.geo();
        const nx = world.x + d.dx, ny = world.y + d.dy;
        if (geo.detected.labelAt(nx, ny) === d.label) {
          d.rec.x = nx; d.rec.y = ny; d.rec.moved = true;
          app.requestRender();
        }
        break;
      }
      default:
    }
    app.emit('live');
  }

  function updateNodeDrag(world) {
    const d = app.drag;
    const node = d.node;
    const excludeNodes = new Set([node.id]);
    const from = mouse.shift && d.walls.length === 1
      ? app.floor().nodes.find((n) => n.id === (d.walls[0].a === node.id ? d.walls[0].b : d.walls[0].a))
      : null;
    const t = snap(world, { excludeNodes, excludeWalls: d.excludeWalls, from, shift: mouse.shift });
    d.target = t;
    if (t.kind === 'wall') {
      node.host = { wallId: t.wallId, d: t.d, face: t.face };
      if (t.pinned) node.host.pinned = true;
    } else if (t.kind === 'node') {
      delete node.host;
      node.x = t.x; node.y = t.y;
    } else if (d.originalHost) {
      node.host = { ...d.originalHost };
      const idx = G.buildIndex(app.floor());
      setNodePos(app.floor(), idx, node, t);
    } else {
      delete node.host;
      node.x = t.x; node.y = t.y;
    }
    app.touch();
  }

  function finishDrag() {
    const d = app.drag;
    app.drag = null;
    if (d.type === 'node' && d.target && d.target.kind === 'node') {
      M.mergeNodes(app.floor(), d.target.nodeId, d.node.id);
      app.sel = app.sel.filter((s) => !(s.t === 'node' && s.id === d.node.id));
    }
    app.commit();
    app.emit('selection');
  }

  // ---------- Pointer events ----------

  function updateMouse(e) {
    const rect = canvas.getBoundingClientRect();
    mouse.sx = e.clientX - rect.left;
    mouse.sy = e.clientY - rect.top;
    mouse.x = (mouse.sx - app.view.ox) / scale();
    mouse.y = (mouse.sy - app.view.oy) / scale();
    mouse.inside = mouse.sx >= 0 && mouse.sy >= 0 && mouse.sx <= rect.width && mouse.sy <= rect.height;
    mouse.shift = e.shiftKey;
    mouse.alt = e.altKey;
    mouse.ctrl = e.ctrlKey || e.metaKey;
  }

  function onPointerDown(e) {
    canvas.focus({ preventScroll: true });
    updateMouse(e);
    const world = { x: mouse.x, y: mouse.y };

    if (e.button === 1 || (e.button === 0 && (spaceHeld || app.tool === 'pan'))) {
      panning = { sx: e.clientX, sy: e.clientY, ox: app.view.ox, oy: app.view.oy };
      updateCursor();
      e.preventDefault();
      return;
    }

    if (e.button === 2) {
      // Right click cancels the current action and returns to the select tool.
      if (app.place) { endPlace(); return; }
      if (app.drag) return;
      if (app.tool !== 'select') endDrawing(true);
      return;
    }
    if (e.button !== 0) return;

    if (app.place) {
      updatePlacement();
      finishPlace();
      return;
    }

    if (app.tool === 'wall' || app.tool === 'guide') {
      const fresh = !app.draw;
      if (fresh) beginChain(snap(world));
      else commitDraw();
      app.requestRender();
      return;
    }

    if (app.tool === 'shape') {
      shapeStep();
      app.requestRender();
      return;
    }

    if (app.tool === 'stairs') {
      if (!app.stairDraft) {
        const t = snap(world);
        app.stairDraft = { start: { x: t.x, y: t.y }, side: stairDefaults.side };
      } else commitStair();
      app.requestRender();
      return;
    }

    if (app.tool === 'dim') {
      // Three clicks: the start, the end, then where the dimension line goes.
      const draft = app.dimDraft;
      if (draft && draft.placing) {
        const dim = { id: M.uid('d'), a: draft.a, b: draft.b, offset: dimOffsetAt(draft, world) };
        app.floor().dims.push(dim);
        app.dimDraft = null;
        app.sel = [{ t: 'dim', id: dim.id }];
        app.commit();
        app.emit('selection');
        app.requestRender();
        return;
      }
      const t = dimSnap(world);
      const end = dimEndFor(t);
      if (!draft) app.dimDraft = end;
      else if (G.dist(draft, t) >= MIN_WALL) app.dimDraft = { a: draft, b: end, placing: true };
      app.requestRender();
      return;
    }

    if (app.tool === 'text') {
      const label = { id: M.uid('t'), x: roundGrid(world.x), y: roundGrid(world.y), text: 'Text', size: 8, rot: 0 };
      app.floor().labels.push(label);
      app.sel = [{ t: 'label', id: label.id }];
      setTool('select');
      app.sel = [{ t: 'label', id: label.id }];
      app.commit();
      app.emit('selection');
      app.emit('focus-text');
      return;
    }

    // Select tool
    const hit = hitTest(world);
    if (!hit) {
      if (!e.shiftKey) app.select([]);
      press = { marquee: true, sx: mouse.sx, sy: mouse.sy, world, base: e.shiftKey ? app.sel.slice() : [] };
      return;
    }
    const kind = selectionKind(hit);
    if (!kind) { press = { hit, sx: mouse.sx, sy: mouse.sy, world }; return; } // a group handle
    const id = hit.id;
    // A click takes in the whole group (a double-click then picks out one item: onDoubleClick).
    const members = M.expandGroups(app.floor(), [{ t: kind, id }]);
    const has = (s) => members.some((m) => m.t === s.t && m.id === s.id);
    if (e.shiftKey) {
      const already = app.isSelected(kind, id);
      app.select(already ? app.sel.filter((s) => !has(s)) : [...app.sel.filter((s) => !has(s)), ...members]);
      if (already) return;
    } else if (!app.isSelected(kind, id)) {
      app.select(members);
    }
    press = { hit, sx: mouse.sx, sy: mouse.sy, world };
  }

  function onPointerMove(e) {
    updateMouse(e);
    const world = { x: mouse.x, y: mouse.y };
    if (panning) {
      app.view.ox = panning.ox + (e.clientX - panning.sx);
      app.view.oy = panning.oy + (e.clientY - panning.sy);
      app.emit('view');
      app.requestRender();
      return;
    }
    if (app.place) {
      if (app.place.pressed && Math.hypot(e.clientX - app.place.startX, e.clientY - app.place.startY) > 6) app.place.moved = true;
      updatePlacement();
      return;
    }
    if (press && press.marquee) {
      press.current = world;
      app.requestRender();
      app.emit('cursor');
      return;
    }
    if (press && !press.blocked && !app.drag && Math.hypot(mouse.sx - press.sx, mouse.sy - press.sy) >= DRAG_START_PX) {
      beginDrag(press.hit, press.world);
    }
    if (app.drag) {
      updateDrag(world);
      app.emit('cursor');
      return;
    }
    if (mouse.inside && app.tool === 'select') {
      const hit = hitTest(world);
      const changed = JSON.stringify(hit) !== JSON.stringify(app.hover);
      app.hover = hit;
      if (changed) updateCursor();
    }
    app.emit('cursor');
    app.requestRender();
  }

  function onPointerUp(e) {
    updateMouse(e);
    if (panning) {
      panning = null;
      updateCursor();
      return;
    }
    if (app.place && app.place.pressed) {
      app.place.pressed = false;
      if (app.place.moved) {
        if (mouse.inside) finishPlace();
        else endPlace();
      } else {
        app.toast('Click on the plan to place it. Right-click cancels.');
      }
      return;
    }
    if (press && press.marquee) {
      if (press.current) finishMarquee(press);
      press = null;
      app.requestRender();
      return;
    }
    if (app.drag) finishDrag();
    press = null;
  }

  function finishMarquee(p) {
    const floor = app.floor();
    const geo = app.geo();
    const x0 = Math.min(p.world.x, p.current.x), x1 = Math.max(p.world.x, p.current.x);
    const y0 = Math.min(p.world.y, p.current.y), y1 = Math.max(p.world.y, p.current.y);
    const inside = (q) => q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1;
    const sel = p.base.slice();
    for (const w of floor.walls) {
      if (inside(geo.idx.nodes.get(w.a)) && inside(geo.idx.nodes.get(w.b))) sel.push({ t: 'wall', id: w.id });
    }
    for (const fx of floor.fixtures) if (inside(fx)) sel.push({ t: 'fixture', id: fx.id });
    for (const l of floor.labels) if (inside(l)) sel.push({ t: 'label', id: l.id });
    for (const st of floor.stairs) if (FP.stairs.geometry(st).polys.every((poly) => poly.every(inside))) sel.push({ t: 'stair', id: st.id });
    for (const g of guideList()) if (inside(g.a) && inside(g.b)) sel.push({ t: 'guide', id: g.id });
    for (const sh of floor.shapes || []) if (FP.shapes.outlinePoints(sh).every(inside)) sel.push({ t: 'shape', id: sh.id });
    for (const dim of floor.dims) {
      const e = M.dimEnds(floor, dim, geo.idx);
      if (inside(e.a) && inside(e.b)) sel.push({ t: 'dim', id: dim.id });
    }
    app.select(M.expandGroups(floor, sel));
  }

  // Double-clicking a member of a group selects just that item, to move or edit it alone.
  function onDoubleClick(e) {
    if (app.tool === 'shape' && app.shapeKind === 'poly') { finishPoly(); return; }
    if (app.tool !== 'select' || app.place || app.drag) return;
    updateMouse(e);
    const hit = hitTest({ x: mouse.x, y: mouse.y });
    const kind = hit && selectionKind(hit);
    if (!kind) return;
    if (M.expandGroups(app.floor(), [{ t: kind, id: hit.id }]).length > 1) app.select([{ t: kind, id: hit.id }]);
  }

  function onWheel(e) {
    e.preventDefault();
    updateMouse(e);
    app.zoomAt(mouse.sx, mouse.sy, Math.exp(-e.deltaY * 0.0015));
  }

  function updateCursor() {
    if (!canvas) return;
    let cursor = 'default';
    if (panning) cursor = 'grabbing';
    else if (spaceHeld || app.tool === 'pan') cursor = 'grab';
    else if (app.tool !== 'select') cursor = app.tool === 'text' ? 'text' : 'crosshair';
    else if (app.hover) {
      const t = app.hover.t;
      if (t === 'fixture-rotate' || t === 'group-rotate' || t === 'shape-rotate') cursor = 'alias';
      else if (t === 'group-scale') {
        const { hx, hy } = app.hover;
        cursor = !hy ? 'ew-resize' : !hx ? 'ns-resize' : hx === hy ? 'nwse-resize' : 'nesw-resize';
      } else if (selectionKind(app.hover) && lockedItem({ t: selectionKind(app.hover), id: app.hover.id })) cursor = 'default';
      else if (t === 'shape-pt') cursor = 'crosshair';
      else if (t === 'fixture-resize' || t === 'shape-resize') {
        const fx = selectedSingle(t === 'shape-resize' ? 'shape' : 'fixture');
        const a = fx ? ((deg(Math.atan2(app.hover.hy, app.hover.hx)) + fx.rot) % 180 + 180) % 180 : 0;
        cursor = a < 22.5 || a >= 157.5 ? 'ew-resize' : a < 67.5 ? 'nwse-resize' : a < 112.5 ? 'ns-resize' : 'nesw-resize';
      } else if (t !== 'room') cursor = 'move';
    }
    canvas.style.cursor = cursor;
  }

  // ---------- Keyboard ----------

  function isEditing(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable || t.closest('dialog'));
  }

  // override: delete only the unlocked items when some of the selection is locked (Ctrl).
  function deleteSelection(override) {
    if (!app.sel.length) return;
    const sel = editableSel('delete', override, 'press Ctrl+Delete');
    if (!sel) return;
    const floor = app.floor();
    let changed = false;
    for (const s of sel) {
      if (s.t === 'wall') { M.deleteWall(floor, s.id); changed = true; }
      else if (s.t === 'node') {
        // Locked walls at the corner stay.
        for (const w of floor.walls.filter((x) => (x.a === s.id || x.b === s.id) && !x.locked)) M.deleteWall(floor, w.id);
        changed = true;
      } else if (s.t === 'opening') { floor.openings = floor.openings.filter((o) => o.id !== s.id); changed = true; }
      else if (s.t === 'fixture') { floor.fixtures = floor.fixtures.filter((o) => o.id !== s.id); changed = true; }
      else if (s.t === 'dim') { floor.dims = floor.dims.filter((o) => o.id !== s.id); changed = true; }
      else if (s.t === 'label') { floor.labels = floor.labels.filter((o) => o.id !== s.id); changed = true; }
      else if (s.t === 'guide') { floor.guides = floor.guides.filter((o) => o.id !== s.id); changed = true; }
      else if (s.t === 'stair') { floor.stairs = floor.stairs.filter((o) => o.id !== s.id); changed = true; }
      else if (s.t === 'shape') { floor.shapes = floor.shapes.filter((o) => o.id !== s.id); changed = true; }
    }
    if (!changed) return;
    app.sel = app.sel.filter((s) => !sel.includes(s));
    app.commit();
    app.emit('selection');
  }

  // ---------- Copy, cut, paste and duplicate ----------

  // The copied items, as plain data independent of any floor, so they can be pasted on any
  // floor or into another drawing opened in the same window.
  let clipboard = null;
  let lastPaste = null;
  const clone = (x) => JSON.parse(JSON.stringify(x));

  // Copies the selection. Walls bring their corners and the doors and windows in them; a T
  // junction stays attached only when the wall it sits on is copied too.
  function buildClip() {
    const floor = app.floor();
    const idx = app.geo().idx;
    const clip = { walls: [], nodes: [], openings: [], loose: [], fixtures: [], labels: [], dims: [], guides: [], stairs: [], shapes: [] };
    const wallIds = new Set(app.sel.filter((s) => s.t === 'wall' && idx.walls.has(s.id)).map((s) => s.id));
    const nodeIds = new Set();
    for (const id of wallIds) {
      const w = idx.walls.get(id);
      clip.walls.push(clone(w));
      nodeIds.add(w.a);
      nodeIds.add(w.b);
    }
    for (const id of nodeIds) {
      const n = clone(idx.nodes.get(id));
      if (n.host && !wallIds.has(n.host.wallId)) delete n.host;
      clip.nodes.push(n);
    }
    for (const op of floor.openings) if (wallIds.has(op.wallId)) clip.openings.push(clone(op));
    for (const s of app.sel) {
      if (s.t === 'opening') {
        const op = byId(floor.openings, s.id);
        if (op && !wallIds.has(op.wallId)) clip.loose.push(clone(op));
      } else if (s.t === 'fixture') {
        const fx = byId(floor.fixtures, s.id);
        if (fx) clip.fixtures.push(clone(fx));
      } else if (s.t === 'stair') {
        const st = byId(floor.stairs, s.id);
        if (st) clip.stairs.push(clone(st));
      } else if (s.t === 'label') {
        const l = byId(floor.labels, s.id);
        if (l) clip.labels.push(clone(l));
      } else if (s.t === 'guide') {
        const g = byId(floor.guides, s.id);
        if (g) clip.guides.push(clone(g));
      } else if (s.t === 'shape') {
        const sh = byId(floor.shapes, s.id);
        if (sh) clip.shapes.push(clone(sh));
      }
    }
    // An end on a copied corner or item stays attached; otherwise it keeps its position.
    const copied = (ref) => ({ fixture: clip.fixtures, stair: clip.stairs, shape: clip.shapes }[ref.t] || clip.openings).some((x) => x.id === ref.id);
    for (const s of app.sel) {
      const dim = s.t === 'dim' && byId(floor.dims, s.id);
      if (!dim) continue;
      const ends = M.dimEnds(floor, dim, idx);
      const end = (e, p) => {
        if (e.nodeId && nodeIds.has(e.nodeId)) return { nodeId: e.nodeId, x: p.x, y: p.y };
        if (e.item && !dim.locked && copied(e.item)) return { ...clone(e), x: p.x, y: p.y };
        return { x: p.x, y: p.y };
      };
      clip.dims.push({ ...clone(dim), a: end(dim.a, ends.a), b: end(dim.b, ends.b) });
    }
    clip.count = clip.walls.length + clip.loose.length + clip.fixtures.length + clip.labels.length + clip.dims.length + clip.guides.length + clip.stairs.length + clip.shapes.length;
    return clip.count ? clip : null;
  }

  function clipCenter(clip) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const take = (p, r) => {
      minX = Math.min(minX, p.x - (r || 0)); maxX = Math.max(maxX, p.x + (r || 0));
      minY = Math.min(minY, p.y - (r || 0)); maxY = Math.max(maxY, p.y + (r || 0));
    };
    for (const n of clip.nodes) take(n);
    for (const fx of clip.fixtures) take(fx, Math.max(fx.w, fx.d) / 2);
    for (const l of clip.labels) take(l);
    for (const st of clip.stairs) for (const poly of FP.stairs.geometry(st).polys) poly.forEach((p) => take(p));
    for (const d of clip.dims) { take(d.a); take(d.b); }
    for (const g of clip.guides) { take(g.a); take(g.b); }
    for (const sh of clip.shapes || []) FP.shapes.outlinePoints(sh).forEach((p) => take(p));
    return Number.isFinite(minX) ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 } : null;
  }

  // Adds a copy of the clip to the current floor, moved by (dx, dy), and selects it.
  function insertClip(clip, dx, dy) {
    const floor = app.floor();
    // Copies come unlocked, and copied group members form a new group of their own.
    const groupMap = new Map();
    const own = (x) => {
      const out = { ...x };
      delete out.locked;
      if (x.group) {
        if (!groupMap.has(x.group)) groupMap.set(x.group, M.uid('grp'));
        out.group = groupMap.get(x.group);
      }
      return out;
    };
    const shift = (p) => ({ ...own(p), x: p.x + dx, y: p.y + dy });
    const nodeMap = new Map(), wallMap = new Map();
    for (const n of clip.nodes) nodeMap.set(n.id, M.uid('n'));
    for (const w of clip.walls) wallMap.set(w.id, M.uid('w'));
    const created = [];
    for (const n of clip.nodes) {
      const node = { ...shift(n), id: nodeMap.get(n.id) };
      if (n.host) node.host = { ...n.host, wallId: wallMap.get(n.host.wallId) };
      floor.nodes.push(node);
    }
    for (const w of clip.walls) {
      floor.walls.push({ ...own(w), id: wallMap.get(w.id), a: nodeMap.get(w.a), b: nodeMap.get(w.b) });
      created.push({ t: 'wall', id: wallMap.get(w.id) });
    }
    const itemMap = new Map(); // old item id -> its copy's id, for attached dimensions
    for (const op of clip.openings) {
      const copy = { ...own(op), id: M.uid('o'), wallId: wallMap.get(op.wallId) };
      itemMap.set(op.id, copy.id);
      floor.openings.push(copy);
    }
    for (const fx of clip.fixtures) {
      const copy = { ...shift(fx), id: M.uid('x') };
      itemMap.set(fx.id, copy.id);
      floor.fixtures.push(copy);
      created.push({ t: 'fixture', id: copy.id });
    }
    for (const l of clip.labels) {
      const copy = { ...shift(l), id: M.uid('t') };
      floor.labels.push(copy);
      created.push({ t: 'label', id: copy.id });
    }
    for (const st of clip.stairs) {
      const copy = { ...shift(st), id: M.uid('s') };
      itemMap.set(st.id, copy.id);
      floor.stairs.push(copy);
      created.push({ t: 'stair', id: copy.id });
    }
    for (const sh of clip.shapes || []) {
      const copy = { ...own(sh), id: M.uid('sh') };
      FP.shapes.translate(copy, dx, dy);
      itemMap.set(sh.id, copy.id);
      floor.shapes.push(copy);
      created.push({ t: 'shape', id: copy.id });
    }
    for (const g of clip.guides) {
      const copy = { ...own(g), id: M.uid('g'), a: shift(g.a), b: shift(g.b) };
      floor.guides.push(copy);
      created.push({ t: 'guide', id: copy.id });
    }
    for (const d of clip.dims) {
      const end = (e) => {
        if (e.nodeId) return { nodeId: nodeMap.get(e.nodeId), x: e.x + dx, y: e.y + dy };
        if (e.item && itemMap.has(e.item.id)) {
          return { item: { ...e.item, id: itemMap.get(e.item.id) }, base: { ...e.base, x: e.base.x + dx, y: e.base.y + dy }, x: e.x + dx, y: e.y + dy };
        }
        return { x: e.x + dx, y: e.y + dy };
      };
      const copy = { ...own(d), id: M.uid('d'), a: end(d.a), b: end(d.b) };
      floor.dims.push(copy);
      created.push({ t: 'dim', id: copy.id });
    }
    // Doors and windows copied without their wall go back on that wall beside the original,
    // if it is on this floor and there is room.
    let skipped = 0;
    for (const op of clip.loose) {
      const wall = floor.walls.find((w) => w.id === op.wallId);
      const len = wall ? G.wallFrame(wall, G.buildIndex(floor)).len : 0;
      const spot = [op.d + op.width + 6, op.d - op.width - 6].find((d) => d >= op.width / 2 && d <= len - op.width / 2 && M.openingFits(floor, op.wallId, d, op.width));
      if (spot == null) { skipped++; continue; }
      const copy = { ...own(op), id: M.uid('o'), d: spot };
      floor.openings.push(copy);
      created.push({ t: 'opening', id: copy.id });
    }
    if (!created.length) return 0;
    app.sel = created;
    app.commit();
    app.emit('selection');
    if (skipped) app.toast(`${skipped} door${skipped > 1 ? 's or windows' : ' or window'} had no room beside the original.`, true);
    return created.length;
  }

  function copySelection() {
    const clip = buildClip();
    if (!clip) { app.toast('Select something to copy first.'); return false; }
    clipboard = clip;
    lastPaste = null;
    app.toast(`Copied ${itemWord(clip.count)}.`);
    return true;
  }

  function cutSelection() {
    const clip = buildClip();
    if (!clip) { app.toast('Select something to cut first.'); return; }
    if (app.sel.some((s) => M.holdsLocked(app.floor(), s))) { app.toast('Part of the selection is locked, so it can\'t be cut. Copy it (Ctrl+C) or unlock it first.', true); return; }
    clipboard = clip;
    lastPaste = null;
    deleteSelection();
    app.toast(`Cut ${itemWord(clip.count)}.`);
  }

  // Pastes centred on the mouse, or in the original position with `inPlace`. Pasting again
  // without moving the mouse steps each copy along so they don't stack.
  function pasteClipboard(inPlace) {
    const clip = clipboard;
    if (!clip) { app.toast('Nothing has been copied yet.'); return; }
    if (clip.count === clip.loose.length) {
      // Doors and windows alone: drop the copy on any wall.
      if (clip.loose.length > 1) { app.toast('Copy doors and windows one at a time, or along with their walls.'); return; }
      const op = clip.loose[0];
      beginPlace({ cat: 'opening', kind: op.kind, width: op.width }, null);
      Object.assign(app.place.preview, { flipHinge: op.flipHinge, flipSwing: op.flipSwing, panels: op.panels });
      return;
    }
    const center = clipCenter(clip) || { x: 0, y: 0 };
    let target = inPlace ? { ...center } : mouse.inside ? { x: roundGrid(mouse.x), y: roundGrid(mouse.y) } : { x: center.x + 12, y: center.y + 12 };
    const key = `${inPlace ? 'here' : 'at'}:${target.x},${target.y}`;
    const repeat = lastPaste && lastPaste.clip === clip && lastPaste.key === key ? lastPaste.repeat + 1 : 0;
    if (!inPlace || repeat) target = { x: target.x + 12 * repeat, y: target.y + 12 * repeat };
    const n = insertClip(clip, target.x - center.x, target.y - center.y);
    if (!n) { app.toast('Nothing could be pasted here.', true); return; }
    lastPaste = { clip, key, repeat };
    app.toast(`Pasted ${itemWord(n)}.`);
  }

  // Duplicate is a copy and paste in one step, a little offset, that leaves the clipboard alone.
  function duplicateSelection() {
    const clip = buildClip();
    if (!clip) { app.toast('Select something to duplicate first.'); return; }
    if (!insertClip(clip, 12, 12)) app.toast('There is no room for a copy there.', true);
  }

  function flipSelection() {
    if (app.sel.length === 1 && lockedItem(app.sel[0])) { editableSel('flip'); return; }
    const wall = selectedSingle('wall');
    if (wall) { wall.side *= -1; app.commit(); return; }
    const st = selectedSingle('stair');
    if (st) { st.side = st.side === 'right' ? 'left' : 'right'; app.commit(); app.emit('selection'); return; }
    const op = selectedSingle('opening');
    if (!op) return;
    // F flips the swing, or for a pocket door, which end the pocket is at.
    const info = M.OPENING_KINDS[op.kind] || {};
    if (info.swing) op.flipSwing = !op.flipSwing;
    else if (info.side && (op.panels || 1) < 2) op.flipHinge = !op.flipHinge;
    else return;
    app.commit();
    app.emit('selection');
  }

  function onKeyDown(e) {
    if (isEditing(e)) return;
    const key = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    mouse.shift = e.shiftKey;
    mouse.alt = e.altKey;

    if (ctrl) {
      const k = key.toLowerCase();
      if (k === 'z') { e.preventDefault(); if (e.shiftKey) app.redo(); else app.undo(); return; }
      if (k === 'y') { e.preventDefault(); app.redo(); return; }
      if (k === 's') { e.preventDefault(); FP.fileio.save(e.shiftKey); return; }
      if (k === 'o') { e.preventDefault(); FP.fileio.open(); return; }
      if (k === 'd') { e.preventDefault(); duplicateSelection(); return; }
      if (k === 'c') { e.preventDefault(); copySelection(); return; }
      if (k === 'x') { e.preventDefault(); cutSelection(); return; }
      if (k === 'v') { e.preventDefault(); pasteClipboard(e.shiftKey); return; }
      if (k === 'l') { e.preventDefault(); toggleLock(); return; }
      if (k === 'g') { e.preventDefault(); if (e.shiftKey) ungroupSelection(); else groupSelection(); return; }
      if (k === 'm') { e.preventDefault(); mergeSelection(); return; }
      if (key === 'Delete' || key === 'Backspace') { e.preventDefault(); deleteSelection(true); return; }
      if (key.startsWith('Arrow') && app.sel.length) { e.preventDefault(); nudge(key, e.shiftKey, true); return; }
      if (k === 'a') {
        e.preventDefault();
        const floor = app.floor();
        app.select([
          ...floor.walls.map((x) => ({ t: 'wall', id: x.id })),
          ...floor.fixtures.map((x) => ({ t: 'fixture', id: x.id })),
          ...floor.labels.map((x) => ({ t: 'label', id: x.id })),
          ...floor.stairs.map((x) => ({ t: 'stair', id: x.id })),
          ...floor.dims.map((x) => ({ t: 'dim', id: x.id })),
          ...guideList().map((x) => ({ t: 'guide', id: x.id })),
          ...(floor.shapes || []).map((x) => ({ t: 'shape', id: x.id })),
        ]);
        return;
      }
      return;
    }

    // Typing a length while drawing a wall, construction line, stairs or shape. Once typing has
    // started, metric units (cm, mm, m) and "x" between a width and depth can follow.
    if (((app.tool === 'wall' || app.tool === 'guide') && app.draw) || (app.tool === 'stairs' && app.stairDraft) || (app.tool === 'shape' && app.shapeDraft)) {
      // With Shift held, the number row types symbols. Read the digit from the physical key.
      const digit = /^(Digit|Numpad)\d$/.test(e.code || '') ? e.code.slice(-1) : null;
      if (digit || /^[0-9'".\/-]$/.test(key) || (buffer && /^[ cmx*,]$/i.test(key))) {
        e.preventDefault();
        typeChar(digit || key);
        return;
      }
      if (key === 'Backspace' && !buffer && app.tool === 'shape') {
        // Takes back the last point placed.
        e.preventDefault();
        const d = app.shapeDraft;
        if (d.pts.length > 1) d.pts.pop(); else app.shapeDraft = null;
        app.requestRender();
        return;
      }
      if (key === 'Backspace') {
        e.preventDefault();
        buffer = buffer.slice(0, -1);
        if (!buffer) clearTyping();
        app.requestRender();
        return;
      }
      if (key === 'Enter') {
        e.preventDefault();
        if (app.tool === 'stairs') {
          commitStair();
        } else if (app.tool === 'shape') {
          if (buffer) shapeStep();
          else finishPoly();
        } else if (buffer) {
          if (app.parse(buffer) > 0) commitDraw();
          else { app.toast(`"${buffer}" is not a length. Try 148 or 12'4".`, true); clearTyping(); }
        } else {
          app.draw = null;
        }
        app.requestRender();
        return;
      }
    }

    if (key === ' ') { e.preventDefault(); if (!spaceHeld) { spaceHeld = true; updateCursor(); } return; }
    if (key === 'Shift' || key === 'Alt') {
      if (key === 'Alt') e.preventDefault();
      refreshPointerState();
      return;
    }

    if (key === 'Escape') {
      if (app.place) { endPlace(); return; }
      if (app.drag) { press = null; app.revert(); return; }
      if (buffer) { clearTyping(); app.requestRender(); return; }
      if (app.shapeDraft) { if (!finishPoly()) app.shapeDraft = null; app.requestRender(); return; }
      if (app.draw || app.dimDraft || app.stairDraft) { app.draw = null; app.dimDraft = null; app.stairDraft = null; app.requestRender(); return; }
      if (app.tool !== 'select') { setTool('select'); return; }
      app.select([]);
      return;
    }

    if (key === 'Delete' || key === 'Backspace') { e.preventDefault(); deleteSelection(); return; }

    const lower = key.toLowerCase();
    if (lower === 'f') {
      if (app.tool === 'stairs') {
        const flip = (s) => (s === 'right' ? 'left' : 'right');
        if (app.stairDraft) app.stairDraft.side = flip(app.stairDraft.side);
        stairDefaults.side = flip(stairDefaults.side);
        app.requestRender();
      } else if (app.tool === 'wall') {
        if (app.draw) { app.draw.side *= -1; app.draw.userFlipped = true; }
        else app.wallSide *= -1;
        app.requestRender();
      } else flipSelection();
      return;
    }
    if (lower === 'v') return setTool('select');
    if (lower === 'w') return setTool('wall', 'interior');
    if (lower === 'e') return setTool('wall', 'exterior');
    if (lower === 'd') return setTool('dim');
    if (lower === 't') return setTool('text');
    if (lower === 'c') return setTool('guide');
    if (lower === 'b') return setTool('guide', 'divider');
    if (lower === 'h') return setTool('pan');
    if (lower === 's') return setTool('stairs');
    if (lower === 'l') return setTool('shape', 'line');
    if (lower === 'p') return setTool('shape', 'poly');
    if (lower === 'r') {
      const by = e.shiftKey ? 15 : 90;
      if (selectedGroup()) {
        const sel = editableSel('rotate', false, 'unlock them first');
        if (!sel) return;
        const b = FP.groups.bounds(app.floor(), app.geo(), app.sel);
        FP.groups.rotate(app.floor(), FP.groups.snapshot(app.floor(), sel), { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, by);
        app.commit();
        app.emit('selection');
        return;
      }
      const sh = selectedSingle('shape');
      if (sh) {
        if (!editableSel('rotate')) return;
        const b = FP.shapes.bounds(sh);
        FP.groups.rotate(app.floor(), FP.groups.snapshot(app.floor(), app.sel), { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, by);
        app.commit();
        app.emit('selection');
        return;
      }
      const fx = selectedSingle('fixture');
      const st = selectedSingle('stair');
      if ((fx || st) && !editableSel('rotate')) return;
      if (fx) { fx.rot = (fx.rot + by) % 360; app.commit(); app.emit('selection'); }
      if (st) { rotateStair(st, by); app.commit(); app.emit('selection'); }
      return;
    }
    if (key === '0') return app.fitView();

    if (key.startsWith('Arrow') && app.sel.length) {
      e.preventDefault();
      nudge(key, e.shiftKey, false);
    }
  }

  // Arrow keys move the selection a grid step (Shift: ten). Ctrl moves only the unlocked items.
  function nudge(key, big, override) {
    const sel = editableSel('move', override, 'hold Ctrl with the arrow keys');
    if (!sel) return;
    const step = (big ? 10 : 1) * app.settings().gridSize;
    const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
    const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
    applyGroupDelta(groupSnapshot(sel), dx, dy);
    app.commit();
    app.emit('selection');
  }

  function onKeyUp(e) {
    if (e.key === ' ') { spaceHeld = false; updateCursor(); }
    if (e.key === 'Shift' || e.key === 'Alt') {
      mouse.shift = e.shiftKey;
      mouse.alt = e.altKey;
      refreshPointerState();
    }
  }

  function refreshPointerState() {
    if (app.place) updatePlacement();
    app.requestRender();
  }

  // ---------- Overlay ----------

  function tooltip(R, lines, sx, sy) {
    const c = R.ctx;
    R.screen();
    c.save();
    c.font = `600 ${12 * R.unit}px system-ui, sans-serif`;
    const pad = 7 * R.unit, lh = 16 * R.unit;
    const w = Math.max(...lines.map((t) => c.measureText(t).width)) + pad * 2;
    const h = lines.length * lh + pad;
    let x = sx + 16 * R.unit, y = sy + 16 * R.unit;
    if (x + w > c.canvas.width) x = sx - w - 12 * R.unit;
    if (y + h > c.canvas.height) y = sy - h - 12 * R.unit;
    c.fillStyle = 'rgba(24,30,40,0.92)';
    c.beginPath();
    c.roundRect(x, y, w, h, 5 * R.unit);
    c.fill();
    c.fillStyle = '#fff';
    c.textBaseline = 'middle';
    lines.forEach((t, i) => c.fillText(t, x + pad, y + pad / 2 + lh * (i + 0.5)));
    c.restore();
  }

  function handle(R, p, color, round) {
    const c = R.ctx;
    R.screen();
    const x = R.sx(p.x), y = R.sy(p.y), r = 4.5 * R.unit;
    c.beginPath();
    if (round) c.arc(x, y, r, 0, Math.PI * 2);
    else c.rect(x - r, y - r, r * 2, r * 2);
    c.fillStyle = '#fff';
    c.fill();
    c.lineWidth = 1.6 * R.unit;
    c.strokeStyle = color || ACCENT;
    c.stroke();
  }

  function snapMarker(R, t) {
    const c = R.ctx;
    R.screen();
    const x = R.sx(t.x), y = R.sy(t.y), r = 7 * R.unit;
    const onGuide = t.kind.startsWith('guide');
    c.lineWidth = 2 * R.unit;
    c.strokeStyle = onGuide ? R.colors.guide : t.kind === 'node' ? '#0f9d58' : '#b5651d';
    if (t.kind === 'item') {
      c.strokeStyle = R.colors.dim;
      c.strokeRect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6);
      const p = t.ref.pt;
      const name = t.ref.t === 'opening' ? (p[1] === 'r' ? 'Opening edge' : 'Opening edge, far face')
        : t.ref.t === 'stair' ? 'Stair corner' : t.ref.t === 'shape' ? FP.shapes.pointName(null, p)
          : p === 'ctr' ? 'Centre' : p[0] === 'm' ? 'Midpoint' : 'Corner';
      Rn.tagText(R, name, x, y - 16 * R.unit, 0, R.colors.dim, 11, 600);
      return;
    }
    c.beginPath();
    if (t.kind === 'node' || t.kind === 'guide-end') c.arc(x, y, r, 0, Math.PI * 2);
    else if (t.kind === 'guide-mid') { c.moveTo(x, y - r); c.lineTo(x + r, y); c.lineTo(x, y + r); c.lineTo(x - r, y); c.closePath(); }
    else { c.moveTo(x - r, y - r); c.lineTo(x + r, y + r); c.moveTo(x + r, y - r); c.lineTo(x - r, y + r); }
    c.stroke();
    const names = { 'guide-end': 'End', 'guide-mid': 'Midpoint', 'guide-cross': 'Intersection', 'guide-on': 'On line' };
    if (names[t.kind]) Rn.tagText(R, names[t.kind], x, y - 16 * R.unit, 0, R.colors.guide, 11, 600);
  }

  function guideLines(R, t) {
    if (!t.guides) return;
    const c = R.ctx;
    R.screen();
    c.save();
    c.setLineDash([4 * R.unit, 4 * R.unit]);
    c.lineWidth = R.unit;
    c.strokeStyle = '#b5651d';
    if (t.guides[0]) { c.beginPath(); c.moveTo(R.sx(t.x), R.sy(t.guides[0].y)); c.lineTo(R.sx(t.x), R.sy(t.y)); c.stroke(); }
    if (t.guides[1]) { c.beginPath(); c.moveTo(R.sx(t.guides[1].x), R.sy(t.y)); c.lineTo(R.sx(t.x), R.sy(t.y)); c.stroke(); }
    c.restore();
  }

  function outlinePoly(R, poly, color, alpha) {
    const c = R.ctx;
    R.world();
    c.beginPath();
    Rn.wallPath(c, poly);
    if (alpha) { c.save(); c.globalAlpha = alpha; c.fillStyle = color; c.fill(); c.restore(); }
    c.lineWidth = R.px(1.6);
    c.strokeStyle = color;
    c.stroke();
  }

  function fixtureOutline(R, fx, color) {
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => toWorld(fx, { x: (a * fx.w) / 2, y: (b * fx.d) / 2 }));
    outlinePoly(R, corners, color);
  }

  function drawWallPreview(R) {
    const { start, target, solved, reach, extension, fromTee } = drawTarget();
    const c = R.ctx;
    const len = G.dist(start, target);
    const u = len > 1e-6 ? G.mul(G.sub(target, start), 1 / len) : { x: 1, y: 0 };
    const isGuide = app.tool === 'guide';
    const color = isGuide ? (app.lineKind === 'divider' ? R.colors.soft : R.colors.guide) : ACCENT;
    if (!isGuide) {
      const s = app.settings();
      const t = app.wallType === 'exterior' ? s.exteriorThickness : s.interiorThickness;
      const off = G.mul(G.nrm(u), app.draw.side * t);
      outlinePoly(R, [start, target, G.add(target, off), G.add(start, off)], ACCENT, 0.28);
    }
    R.world();
    c.save();
    if (isGuide) c.setLineDash([R.px(7), R.px(4)]);
    c.beginPath();
    c.moveTo(start.x, start.y);
    c.lineTo(target.x, target.y);
    c.lineWidth = R.px(isGuide ? 1.6 : 2.2);
    c.strokeStyle = color;
    c.stroke();
    c.restore();
    if (solved) {
      // Show the solved right triangle: the known rise, and the run it worked out.
      c.save();
      c.setLineDash([R.px(3), R.px(3)]);
      c.lineWidth = R.px(1.2);
      c.strokeStyle = R.colors.guide;
      c.beginPath();
      c.moveTo(start.x, start.y);
      c.lineTo(solved.foot.x, solved.foot.y);
      c.lineTo(target.x, target.y);
      c.stroke();
      c.restore();
      snapMarker(R, { kind: 'guide-cross', x: target.x, y: target.y });
    } else if (isSnapPoint(target)) snapMarker(R, target);
    guideLines(R, target);
    handle(R, start, color, true);
    let angle = (deg(Math.atan2(-(target.y - start.y), target.x - start.x)) + 360) % 360;
    if (angle > 359.95) angle = 0;
    const lines = [`${app.fmt(len)}   ${angle.toFixed(1)}°`];
    if (solved) lines.push(`Rise ${app.fmt(solved.rise)}   Run ${app.fmt(solved.run)}`);
    if (reach != null) lines.push(`Too short to reach that line (needs ${app.fmt(reach)})`);
    if (fromTee) lines.push('Starts at the T wall\'s inside edge (Alt: from the wall end)');
    if (extension) lines.push(`Room ${app.fmt(extension.room)} from the T wall, so this wall is ${app.fmt(extension.total)}`);
    if (!buffer && app.tool === 'wall' && len > 1e-6 && !mouse.alt) {
      const add = extensionOffset(start, u);
      if (add != null && Math.abs(add) >= 1 / 16 && len - add > 0) lines.push(`Room ${app.fmt(len - add)} from the T wall`);
    }
    if (buffer) lines.push(`Length: ${buffer}${app.parse(buffer) > 0 ? '' : '  ?'}  (Enter)`);
    tooltip(R, lines, R.sx(target.x), R.sy(target.y));
  }

  // The shape being drawn, its points, what the next click snaps to, and its size.
  function drawShapePreview(R) {
    const d = app.shapeDraft;
    const t = shapeTarget();
    if (!d) {
      if (isSnapPoint(t)) snapMarker(R, t);
      else handle(R, t, ACCENT, true);
      guideLines(R, t);
      return;
    }
    const shape = shapeDraftShape();
    FP.shapes.draw(R, { ...shapeStyle, ...shape }, { color: ACCENT, alpha: 0.9 });
    for (const p of d.pts) handle(R, p, ACCENT, true);
    const closing = closesPoly(d, t);
    if (closing) snapMarker(R, { kind: 'node', x: d.pts[0].x, y: d.pts[0].y });
    else if (isSnapPoint(t)) snapMarker(R, t);
    guideLines(R, t);
    const k = app.shapeKind, last = d.pts[d.pts.length - 1];
    const lines = [];
    const byLength = k === 'line' || k === 'poly' || (k === 'arc' && d.pts.length === 1);
    if (byLength) {
      let angle = (deg(Math.atan2(-(t.y - last.y), t.x - last.x)) + 360) % 360;
      if (angle > 359.95) angle = 0;
      lines.push(`${app.fmt(G.dist(last, t))}   ${angle.toFixed(1)}°`);
      if (closing) lines.push('Click to close the shape');
    } else if (k === 'arc') {
      const g = shape.kind === 'arc' && FP.shapes.arcGeom(shape);
      if (g) lines.push(`Radius ${app.fmt(g.r)}`, `Length ${app.fmt(FP.shapes.length(shape))}`);
    } else if (k === 'circle') lines.push(`Diameter ${app.fmt(shape.w)}`);
    else lines.push(`${app.fmt(shape.w)} x ${app.fmt(shape.d)}`);
    if (buffer) lines.push(`${byLength ? 'Length' : k === 'circle' ? 'Diameter' : 'Size'}: ${buffer}${typedOk() ? '' : '  ?'}  (Enter)`);
    tooltip(R, lines, R.sx(t.x), R.sy(t.y));
  }

  // Saves the selected shapes to the drawing's furniture library as one piece. Loose shapes
  // are grouped so the piece on the plan moves as one too.
  function saveFurniture(name) {
    const floor = app.floor();
    const items = app.sel.filter((s) => s.t === 'shape').map((s) => byId(floor.shapes, s.id)).filter(Boolean);
    if (!items.length) { app.toast('Select the shapes that make up the piece first.', true); return false; }
    name = (name || '').trim();
    if (!name) { app.toast('Give the piece a name first.', true); return false; }
    const piece = FP.shapes.toPiece(name, items);
    piece.id = M.uid('fp');
    app.doc.furniture = [...(app.doc.furniture || []), piece];
    if (items.length > 1 && items.every((x) => !x.group)) {
      const gid = M.uid('grp');
      for (const x of items) x.group = gid;
    }
    app.commit();
    app.emit('selection');
    app.toast(`${name} saved to My Furniture. Drag it from the library to place another.`);
    return true;
  }

  // Where a locked item's padlock goes.
  function lockAnchor(floor, geo, s) {
    const x = M.itemOf(floor, s);
    if (!x) return null;
    if (s.t === 'node') return x;
    if (s.t === 'wall') { const a = geo.idx.nodes.get(x.a), b = geo.idx.nodes.get(x.b); return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null; }
    if (s.t === 'opening') {
      const wall = geo.idx.walls.get(x.wallId);
      if (!wall) return null;
      const f = G.wallFrame(wall, geo.idx);
      return G.add(G.add(f.a, G.mul(f.u, x.d)), G.mul(f.ns, f.t / 2));
    }
    if (s.t === 'stair') {
      const pts = FP.stairs.geometry(x).polys.flat();
      return { x: (Math.min(...pts.map((p) => p.x)) + Math.max(...pts.map((p) => p.x))) / 2, y: (Math.min(...pts.map((p) => p.y)) + Math.max(...pts.map((p) => p.y))) / 2 };
    }
    if (s.t === 'dim') {
      const e = Rn.dimGeometry(floor, x, geo.idx);
      return { x: (e.p.x + e.q.x) / 2, y: (e.p.y + e.q.y) / 2 };
    }
    if (s.t === 'guide') return { x: (x.a.x + x.b.x) / 2, y: (x.a.y + x.b.y) / 2 };
    if (s.t === 'shape') { const b = FP.shapes.bounds(x); return b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : null; }
    return { x: x.x, y: x.y }; // fixture, text, room name
  }

  const LOCK_COLOR = '#b26b00';
  function padlock(R, p) {
    if (!p) return;
    const c = R.ctx, u = R.unit;
    R.screen();
    const x = R.sx(p.x) + 12 * u, y = R.sy(p.y) - 12 * u;
    c.save();
    c.beginPath();
    c.arc(x, y, 9 * u, 0, Math.PI * 2);
    c.fillStyle = '#fff';
    c.fill();
    c.lineWidth = 1.4 * u;
    c.strokeStyle = LOCK_COLOR;
    c.stroke();
    c.beginPath();
    c.arc(x, y - 1.5 * u, 2.8 * u, Math.PI, 0);
    c.lineWidth = 1.6 * u;
    c.stroke();
    c.fillStyle = LOCK_COLOR;
    c.fillRect(x - 4.5 * u, y - 1.5 * u, 9 * u, 6.5 * u);
    c.restore();
  }

  // The selected group's box, with handles to scale it and one above to turn it.
  function drawGroupFrame(R) {
    if (!selectedGroup()) return;
    const c = R.ctx;
    const gf = groupFrame();
    const b = gf ? gf.box : FP.groups.bounds(app.floor(), app.geo(), app.sel);
    if (!b) return;
    R.world();
    c.save();
    c.setLineDash([R.px(5), R.px(4)]);
    c.lineWidth = R.px(1.2);
    c.strokeStyle = ACCENT;
    c.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
    c.restore();
    const d = app.drag;
    if (d && d.type === 'group-scale' && d.size) tooltip(R, [`${app.fmt(d.size.w)} x ${app.fmt(d.size.h)}`], mouse.sx * R.unit, mouse.sy * R.unit);
    if (d && d.type === 'group-rotate') tooltip(R, [`${d.angle}°`], mouse.sx * R.unit, mouse.sy * R.unit);
    if (!gf || d) return;
    for (const h of gf.handles) handle(R, h.p, ACCENT);
    R.screen();
    c.beginPath();
    c.moveTo(R.sx(gf.center.x), R.sy(gf.box.minY));
    c.lineTo(R.sx(gf.rotate.x), R.sy(gf.rotate.y));
    c.lineWidth = 1.2 * R.unit;
    c.strokeStyle = ACCENT;
    c.stroke();
    handle(R, gf.rotate, ACCENT, true);
  }

  function drawOverlay(R, floor, geo) {
    const c = R.ctx;

    for (const s of app.sel) {
      if (s.t === 'wall') {
        const j = geo.joins.get(s.id);
        if (!j) continue;
        outlinePoly(R, j.poly, ACCENT, 0.2);
        const w = geo.idx.walls.get(s.id);
        handle(R, geo.idx.nodes.get(w.a), ACCENT);
        handle(R, geo.idx.nodes.get(w.b), ACCENT);
      } else if (s.t === 'node') {
        const n = geo.idx.nodes.get(s.id);
        if (n) handle(R, n, ACCENT, true);
      } else if (s.t === 'fixture') {
        const fx = byId(floor.fixtures, s.id);
        if (fx) fixtureOutline(R, fx, ACCENT);
      } else if (s.t === 'opening') {
        const op = byId(floor.openings, s.id);
        const wall = op && geo.idx.walls.get(op.wallId);
        if (wall) {
          const f = G.wallFrame(wall, geo.idx);
          const at = (al, p) => G.add(G.add(f.a, G.mul(f.u, al)), G.mul(f.ns, p));
          outlinePoly(R, [at(op.d - op.width / 2, 0), at(op.d + op.width / 2, 0), at(op.d + op.width / 2, f.t), at(op.d - op.width / 2, f.t)], ACCENT, 0.15);
        }
      } else if (s.t === 'dim') {
        const dim = byId(floor.dims, s.id);
        if (dim) {
          Rn.drawDim(R, floor, dim, geo.idx, { units: app.settings().units }, ACCENT);
          if (app.sel.length === 1 && !dim.locked) {
            const e = Rn.dimGeometry(floor, dim, geo.idx);
            handle(R, e.a, ACCENT, true);
            handle(R, e.b, ACCENT, true);
          }
        }
      } else if (s.t === 'stair') {
        const st = byId(floor.stairs, s.id);
        if (st) for (const poly of FP.stairs.geometry(st).polys) outlinePoly(R, poly, ACCENT, 0.12);
      } else if (s.t === 'guide') {
        const g = byId(floor.guides, s.id);
        if (g) {
          R.world();
          c.beginPath();
          c.moveTo(g.a.x, g.a.y);
          c.lineTo(g.b.x, g.b.y);
          c.lineWidth = R.px(2.2);
          c.strokeStyle = ACCENT;
          c.stroke();
          if (!g.locked) {
            handle(R, g.a, ACCENT, true);
            handle(R, g.b, ACCENT, true);
          }
        }
      } else if (s.t === 'shape') {
        const sh = byId(floor.shapes, s.id);
        if (sh) {
          FP.shapes.draw(R, sh, { color: ACCENT, noFill: true, weight: Math.max(2, (sh.weight || 1.25) + 1) });
          if (app.sel.length === 1 && !sh.locked && !app.drag) {
            if (FP.shapes.boxed(sh)) {
              for (const h of fixtureHandles(sh)) handle(R, h.p, ACCENT);
              const rp = rotateHandlePos(sh), base = toWorld(sh, { x: 0, y: sh.d / 2 });
              R.screen();
              c.beginPath();
              c.moveTo(R.sx(base.x), R.sy(base.y));
              c.lineTo(R.sx(rp.x), R.sy(rp.y));
              c.lineWidth = 1.2 * R.unit;
              c.strokeStyle = ACCENT;
              c.stroke();
              handle(R, rp, ACCENT, true);
            } else for (const h of shapePointHandles(sh)) handle(R, h.p, ACCENT, h.key === 'm');
          }
        }
      } else if (s.t === 'label') {
        const l = byId(floor.labels, s.id);
        if (l) {
          const box = labelBox(l);
          fixtureOutline(R, { x: l.x, y: l.y, rot: l.rot, w: box.hw * 2 + 2, d: box.hh * 2 }, ACCENT);
        }
      } else if (s.t === 'room') {
        const rec = byId(floor.rooms, s.id);
        if (rec) {
          R.screen();
          c.save();
          c.strokeStyle = ACCENT;
          c.lineWidth = 1.5 * R.unit;
          c.setLineDash([4 * R.unit, 3 * R.unit]);
          c.strokeRect(R.sx(rec.x) - 48 * R.unit, R.sy(rec.y) - 20 * R.unit, 96 * R.unit, 40 * R.unit);
          c.restore();
        }
      }
    }

    drawGroupFrame(R);
    for (const s of app.sel) if (lockedItem(s)) padlock(R, lockAnchor(floor, geo, s));
    if (app.tool === 'select' && app.hover && !app.drag) {
      const kind = selectionKind(app.hover);
      if (kind && !app.isSelected(kind, app.hover.id) && lockedItem({ t: kind, id: app.hover.id })) padlock(R, lockAnchor(floor, geo, { t: kind, id: app.hover.id }));
    }

    const fxSel = selectedSingle('fixture');
    if (fxSel && !app.drag && !fxSel.locked) {
      for (const h of fixtureHandles(fxSel)) handle(R, h.p, ACCENT);
      const rp = rotateHandlePos(fxSel);
      const base = toWorld(fxSel, { x: 0, y: fxSel.d / 2 });
      R.screen();
      c.beginPath();
      c.moveTo(R.sx(base.x), R.sy(base.y));
      c.lineTo(R.sx(rp.x), R.sy(rp.y));
      c.lineWidth = 1.2 * R.unit;
      c.strokeStyle = ACCENT;
      c.stroke();
      handle(R, rp, ACCENT, true);
    }

    if (app.tool === 'select' && app.hover && !app.drag) {
      if (app.hover.t === 'node') {
        const n = geo.idx.nodes.get(app.hover.id);
        if (n) handle(R, n, '#0f9d58', true);
      } else if (app.hover.t === 'wall' && !app.isSelected('wall', app.hover.id)) {
        const j = geo.joins.get(app.hover.id);
        if (j) outlinePoly(R, j.poly, ACCENT);
      } else if (app.hover.t === 'fixture' && !app.isSelected('fixture', app.hover.id)) {
        const fx = byId(floor.fixtures, app.hover.id);
        if (fx) fixtureOutline(R, fx, ACCENT);
      } else if (app.hover.t === 'shape' && !app.isSelected('shape', app.hover.id)) {
        const sh = byId(floor.shapes, app.hover.id);
        if (sh) FP.shapes.draw(R, sh, { color: ACCENT, noFill: true, alpha: 0.7 });
      }
    }

    if (app.drag && app.drag.type === 'node' && app.drag.target) {
      const t = app.drag.target;
      if (t.kind === 'node' || t.kind === 'wall') snapMarker(R, t);
      guideLines(R, t);
      for (const w of app.drag.walls) {
        const f = G.wallFrame(w, geo.idx);
        tooltip(R, [app.fmt(f.len)], R.sx(app.drag.node.x), R.sy(app.drag.node.y));
      }
    }

    if (app.drag && (app.drag.type === 'guide-end' || app.drag.type === 'shape-pt') && isSnapPoint(app.drag.target)) snapMarker(R, app.drag.target);

    if (app.tool === 'shape' && mouse.inside) drawShapePreview(R);

    if ((app.tool === 'wall' || app.tool === 'guide') && mouse.inside) {
      if (app.draw) drawWallPreview(R);
      else {
        const t = snap({ x: mouse.x, y: mouse.y });
        if (isSnapPoint(t)) snapMarker(R, t);
        else handle(R, t, app.tool === 'guide' ? R.colors.guide : ACCENT, true);
      }
    }

    if (app.tool === 'stairs' && mouse.inside) {
      if (app.stairDraft) {
        const st = stairDraftStair();
        // The whole stair shows while drawing, even when its upper part will be hidden.
        FP.stairs.draw(R, st, { color: ACCENT, alpha: 0.85, mode: st.goes === 'down' ? 'down' : 'up', upper: st.upper === 'hidden' ? 'dashed' : undefined });
        const g = FP.stairs.geometry(st);
        const k = g.counts;
        const lines = [
          `${k.risers} risers at ${app.fmtShort(Math.round(k.riserHeight * 16) / 16)}`,
          `${k.treads} treads at ${app.fmt(st.tread)}${k.landing ? ' + landing' : ''}`,
          `Run ${app.fmt(g.run)}`,
        ];
        if (buffer) lines.push(`First flight run: ${buffer}${app.parse(buffer) > 0 ? '' : '  ?'}  (Enter)`);
        tooltip(R, lines, mouse.sx * R.unit, mouse.sy * R.unit);
        handle(R, app.stairDraft.start, ACCENT, true);
      } else {
        const t = snap({ x: mouse.x, y: mouse.y });
        if (isSnapPoint(t)) snapMarker(R, t);
        else handle(R, t, ACCENT, true);
      }
    }

    if (app.tool === 'dim' && mouse.inside && app.dimDraft && app.dimDraft.placing) {
      // Third step: the dimension line follows the cursor, with its distance from the middle
      // of what it measures.
      const draft = app.dimDraft;
      const offset = dimOffsetAt(draft, mouse);
      const g = Rn.dimGeometry(floor, { a: draft.a, b: draft.b, offset }, geo.idx);
      Rn.drawDim(R, floor, { a: draft.a, b: draft.b, offset }, geo.idx, { units: app.settings().units }, R.colors.dim);
      const m = G.mul(G.add(g.a, g.b), 0.5), mq = G.mul(G.add(g.p, g.q), 0.5);
      R.world();
      c.save();
      c.setLineDash([R.px(4), R.px(3)]);
      c.lineWidth = R.px(1);
      c.strokeStyle = R.colors.dim;
      c.beginPath();
      c.moveTo(m.x, m.y);
      c.lineTo(mq.x, mq.y);
      c.stroke();
      c.restore();
      tooltip(R, [`Offset ${app.fmt(Math.abs(offset))}`], R.sx(mouse.x), R.sy(mouse.y));
    } else if (app.tool === 'dim' && mouse.inside) {
      const t = dimSnap({ x: mouse.x, y: mouse.y });
      if (isSnapPoint(t)) snapMarker(R, t);
      else handle(R, t, R.colors.dim, true);
      if (app.dimDraft) {
        R.world();
        c.beginPath();
        c.moveTo(app.dimDraft.x, app.dimDraft.y);
        c.lineTo(t.x, t.y);
        c.lineWidth = R.px(1.2);
        c.strokeStyle = R.colors.dim;
        c.stroke();
        tooltip(R, [app.fmt(G.dist(app.dimDraft, t))], R.sx(t.x), R.sy(t.y));
      }
    }

    if (app.place && mouse.inside) {
      if (app.place.cat === 'furniture') {
        for (const sh of app.place.preview) FP.shapes.draw(R, sh, { alpha: 0.75 });
        const b = FP.shapes.boundsOf(app.place.preview);
        if (b) outlinePoly(R, [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }], ACCENT);
      } else if (app.place.cat === 'fixture') {
        Rn.drawFixture(R, app.place.preview, { alpha: 0.75 });
        fixtureOutline(R, app.place.preview, ACCENT);
      } else if (app.place.preview.wallId) {
        const wall = geo.idx.walls.get(app.place.preview.wallId);
        if (wall) {
          R.world();
          Rn.drawOpening(R, G.wallFrame(wall, geo.idx), app.place.preview, { color: app.place.valid ? ACCENT : BAD });
        }
      } else {
        tooltip(R, ['Drop on a wall'], mouse.sx * R.unit, mouse.sy * R.unit);
      }
    }

    // What a dragged or placed fixture, door or window has lined up with.
    const moving = app.place || (app.drag && (app.drag.type === 'fixture' || app.drag.type === 'opening'));
    if (moving && app.snapHint) for (const p of app.snapHint) snapMarker(R, { kind: 'align', x: p.x, y: p.y });

    if (press && press.marquee && press.current) {
      R.world();
      const x = press.world.x, y = press.world.y;
      const w = press.current.x - x, h = press.current.y - y;
      c.save();
      c.globalAlpha = 0.1;
      c.fillStyle = ACCENT;
      c.fillRect(x, y, w, h);
      c.restore();
      c.lineWidth = R.px(1);
      c.strokeStyle = ACCENT;
      c.strokeRect(x, y, w, h);
    }
  }

  // ---------- Frame ----------

  function viewOptions(width, height) {
    const s = app.settings();
    const below = s.showGhost ? M.floorBelow(app.doc, app.floor()) : null;
    const ghost = below ? { floor: below, geo: app.geo(below) } : null;
    const over = s.showGhostAbove ? M.floorAbove(app.doc, app.floor()) : null;
    const above = over ? { floor: over, geo: app.geo(over) } : null;
    // In a design option, what it changes from as-is.
    let changes = null;
    if (app.floor().option && app.floor().asIs && app.view.changes !== false) {
      const base = FP.options.view(app.floor(), null);
      changes = { floor: base, geo: app.geo(base) };
    }
    return {
      changes,
      width, height, units: s.units, gridSize: s.gridSize, showGrid: s.showGrid,
      showLengths: s.showLengths, bothFaces: s.bothFaces, showRooms: s.showRooms, showGuides: s.showGuides, ghost, above,
      stairs: M.stairsSeen(app.doc, app.floor()),
      stairView: app.view.stairs || 'show',
    };
  }

  function render() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    }
    app.viewport.width = rect.width;
    app.viewport.height = rect.height;
    const floor = app.floor();
    const geo = app.geo(floor);
    const R = Rn.makeR(ctx, app.view.scale * dpr, app.view.ox * dpr, app.view.oy * dpr, dpr, Rn.PALETTES[FP.prefs.theme()]);
    Rn.drawPlan(R, floor, geo, viewOptions(w, h));
    drawOverlay(R, floor, geo);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function init(el) {
    canvas = el;
    ctx = canvas.getContext('2d');
    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDoubleClick);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerleave', () => { mouse.inside = false; app.requestRender(); });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', () => { spaceHeld = false; });
    app.setRenderer(render);
    window.addEventListener('resize', () => app.requestRender());
    updateCursor();
  }

  function hintText() {
    if (app.place) {
      return app.place.cat === 'opening'
        ? 'Drop on a wall. Its edges snap to corners and construction lines; hold Alt to place freely. Right-click cancels.'
        : 'Drop on the plan. It snaps flush to walls and lines up with corners and construction lines; hold Alt to place freely. Right-click cancels.';
    }
    if (app.tool === 'wall') {
      return app.draw
        ? 'Click to place, or type a length and press Enter. Hover a line first to land exactly on it. Shift locks the angle, F flips the thickness side.'
        : 'Click to start a wall. Click an existing wall or corner to attach. Right-click returns to Select.';
    }
    if (app.tool === 'guide' && app.lineKind === 'divider') {
      return app.draw
        ? 'Click on a wall to finish, or type a length and press Enter. Shift locks the angle. Right-click returns to Select.'
        : 'Click on a wall to start a room divider. It splits a room in two without a wall, such as a kitchen from a dining room.';
    }
    if (app.tool === 'guide') {
      return app.draw
        ? 'Click to place, or type a length and press Enter. Shift locks the angle. Enter alone ends the line. Right-click returns to Select.'
        : 'Click to start a construction line. These aren\'t walls, but everything can snap to them.';
    }
    if (app.tool === 'stairs') {
      return app.stairDraft
        ? 'Aim the way the stairs go up and click, or type the first flight\'s run and press Enter. F flips the side, Alt allows any angle. Shape and height are in the Inspector.'
        : 'Click the bottom corner of the stairs, on the edge they run along. On the top floor they go down to the floor below; change it in the Inspector.';
    }
    if (app.tool === 'dim') {
      if (app.dimDraft && app.dimDraft.placing) return 'Move to where the dimension line goes, then click. Hold Alt to place it off the grid. Esc cancels.';
      return app.dimDraft ? 'Click the second point.' : 'Click the first point to measure from.';
    }
    if (app.tool === 'shape') {
      const k = app.shapeKind, d = app.shapeDraft;
      const tail = ' Shift locks the angle, Alt skips snapping. Right-click returns to Select.';
      if (k === 'line') return d ? `Click the end, or type a length and press Enter.${tail}` : 'Click to start a line. Shapes snap to walls, corners, fixtures and other shapes.';
      if (k === 'poly') return d ? `Click each corner, or type a length and press Enter. Click the first point to close it; double-click, Enter or Esc ends it open. Backspace takes back a point.${tail}` : 'Click the first corner of a polyline.';
      if (k === 'rect') return d ? 'Click the opposite corner, or type width x depth (such as 36 x 20) and press Enter.' : 'Click one corner of the rectangle.';
      if (k === 'circle') return d ? 'Click a point on the edge, or type the diameter and press Enter.' : 'Click the centre of the circle.';
      if (k === 'ellipse') return d ? 'Click a corner of the box around it, or type width x depth and press Enter.' : 'Click the centre of the ellipse.';
      if (!d) return 'Click where the arc starts.';
      return d.pts.length === 1 ? `Click where the arc ends, or type the distance between its ends.${tail}` : 'Move to bend the arc through the cursor, then click.';
    }
    if (app.tool === 'text') return 'Click where the text should go.';
    if (app.tool === 'pan') return 'Drag to pan the view.';
    if (selectedGroup()) return 'Drag to move the group, or its handles to scale or turn it (Shift keeps proportions). Double-click an item to pick it out alone. Ctrl+Shift+G ungroups.';
    if (app.sel.length && app.sel.some(lockedItem)) return 'Locked items can\'t be changed. Ctrl+L unlocks the selection; hold Ctrl to move or delete only the unlocked items.';
    return 'Drag anything to move it. Drag corners to reshape. Drag on empty space to box-select. Ctrl+G groups, Ctrl+L locks.';
  }

  FP.interact = {
    init, setTool, beginPlace, endPlace, hintText, mouse, fixtureHandles, snapFixtureToWalls, deleteSelection, rememberStair, rotateStair,
    setLocked, toggleLock, groupSelection, ungroupSelection, selectedGroup, mergeSelection, mergeAllWalls,
    rememberShapeStyle, saveFurniture, SHAPE_TOOLS,
  };
})(globalThis);
