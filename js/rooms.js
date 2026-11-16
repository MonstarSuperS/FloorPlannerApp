// Room detection. Wall polygons are rasterized onto a fine grid and flood-filled from outside:
// any open area the flood cannot reach is a room. This handles T-junctions, angled walls and
// crossing walls without needing a clean planar graph. Openings do not break a room.
(function (root) {
  const FP = (root.FP = root.FP || {});
  const MAX_CELLS = 4e6;
  const MIN_ROOM_AREA = 144; // sq in; smaller pockets are slivers, not rooms

  function fillPolygon(poly, grid, g, value) {
    value = value || 1;
    const crossings = [];
    let minY = Infinity, maxY = -Infinity;
    for (const p of poly) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    const r0 = Math.max(0, Math.floor((minY - g.oy) / g.cell - 0.5));
    const r1 = Math.min(g.h - 1, Math.ceil((maxY - g.oy) / g.cell - 0.5));
    for (let r = r0; r <= r1; r++) {
      const y = g.oy + (r + 0.5) * g.cell;
      crossings.length = 0;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[j], b = poly[i];
        if ((a.y <= y) !== (b.y <= y)) {
          crossings.push({ x: a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x), dir: b.y > a.y ? 1 : -1 });
        }
      }
      crossings.sort((p, q) => p.x - q.x);
      let winding = 0;
      for (let k = 0; k < crossings.length - 1; k++) {
        winding += crossings[k].dir;
        if (!winding) continue;
        const c0 = Math.max(0, Math.ceil((crossings[k].x - g.ox) / g.cell - 0.5));
        const c1 = Math.min(g.w - 1, Math.floor((crossings[k + 1].x - g.ox) / g.cell - 0.5));
        for (let c = c0; c <= c1; c++) grid[r * g.w + c] = value;
      }
    }
  }

  // A room divider as a thin band of grid cells: wide enough that the flood cannot slip through
  // it diagonally, and run a little past each end so it closes against the walls it meets.
  function dividerBand(a, b, cell) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return null;
    const ux = dx / len, uy = dy / len;
    const half = cell * 0.8, over = cell * 2;
    const nx = -uy * half, ny = ux * half;
    const p = { x: a.x - ux * over, y: a.y - uy * over }, q = { x: b.x + ux * over, y: b.y + uy * over };
    return [{ x: p.x + nx, y: p.y + ny }, { x: q.x + nx, y: q.y + ny }, { x: q.x - nx, y: q.y - ny }, { x: p.x - nx, y: p.y - ny }];
  }

  // polys: wall polygons in inches. minThickness: thinnest wall, so the grid cannot leak through it.
  // dividers: [[a, b], ...] room divider lines, which split rooms like walls but take no area.
  function detect(polys, minThickness, dividers) {
    const empty = { rooms: [], labels: null, labelAt: () => -1 };
    if (!polys.length) return empty;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const poly of polys) {
      for (const p of poly) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
    }
    let cell = Math.min(1, Math.max(0.25, minThickness / 2.5));
    const area = (maxX - minX + 4) * (maxY - minY + 4);
    if (area / (cell * cell) > MAX_CELLS) cell = Math.sqrt(area / MAX_CELLS);
    const g = {
      cell,
      ox: Math.floor(minX / cell) * cell - 2 * cell,
      oy: Math.floor(minY / cell) * cell - 2 * cell,
    };
    g.w = Math.ceil((maxX - g.ox) / cell) + 3;
    g.h = Math.ceil((maxY - g.oy) / cell) + 3;
    const grid = new Uint8Array(g.w * g.h);
    // Dividers first, as 2; walls then overwrite with 1 wherever they overlap.
    for (const [a, b] of dividers || []) {
      const band = dividerBand(a, b, cell);
      if (band) fillPolygon(band, grid, g, 2);
    }
    for (const poly of polys) fillPolygon(poly, grid, g);

    // labels: -1 wall, -3 divider, 0 outside or unassigned, >0 room number
    const DIVIDER = -3;
    const labels = new Int32Array(g.w * g.h);
    let hasDividers = false;
    for (let i = 0; i < grid.length; i++) {
      if (grid[i] === 1) labels[i] = -1;
      else if (grid[i] === 2) { labels[i] = DIVIDER; hasDividers = true; }
    }
    const stack = [];
    const flood = (start, value) => {
      let count = 0;
      labels[start] = value;
      stack.push(start);
      while (stack.length) {
        const i = stack.pop();
        count++;
        const c = i % g.w;
        if (c > 0 && labels[i - 1] === 0) { labels[i - 1] = value; stack.push(i - 1); }
        if (c < g.w - 1 && labels[i + 1] === 0) { labels[i + 1] = value; stack.push(i + 1); }
        if (i >= g.w && labels[i - g.w] === 0) { labels[i - g.w] = value; stack.push(i - g.w); }
        if (i < labels.length - g.w && labels[i + g.w] === 0) { labels[i + g.w] = value; stack.push(i + g.w); }
      }
      return count;
    };
    const OUTSIDE = -2;
    flood(0, OUTSIDE);
    const counts = [];
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] === 0) {
        const value = counts.length + 1;
        counts.push(flood(i, value));
      }
    }

    // Distance from each cell to the nearest other label, to centre room labels in open space.
    const dist = new Float32Array(g.w * g.h);
    const D = 1, D2 = 1.414;
    for (let r = 0; r < g.h; r++) {
      for (let c = 0; c < g.w; c++) {
        const i = r * g.w + c;
        if (labels[i] <= 0) continue;
        let best = 1e9;
        if (r > 0) {
          best = Math.min(best, dist[i - g.w] + D);
          if (c > 0) best = Math.min(best, dist[i - g.w - 1] + D2);
          if (c < g.w - 1) best = Math.min(best, dist[i - g.w + 1] + D2);
        }
        if (c > 0) best = Math.min(best, dist[i - 1] + D);
        dist[i] = best;
      }
    }
    const anchors = counts.map(() => ({ d: -1, i: 0 }));
    for (let r = g.h - 1; r >= 0; r--) {
      for (let c = g.w - 1; c >= 0; c--) {
        const i = r * g.w + c;
        if (labels[i] <= 0) continue;
        let best = dist[i];
        if (r < g.h - 1) {
          best = Math.min(best, dist[i + g.w] + D);
          if (c > 0) best = Math.min(best, dist[i + g.w - 1] + D2);
          if (c < g.w - 1) best = Math.min(best, dist[i + g.w + 1] + D2);
        }
        if (c < g.w - 1) best = Math.min(best, dist[i + 1] + D);
        dist[i] = best;
        const a = anchors[labels[i] - 1];
        if (best > a.d) { a.d = best; a.i = i; }
      }
    }

    // A divider has no thickness: its cells go back to the rooms either side, so the two areas
    // add up to the undivided room. Done after the label anchors, so each label is centred in
    // its own part. Divider cells outside any room (past a wall) become wall.
    if (hasDividers) {
      for (let pass = 0; pass < 4; pass++) {
        const claims = [];
        for (let i = 0; i < labels.length; i++) {
          if (labels[i] !== DIVIDER) continue;
          const c = i % g.w;
          const n = [c > 0 ? labels[i - 1] : 0, c < g.w - 1 ? labels[i + 1] : 0,
            i >= g.w ? labels[i - g.w] : 0, i < labels.length - g.w ? labels[i + g.w] : 0];
          const room = n.find((v) => v > 0);
          if (room) claims.push(i, room);
        }
        if (!claims.length) break;
        for (let k = 0; k < claims.length; k += 2) { labels[claims[k]] = claims[k + 1]; counts[claims[k + 1] - 1]++; }
      }
      for (let i = 0; i < labels.length; i++) if (labels[i] === DIVIDER) labels[i] = -1;
    }

    const rooms = [];
    counts.forEach((count, k) => {
      const sq = count * cell * cell;
      if (sq < MIN_ROOM_AREA) return;
      const i = anchors[k].i;
      rooms.push({
        label: k + 1,
        area: sq,
        anchor: { x: g.ox + ((i % g.w) + 0.5) * cell, y: g.oy + (Math.floor(i / g.w) + 0.5) * cell },
      });
    });

    return {
      rooms, labels, ox: g.ox, oy: g.oy, w: g.w, h: g.h, cell,
      labelAt(x, y) {
        const c = Math.floor((x - g.ox) / cell), r = Math.floor((y - g.oy) / cell);
        if (c < 0 || r < 0 || c >= g.w || r >= g.h) return -1;
        return labels[r * g.w + c];
      },
    };
  }

  FP.rooms = { detect };
})(globalThis);
