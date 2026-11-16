// Drawing data model and the edits that keep it consistent. No DOM access here.
(function (root) {
  const FP = (root.FP = root.FP || {});
  const G = FP.geom;

  let counter = 0;
  const uid = (prefix) =>
    `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  // swing: has a side it opens toward (flipSwing). side: has a hinge or pocket end (flipHinge).
  // panels: choice of single or double.
  const OPENING_KINDS = {
    door_int: { name: 'Interior Door', width: 32, sizes: [24, 28, 30, 32, 36], door: true, swing: true, side: true },
    door_ext: { name: 'Exterior Door', width: 36, sizes: [32, 36, 42, 60, 72], door: true, swing: true, side: true },
    bifold: { name: 'Bifold Closet Door', width: 48, sizes: [24, 30, 36, 48, 60, 72], door: true, swing: true, side: true, panels: true },
    pocket: { name: 'Pocket Door', width: 32, sizes: [24, 28, 30, 32, 36, 48, 60, 72], door: true, side: true, panels: true },
    slider: { name: 'Sliding Glass Door', width: 72, sizes: [60, 72, 96, 120], door: true, side: true },
    cased: { name: 'Doorless Opening', width: 36, sizes: [24, 30, 32, 36, 42, 48, 60, 72, 96], door: true },
    window: { name: 'Window', width: 36, sizes: [24, 30, 36, 48, 60, 72, 96], door: false },
  };

  // Where a pocket door's panels slide into the wall, as spans along the wall [lo, hi], each
  // with `out`, the way its panel slides out (+1 toward the wall's end). One pocket the full
  // opening width at the hinge end, or for a double, two half-width pockets, one each side.
  function pocketSpans(op) {
    const s = op.d - op.width / 2, e = op.d + op.width / 2;
    if ((op.panels || 1) >= 2) {
      const h = op.width / 2;
      return [{ lo: s - h, hi: s, out: 1 }, { lo: e, hi: e + h, out: -1 }];
    }
    return op.flipHinge ? [{ lo: e, hi: e + op.width, out: -1 }] : [{ lo: s - op.width, hi: s, out: 1 }];
  }

  // Why a pocket door's pocket won't fit in its wall, or '' if it does: the pocket must stay
  // within the wall and clear of other doors and windows.
  function pocketProblem(floor, op) {
    if (op.kind !== 'pocket') return '';
    const idx = G.buildIndex(floor);
    const wall = idx.walls.get(op.wallId);
    if (!wall) return '';
    const len = G.wallFrame(wall, idx).len;
    for (const p of pocketSpans(op)) {
      if (p.lo < -1e-6 || p.hi > len + 1e-6) return 'The pocket runs past the end of the wall.';
      const hit = floor.openings.some((o) => o.id !== op.id && o.wallId === op.wallId &&
        o.d + o.width / 2 > p.lo + 1e-6 && o.d - o.width / 2 < p.hi - 1e-6);
      if (hit) return 'The pocket runs into another door or window.';
    }
    return '';
  }

  const defaultSettings = () => ({
    units: 'ftin', gridSize: 1, snap: true, angleStep: 45,
    showGrid: true, showLengths: true, bothFaces: false, showRooms: true, showGhost: true, showGhostAbove: true, showGuides: true,
    interiorThickness: 4, exteriorThickness: 6,
    // A dimension attached to an item is removed once the attached point has moved more than
    // dimMove inches, or the item turned more than dimTurn degrees, from where it was drawn.
    dimMove: 12, dimTurn: 5,
  });

  // Keeps only known settings, replacing anything invalid with its default.
  function cleanSettings(raw) {
    const out = defaultSettings();
    raw = raw || {};
    for (const key of ['snap', 'showGrid', 'showLengths', 'bothFaces', 'showRooms', 'showGhost', 'showGhostAbove', 'showGuides']) {
      if (typeof raw[key] === 'boolean') out[key] = raw[key];
    }
    if (FP.units.MODES.includes(raw.units)) out.units = raw.units;
    if (Number.isFinite(raw.gridSize) && raw.gridSize > 0) out.gridSize = raw.gridSize;
    if ([15, 45, 90].includes(raw.angleStep)) out.angleStep = raw.angleStep;
    if (Number.isFinite(raw.interiorThickness)) out.interiorThickness = Math.max(1, raw.interiorThickness);
    if (Number.isFinite(raw.exteriorThickness)) out.exteriorThickness = Math.max(1, raw.exteriorThickness);
    if (Number.isFinite(raw.dimMove) && raw.dimMove >= 0) out.dimMove = raw.dimMove;
    if (Number.isFinite(raw.dimTurn) && raw.dimTurn >= 0) out.dimTurn = Math.min(180, raw.dimTurn);
    return out;
  }

  function createFloor(name) {
    return { id: uid('f'), name, hidden: false, nodes: [], walls: [], openings: [], fixtures: [], stairs: [], dims: [], labels: [], rooms: [], guides: [], shapes: [] };
  }

  // Moves a floor to a new position in the stack. Floors run lowest to highest.
  function moveFloor(doc, id, to) {
    const from = doc.floors.findIndex((f) => f.id === id);
    const target = Math.max(0, Math.min(doc.floors.length - 1, to));
    if (from < 0 || target === from) return false;
    const [floor] = doc.floors.splice(from, 1);
    doc.floors.splice(target, 0, floor);
    return true;
  }

  // The floor directly below, whose stairs arrive on this one.
  function floorUnder(doc, floor) {
    const i = doc.floors.indexOf(floor);
    return i > 0 ? doc.floors[i - 1] : null;
  }

  // The floor directly above.
  function floorOver(doc, floor) {
    const i = doc.floors.indexOf(floor);
    return i >= 0 && i < doc.floors.length - 1 ? doc.floors[i + 1] : null;
  }

  // The floor shown faintly under this one: the nearest one below that isn't hidden.
  function floorBelow(doc, floor) {
    for (let i = doc.floors.indexOf(floor) - 1; i >= 0; i--) {
      if (!doc.floors[i].hidden) return doc.floors[i];
    }
    return null;
  }

  // The floor overlaid faintly on this one: the nearest one above that isn't hidden.
  function floorAbove(doc, floor) {
    const i = doc.floors.indexOf(floor);
    if (i < 0) return null;
    for (let k = i + 1; k < doc.floors.length; k++) {
      if (!doc.floors[k].hidden) return doc.floors[k];
    }
    return null;
  }

  // Every stair that appears on a floor, and how. A stair connects two floors and belongs to the
  // one it was drawn on: one that goes up runs to the floor above, one that goes down to the floor
  // below. On the lower floor it's seen from the bottom ('up'), on the upper floor from the top
  // ('down'). own: whether it belongs to this floor, so it can be selected here.
  function stairsSeen(doc, floor) {
    const out = [];
    for (const st of floor.stairs || []) out.push({ st, mode: st.goes === 'down' ? 'down' : 'up', own: true });
    const under = floorUnder(doc, floor), over = floorOver(doc, floor);
    for (const st of under ? under.stairs || [] : []) if (st.goes !== 'down') out.push({ st, mode: 'down', own: false });
    for (const st of over ? over.stairs || [] : []) if (st.goes === 'down') out.push({ st, mode: 'up', own: false });
    return out;
  }

  function createDoc(defaults) {
    const floor = createFloor('Floor 1');
    return { name: 'Untitled plan', settings: cleanSettings(defaults), floors: [floor], activeFloorId: floor.id, customFixtures: [], furniture: [] };
  }

  function addNode(floor, x, y, host) {
    const node = { id: uid('n'), x, y };
    if (host) node.host = host;
    floor.nodes.push(node);
    return node;
  }

  function addWall(floor, a, b, type, thickness, side) {
    const wall = { id: uid('w'), a, b, type, thickness, side: side === 1 ? 1 : -1 };
    floor.walls.push(wall);
    return wall;
  }

  // Re-establishes derived state after any edit: T-junctions, then openings on their walls.
  function normalize(floor) {
    const idx = G.buildIndex(floor);
    G.syncHosted(floor, idx);
    G.updateHostFaces(floor, idx);
    G.syncHosted(floor, idx);
    for (const op of floor.openings) {
      const wall = idx.walls.get(op.wallId);
      if (!wall) continue;
      const f = G.wallFrame(wall, idx);
      op.d = f.len <= op.width ? f.len / 2 : Math.max(op.width / 2, Math.min(f.len - op.width / 2, op.d));
    }
  }

  // Keeps a dimension's position when the node it was attached to goes away.
  function releaseDimRefs(floor, node) {
    for (const dim of floor.dims) {
      for (const end of [dim.a, dim.b]) {
        if (end.nodeId === node.id) { end.x = node.x; end.y = node.y; delete end.nodeId; }
      }
    }
  }

  function pruneNodes(floor) {
    const used = new Set();
    for (const w of floor.walls) { used.add(w.a); used.add(w.b); }
    floor.nodes = floor.nodes.filter((n) => {
      if (used.has(n.id)) return true;
      releaseDimRefs(floor, n);
      return false;
    });
  }

  function deleteWall(floor, wallId) {
    floor.walls = floor.walls.filter((w) => w.id !== wallId);
    floor.openings = floor.openings.filter((o) => o.wallId !== wallId);
    for (const n of floor.nodes) if (n.host && n.host.wallId === wallId) delete n.host;
    pruneNodes(floor);
    normalize(floor);
  }

  // Merges node `drop` into `keep`, removing any wall that collapses or becomes a duplicate.
  function mergeNodes(floor, keepId, dropId) {
    if (keepId === dropId) return;
    for (const w of floor.walls) {
      if (w.a === dropId) w.a = keepId;
      if (w.b === dropId) w.b = keepId;
    }
    for (const dim of floor.dims) {
      if (dim.a.nodeId === dropId) dim.a.nodeId = keepId;
      if (dim.b.nodeId === dropId) dim.b.nodeId = keepId;
    }
    const seen = new Set();
    for (const w of floor.walls.slice()) {
      const key = [w.a, w.b].sort().join('|');
      if (w.a === w.b || seen.has(key)) {
        floor.walls = floor.walls.filter((x) => x !== w);
        floor.openings = floor.openings.filter((o) => o.wallId !== w.id);
        for (const n of floor.nodes) if (n.host && n.host.wallId === w.id) delete n.host;
      } else {
        seen.add(key);
      }
    }
    floor.nodes = floor.nodes.filter((n) => n.id !== dropId);
    pruneNodes(floor);
    normalize(floor);
  }

  // Separates a shared corner so each wall gets its own end, freeing a T-junction too.
  function splitNode(floor, nodeId) {
    const idx = G.buildIndex(floor);
    const node = idx.nodes.get(nodeId);
    if (!node) return;
    delete node.host;
    (idx.byNode.get(nodeId) || []).slice(1).forEach((w) => {
      const clone = addNode(floor, node.x, node.y);
      if (w.a === nodeId) w.a = clone.id; else w.b = clone.id;
    });
    normalize(floor);
  }

  // Which nodes must move with `startId` so connected walls keep their angles. Walls parallel
  // to the move simply stretch and stop the spread. Returns null if the fixed end would have to move.
  function collectStretch(idx, startId, fixedId, delta, editedWallId) {
    const mag = Math.hypot(delta.x, delta.y);
    if (mag < 1e-9) return new Set([startId]);
    const dir = { x: delta.x / mag, y: delta.y / mag };
    const moved = new Set([startId]);
    const queue = [startId];
    while (queue.length) {
      const p = queue.shift();
      for (const w of idx.byNode.get(p) || []) {
        if (w.id === editedWallId) continue;
        const qId = w.a === p ? w.b : w.a;
        if (moved.has(qId)) continue;
        const f = G.wallFrame(w, idx);
        if (Math.abs(G.cross(f.u, dir)) < 0.01) continue; // parallel: it stretches
        const q = idx.nodes.get(qId);
        if (q.host) continue; // a T-junction slides along its own host
        if (qId === fixedId) return null;
        moved.add(qId);
        queue.push(qId);
      }
    }
    return moved;
  }

  // Sets a wall's inside-face length. anchor: which part stays put ('a', 'b' or 'center').
  function setWallLength(floor, wallId, length, anchor, keepAngles) {
    const idx = G.buildIndex(floor);
    const wall = idx.walls.get(wallId);
    if (!wall || !(length > 0)) return { ok: false, msg: 'Enter a length greater than zero.' };
    const f = G.wallFrame(wall, idx);
    const change = length - f.len;
    const aHosted = !!f.a.host, bHosted = !!f.b.host;
    if (aHosted && bHosted) return { ok: false, msg: 'Both ends sit on other walls. Move those walls to change this length.' };
    if (anchor === 'center' && (aHosted || bHosted)) anchor = aHosted ? 'a' : 'b';
    if (anchor === 'a' && bHosted) anchor = 'b';
    if (anchor === 'b' && aHosted) anchor = 'a';

    const moves = [];
    if (anchor === 'a') moves.push([wall.b, wall.a, G.mul(f.u, change)]);
    else if (anchor === 'b') moves.push([wall.a, wall.b, G.mul(f.u, -change)]);
    else {
      moves.push([wall.b, wall.a, G.mul(f.u, change / 2)]);
      moves.push([wall.a, wall.b, G.mul(f.u, -change / 2)]);
    }
    const passOpeningOffset = anchor !== 'a';
    const shift = anchor === 'b' ? change : anchor === 'center' ? change / 2 : 0;
    for (const [nodeId, fixedId, delta] of moves) {
      const set = (keepAngles && collectStretch(idx, nodeId, fixedId, delta, wall.id)) || new Set([nodeId]);
      for (const id of set) {
        const n = idx.nodes.get(id);
        n.x += delta.x; n.y += delta.y;
      }
    }
    // Whatever sits on this wall keeps its real-world position when the start end moves.
    if (passOpeningOffset) {
      for (const op of floor.openings) if (op.wallId === wall.id) op.d += shift;
      for (const n of floor.nodes) if (n.host && n.host.wallId === wall.id) n.host.d += shift;
    }
    normalize(floor);
    return { ok: true };
  }

  // Rotates the wall about its start. Angle in degrees, counterclockwise on screen, 0 = right.
  function setWallAngle(floor, wallId, degrees) {
    const idx = G.buildIndex(floor);
    const wall = idx.walls.get(wallId);
    if (!wall) return { ok: false };
    const f = G.wallFrame(wall, idx);
    if (f.b.host) return { ok: false, msg: 'The end of this wall sits on another wall, so its angle is set by that wall.' };
    const r = (degrees * Math.PI) / 180;
    f.b.x = f.a.x + Math.cos(r) * f.len;
    f.b.y = f.a.y - Math.sin(r) * f.len;
    normalize(floor);
    return { ok: true };
  }

  function wallAngle(f) {
    const deg = (Math.atan2(-(f.b.y - f.a.y), f.b.x - f.a.x) * 180) / Math.PI;
    return ((deg % 360) + 360) % 360;
  }

  function openingFits(floor, wallId, d, width, ignoreId) {
    const idx = G.buildIndex(floor);
    const wall = idx.walls.get(wallId);
    if (!wall) return false;
    const f = G.wallFrame(wall, idx);
    if (d - width / 2 < -1e-6 || d + width / 2 > f.len + 1e-6) return false;
    return !floor.openings.some((o) => o.id !== ignoreId && o.wallId === wallId &&
      Math.abs(o.d - d) < (o.width + width) / 2 - 1e-6);
  }

  // Applies detected regions to the floor's room records, keeping names through wall edits.
  function syncRoomRecords(floor, detected) {
    const claimed = new Set();
    const next = [];
    const shown = new Map();
    for (const rec of floor.rooms) {
      const label = detected.labelAt(rec.x, rec.y);
      const region = detected.rooms.find((r) => r.label === label);
      if (region && !claimed.has(label)) {
        claimed.add(label);
        if (!rec.moved && !rec.locked) { rec.x = region.anchor.x; rec.y = region.anchor.y; }
        next.push(rec);
        shown.set(rec.id, region);
      } else if (rec.name) {
        next.push(rec); // a named room stays dormant in case the wall comes back
      }
    }
    for (const region of detected.rooms) {
      if (claimed.has(region.label)) continue;
      const rec = { id: uid('r'), x: region.anchor.x, y: region.anchor.y, name: '', moved: false };
      next.push(rec);
      shown.set(rec.id, region);
    }
    floor.rooms = next;
    return shown;
  }

  // ---------- Points on items that dimensions attach to ----------
  // Fixtures: corners c0-c3, side middles m0-m3 and the centre. Doors and windows: each end on
  // each face (s/e, r/f for the inside and far face). Stairs: each flight's and the landing's
  // corners. Each point carries the item's angle in degrees.
  function itemPoints(floor, t, item, idx) {
    const out = [];
    if (t === 'fixture') {
      const r = (item.rot * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
      const at = (a, b) => ({ x: item.x + (a * item.w / 2) * cos - (b * item.d / 2) * sin, y: item.y + (a * item.w / 2) * sin + (b * item.d / 2) * cos });
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([a, b], k) => out.push({ pt: `c${k}`, ...at(a, b) }));
      [[0, -1], [1, 0], [0, 1], [-1, 0]].forEach(([a, b], k) => out.push({ pt: `m${k}`, ...at(a, b) }));
      out.push({ pt: 'ctr', x: item.x, y: item.y });
      for (const p of out) p.ang = item.rot;
    } else if (t === 'opening') {
      idx = idx || G.buildIndex(floor);
      const wall = idx.walls.get(item.wallId);
      if (!wall) return out;
      const f = G.wallFrame(wall, idx);
      const ang = (Math.atan2(f.u.y, f.u.x) * 180) / Math.PI;
      for (const [k, along] of [['s', item.d - item.width / 2], ['e', item.d + item.width / 2]]) {
        for (const [face, perp] of [['r', 0], ['f', f.t]]) {
          out.push({ pt: k + face, x: f.a.x + f.u.x * along + f.ns.x * perp, y: f.a.y + f.u.y * along + f.ns.y * perp, ang });
        }
      }
    } else if (t === 'shape' && FP.shapes) {
      return FP.shapes.snapPoints(item);
    } else if (t === 'stair' && FP.stairs) {
      const g = FP.stairs.geometry(item);
      g.flights.forEach((fl, i) => fl.corners.forEach((p, k) => out.push({ pt: `f${i}c${k}`, x: p.x, y: p.y, ang: item.rot })));
      if (g.landing) g.landing.forEach((p, k) => out.push({ pt: `lc${k}`, x: p.x, y: p.y, ang: item.rot }));
    }
    return out;
  }

  const ITEM_LISTS = { fixture: 'fixtures', opening: 'openings', stair: 'stairs', shape: 'shapes' };

  // Where an attached dimension end is now, or null if its item or point is gone.
  function itemPoint(floor, ref, idx) {
    const list = floor[ITEM_LISTS[ref.t]];
    const item = list && list.find((x) => x.id === ref.id);
    if (!item) return null;
    return itemPoints(floor, ref.t, item, idx).find((p) => p.pt === ref.pt) || null;
  }

  // A locked dimension stays where it is rather than following its items.
  function dimEnds(floor, dim, idx) {
    idx = idx || G.buildIndex(floor);
    const at = (end) => (end.nodeId && idx.nodes.get(end.nodeId)) || (end.item && !dim.locked && itemPoint(floor, end.item, idx)) || end;
    return { a: at(dim.a), b: at(dim.b) };
  }

  // After an edit: dimensions attached to items take their new positions, and any whose item
  // is gone, or moved or turned past the drawing's limits from where it was when the dimension
  // was drawn, are removed. Returns how many were removed.
  function followItems(floor, settings) {
    const idx = G.buildIndex(floor);
    const move = settings ? settings.dimMove : 12, turn = settings ? settings.dimTurn : 5;
    const turned = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);
    const before = floor.dims.length;
    floor.dims = floor.dims.filter((dim) => {
      if (dim.locked) {
        // A locked dimension stays put, letting go of an item that moved (as with corners).
        for (const end of [dim.a, dim.b]) {
          if (!end.item) continue;
          const p = itemPoint(floor, end.item, idx);
          if (!p || Math.hypot(p.x - end.x, p.y - end.y) > 1e-6) { delete end.item; delete end.base; }
        }
        return true;
      }
      for (const end of [dim.a, dim.b]) {
        if (!end.item) continue;
        const p = itemPoint(floor, end.item, idx);
        if (!p) return false;
        const base = end.base || { x: p.x, y: p.y, ang: p.ang };
        if (Math.hypot(p.x - base.x, p.y - base.y) > move + 1e-6 || turned(p.ang, base.ang) > turn + 1e-6) return false;
        end.x = p.x; end.y = p.y;
      }
      return true;
    });
    return before - floor.dims.length;
  }

  // An end attached to an item point, remembering where it started.
  function itemEnd(ref, p) {
    return { item: { t: ref.t, id: ref.id, pt: ref.pt }, base: { x: p.x, y: p.y, ang: p.ang }, x: p.x, y: p.y };
  }

  function floorBounds(floor, geo, includeGuides) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const take = (p) => {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    };
    if (geo) for (const j of geo.joins.values()) j.poly.forEach(take);
    floor.nodes.forEach(take);
    for (const g of floor.guides) if (includeGuides || g.divider) { take(g.a); take(g.b); }
    for (const fx of floor.fixtures) {
      const r = (fx.rot * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const lx = (a * fx.w) / 2, ly = (b * fx.d) / 2;
        take({ x: fx.x + lx * cos - ly * sin, y: fx.y + lx * sin + ly * cos });
      }
    }
    for (const st of floor.stairs || []) for (const poly of FP.stairs.geometry(st).polys) poly.forEach(take);
    for (const sh of floor.shapes || []) FP.shapes.outlinePoints(sh).forEach(take);
    const idx = G.buildIndex(floor);
    for (const dim of floor.dims) {
      const e = dimEnds(floor, dim, idx);
      const len = G.dist(e.a, e.b) || 1;
      const off = { x: (-(e.b.y - e.a.y) / len) * dim.offset, y: ((e.b.x - e.a.x) / len) * dim.offset };
      take(e.a); take(e.b); take(G.add(e.a, off)); take(G.add(e.b, off));
    }
    for (const l of floor.labels) {
      // Text width is estimated here, since this module has no drawing context to measure with.
      const half = (l.text.length * l.size * 0.55) / 2;
      const r = (l.rot * Math.PI) / 180;
      const hx = Math.abs(Math.cos(r)) * half + Math.abs(Math.sin(r)) * l.size * 0.6;
      const hy = Math.abs(Math.sin(r)) * half + Math.abs(Math.cos(r)) * l.size * 0.6;
      take({ x: l.x - hx, y: l.y - hy });
      take({ x: l.x + hx, y: l.y + hy });
    }
    // Door swings reach beyond the wall, on the side the door opens toward.
    for (const op of floor.openings) {
      const wall = idx.walls.get(op.wallId);
      if (!wall || !(OPENING_KINDS[op.kind] || {}).swing) continue;
      const f = G.wallFrame(wall, idx);
      const toFar = !!op.flipSwing;
      const reach = toFar ? f.t + op.width : -op.width;
      for (const along of [op.d - op.width / 2, op.d + op.width / 2]) {
        take(G.add(G.add(f.a, G.mul(f.u, along)), G.mul(f.ns, reach)));
      }
    }
    if (minX === Infinity) return null;
    return { minX, minY, maxX, maxY };
  }

  // ---------- Locks and groups ----------
  // Any item but a corner can be locked. Walls, fixtures, stairs, text, dimensions and lines can
  // be grouped; doors, windows and rooms go with their walls. Items carry `locked: true` and
  // `group: id`; a group is just the items sharing an id.
  const LOCKABLE = new Set(['wall', 'opening', 'fixture', 'stair', 'label', 'dim', 'guide', 'room', 'shape']);
  const GROUPABLE = new Set(['wall', 'fixture', 'stair', 'label', 'dim', 'guide', 'shape']);
  const LISTS = { wall: 'walls', node: 'nodes', fixture: 'fixtures', opening: 'openings', dim: 'dims', label: 'labels', room: 'rooms', guide: 'guides', stair: 'stairs', shape: 'shapes' };

  function itemOf(floor, s) {
    const list = LISTS[s.t] && floor[LISTS[s.t]];
    return list ? list.find((x) => x.id === s.id) || null : null;
  }

  // A corner counts as locked when every wall at it is.
  function isLocked(floor, s) {
    if (s.t === 'node') {
      const walls = floor.walls.filter((w) => w.a === s.id || w.b === s.id);
      return walls.length > 0 && walls.every((w) => w.locked);
    }
    const item = itemOf(floor, s);
    return !!(item && item.locked);
  }

  // Locked, or a wall carrying a locked door or window, which would move or go with it.
  function holdsLocked(floor, s) {
    return isLocked(floor, s) || (s.t === 'wall' && floor.openings.some((o) => o.wallId === s.id && o.locked));
  }

  function groupMembers(floor, gid) {
    const out = [];
    if (!gid) return out;
    for (const t of GROUPABLE) for (const x of floor[LISTS[t]] || []) if (x.group === gid) out.push({ t, id: x.id });
    return out;
  }

  // The items plus every other member of any group they belong to.
  function expandGroups(floor, items) {
    const out = [], seen = new Set(), groups = new Set();
    const add = (s) => { const k = `${s.t}:${s.id}`; if (!seen.has(k)) { seen.add(k); out.push(s); } };
    for (const s of items) {
      add(s);
      const item = GROUPABLE.has(s.t) && itemOf(floor, s);
      if (item && item.group) groups.add(item.group);
    }
    for (const gid of groups) groupMembers(floor, gid).forEach(add);
    return out;
  }

  // A group left with one member is no longer a group.
  function pruneGroups(floor) {
    const count = new Map();
    for (const t of GROUPABLE) for (const x of floor[LISTS[t]] || []) if (x.group) count.set(x.group, (count.get(x.group) || 0) + 1);
    for (const t of GROUPABLE) for (const x of floor[LISTS[t]] || []) if (x.group && count.get(x.group) < 2) delete x.group;
  }

  // Where locked walls' ends and locked dimensions' ends are, to hold them there through an edit.
  function lockedEnds(floor) {
    const idx = G.buildIndex(floor);
    const walls = new Map(), dims = new Map();
    for (const w of floor.walls) {
      if (!w.locked) continue;
      const a = idx.nodes.get(w.a), b = idx.nodes.get(w.b);
      if (a && b) walls.set(w.id, { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } });
    }
    for (const d of floor.dims) {
      if (!d.locked) continue;
      const e = dimEnds(floor, d, idx);
      dims.set(d.id, { a: { x: e.a.x, y: e.a.y }, b: { x: e.b.x, y: e.b.y } });
    }
    return { walls, dims };
  }

  // After an edit, a locked wall whose end was carried along by an unlocked one separates from
  // it and stays where it was, and a locked dimension lets go of a corner that moved. Returns
  // whether anything had to be separated.
  function protectLocked(floor, before) {
    if (!before || (!before.walls.size && !before.dims.size)) return false;
    let idx = G.buildIndex(floor);
    let changed = false;
    const clones = new Map();
    for (const [id, ends] of before.walls) {
      const wall = idx.walls.get(id);
      if (!wall || !wall.locked) continue;
      for (const end of ['a', 'b']) {
        const n = idx.nodes.get(wall[end]), old = ends[end];
        if (!n || Math.hypot(n.x - old.x, n.y - old.y) < 1e-6) continue;
        const key = `${n.id}|${old.x}|${old.y}`;
        if (!clones.has(key)) clones.set(key, addNode(floor, old.x, old.y));
        wall[end] = clones.get(key).id;
        changed = true;
      }
    }
    if (changed) { pruneNodes(floor); idx = G.buildIndex(floor); }
    for (const [id, ends] of before.dims) {
      const dim = floor.dims.find((d) => d.id === id);
      if (!dim || !dim.locked) continue;
      const now = dimEnds(floor, dim, idx);
      for (const end of ['a', 'b']) {
        const old = ends[end];
        if (Math.hypot(now[end].x - old.x, now[end].y - old.y) < 1e-6) continue;
        dim[end] = { x: old.x, y: old.y };
        changed = true;
      }
    }
    if (changed) normalize(floor);
    return changed;
  }

  // Before a corner is dragged, locked walls at it get their own corner so they stay put.
  // Returns the walls left on the dragged corner.
  function detachLocked(floor, nodeId) {
    const idx = G.buildIndex(floor);
    const node = idx.nodes.get(nodeId);
    const walls = idx.byNode.get(nodeId) || [];
    const locked = walls.filter((w) => w.locked);
    if (!node || !locked.length || locked.length === walls.length) return walls;
    const clone = addNode(floor, node.x, node.y, node.host ? { ...node.host } : undefined);
    for (const w of locked) { if (w.a === nodeId) w.a = clone.id; else w.b = clone.id; }
    for (const d of floor.dims) {
      if (!d.locked) continue;
      for (const end of [d.a, d.b]) if (end.nodeId === nodeId) end.nodeId = clone.id;
    }
    normalize(floor);
    return walls.filter((w) => !w.locked);
  }

  // ---------- Reading files ----------
  // A drawing file may be damaged, or made by someone else, so every item is checked before
  // use: ids are text, numbers are finite and within LIMIT, and choices are ones the app knows.
  const LIMIT = 1e6; // inches, about 16 miles: anything further out is damage, not a drawing
  const coord = (v) => Number.isFinite(v) && Math.abs(v) <= LIMIT;
  const num = (v, fallback) => (coord(v) ? v : fallback);
  const isPoint = (p) => !!p && coord(p.x) && coord(p.y);
  const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max || 500) : null);
  const angle = (v) => ((num(v, 0) % 360) + 360) % 360;
  const size = (v, max) => (coord(v) && v > 0 ? Math.min(v, max || LIMIT) : null);

  // Keeps `locked` and `group` only when they're the right kind.
  function flags(raw, out) {
    delete out.locked; delete out.group;
    if (raw.locked === true) out.locked = true;
    if (isId(raw.group)) out.group = raw.group;
    return out;
  }

  // A dimension end: a position, optionally on a corner or attached to a point on an item.
  function dimEnd(e) {
    if (!isPoint(e)) return null;
    const out = { x: e.x, y: e.y };
    if (isId(e.nodeId)) out.nodeId = e.nodeId;
    const okRef = e.item && ITEM_LISTS[e.item.t] && isId(e.item.id) && isId(e.item.pt);
    const okBase = e.base && isPoint(e.base) && Number.isFinite(e.base.ang);
    if (okRef && okBase) {
      out.item = { t: e.item.t, id: e.item.id, pt: e.item.pt };
      out.base = { x: e.base.x, y: e.base.y, ang: e.base.ang };
    }
    return out;
  }

  // One item of a floor's list, repaired, or null if it can't be used. Whether the walls and
  // corners it refers to exist is checked separately, once the whole floor is read.
  const CLEAN = {
    nodes(n) {
      if (!n || !isId(n.id) || !isPoint(n)) return null;
      const out = { id: n.id, x: n.x, y: n.y };
      const h = n.host;
      if (h && isId(h.wallId) && coord(h.d)) {
        out.host = { wallId: h.wallId, d: h.d, face: h.face === 'far' ? 'far' : 'ref' };
        if (h.pinned === true) out.host.pinned = true;
      }
      return out;
    },
    walls(w) {
      if (!w || !isId(w.id) || !isId(w.a) || !isId(w.b) || w.a === w.b) return null;
      return flags(w, { ...w, type: w.type === 'exterior' ? 'exterior' : 'interior', thickness: Math.min(120, Math.max(1, num(w.thickness, 4))), side: w.side === 1 ? 1 : -1 });
    },
    openings(o) {
      if (!o || !isId(o.id) || !OPENING_KINDS[o.kind] || !isId(o.wallId) || !size(o.width) || !coord(o.d)) return null;
      return flags(o, { ...o, width: size(o.width, 1200), flipHinge: o.flipHinge === true, flipSwing: o.flipSwing === true, panels: o.panels === 2 ? 2 : 1 });
    },
    fixtures(f) {
      if (!f || !isId(f.id) || !isPoint(f) || !size(f.w) || !size(f.d)) return null;
      const kinds = FP.fixtures ? FP.fixtures.KINDS : {};
      const out = flags(f, { ...f, kind: kinds[f.kind] ? f.kind : 'generic', w: size(f.w, 2400), d: size(f.d, 2400), rot: angle(f.rot) });
      if (text(f.name, 100) === null) delete out.name; else out.name = text(f.name, 100);
      if (!isId(f.customId)) delete out.customId;
      return out;
    },
    dims(d) {
      const a = d && dimEnd(d.a), b = d && dimEnd(d.b);
      if (!a || !b) return null;
      return flags(d, { ...d, id: isId(d.id) ? d.id : uid('d'), a, b, offset: num(d.offset, 18) });
    },
    labels(l) {
      if (!l || text(l.text) === null || !isPoint(l)) return null;
      return flags(l, { ...l, id: isId(l.id) ? l.id : uid('t'), text: text(l.text), size: Math.min(1000, Math.max(1, num(l.size, 8))), rot: angle(l.rot) });
    },
    rooms(r) {
      if (!r || !isPoint(r)) return null;
      const out = flags(r, { ...r, id: isId(r.id) ? r.id : uid('r') });
      if (text(r.name, 200) === null) delete out.name; else out.name = text(r.name, 200);
      if (r.moved !== true) delete out.moved;
      return out;
    },
    guides(g) {
      if (!g || !isId(g.id) || !isPoint(g.a) || !isPoint(g.b)) return null;
      const out = flags(g, { ...g, a: { x: g.a.x, y: g.a.y }, b: { x: g.b.x, y: g.b.y } });
      if (g.divider !== true) delete out.divider;
      return out;
    },
    stairs(s, goes) {
      if (!s || !isId(s.id) || !isPoint(s)) return null;
      return flags(s, { ...FP.stairs.clean({ ...s, goes: s.goes || goes || 'up' }), id: s.id });
    },
    shapes(x) {
      const out = FP.shapes.clean(x);
      return out && isId(out.id) ? out : null;
    },
  };

  // A list from a file, cleaned item by item, keeping the first of any repeated id.
  function cleanList(k, list, extra) {
    const seen = new Set();
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
      const x = CLEAN[k](raw, extra);
      if (!x || seen.has(x.id)) continue;
      seen.add(x.id);
      out.push(x);
    }
    return out;
  }
  const cleanItem = (k, raw) => (CLEAN[k] ? CLEAN[k](raw) : null);

  // Validates and repairs a loaded file. Throws with a readable message if it cannot be used.
  function sanitizeDoc(data) {
    if (!data || data.app !== 'FloorPlanner' || !Array.isArray(data.floors) || !data.floors.length) {
      throw new Error('This is not a FloorPlanner drawing file.');
    }
    if (data.format > FORMAT) throw new Error('This file was saved by a newer version of FloorPlanner.');
    const doc = createDoc();
    doc.name = text(data.name, 200) || doc.name;
    doc.settings = cleanSettings(data.settings);
    const kinds = FP.fixtures ? FP.fixtures.KINDS : {};
    doc.customFixtures = (Array.isArray(data.customFixtures) ? data.customFixtures : [])
      .filter((c) => c && isId(c.id) && size(c.w) && size(c.d))
      .map((c) => ({ id: c.id, name: text(c.name, 100) || 'Custom fixture', base: kinds[c.base] ? c.base : 'generic', w: size(c.w, 2400), d: size(c.d, 2400) }));
    doc.furniture = (Array.isArray(data.furniture) ? data.furniture : []).map((p) => FP.shapes.cleanPiece(p)).filter(Boolean);
    const floorIds = new Set();
    doc.floors = data.floors.filter((raw) => raw && typeof raw === 'object').map((raw, i, all) => {
      const floor = createFloor(text(raw.name, 100) || `Floor ${i + 1}`);
      if (isId(raw.id) && !floorIds.has(raw.id)) floor.id = raw.id;
      floorIds.add(floor.id);
      floor.hidden = raw.hidden === true;
      floor.nodes = cleanList('nodes', raw.nodes);
      const ids = new Set(floor.nodes.map((n) => n.id));
      floor.walls = cleanList('walls', raw.walls).filter((w) => ids.has(w.a) && ids.has(w.b));
      const wallIds = new Set(floor.walls.map((w) => w.id));
      floor.openings = cleanList('openings', raw.openings).filter((o) => wallIds.has(o.wallId));
      floor.fixtures = cleanList('fixtures', raw.fixtures);
      floor.dims = cleanList('dims', raw.dims);
      // Stairs saved before they had a direction went up; one on the top floor can only have
      // meant the stairs from the floor below.
      floor.stairs = cleanList('stairs', raw.stairs, i > 0 && i === all.length - 1 ? 'down' : 'up');
      floor.labels = cleanList('labels', raw.labels);
      floor.rooms = cleanList('rooms', raw.rooms);
      floor.guides = cleanList('guides', raw.guides);
      floor.shapes = cleanList('shapes', raw.shapes);
      // A T-junction chain that loops, or points at a missing wall, is dropped back to a free node.
      for (const n of floor.nodes) {
        if (n.host && (!wallIds.has(n.host.wallId) || !Number.isFinite(n.host.d))) delete n.host;
      }
      const idx = G.buildIndex(floor);
      for (const n of floor.nodes) {
        if (!n.host) continue;
        const hostId = n.host.wallId;
        const saved = n.host;
        delete n.host;
        if (!G.wouldCycle(idx, n.id, hostId)) n.host = saved;
      }
      pruneGroups(floor);
      normalize(floor);
      if (FP.options) FP.options.clean(floor, raw);
      return floor;
    });
    if (!doc.floors.length) throw new Error('This is not a FloorPlanner drawing file.');
    doc.activeFloorId = doc.floors.some((f) => f.id === data.activeFloorId) ? data.activeFloorId : doc.floors[0].id;
    return doc;
  }

  const FORMAT = 1;
  function serializeDoc(doc) {
    // Floors are saved with their as-is plan in place, whichever design option is open.
    const floors = FP.options ? doc.floors.map((f) => FP.options.forSaving(f)) : doc.floors;
    return { app: 'FloorPlanner', format: FORMAT, savedAt: new Date().toISOString(), ...doc, floors };
  }

  FP.model = {
    uid, OPENING_KINDS, pocketSpans, pocketProblem, defaultSettings, cleanSettings, createFloor, moveFloor, floorBelow, floorAbove, floorUnder, floorOver, stairsSeen, createDoc, addNode, addWall, normalize,
    deleteWall, mergeNodes, splitNode, setWallLength, setWallAngle, wallAngle, openingFits,
    syncRoomRecords, dimEnds, itemPoints, itemPoint, followItems, itemEnd, floorBounds, sanitizeDoc, serializeDoc, pruneNodes, cleanItem, LIMIT,
    LOCKABLE, GROUPABLE, itemOf, isLocked, holdsLocked, groupMembers, expandGroups, pruneGroups, lockedEnds, protectLocked, detachLocked,
  };
})(globalThis);
