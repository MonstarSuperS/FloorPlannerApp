// Moving a group as one: its bounding box, and scaling or rotating every member together.
(function (root) {
  const FP = (root.FP = root.FP || {});
  const G = FP.geom, M = FP.model;

  const rad = (d) => (d * Math.PI) / 180;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const wrap = (a) => ((a % 360) + 360) % 360;

  function stairCenter(st) {
    const pts = FP.stairs.geometry(st).polys.flat();
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  }

  function fixtureCorners(fx) {
    const r = rad(fx.rot), cos = Math.cos(r), sin = Math.sin(r);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
      const lx = (a * fx.w) / 2, ly = (b * fx.d) / 2;
      return { x: fx.x + lx * cos - ly * sin, y: fx.y + lx * sin + ly * cos };
    });
  }

  // The box around the items, or null if none of them are on this floor.
  function bounds(floor, geo, items) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const take = (p) => {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    };
    const idx = geo ? geo.idx : G.buildIndex(floor);
    for (const s of items) {
      const x = M.itemOf(floor, s);
      if (!x) continue;
      if (s.t === 'wall') {
        const j = geo && geo.joins.get(x.id);
        if (j) j.poly.forEach(take);
        else { take(idx.nodes.get(x.a)); take(idx.nodes.get(x.b)); }
      } else if (s.t === 'fixture') fixtureCorners(x).forEach(take);
      else if (s.t === 'stair') FP.stairs.geometry(x).polys.forEach((poly) => poly.forEach(take));
      else if (s.t === 'guide') { take(x.a); take(x.b); }
      else if (s.t === 'shape') FP.shapes.outlinePoints(x).forEach(take);
      else if (s.t === 'dim') {
        const e = M.dimEnds(floor, x, idx);
        const len = G.dist(e.a, e.b) || 1;
        const off = { x: (-(e.b.y - e.a.y) / len) * x.offset, y: ((e.b.x - e.a.x) / len) * x.offset };
        take(e.a); take(e.b); take(G.add(e.a, off)); take(G.add(e.b, off));
      } else if (s.t === 'label') {
        const half = (x.text.length * x.size * 0.55) / 2;
        fixtureCorners({ x: x.x, y: x.y, rot: x.rot, w: half * 2, d: x.size * 1.2 }).forEach(take);
      }
    }
    return minX === Infinity ? null : { minX, minY, maxX, maxY };
  }

  // Where every member starts, so a scale or rotation is always worked out from the original
  // and a drag can go back and forth without drifting.
  function snapshot(floor, items) {
    const idx = G.buildIndex(floor);
    const s = { nodes: [], openings: [], fixtures: [], stairs: [], labels: [], dims: [], guides: [], shapes: [] };
    const wallIds = new Set(), nodeIds = new Set();
    for (const it of items) {
      const x = M.itemOf(floor, it);
      if (!x) continue;
      if (it.t === 'wall') { wallIds.add(x.id); nodeIds.add(x.a); nodeIds.add(x.b); }
      else if (it.t === 'fixture') s.fixtures.push({ fx: x, x: x.x, y: x.y, w: x.w, d: x.d, rot: x.rot });
      else if (it.t === 'stair') s.stairs.push({ st: x, x: x.x, y: x.y, rot: x.rot, c: stairCenter(x) });
      else if (it.t === 'label') s.labels.push({ l: x, x: x.x, y: x.y, rot: x.rot });
      else if (it.t === 'dim') s.dims.push({ dim: x, a: { ...x.a }, b: { ...x.b } });
      else if (it.t === 'guide') s.guides.push({ g: x, a: { ...x.a }, b: { ...x.b } });
      else if (it.t === 'shape') s.shapes.push({ sh: x, from: JSON.parse(JSON.stringify(x)) });
    }
    for (const id of nodeIds) {
      const n = idx.nodes.get(id);
      if (n) s.nodes.push({ n, x: n.x, y: n.y, hosted: !!n.host });
    }
    for (const op of floor.openings) {
      if (wallIds.has(op.wallId)) s.openings.push({ op, d: op.d, len: G.wallFrame(idx.walls.get(op.wallId), idx).len });
    }
    return s;
  }

  // Moves every member through `map`. With o.sx/o.sy, sizes scale too; with o.by, everything
  // turns by that many degrees. Wall thickness, door widths, text size and stairs' steps keep
  // their real sizes.
  function place(floor, s, map, o) {
    for (const g of s.nodes) {
      if (g.hosted && g.n.host) continue;
      const p = map(g);
      g.n.x = p.x; g.n.y = p.y;
    }
    let idx = G.buildIndex(floor);
    // A T-junction slides along the wall it sits on to where the move takes it.
    for (const g of s.nodes) {
      if (!g.hosted || !g.n.host) continue;
      const wall = idx.walls.get(g.n.host.wallId);
      if (!wall) continue;
      const f = G.wallFrame(wall, idx);
      g.n.host.d = clamp(G.dot(G.sub(map(g), f.a), f.u), 0, f.len);
    }
    G.syncHosted(floor, idx);
    idx = G.buildIndex(floor);
    if (o.sx) {
      for (const g of s.openings) {
        const wall = idx.walls.get(g.op.wallId);
        if (wall && g.len > 1e-9) g.op.d = g.d * (G.wallFrame(wall, idx).len / g.len);
      }
    }
    for (const g of s.fixtures) {
      const p = map(g);
      g.fx.x = p.x; g.fx.y = p.y;
      if (o.sx) {
        const r = rad(g.rot), cos = Math.cos(r), sin = Math.sin(r);
        g.fx.w = Math.max(1, g.w * Math.hypot(cos * o.sx, sin * o.sy));
        g.fx.d = Math.max(1, g.d * Math.hypot(sin * o.sx, cos * o.sy));
      }
      if (o.by) g.fx.rot = wrap(g.rot + o.by);
    }
    for (const g of s.stairs) {
      if (o.by) {
        const p = map(g);
        g.st.x = p.x; g.st.y = p.y;
        g.st.rot = wrap(g.rot + o.by);
      } else {
        const c = map(g.c);
        g.st.x = g.x + c.x - g.c.x; g.st.y = g.y + c.y - g.c.y;
      }
    }
    for (const g of s.labels) {
      const p = map(g);
      g.l.x = p.x; g.l.y = p.y;
      if (o.by) g.l.rot = wrap(g.rot + o.by);
    }
    for (const g of s.guides) { g.g.a = map(g.a); g.g.b = map(g.b); }
    for (const g of s.shapes) FP.shapes.place(g.sh, g.from, map, o);
    for (const g of s.dims) {
      for (const end of ['a', 'b']) {
        const e = g[end];
        if (e.item && e.base) {
          // Its item moves with the group; the starting point moves too, so it isn't dropped.
          const b = map(e.base);
          g.dim[end].base = { x: b.x, y: b.y, ang: e.base.ang + (o.by || 0) };
        } else if (!e.nodeId) { const p = map(e); g.dim[end] = { x: p.x, y: p.y }; }
      }
    }
  }

  // Scales about `anchor` by sx across and sy down.
  function scale(floor, s, anchor, sx, sy) {
    place(floor, s, (p) => ({ x: anchor.x + (p.x - anchor.x) * sx, y: anchor.y + (p.y - anchor.y) * sy }), { sx, sy });
  }

  // Turns about `center` by `by` degrees, clockwise on screen like a fixture's rotation.
  function rotate(floor, s, center, by) {
    const r = rad(by), cos = Math.cos(r), sin = Math.sin(r);
    place(floor, s, (p) => {
      const dx = p.x - center.x, dy = p.y - center.y;
      return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
    }, { by });
  }

  FP.groups = { bounds, snapshot, scale, rotate };
})(globalThis);
