// Pure geometry: vectors, wall frames, T-junction positions and mitered wall polygons.
//
// Wall model: a wall runs from node a to node b, and that line IS the wall's inside
// (reference) face. Its thickness builds to one side of that line, chosen by wall.side.
// With y pointing down on screen, side -1 is the left of the travel direction.
(function (root) {
  const FP = (root.FP = root.FP || {});

  const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
  const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
  const neg = (a) => ({ x: -a.x, y: -a.y });
  const dot = (a, b) => a.x * b.x + a.y * b.y;
  const cross = (a, b) => a.x * b.y - a.y * b.x;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const nrm = (u) => ({ x: -u.y, y: u.x });

  function lineIntersect(p, u, q, v) {
    const c = cross(u, v);
    if (Math.abs(c) < 1e-9) return null;
    const t = cross(sub(q, p), v) / c;
    return { x: p.x + u.x * t, y: p.y + u.y * t, t };
  }

  function pointInPoly(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > pt.y) !== (b.y > pt.y) &&
          pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  function distToSegment(p, a, b) {
    const ab = sub(b, a);
    const l2 = dot(ab, ab);
    const t = l2 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
    return dist(p, add(a, mul(ab, t)));
  }

  function buildIndex(floor) {
    const nodes = new Map(floor.nodes.map((n) => [n.id, n]));
    const walls = new Map(floor.walls.map((w) => [w.id, w]));
    const byNode = new Map(floor.nodes.map((n) => [n.id, []]));
    for (const w of floor.walls) {
      if (byNode.has(w.a)) byNode.get(w.a).push(w);
      if (byNode.has(w.b)) byNode.get(w.b).push(w);
    }
    return { nodes, walls, byNode };
  }

  function wallFrame(wall, idx) {
    const a = idx.nodes.get(wall.a), b = idx.nodes.get(wall.b);
    const len = dist(a, b);
    const u = len > 1e-9 ? { x: (b.x - a.x) / len, y: (b.y - a.y) / len } : { x: 1, y: 0 };
    const n = nrm(u);
    const s = wall.side * wall.thickness; // signed offset of the far face along n
    return { a, b, u, n, len, s, t: wall.thickness, side: wall.side, ns: mul(n, wall.side), off: mul(n, s) };
  }

  // Positions a hosted (T-junction) node from its host wall. Hosts can chain, so resolve depth-first.
  function syncHosted(floor, idx) {
    idx = idx || buildIndex(floor);
    const done = new Set();
    const visit = (node) => {
      if (done.has(node.id)) return;
      done.add(node.id);
      if (!node.host) return;
      const wall = idx.walls.get(node.host.wallId);
      if (!wall) { delete node.host; return; }
      visit(idx.nodes.get(wall.a));
      visit(idx.nodes.get(wall.b));
      const f = wallFrame(wall, idx);
      node.host.d = Math.max(0, Math.min(f.len, node.host.d));
      let p = add(f.a, mul(f.u, node.host.d));
      if (node.host.face === 'far') p = add(p, f.off);
      node.x = p.x; node.y = p.y;
    };
    floor.nodes.forEach(visit);
    return idx;
  }

  // A T-junction sits on whichever face of the host its walls come off of.
  function updateHostFaces(floor, idx) {
    idx = idx || buildIndex(floor);
    for (const node of floor.nodes) {
      if (!node.host || node.host.pinned) continue;
      const wall = idx.walls.get(node.host.wallId);
      if (!wall) continue;
      const f = wallFrame(wall, idx);
      let far = 0, ref = 0;
      for (const w of idx.byNode.get(node.id) || []) {
        const other = idx.nodes.get(w.a === node.id ? w.b : w.a);
        if (dot(sub(other, f.a), f.ns) > f.t / 2) far++; else ref++;
      }
      if (far || ref) node.host.face = far > ref ? 'far' : 'ref';
    }
    return idx;
  }

  // True if making nodeId depend on wallId would create a circular T-junction chain.
  function wouldCycle(idx, nodeId, wallId) {
    const seen = new Set();
    const dependsOn = (wid) => {
      if (seen.has(wid)) return false;
      seen.add(wid);
      const w = idx.walls.get(wid);
      if (!w) return false;
      for (const nid of [w.a, w.b]) {
        if (nid === nodeId) return true;
        const n = idx.nodes.get(nid);
        if (n && n.host && dependsOn(n.host.wallId)) return true;
      }
      return false;
    };
    return dependsOn(wallId);
  }

  // Builds each wall's polygon, mitering every junction. Around a node, each gap between
  // neighbouring walls gets one vertex where the two faces bordering that gap intersect.
  function computeJoins(floor, idx) {
    idx = idx || buildIndex(floor);
    const ends = new Map();
    const TWO_PI = Math.PI * 2;
    for (const node of floor.nodes) {
      const items = [];
      for (const w of idx.byNode.get(node.id) || []) {
        const f = wallFrame(w, idx);
        if (f.len < 1e-6) continue;
        const atA = w.a === node.id;
        items.push(makeItem(atA ? f.u : neg(f.u), atA ? f.s : -f.s, w, atA));
      }
      if (!items.length) continue;
      if (node.host && idx.walls.has(node.host.wallId)) {
        // The host counts as two virtual walls running each way along its face.
        const f = wallFrame(idx.walls.get(node.host.wallId), idx);
        const s = node.host.face === 'far' ? -f.s : f.s;
        items.push(makeItem(f.u, s, null), makeItem(neg(f.u), -s, null));
      }
      items.sort((p, q) => p.ang - q.ang);
      for (const it of items) {
        it.plus = add(node, mul(nrm(it.u), it.p));
        it.minus = add(node, mul(nrm(it.u), it.q));
      }
      if (items.length > 1) {
        items.forEach((A, i) => {
          const j = (i + 1) % items.length;
          const B = items[j];
          if (!A.wall && !B.wall) return;
          let wedge = B.ang - A.ang;
          if (j === 0) wedge += TWO_PI;
          if (wedge < 0.01 || TWO_PI - wedge < 0.01 || Math.abs(wedge - Math.PI) < 0.01) return;
          const X = lineIntersect(A.plus, A.u, B.minus, B.u);
          const limit = 4 * Math.max(A.p, -A.q, B.p, -B.q) + 1;
          if (!X || dist(X, node) > limit) return;
          const v = { x: X.x, y: X.y };
          A.plus = v;
          B.minus = v;
        });
      }
      for (const it of items) {
        if (!it.wall) continue;
        const end = it.s > 0 ? { far: it.plus, ref: it.minus } : { far: it.minus, ref: it.plus };
        end.node = { x: node.x, y: node.y };
        const e = ends.get(it.wall.id) || {};
        e[it.atA ? 'a' : 'b'] = end;
        ends.set(it.wall.id, e);
      }
    }
    squareContinuedTees(floor, idx, ends);
    const out = new Map();
    for (const w of floor.walls) {
      const e = ends.get(w.id);
      if (!e || !e.a || !e.b) continue;
      const f = wallFrame(w, idx);
      out.set(w.id, {
        poly: [e.a.ref, e.b.ref, e.b.node, e.b.far, e.a.far, e.a.node],
        refA: e.a.ref, refB: e.b.ref, farA: e.a.far, farB: e.b.far,
        farLen: Math.abs(dot(sub(e.b.far, e.a.far), f.u)),
      });
    }
    return out;
  }

  // A wall that continues past a T wall, starting on the T wall's far face, reads as one wall
  // with the T butting into it. So the wall being continued runs across the T wall's end to
  // meet its continuation, and the T wall stops square against that wall's inside face.
  function squareContinuedTees(floor, idx, ends) {
    for (const start of floor.nodes) {
      const tee = start.host && idx.walls.get(start.host.wallId);
      if (!tee) continue;
      const t = wallFrame(tee, idx);
      const atA = start.host.d <= t.len / 2;
      const nodeId = atA ? tee.a : tee.b;
      const corner = idx.nodes.get(nodeId);
      const teeEnd = (ends.get(tee.id) || {})[atA ? 'a' : 'b'];
      if (!teeEnd) continue;
      for (const old of idx.byNode.get(nodeId) || []) {
        if (old === tee || tee.thickness > old.thickness) continue;
        const f = wallFrame(old, idx);
        const inward = old.b === nodeId ? f.u : neg(f.u); // along the wall, toward the corner
        const gap = sub(start, corner);
        const run = dot(gap, inward);
        if (run < 1e-6 || Math.abs(cross(gap, inward)) > 1e-6) continue;
        const continues = (idx.byNode.get(start.id) || []).some((w) => {
          if (w.type !== old.type || w === tee) return false;
          const g = wallFrame(w, idx);
          return dot(w.a === start.id ? g.u : neg(g.u), inward) > 0.999;
        });
        const oldEnd = (ends.get(old.id) || {})[old.b === nodeId ? 'b' : 'a'];
        if (!continues || !oldEnd) continue;
        const p = { x: start.x, y: start.y };
        oldEnd.ref = p;
        oldEnd.node = p;
        teeEnd[start.host.face === 'far' ? 'far' : 'ref'] = p;
        break;
      }
    }
  }

  function makeItem(u, s, wall, atA) {
    return { u, s, wall, atA, ang: Math.atan2(u.y, u.x), p: Math.max(0, s), q: Math.min(0, s) };
  }

  FP.geom = {
    add, sub, mul, neg, dot, cross, dist, nrm, lineIntersect, pointInPoly, distToSegment,
    buildIndex, wallFrame, syncHosted, updateHostFaces, wouldCycle, computeJoins,
  };
})(globalThis);
