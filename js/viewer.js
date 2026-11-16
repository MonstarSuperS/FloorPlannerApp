// View-only mode: look at a drawing, check sizes, measure and export, with no way to change it.
// Phones open in this mode (see device.js). The plan is driven by FP.gestures:
//   drag pans, pinch zooms, double tap fits the plan to the screen,
//   tap shows what's there and its sizes on a card,
//   Measure: tap two points for the distance between them; drag either end to adjust. The
//   second point keeps to 45-degree steps from the first unless Any angle is on (or Alt held).
(function (root) {
  const FP = (root.FP = root.FP || {});
  const app = FP.app, G = FP.geom, M = FP.model;
  const ACCENT = '#1f6feb';

  // Screen distances by input type: how near a tap must be to a thin line to pick it, how far a
  // measuring point reaches to land on a corner or wall, and how near a press must be to a
  // measuring end to drag it. Fingers need more room than a mouse.
  const REACH = {
    touch: { hit: 12, snap: 24, grab: 28 },
    pen: { hit: 8, snap: 16, grab: 18 },
    mouse: { hit: 5, snap: 12, grab: 10 },
  };
  const reach = (type) => REACH[type] || REACH.touch;

  let canvas = null;
  let gestures = null;
  let inspected = null;  // { t, id } of the item whose card is showing
  const measure = { on: false, a: null, b: null, free: false };
  let dragging = null;   // 'pan', or 'a' / 'b' for a measuring end

  const $ = (id) => document.getElementById(id);
  const fmt = () => ({ len: app.fmt, short: app.fmtShort, area: (v) => app.fmtArea(v) });
  const toWorld = (p) => ({ x: (p.x - app.view.ox) / app.view.scale, y: (p.y - app.view.oy) / app.view.scale });
  const toScreen = (w) => ({ x: w.x * app.view.scale + app.view.ox, y: w.y * app.view.scale + app.view.oy });

  // ---------- The card ----------

  function showCard(desc, note) {
    const card = $('infoCard');
    $('infoTitle').textContent = desc ? desc.title : '';
    const rows = $('infoRows');
    rows.textContent = '';
    for (const [label, value] of (desc && desc.rows) || []) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      rows.append(dt, dd);
    }
    $('infoNote').textContent = note || '';
    $('infoNote').hidden = !note;
    // The angle switch belongs to measuring only.
    $('infoActions').hidden = !measure.on;
    const free = $('anyAngleBtn');
    free.classList.toggle('on', measure.free);
    free.setAttribute('aria-pressed', String(measure.free));
    card.hidden = false;
  }

  function hideCard() {
    $('infoCard').hidden = true;
  }

  // Re-reads the card from the drawing, e.g. after the units change or another floor opens.
  function refreshCard() {
    if (measure.on) {
      if (measure.a && measure.b) {
        showCard(FP.describe.measurement(measure.a, measure.b, fmt()), 'Drag either end to adjust it. Tap anywhere else to measure again.');
      } else {
        showCard({ title: 'Measure', rows: [] }, measure.a ? 'Tap the second point.' : 'Tap the first point. Points land on corners and walls when close.');
      }
      return;
    }
    const desc = inspected && FP.describe.describe(app.floor(), app.geo(), inspected, fmt());
    if (!desc) { inspected = null; hideCard(); return; }
    showCard(desc);
  }

  function closeCard() {
    if (measure.on) { setMeasuring(false); return; }
    inspected = null;
    hideCard();
    app.requestRender();
  }

  // ---------- Tapping and measuring ----------

  function inspect(world, type) {
    const hit = FP.interact.tapHit(world, reach(type).hit);
    inspected = hit ? { t: hit.t === 'room-label' ? 'room' : hit.t, id: hit.id } : null;
    refreshCard();
    app.requestRender();
  }

  // Where a measuring end goes: the first lands on whatever is near; one placed or moved with
  // the other end down keeps to 45-degree steps from it, unless freed.
  function endPoint(world, type, other, alt) {
    const px = reach(type).snap;
    return other ? FP.interact.measureSnapFrom(other, world, px, measure.free || !!alt) : FP.interact.measureSnap(world, px);
  }

  function placePoint(world, type, alt) {
    if (!measure.a || measure.b) { measure.a = endPoint(world, type, null); measure.b = null; }
    else measure.b = endPoint(world, type, measure.a, alt);
    refreshCard();
    app.requestRender();
  }

  // Any angle: when turned off, the second end swings onto the nearest 45-degree step.
  function setFree(on) {
    measure.free = !!on;
    if (!measure.free && measure.a && measure.b) measure.b = endPoint(measure.b, 'touch', measure.a);
    refreshCard();
    app.requestRender();
  }

  function setMeasuring(on) {
    measure.on = !!on;
    measure.a = measure.b = null; // Any angle is kept for next time
    dragging = null;
    inspected = null;
    const btn = $('measureBtn');
    btn.classList.toggle('on', measure.on);
    btn.setAttribute('aria-pressed', String(measure.on));
    if (measure.on) refreshCard();
    else hideCard();
    app.requestRender();
  }

  // The measuring end within reach of screen point p, if any.
  function endAt(p, type) {
    let best = null, bestD = reach(type).grab;
    for (const k of ['a', 'b']) {
      if (!measure[k]) continue;
      const s = toScreen(measure[k]);
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d <= bestD) { best = k; bestD = d; }
    }
    return best;
  }

  // ---------- Gestures ----------

  const handlers = {
    enabled: () => app.readOnly,
    tap(p, info) {
      const world = toWorld(p);
      if (measure.on) placePoint(world, info.pointerType, info.event && info.event.altKey);
      else inspect(world, info.pointerType);
    },
    doubleTap(p, info) {
      // While measuring, quick taps are points; otherwise a double tap fits the plan.
      if (measure.on) placePoint(toWorld(p), info.pointerType, info.event && info.event.altKey);
      else app.fitView();
    },
    dragStart(p, info) {
      dragging = (measure.on && !info.afterPinch && endAt(p, info.pointerType)) || 'pan';
      if (dragging === 'pan') canvas.style.cursor = 'grabbing';
    },
    dragMove(p, delta, info) {
      if (dragging === 'pan') {
        app.view.ox += delta.x;
        app.view.oy += delta.y;
        app.emit('view');
        app.requestRender();
      } else if (dragging) {
        const other = measure[dragging === 'a' ? 'b' : 'a'];
        measure[dragging] = endPoint(toWorld(p), info.pointerType, other, info.event && info.event.altKey);
        refreshCard();
        app.requestRender();
      }
    },
    dragEnd() {
      dragging = null;
      canvas.style.cursor = 'grab';
    },
    pinch({ center, ratio, dx, dy }) {
      app.view.ox += dx;
      app.view.oy += dy;
      app.zoomAt(center.x, center.y, ratio);
    },
  };

  // Keys still work with a keyboard attached, but only for viewing.
  function onKey(e) {
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'o') { e.preventDefault(); FP.fileio.open(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'Escape') {
      if (measure.on && measure.a) { measure.a = measure.b = null; refreshCard(); app.requestRender(); }
      else closeCard();
    } else if (k === '0') app.fitView();
    else if (k === 'm' || k === 'M') setMeasuring(!measure.on);
    else if (k === '+' || k === '=') app.zoomAt(app.viewport.width / 2, app.viewport.height / 2, 1.25);
    else if (k === '-') app.zoomAt(app.viewport.width / 2, app.viewport.height / 2, 0.8);
  }

  // ---------- Drawing ----------

  const roomPaths = new WeakMap(); // detected rooms -> Map(label -> Path2D)

  // A room's floor area as a path, built from room detection's grid one row of cells at a time.
  function roomPath(detected, label) {
    let byLabel = roomPaths.get(detected);
    if (!byLabel) { byLabel = new Map(); roomPaths.set(detected, byLabel); }
    if (byLabel.has(label)) return byLabel.get(label);
    const path = new Path2D();
    const { w, h, ox, oy, cell, labels } = detected;
    for (let r = 0; r < h; r++) {
      let c = 0;
      while (c < w) {
        if (labels[r * w + c] !== label) { c++; continue; }
        const c0 = c;
        while (c < w && labels[r * w + c] === label) c++;
        path.rect(ox + c0 * cell, oy + r * cell, (c - c0) * cell, cell);
      }
    }
    byLabel.set(label, path);
    return path;
  }

  function strokeLine(R, a, b, width) {
    const c = R.ctx;
    R.world();
    c.beginPath();
    c.moveTo(a.x, a.y);
    c.lineTo(b.x, b.y);
    c.lineWidth = R.px(width);
    c.strokeStyle = ACCENT;
    c.stroke();
  }

  function drawHighlight(R, floor, geo) {
    if (!inspected) return;
    const I = FP.interact, c = R.ctx, id = inspected.id;
    const find = (list) => (list || []).find((x) => x.id === id);
    switch (inspected.t) {
      case 'wall': {
        const j = geo.joins.get(id);
        if (j) I.outlinePoly(R, j.poly, ACCENT, 0.25);
        break;
      }
      case 'opening': {
        const op = find(floor.openings);
        const wall = op && geo.idx.walls.get(op.wallId);
        if (!wall) break;
        const f = G.wallFrame(wall, geo.idx);
        const at = (al, p) => G.add(G.add(f.a, G.mul(f.u, al)), G.mul(f.ns, p));
        I.outlinePoly(R, [at(op.d - op.width / 2, 0), at(op.d + op.width / 2, 0), at(op.d + op.width / 2, f.t), at(op.d - op.width / 2, f.t)], ACCENT, 0.25);
        break;
      }
      case 'fixture': {
        const fx = find(floor.fixtures);
        if (fx) I.fixtureOutline(R, fx, ACCENT);
        break;
      }
      case 'shape': {
        const sh = find(floor.shapes);
        if (sh) FP.shapes.draw(R, sh, { color: ACCENT, noFill: true, weight: Math.max(2, (sh.weight || 1.25) + 1) });
        break;
      }
      case 'stair': {
        const st = find(floor.stairs);
        if (st) for (const poly of FP.stairs.geometry(st).polys) I.outlinePoly(R, poly, ACCENT, 0.12);
        break;
      }
      case 'dim': {
        const dim = find(floor.dims);
        if (dim) { const g = FP.render.dimGeometry(floor, dim, geo.idx); strokeLine(R, g.p, g.q, 3); }
        break;
      }
      case 'guide': {
        const g = find(floor.guides);
        if (g) strokeLine(R, g.a, g.b, 3);
        break;
      }
      case 'label': {
        const l = find(floor.labels);
        if (l) { const box = I.labelBox(l); I.fixtureOutline(R, { x: l.x, y: l.y, rot: l.rot, w: box.hw * 2 + 2, d: box.hh * 2 }, ACCENT); }
        break;
      }
      case 'room': {
        const region = geo.shown && geo.shown.get(id);
        if (!region || !geo.detected || !geo.detected.labels) break;
        R.world();
        c.save();
        c.globalAlpha = 0.16;
        c.fillStyle = ACCENT;
        c.fill(roomPath(geo.detected, region.label));
        c.restore();
        break;
      }
      default:
    }
  }

  function drawMeasure(R) {
    if (!measure.on || !measure.a) return;
    const c = R.ctx, u = R.unit;
    const a = measure.a, b = measure.b;
    if (b) strokeLine(R, a, b, 2);
    R.screen();
    for (const p of b ? [a, b] : [a]) {
      c.beginPath();
      c.arc(R.sx(p.x), R.sy(p.y), 6 * u, 0, Math.PI * 2);
      c.fillStyle = '#fff';
      c.fill();
      c.lineWidth = 2 * u;
      c.strokeStyle = ACCENT;
      c.stroke();
    }
    if (b && G.dist(a, b) > 1e-6) {
      const mx = R.sx((a.x + b.x) / 2), my = R.sy((a.y + b.y) / 2);
      let ang = Math.atan2(b.y - a.y, b.x - a.x);
      if (ang > Math.PI / 2) ang -= Math.PI;
      if (ang < -Math.PI / 2) ang += Math.PI;
      const off = 14 * u;
      FP.render.tagText(R, app.fmt(G.dist(a, b)), mx + Math.sin(ang) * off, my - Math.cos(ang) * off, ang, ACCENT, 13, 600);
    }
  }

  function drawOverlay(R, floor, geo) {
    drawHighlight(R, floor, geo);
    drawMeasure(R);
  }

  // ---------- Page state ----------

  // A phone with nothing open yet gets a prompt to open a drawing instead of an empty grid.
  function refreshEmpty() {
    const empty = app.readOnly && app.doc.floors.every((f) => !M.floorBounds(f, app.geo(f), false));
    $('emptyState').hidden = !empty;
    // Nothing to export or measure until a drawing is open.
    $('exportBtn').disabled = empty;
    $('measureBtn').disabled = empty;
    if (empty && measure.on) setMeasuring(false);
  }

  function onModeChange() {
    if (gestures) gestures.cancel();
    setMeasuring(false);
    inspected = null;
    hideCard();
    $('viewSheetBtn').setAttribute('aria-expanded', 'false');
    $('viewSheetBtn').classList.remove('on');
    $('topbar').classList.remove('show-view');
    canvas.style.cursor = app.readOnly ? 'grab' : '';
    refreshEmpty();
  }

  function init(el) {
    canvas = el;
    gestures = FP.gestures.attach(canvas, handlers);
    $('infoClose').onclick = () => closeCard();
    $('measureBtn').onclick = () => setMeasuring(!measure.on);
    $('anyAngleBtn').onclick = () => setFree(!measure.free);
    $('viewSheetBtn').onclick = () => {
      const open = $('topbar').classList.toggle('show-view');
      $('viewSheetBtn').setAttribute('aria-expanded', String(open));
      $('viewSheetBtn').classList.toggle('on', open);
    };
    $('emptyOpenBtn').onclick = () => FP.fileio.open();
    app.on((what) => {
      if (what === 'mode') onModeChange();
      else if (what === 'setting' && app.readOnly) { if (inspected || measure.on) refreshCard(); }
      else if (what === 'doc' && app.readOnly) {
        // Another floor, option or drawing: drop what no longer applies, keep what still does.
        if (measure.on && (measure.a || measure.b) && measure.floor !== app.doc.activeFloorId) { measure.a = measure.b = null; }
        measure.floor = app.doc.activeFloorId;
        if (inspected || measure.on) refreshCard();
        refreshEmpty();
      }
    });
    onModeChange();
  }

  FP.viewer = {
    init, onKey, drawOverlay, setMeasuring, setFree, REACH,
    state: () => ({ inspected, measure: { on: measure.on, a: measure.a, b: measure.b, free: measure.free }, dragging }),
  };
})(globalThis);
