// Merging wall segments that make up one straight wall into a single wall.
//
// The longest segment survives (keeping its id, type, side and lock/group state) and is
// stretched from the chain's first end to its last. Small drawing errors are straightened:
// segments may be up to ANGLE_TOL off line and OFFSET_TOL off the straight line or apart.
// Doors and windows keep their places on the merged wall, T-junctions on any segment move to
// it, and a wall meeting the chain at a seam becomes a T-junction on it.
(function (root) {
  const FP = (root.FP = root.FP || {});
  const G = FP.geom;
  const M = FP.model;

  const ANGLE_TOL = (2 * Math.PI) / 180;
  const OFFSET_TOL = 1; // inches

  const sideOf = (wall, f) => G.mul(f.n, wall.side); // physical direction of the thickness
  const segWord = (n) => `${n} segment${n === 1 ? '' : 's'}`;

  // A gap the width of a T wall: one piece ends at the T wall's end, and the next starts on its
  // face (a wall drawn past a T, as the wall tool does). Merging runs the wall across that T
  // wall's end, which then becomes a T on it.
  function bridged(idx, ids, p, q, gap) {
    for (const [h, c] of [[p, q], [q, p]]) {
      const x = h.host && idx.walls.get(h.host.wallId);
      if (x && !ids.has(x.id) && (x.a === c.id || x.b === c.id) && Math.abs(gap - x.thickness) <= OFFSET_TOL) return true;
    }
    return false;
  }

  // Checks that the walls form one straight, gap-free run and works out its ends.
  function plan(floor, idx, walls) {
    if (walls.length < 2) return { ok: false, msg: 'Select two or more wall segments to merge.' };
    const first = walls[0];
    const odd = walls.find((w) => w.type !== first.type || Math.abs(w.thickness - first.thickness) > 1e-6);
    if (odd) {
      return { ok: false, msg: 'These segments differ in type or thickness. Make them match in the Inspector first, then merge.', wallId: odd.id };
    }
    if (walls.some((w) => M.holdsLocked(floor, { t: 'wall', id: w.id }))) {
      return { ok: false, msg: 'Some of these segments are locked, or hold a locked door or window. Unlock them (Ctrl+L) to merge.' };
    }
    if (walls.some((w) => (w.group || null) !== (first.group || null))) {
      return { ok: false, msg: 'These segments are in different groups. Ungroup them (Ctrl+Shift+G) to merge.' };
    }
    const frames = new Map(walls.map((w) => [w.id, G.wallFrame(w, idx)]));
    const keep = walls.reduce((a, b) => (frames.get(b.id).len > frames.get(a.id).len ? b : a));
    const kf = frames.get(keep.id);
    const ns = sideOf(keep, kf);
    for (const w of walls) {
      const f = frames.get(w.id);
      if (Math.abs(G.cross(f.u, kf.u)) > Math.sin(ANGLE_TOL)) return { ok: false, msg: 'These segments aren\'t in a straight line, so they can\'t be one wall.' };
      if (G.dot(sideOf(w, f), ns) < 0) return { ok: false, msg: 'These segments have their thickness on opposite sides. Flip one (Inspector) so they match, then merge.' };
    }

    // Order the segments along the line and find the outermost ends.
    const t = (p) => G.dot(G.sub(p, kf.a), kf.u);
    let lo = null, hi = null;
    const spans = walls.map((w) => {
      const f = frames.get(w.id);
      const ta = t(f.a), tb = t(f.b);
      for (const [node, tv] of [[f.a, ta], [f.b, tb]]) {
        if (!lo || tv < lo.t) lo = { node, t: tv };
        if (!hi || tv > hi.t) hi = { node, t: tv };
      }
      const fwd = ta <= tb;
      return { w, from: Math.min(ta, tb), to: Math.max(ta, tb), nFrom: fwd ? f.a : f.b, nTo: fwd ? f.b : f.a };
    }).sort((a, b) => a.from - b.from);
    const ids = new Set(walls.map((w) => w.id));
    let reach = spans[0].to, reachNode = spans[0].nTo;
    for (const s of spans.slice(1)) {
      const gap = s.from - reach;
      if (gap > OFFSET_TOL && !bridged(idx, ids, reachNode, s.nFrom, gap)) {
        return { ok: false, msg: 'There is a gap between these segments. Select every segment of the wall, or close the gap first.' };
      }
      if (s.to > reach) { reach = s.to; reachNode = s.nTo; }
    }
    if (lo.node.id === hi.node.id || hi.t - lo.t < 1e-6) return { ok: false, msg: 'These segments don\'t make a wall with any length.' };

    // The merged wall follows the longest segment's line exactly, so a square wall stays
    // square. Every end must lie within OFFSET_TOL of that line.
    const A = lo.node, B = hi.node;
    for (const w of walls) {
      const f = frames.get(w.id);
      for (const p of [f.a, f.b]) {
        if (Math.abs(G.cross(kf.u, G.sub(p, kf.a))) > OFFSET_TOL) return { ok: false, msg: 'These segments are too far out of line to be one wall (more than 1").' };
      }
    }
    const u = kf.u;

    // Seams: chain ends other than the outer two. Other walls meeting one become T-junctions.
    const seams = new Set();
    for (const w of walls) for (const n of [w.a, w.b]) if (n !== A.id && n !== B.id) seams.add(n);
    for (const nid of seams) {
      const node = idx.nodes.get(nid);
      const others = (idx.byNode.get(nid) || []).filter((w) => !ids.has(w.id));
      if (!others.length) continue;
      if (node.host && !ids.has(node.host.wallId)) return { ok: false, msg: 'A joint between these segments sits on another wall, so they can\'t be merged across it.' };
      if (others.some((w) => w.locked)) return { ok: false, msg: 'A locked wall meets a joint between these segments. Unlock it (Ctrl+L) to merge.' };
      // A wall that becomes a T on the merged wall can't also hold one of its ends.
      if (others.some((w) => (A.host && A.host.wallId === w.id) || (B.host && B.host.wallId === w.id))) {
        return { ok: false, msg: 'A wall meeting a joint between these segments also holds one of their ends, so they can\'t be merged.' };
      }
    }
    return { ok: true, walls, ids, frames, keep, kf, A, B, u, ns, seams };
  }

  // Moves an outer end onto the merged wall's line: a free corner straight across to it, a
  // T-junction along its host wall to where that wall meets the line.
  function ontoLine(idx, node, kf) {
    const off = G.cross(kf.u, G.sub(node, kf.a));
    if (Math.abs(off) < 1e-9) return;
    if (!node.host) {
      const p = G.add(kf.a, G.mul(kf.u, G.dot(G.sub(node, kf.a), kf.u)));
      node.x = p.x; node.y = p.y;
      return;
    }
    const host = idx.walls.get(node.host.wallId);
    if (!host) return;
    const hf = G.wallFrame(host, idx);
    const base = node.host.face === 'far' ? G.add(hf.a, hf.off) : hf.a;
    const X = G.lineIntersect(base, hf.u, kf.a, kf.u);
    if (!X) return;
    const d = G.dot(G.sub(X, base), hf.u);
    if (d < 0 || d > hf.len) return;
    node.host.d = d;
    node.x = X.x; node.y = X.y;
  }

  // Merges the given walls into one. Returns { ok, msg, wallId }.
  function mergeWalls(floor, wallIds) {
    const idx = G.buildIndex(floor);
    const walls = [...new Set(wallIds)].map((id) => idx.walls.get(id)).filter(Boolean);
    const p = plan(floor, idx, walls);
    if (!p.ok) return p;
    const { ids, frames, keep, kf, A, B, u, ns } = p;

    // Where doors, windows and T-junctions sit now, taken before any corner moves (frames
    // hold live corners).
    const ops = floor.openings.filter((op) => ids.has(op.wallId)).map((op) => {
      const f = frames.get(op.wallId);
      return { op, at: G.add(f.a, G.mul(f.u, op.d)), reversed: G.dot(f.u, u) < 0 };
    });
    const tees = floor.nodes.filter((n) => n.host && ids.has(n.host.wallId) && !p.seams.has(n.id) && n.id !== A.id && n.id !== B.id).map((node) => {
      const f = frames.get(node.host.wallId);
      return { node, at: node.host.face === 'far' ? G.sub(node, f.off) : { x: node.x, y: node.y } };
    });

    // Outer ends that aren't the longest segment's move onto its line.
    const start = { x: kf.a.x, y: kf.a.y };
    for (const n of [A, B]) if (n.id !== keep.a && n.id !== keep.b) ontoLine(idx, n, { a: start, u });
    const along = (pt) => G.dot(G.sub(pt, A), u);

    // Doors and windows keep their place along the wall; a reversed segment swaps the hinge end.
    for (const { op, at, reversed } of ops) {
      op.d = along(at);
      if (reversed) op.flipHinge = !op.flipHinge;
      op.wallId = keep.id;
    }

    // T-junctions on any segment move to the merged wall, on the same face.
    for (const { node, at } of tees) {
      node.host.wallId = keep.id;
      node.host.d = along(at);
    }

    // Walls meeting a seam become T-junctions, one per face of the merged wall.
    for (const nid of p.seams) {
      const node = idx.nodes.get(nid);
      const others = (idx.byNode.get(nid) || []).filter((w) => !ids.has(w.id));
      if (!others.length) continue;
      const d = along(node);
      const byFace = { ref: [], far: [] };
      for (const w of others) {
        const end = idx.nodes.get(w.a === nid ? w.b : w.a);
        byFace[G.dot(G.sub(end, node), ns) > 0 ? 'far' : 'ref'].push(w);
      }
      let reuse = node;
      for (const face of ['ref', 'far']) {
        if (!byFace[face].length) continue;
        const target = reuse || M.addNode(floor, node.x, node.y);
        reuse = null;
        target.host = { wallId: keep.id, d, face };
        for (const w of byFace[face]) {
          if (w.a === nid) w.a = target.id;
          if (w.b === nid) w.b = target.id;
        }
      }
    }

    // The longest segment becomes the whole wall. A and B are ordered along its own direction,
    // so its side (and which face is the inside) stays the same.
    floor.walls = floor.walls.filter((w) => !ids.has(w.id) || w === keep);
    keep.a = A.id;
    keep.b = B.id;
    M.pruneNodes(floor);
    M.normalize(floor);
    return { ok: true, wallId: keep.id, count: walls.length };
  }

  // Straight runs on the floor made of more than one segment: chains of unlocked walls that
  // meet end to end at a shared, free corner (or across a T wall's end, see bridged), continue
  // in line, and match in type, thickness, side and group. A corner with more than one in-line
  // pair (walls crossing) is left alone;
  // a wall meeting a run's corner from the side becomes a T-junction when the run is merged.
  function straightRuns(floor) {
    const idx = G.buildIndex(floor);
    const free = (w) => !M.holdsLocked(floor, { t: 'wall', id: w.id });
    const parent = new Map();
    const find = (id) => { while (parent.get(id) !== id) id = parent.get(id); return id; };
    const join = (a, b) => parent.set(find(a), find(b));
    for (const w of floor.walls) parent.set(w.id, w.id);
    const linked = new Set();
    const link = (a, b) => { join(a.id, b.id); linked.add(a.id); linked.add(b.id); };
    // Direction a wall leaves a corner in.
    const out = (w, nodeId) => {
      const f = G.wallFrame(w, idx);
      return w.a === nodeId ? f.u : G.mul(f.u, -1);
    };
    // Whether wall a, leaving corner na, and wall b, leaving corner nb, are one wall.
    const continues = (a, na, b, nb) => {
      if (a === b || a.type !== b.type || Math.abs(a.thickness - b.thickness) > 1e-6 || (a.group || null) !== (b.group || null)) return false;
      if (G.dot(out(a, na), out(b, nb)) > -Math.cos(ANGLE_TOL)) return false; // not straight on
      return G.dot(sideOf(a, G.wallFrame(a, idx)), sideOf(b, G.wallFrame(b, idx))) > 0;
    };
    for (const node of floor.nodes) {
      const here = (idx.byNode.get(node.id) || []).filter(free);
      if (!node.host) {
        // Two pieces sharing a corner.
        const pairs = [];
        for (let i = 0; i < here.length; i++) {
          for (let j = i + 1; j < here.length; j++) if (continues(here[i], node.id, here[j], node.id)) pairs.push([here[i], here[j]]);
        }
        if (pairs.length === 1) link(...pairs[0]); // none, or ambiguous (walls crossing)
        continue;
      }
      // A piece starting on a T wall's face, continuing one that ends at that T wall's end.
      const tee = idx.walls.get(node.host.wallId);
      if (!tee || here.length !== 1) continue;
      const w1 = here[0];
      for (const cid of [tee.a, tee.b]) {
        const corner = idx.nodes.get(cid);
        const gap = G.dist(corner, node);
        if (corner.host || Math.abs(gap - tee.thickness) > OFFSET_TOL || gap < 1e-6) continue;
        const across = G.mul(G.sub(node, corner), 1 / gap);
        if (G.dot(out(w1, node.id), across) < Math.cos(ANGLE_TOL)) continue; // w1 heads away from the corner
        const pairs = (idx.byNode.get(cid) || []).filter(free).filter((w2) => w2 !== tee && continues(w1, node.id, w2, cid));
        if (pairs.length === 1) link(w1, pairs[0]);
      }
    }
    const runs = new Map();
    for (const id of linked) {
      const r = find(id);
      if (!runs.has(r)) runs.set(r, []);
      runs.get(r).push(id);
    }
    return [...runs.values()].filter((ids) => ids.length > 1);
  }

  // Merges every straight run on the floor. Returns how many runs and segments were merged.
  function mergeAll(floor) {
    let runs = 0, segments = 0;
    for (const ids of straightRuns(floor)) {
      if (!ids.every((id) => floor.walls.some((w) => w.id === id))) continue;
      const res = mergeWalls(floor, ids);
      if (res.ok) { runs++; segments += res.count; }
    }
    return { runs, segments };
  }

  FP.merge = { mergeWalls, straightRuns, mergeAll, segWord, ANGLE_TOL, OFFSET_TOL };
})(globalThis);
