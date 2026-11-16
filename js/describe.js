// Plain descriptions of items on the plan, for showing rather than editing: what it is and its
// sizes. Used by the card that appears when you tap something in view-only mode.
//
// describe(floor, geo, ref, fmt) -> { title, rows: [[label, value], ...] } or null
//   ref: { t, id } as hit-testing returns it ('room-label' counts as the room)
//   fmt: { len, short, area } formatting functions for the drawing's units
(function (root) {
  const FP = (root.FP = root.FP || {});
  const G = FP.geom, M = FP.model;

  const byId = (list, id) => (list || []).find((x) => x.id === id) || null;
  const pair = (fmt, w, d) => `${fmt.short(w)} x ${fmt.short(d)}`;

  const KINDS = {
    wall(floor, geo, id, fmt) {
      const wall = geo.idx.walls.get(id);
      if (!wall) return null;
      const f = G.wallFrame(wall, geo.idx);
      const j = geo.joins.get(id);
      const rows = [['Length (inside face)', fmt.len(f.len)]];
      if (j) rows.push(['Other face', fmt.len(j.farLen)]);
      rows.push(['Thickness', fmt.short(wall.thickness)]);
      return { title: wall.type === 'exterior' ? 'Exterior Wall' : 'Interior Wall', rows };
    },

    opening(floor, geo, id, fmt) {
      const op = byId(floor.openings, id);
      if (!op) return null;
      const kind = M.OPENING_KINDS[op.kind] || { name: 'Opening' };
      return { title: kind.name, rows: [['Width', fmt.short(op.width)]] };
    },

    fixture(floor, geo, id, fmt) {
      const fx = byId(floor.fixtures, id);
      if (!fx) return null;
      const kind = FP.fixtures.KINDS[fx.kind] || FP.fixtures.KINDS.generic;
      return { title: fx.name || kind.name, rows: [['Size', pair(fmt, fx.w, fx.d)]] };
    },

    shape(floor, geo, id, fmt) {
      const S = FP.shapes;
      const sh = byId(floor.shapes, id);
      if (!sh) return null;
      const title = S.nameOf(sh);
      if (sh.kind === 'ellipse' && sh.circle) return { title, rows: [['Diameter', fmt.short(sh.w)]] };
      if (S.boxed(sh)) return { title, rows: [['Size', pair(fmt, sh.w, sh.d)]] };
      if (S.isClosed(sh)) {
        const b = S.bounds(sh);
        const rows = [['Perimeter', fmt.len(S.length(sh))]];
        if (b) rows.push(['Overall', pair(fmt, b.maxX - b.minX, b.maxY - b.minY)]);
        return { title, rows };
      }
      return { title, rows: [['Length', fmt.len(S.length(sh))]] };
    },

    stair(floor, geo, id, fmt) {
      const st = byId(floor.stairs, id);
      if (!st) return null;
      const g = FP.stairs.geometry(st);
      const k = g.counts;
      const title = st.shape === 'straight' ? 'Straight Stairs' : st.shape === 'L' ? 'L-Shaped Stairs' : 'U-Shaped Stairs';
      return {
        title,
        rows: [
          ['Width', fmt.short(st.width)],
          ['Risers', `${k.risers} at ${fmt.short(Math.round(k.riserHeight * 16) / 16)}`],
          ['Treads', k.landing ? `${k.first} + landing + ${k.second}` : String(k.treads)],
          ['Run', fmt.len(g.run)],
        ],
      };
    },

    dim(floor, geo, id, fmt) {
      const dim = byId(floor.dims, id);
      if (!dim) return null;
      return { title: 'Dimension', rows: [['Measures', fmt.len(FP.render.dimGeometry(floor, dim, geo.idx).len)]] };
    },

    guide(floor, geo, id, fmt) {
      const g = byId(floor.guides, id);
      if (!g) return null;
      return { title: g.divider ? 'Room Divider' : 'Construction Line', rows: [['Length', fmt.len(G.dist(g.a, g.b))]] };
    },

    label(floor, geo, id) {
      const l = byId(floor.labels, id);
      if (!l) return null;
      return { title: 'Text', rows: [['Reads', l.text]] };
    },

    room(floor, geo, id, fmt) {
      const rec = byId(floor.rooms, id);
      const region = rec && geo.shown && geo.shown.get(id);
      if (!region) return null;
      return { title: rec.name || 'Room', rows: [['Floor area', fmt.area(region.area)]] };
    },
  };

  function describe(floor, geo, ref, fmt) {
    if (!ref) return null;
    const t = ref.t === 'room-label' ? 'room' : ref.t;
    return KINDS[t] ? KINDS[t](floor, geo, ref.id, fmt) : null;
  }

  // Two points measured on screen: the distance between them, and how far apart they are
  // across and up or down the page.
  function measurement(a, b, fmt) {
    return {
      title: 'Measurement',
      rows: [
        ['Distance', fmt.len(G.dist(a, b))],
        ['Across', fmt.len(Math.abs(b.x - a.x))],
        ['Up or down', fmt.len(Math.abs(b.y - a.y))],
      ],
    };
  }

  FP.describe = { describe, measurement, kinds: Object.keys(KINDS) };
})(globalThis);
