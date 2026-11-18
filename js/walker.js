// The Walk tool: draw walls by walking around a room and typing what the tape says. The words
// and the geometry are in walk.js; this is the tool around them: where a walk starts, the pad
// and command line, the preview on the plan, and undo.
//
// A walk starts where you tap (an existing corner or wall face joins it), or in the middle of
// the screen if you just start typing. Each entry rebuilds the walk's walls from the floor as
// it was when the walk began and records one undo step, so Undo, Ctrl+Z and the Undo button
// all agree. Closing a room, or Finish, ends that walk; the next one carries on from the same
// corner unless you tap somewhere else.
//
// On a phone this is the editor: Draw switches from viewing to walking, Done switches back.
(function (root) {
  const FP = (root.FP = root.FP || {});
  const app = FP.app, G = FP.geom, W = FP.walk;
  const ACCENT = '#1f6feb';
  const ERROR = '#bf3320';
  const REACH = { touch: 24, pen: 16, mouse: 12 }; // how far a tap reaches to land on a corner or wall

  // Walks since the tool was picked, oldest first; the last is the current one. Each:
  //   { floorId, base, baseHist, baseSnap, start, heading, type, entries, count, tr, sig,
  //     penNodeId, from }
  // base: the floor's corners, walls and openings as they were when the walk began.
  // entries: [{ entry, hist, snap, penNodeId }]; those past `count` were undone and come back
  //   with Redo. hist and snap tie each to the undo history, so a change made any other way
  //   is noticed.
  // from: how the walk began, if it carried on from the one before: 'close' or 'finish'.
  let walks = [];
  let canvas = null;
  let committing = false;
  let note = null;     // { text, error } shown on the panel until the next entry
  let preview = null;  // { tr, from } for what's typed but not yet added, or { error }
  let keyboardOn = false;

  const $ = (id) => document.getElementById(id);
  const cur = () => walks[walks.length - 1] || null;
  const active = () => app.tool === 'walk' && !app.readOnly;
  const phone = () => document.documentElement.classList.contains('compact');
  const toWorld = (p) => ({ x: (p.x - app.view.ox) / app.view.scale, y: (p.y - app.view.oy) / app.view.scale });
  const floorParts = (f) => JSON.stringify({ nodes: f.nodes, walls: f.walls, openings: f.openings });

  // ---------- Walks ----------

  function ctxOf(w) {
    if (!w.faces) w.faces = W.facesOf(JSON.parse(w.base));
    return { start: w.start, heading: w.heading, type: w.type, faces: w.faces };
  }

  const entriesOf = (w) => w.entries.slice(0, w.count).map((x) => x.entry);
  // What the walls depend on, so steps that change nothing (a turn on its own) skip the rebuild.
  const sigOf = (tr) => JSON.stringify([tr.legs.map((l) => [l.heading, l.type, l.segs.map((s) => [s.len, s.opening])]), tr.side, tr.closed]);

  // A new walk from `start`: { kind: 'node' | 'wall' | 'free', x, y, nodeId?, wallId?, d?, face? }.
  function begin(start, heading, type) {
    const floor = app.floor();
    const w = {
      floorId: floor.id, base: floorParts(floor), baseHist: app.historyIndex, baseSnap: app.history[app.historyIndex],
      start, heading: W.norm(heading || 0), type: type || app.wallType || 'exterior', entries: [], count: 0, penNodeId: null,
    };
    w.tr = W.trace([], ctxOf(w));
    w.sig = sigOf(w.tr);
    walks.push(w);
    return w;
  }

  // Where to start when typing begins without a tap: the middle of the screen, on the grid.
  function defaultStart() {
    const c = toWorld({ x: app.viewport.width / 2, y: app.viewport.height / 2 });
    const g = app.settings().gridSize || 1;
    return { kind: 'free', x: Math.round(c.x / g) * g, y: Math.round(c.y / g) * g };
  }

  // A walk nobody has picked a start for begins in the middle of the screen as it is now, so
  // it follows panning, zooming and New until the first wall is typed.
  function atCentre(heading, type) {
    const w = begin(defaultStart(), heading, type);
    w.centred = true;
    return w;
  }
  function settle(w) {
    if (!w || !w.centred || w.count) return w;
    const c = defaultStart();
    if (c.x !== w.start.x || c.y !== w.start.y) {
      w.start = c;
      w.tr = W.trace([], ctxOf(w));
    }
    return w;
  }

  function ensureWalk() {
    const w = cur();
    if (w && w.floorId === app.doc.activeFloorId) return w.tr.closed ? carryOn(w, 'close') : settle(w);
    walks = [];
    return atCentre(0, app.wallType);
  }

  // Keeps the walk on screen as it grows: pans to it, zooming out only if it no longer fits.
  function follow(tr) {
    if (!tr || tr.corners.length < 2) return;
    const v = app.view, vp = app.viewport, m = 36;
    // The design bar sits over the top of the plan, so the walk keeps clear of it too.
    const bar = $('designBar');
    const top = m + (bar && !bar.hidden ? Math.max(0, bar.getBoundingClientRect().bottom - canvas.getBoundingClientRect().top) : 0);
    const availW = vp.width - 2 * m, availH = vp.height - top - m;
    if (availW <= 0 || availH <= 0) return;
    const xs = tr.corners.map((p) => p.x), ys = tr.corners.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const fit = Math.min(availW / Math.max(maxX - minX, 1e-6), availH / Math.max(maxY - minY, 1e-6));
    let changed = false;
    if (fit < v.scale) {
      const cx = (vp.width / 2 - v.ox) / v.scale, cy = ((vp.height + top - m) / 2 - v.oy) / v.scale;
      v.scale = Math.max(0.2, fit);
      v.ox = vp.width / 2 - cx * v.scale;
      v.oy = (vp.height + top - m) / 2 - cy * v.scale;
      changed = true;
    }
    const sx0 = minX * v.scale + v.ox, sx1 = maxX * v.scale + v.ox;
    const sy0 = minY * v.scale + v.oy, sy1 = maxY * v.scale + v.oy;
    const dx = sx0 < m ? m - sx0 : sx1 > vp.width - m ? vp.width - m - sx1 : 0;
    const dy = sy0 < top ? top - sy0 : sy1 > vp.height - m ? vp.height - m - sy1 : 0;
    if (dx || dy) { v.ox += dx; v.oy += dy; changed = true; }
    if (changed) app.emit('view');
  }

  // Carries on from the end of the walk just ended: its last corner, facing the same way.
  // how: 'close' or 'finish', which decides what Undo does next.
  function carryOn(w, how) {
    const pen = w.tr.pen;
    const start = w.penNodeId && app.floor().nodes.some((n) => n.id === w.penNodeId)
      ? { kind: 'node', nodeId: w.penNodeId, x: pen.x, y: pen.y }
      : { kind: 'free', x: pen.x, y: pen.y };
    const next = begin(start, w.tr.heading, w.tr.type);
    next.from = how;
    return next;
  }

  // Starts a walk where the plan was tapped, joining a corner or wall face within reach.
  function startAt(world, pointerType) {
    const px = REACH[pointerType] || REACH.touch;
    const t = FP.interact.snapTarget(world, { snapPx: px });
    let start, heading = 0;
    if (t.kind === 'node') start = { kind: 'node', nodeId: t.nodeId, x: t.x, y: t.y };
    else if (t.kind === 'wall') {
      start = { kind: 'wall', wallId: t.wallId, d: t.d, face: t.face, x: t.x, y: t.y };
      // On a wall's face: head straight away from it, into the room that was tapped.
      const idx = app.geo().idx;
      const wall = idx.walls.get(t.wallId);
      if (wall) {
        const f = G.wallFrame(wall, idx);
        const out = t.face === 'far' ? f.ns : G.neg(f.ns);
        heading = Math.round(W.norm((Math.atan2(-out.y, out.x) * 180) / Math.PI) * 1e6) / 1e6;
      }
    } else start = { kind: 'free', x: t.x, y: t.y };
    const prev = cur();
    // A walk with nothing in it yet just moves; one with walls stays as it is and a new one starts.
    if (prev && prev.floorId !== app.doc.activeFloorId) walks = [];
    else if (prev && prev.count === 0 && !prev.from) walks.pop();
    begin(start, heading, app.wallType);
    note = { text: start.kind === 'free' ? 'Starting here. Type the first wall.' : 'Starting on that wall. Type the first wall.' };
    updatePreview();
  }

  // Adds entries one at a time. Returns the index of the first that couldn't be added, or -1.
  function addEntries(list) {
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.cmd === 'undo') { undo(); continue; }
      if (e.cmd === 'done') { finish(); continue; }
      const w = ensureWalk();
      const tr = W.trace(entriesOf(w).concat([e]), ctxOf(w));
      if (tr.error) { note = { text: tr.error, error: true }; refresh(); return i; }
      record(w, e, tr);
      follow(tr);
      if (tr.closed) {
        note = { text: closeText(tr) };
        carryOn(w, 'close');
      }
    }
    refresh();
    return -1;
  }

  // Applies a traced walk to the floor as one undo step, unless the walls don't change.
  function record(w, entry, tr) {
    const sig = sigOf(tr);
    w.entries.length = w.count; // anything undone is gone once something new is added
    walks.length = walks.indexOf(w) + 1;
    let notes = [];
    if (sig !== w.sig) {
      const floor = app.floor();
      const base = JSON.parse(w.base);
      floor.nodes = base.nodes;
      floor.walls = base.walls;
      floor.openings = base.openings;
      const s = app.settings();
      const res = W.realize(floor, tr, {
        start: w.start, thickness: { exterior: s.exteriorThickness, interior: s.interiorThickness },
      });
      w.penNodeId = res.penNodeId;
      notes = res.notes;
      app.sel = [];
      committing = true;
      try { app.commit(); } finally { committing = false; }
    }
    w.entries.push({ entry, hist: app.historyIndex, snap: app.history[app.historyIndex], penNodeId: w.penNodeId });
    w.count = w.entries.length;
    w.tr = tr;
    w.sig = sig;
    note = notes.length ? { text: notesText(notes), error: notes.some((n) => n.kind === 'noFit') } : null;
  }

  function closeText(tr) {
    const c = tr.close;
    if (!c || c.gap < 1e-6) return 'Room closed. Tap where the next walls start, or keep going from here.';
    if (c.added) return `Room closed with a ${app.fmt(c.added)} wall back to the start.`;
    // Small amounts read better in inches (1") than feet and inches (0' 1").
    const parts = c.changes.map((ch) => `wall ${ch.leg + 1} is ${app.fmtShort(Math.abs(ch.by))} ${ch.by > 0 ? 'longer' : 'shorter'}`);
    return `Room closed. The walls ended ${app.fmtShort(c.gap)} from the start, so ${parts.join(' and ')} than typed.`;
  }

  function notesText(notes) {
    return notes.map((n) => (n.kind === 'existing'
      ? `That wall already has a ${n.name} there, so it was kept.`
      : `The ${app.fmt(n.width)} ${n.name} doesn't fit there and was left out.`)).join(' ');
  }

  // Takes back the last entry. In a walk with nothing in it yet, it goes back to the walk
  // before: a tap somewhere else is forgotten, Finish is taken back, and a close is undone.
  function undo() {
    let w = cur();
    if (!w) return;
    if (w.count === 0) {
      if (walks.length < 2) { note = { text: 'Nothing to undo in this walk.' }; refresh(); return; }
      walks.pop();
      const how = w.from;
      w = cur();
      if (how !== 'close' || !w.count) { note = null; updatePreview(); return; }
    }
    const last = w.entries[w.count - 1];
    const before = w.count > 1 ? w.entries[w.count - 2].hist : w.baseHist;
    note = null;
    if (last.hist !== before) {
      app.undo(); // sync() lines the walk up with the history
    } else {
      w.count--;
      retrace(w);
      updatePreview();
    }
  }

  function finish() {
    const w = cur();
    if (!w || !w.count) { note = { text: 'Tap where the walls start, then type each wall.' }; refresh(); return; }
    carryOn(w, 'finish');
    note = { text: 'Walk finished. Tap where the next walls start, or keep going from here.' };
    updatePreview();
  }

  function retrace(w) {
    w.tr = W.trace(entriesOf(w), ctxOf(w));
    w.sig = sigOf(w.tr);
    const e = w.entries[w.count - 1];
    w.penNodeId = e ? e.penNodeId : null;
  }

  // After an undo, redo or any other change to the drawing: find the step of a walk that matches
  // where the history now is. If none does, the drawing was changed some other way, so the walks
  // so far are put down and a fresh one carries on from the same spot.
  function sync() {
    if (committing || !walks.length) return;
    const h = app.historyIndex;
    for (let k = walks.length - 1; k >= 0; k--) {
      const w = walks[k];
      if (w.floorId !== app.doc.activeFloorId) continue;
      let found = -1;
      for (let i = w.entries.length - 1; i >= 0; i--) {
        if (w.entries[i].hist === h && app.history[h] === w.entries[i].snap) { found = i + 1; break; }
      }
      if (found < 0 && w.baseHist === h && app.history[h] === w.baseSnap) found = 0;
      if (found < 0) continue;
      walks.length = k + 1;
      w.count = found;
      retrace(w);
      if (w.tr.closed) carryOn(w, 'close'); // redone up to a close: carry on from there
      updatePreview();
      return;
    }
    const last = cur();
    walks = [];
    if (last && last.floorId === app.doc.activeFloorId) begin({ kind: 'free', x: last.tr.pen.x, y: last.tr.pen.y }, last.tr.heading, last.tr.type);
    else atCentre(0, app.wallType);
    note = null;
    updatePreview();
  }

  // ---------- The panel ----------

  function submit() {
    const input = $('walkInput');
    const text = input.value;
    if (!text.trim()) return;
    const parsed = W.parse(text, app.settings().units);
    // Entries are added in order up to any that can't be read or added; that one and the rest
    // stay in the box to fix.
    const parts = text.split(/[,;\n]/).filter((p) => p.trim());
    let failedAt = addEntries(parsed.entries);
    if (failedAt < 0 && parsed.error) failedAt = parsed.entries.length;
    input.value = failedAt < 0 ? '' : parts.slice(failedAt).join(', ').trim();
    updatePreview();
    if (parsed.error && failedAt === parsed.entries.length) { note = { text: parsed.error, error: true }; refresh(); }
    if (!phone()) input.focus();
  }

  // What the typed text would add, drawn dashed on the plan before it's added.
  function updatePreview() {
    const text = $('walkInput').value;
    preview = null;
    const w = settle(cur());
    if (text.trim() && w) {
      const parsed = W.parse(text, app.settings().units);
      const steps = (parsed.entries || []).filter((e) => !e.cmd || e.cmd === 'close' || e.cmd === 'flip' || e.cmd === 'type');
      if (parsed.error) preview = { error: parsed.error };
      else if (steps.length) preview = { tr: W.trace(entriesOf(w).concat(steps), ctxOf(w)), from: w.tr };
    }
    refresh();
  }

  function refreshStatus() {
    const w = cur();
    const el = $('walkStatus');
    let text, error = false;
    if (preview && preview.error) { text = preview.error; error = true; }
    else if (preview && preview.tr && preview.tr.error) { text = preview.tr.error; error = true; }
    else if (note) { text = note.text; error = !!note.error; }
    else if (!w) text = 'Tap where the walls start, or just type the first wall.';
    else {
      const walls = w.tr.legs.length;
      const type = w.tr.type === 'exterior' ? 'exterior' : 'interior';
      text = walls
        ? `${walls} wall${walls === 1 ? '' : 's'} so far. Next: ${type} wall, going ${W.headingText(w.tr.heading)}.`
        : `Next: ${type} wall, going ${W.headingText(w.tr.heading)}. Type its length, or tap where to start.`;
    }
    el.textContent = text;
    el.classList.toggle('error', error);
    const heading = w ? w.tr.heading : 0;
    $('walkHeading').style.transform = `rotate(${-heading}deg)`;
    $('walkHeading').title = `Going ${W.headingText(heading)}`;
    const type = w ? w.tr.type : app.wallType;
    $('walkType').textContent = type === 'exterior' ? 'Exterior' : 'Interior';
    $('walkUndo').disabled = !w || (w.count === 0 && walks.length < 2);
    $('walkClose').disabled = !w || w.tr.legs.length < 2;
    $('walkFinish').disabled = !w || !w.count;
  }

  function refresh() {
    if (!$('walkPanel').hidden) refreshStatus();
    app.requestRender();
  }

  // The entry being typed (after the last comma), as its direction, and the rest without any
  // door or window word. Lets pad keys swap one direction or word for another.
  const DIR_RE = /(^|\s)(@-?\d+(?:\.\d+)?°?|[lr]\d*(?:\.\d+)?|[→↗↑↖←↙↓↘])(?=\s|$)/gi;
  function splitTail(v) {
    const cut = v.lastIndexOf(',') + 1;
    const head = cut ? `${v.slice(0, cut)} ` : '';
    let tail = v.slice(cut);
    const dirs = [];
    tail = tail.replace(DIR_RE, (m, sp, d) => { dirs.push(d); return ' '; });
    const words = W.OPENING_WORDS.map(([word]) => word).join('|');
    tail = tail.replace(new RegExp(`(^|\\s)(${words}|to ?wall)(?=\\s|$)`, 'gi'), ' ');
    return { head, dir: dirs.join(' '), rest: tail.replace(/\s+/g, ' ').trim() };
  }

  // Puts pad text into the box. A direction replaces the one already in the entry, and a door or
  // window word replaces the one there, so tapping another changes it instead of adding.
  function insert(text, kind) {
    const input = $('walkInput');
    const v = input.value;
    if (kind === 'dir') {
      const { head, rest } = splitTail(v);
      const word = (v.slice(v.lastIndexOf(',') + 1).match(new RegExp(`(^|\\s)(${W.OPENING_WORDS.map(([x]) => x).join('|')})(?=\\s|$)`, 'i')) || [])[2];
      input.value = `${head}${text} ${word ? `${word} ` : ''}${rest}`.replace(/\s+/g, ' ').replace(/^ /, '');
      if (!/\s$/.test(input.value)) input.value += ' ';
    } else if (kind === 'word') {
      const { head, dir, rest } = splitTail(v);
      input.value = `${head}${dir} ${text} ${rest}`.replace(/\s+/g, ' ').replace(/^ /, '');
      if (!/\s$/.test(input.value)) input.value += ' ';
    } else {
      const focused = document.activeElement === input;
      const start = focused && input.selectionStart != null ? input.selectionStart : v.length;
      const end = focused && input.selectionEnd != null ? input.selectionEnd : v.length;
      input.value = v.slice(0, start) + text + v.slice(end);
      if (focused) { const at = start + text.length; try { input.setSelectionRange(at, at); } catch (err) { /* ignore */ } }
    }
    updatePreview();
  }

  function backspace() {
    const input = $('walkInput');
    input.value = input.value.replace(/\s+$/, '').slice(0, -1);
    updatePreview();
  }

  function setType(type) {
    const w = cur();
    app.wallType = type;
    if (w && w.count && !w.tr.closed) addEntries([{ cmd: 'type', type, text: type }]);
    else if (w) { w.type = type; retrace(w); refresh(); }
    app.emit('tool');
  }

  // The unit keys follow the drawing's units.
  function refreshUnits() {
    const metric = FP.units.isMetric(app.settings().units);
    const big = $('walkUnitBig'), small = $('walkUnitSmall');
    big.textContent = metric ? 'm' : 'ft';
    big.dataset.insert = metric ? 'm ' : "' ";
    small.textContent = metric ? 'cm' : 'in';
    small.dataset.insert = metric ? 'cm ' : '" ';
    $('walkInput').placeholder = metric ? 'R 3m 20cm, 90cm, door 80cm, 1m' : `R 10', 36, door 28, 3ft 2"`;
  }

  // On a phone the pad types, so the box doesn't call up the keyboard unless asked for.
  // With the keyboard, the pad gives way completely: everything on it can be typed, so only the
  // box (and abc to go back, and Add) stays. Closing the keyboard brings the pad back.
  function setKeyboard(on) {
    keyboardOn = !!on;
    const input = $('walkInput');
    input.setAttribute('inputmode', phone() && !keyboardOn ? 'none' : 'text');
    document.documentElement.classList.toggle('walk-typing', keyboardOn && phone());
    $('walkKeyboard').classList.toggle('on', keyboardOn);
    $('walkKeyboard').setAttribute('aria-pressed', String(keyboardOn));
    $('walkKeyboard').textContent = keyboardOn ? 'Pad' : 'abc';
    $('walkKeyboard').title = keyboardOn ? 'Back to the keypad' : 'Type with the keyboard';
    $('walkKeyboard').setAttribute('aria-label', $('walkKeyboard').title);
    if (keyboardOn) { input.blur(); input.focus(); }
    app.requestRender(); // the plan's area changes size
  }

  // The keyboard was put away (the back button, or tapping off the box): back to the pad.
  let keyboardSeen = false;
  function watchKeyboard() {
    const vv = root.visualViewport;
    if (!keyboardOn || !phone()) { keyboardSeen = false; return; }
    if (!vv) return;
    const open = vv.height < root.innerHeight * 0.8 || (root.screen && vv.height < root.screen.height * 0.6);
    if (open) keyboardSeen = true;
    else if (keyboardSeen) { keyboardSeen = false; setKeyboard(false); }
  }

  function showPanel() {
    const on = active();
    const panel = $('walkPanel');
    if (panel.hidden === !on) return;
    panel.hidden = !on;
    closeMenu();
    document.documentElement.classList.toggle('walking', on);
    walks = [];
    note = null;
    preview = null;
    $('walkInput').value = '';
    if (on) {
      refreshUnits();
      setKeyboard(false);
      // Lay out with the panel showing first, so the walk begins in the middle of what's left.
      app.renderNow();
      atCentre(0, app.wallType);
      refreshStatus();
      if (!phone()) $('walkInput').focus();
    }
    app.requestRender();
  }

  // ---------- Gestures ----------

  let panning = false;
  const handlers = {
    enabled: active,
    tap(p, info) { startAt(toWorld(p), info.pointerType); },
    doubleTap(p, info) { startAt(toWorld(p), info.pointerType); },
    dragStart() { panning = true; canvas.style.cursor = 'grabbing'; },
    dragMove(p, delta) {
      if (!panning) return;
      app.view.ox += delta.x;
      app.view.oy += delta.y;
      app.emit('view');
      app.requestRender();
    },
    dragEnd() { panning = false; canvas.style.cursor = ''; },
    pinch({ center, ratio, dx, dy }) {
      app.view.ox += dx;
      app.view.oy += dy;
      app.zoomAt(center.x, center.y, ratio);
    },
  };

  // Keys pressed while the plan (not the box) has focus go to the box, so typing just works.
  function onKey(e) {
    if (!active() || e.ctrlKey || e.metaKey || e.altKey) return false;
    const input = $('walkInput');
    if (e.key === 'Enter') { e.preventDefault(); submit(); return true; }
    if (e.key.length === 1 && e.key !== ' ') {
      e.preventDefault();
      input.focus();
      const end = input.value.length;
      try { input.setSelectionRange(end, end); } catch (err) { /* ignore */ }
      insert(e.key);
      return true;
    }
    return false;
  }

  function onInputKey(e) {
    const ctrl = e.ctrlKey || e.metaKey;
    const input = $('walkInput');
    if (e.key === 'Escape') {
      e.preventDefault();
      if (input.value) { input.value = ''; updatePreview(); }
      else if (!phone()) { FP.interact.setTool('select'); canvas.focus({ preventScroll: true }); }
      return;
    }
    // Undo and Redo reach the drawing once the box is empty; while typing they edit the text.
    if (ctrl && !input.value) {
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); if (e.shiftKey) app.redo(); else undo(); }
      else if (k === 'y') { e.preventDefault(); app.redo(); }
    }
  }

  // ---------- Drawing on the plan ----------

  function arrow(R, p, heading, color) {
    const c = R.ctx, u = R.unit, v = W.vec(heading);
    const x = R.sx(p.x), y = R.sy(p.y);
    const len = 30 * u, head = 9 * u;
    const tx = x + v.x * len, ty = y + v.y * len;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(tx, ty);
    c.lineWidth = 2.5 * u;
    c.strokeStyle = color;
    c.stroke();
    const a = Math.atan2(v.y, v.x);
    c.beginPath();
    c.moveTo(tx + Math.cos(a) * head * 0.4, ty + Math.sin(a) * head * 0.4);
    c.lineTo(tx - Math.cos(a - 0.5) * head, ty - Math.sin(a - 0.5) * head);
    c.lineTo(tx - Math.cos(a + 0.5) * head, ty - Math.sin(a + 0.5) * head);
    c.closePath();
    c.fillStyle = color;
    c.fill();
  }

  function dot(R, p, color, hollow) {
    const c = R.ctx, u = R.unit;
    c.beginPath();
    c.arc(R.sx(p.x), R.sy(p.y), (hollow ? 7 : 5) * u, 0, Math.PI * 2);
    c.fillStyle = hollow ? '#fff' : color;
    c.fill();
    c.lineWidth = 2 * u;
    c.strokeStyle = color;
    c.stroke();
  }

  // The legs a preview adds or changes, dashed, with their lengths.
  function drawPreview(R) {
    if (!preview || !preview.tr) return;
    const tr = preview.tr, from = preview.from;
    const color = tr.error ? ERROR : ACCENT;
    const c = R.ctx, u = R.unit;
    const k = from ? from.legs.length : 0;
    const first = Math.max(0, k - 1); // the leg being continued is redrawn whole
    const pts = tr.corners.slice(first);
    if (pts.length < 2) return;
    R.screen();
    c.save();
    c.setLineDash([7 * u, 5 * u]);
    c.lineWidth = 2 * u;
    c.strokeStyle = color;
    c.beginPath();
    c.moveTo(R.sx(pts[0].x), R.sy(pts[0].y));
    for (const p of pts.slice(1)) c.lineTo(R.sx(p.x), R.sy(p.y));
    c.stroke();
    c.restore();
    for (let i = first; i < tr.legs.length; i++) {
      const same = from && i < from.legs.length && Math.abs(W.legLength(tr.legs[i]) - W.legLength(from.legs[i])) < 1e-9;
      if (same) continue;
      const a = tr.corners[i], b = tr.corners[i + 1];
      let ang = Math.atan2(b.y - a.y, b.x - a.x);
      if (ang > Math.PI / 2) ang -= Math.PI;
      if (ang < -Math.PI / 2) ang += Math.PI;
      const off = 14 * u;
      const mx = R.sx((a.x + b.x) / 2), my = R.sy((a.y + b.y) / 2);
      FP.render.tagText(R, app.fmt(W.legLength(tr.legs[i])), mx + Math.sin(ang) * off, my - Math.cos(ang) * off, ang, color, 13, 600);
    }
  }

  function drawOverlay(R) {
    const w = active() && settle(cur());
    if (!w) return;
    drawPreview(R);
    R.screen();
    if (w.count === 0) dot(R, w.start, ACCENT, true);
    const tr = preview && preview.tr && !preview.tr.error && !preview.tr.closed ? preview.tr : w.tr;
    arrow(R, tr.pen, tr.heading, ACCENT);
    dot(R, tr.pen, ACCENT, false);
  }

  // ---------- The phone menu ----------

  // While drawing on a phone the top bar is one row, so New, Open, Save, Export, the units and
  // labels, the theme and the floors are in this menu. Each item works through the button it
  // stands for, so they behave exactly the same.
  function menuItem(menu, label, run, on) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = label;
    if (on) b.classList.add('on');
    b.onclick = () => { closeMenu(); run(); };
    menu.appendChild(b);
  }

  function openMenu() {
    const menu = $('phoneMenu');
    menu.textContent = '';
    const click = (id) => () => $(id).click();
    menuItem(menu, 'New', click('newBtn'));
    menuItem(menu, 'Open', click('openBtn'));
    menuItem(menu, 'Save', click('saveBtn'));
    menuItem(menu, 'Export', click('exportBtn'));
    menu.appendChild(document.createElement('hr'));
    menuItem(menu, 'Units and labels', click('viewSheetBtn'), $('topbar').classList.contains('show-view'));
    menuItem(menu, FP.prefs.theme() === 'dark' ? 'Light mode' : 'Dark mode', click('themeBtn'));
    menu.appendChild(document.createElement('hr'));
    const label = document.createElement('p');
    label.className = 'menu-label';
    label.textContent = 'Floors';
    menu.appendChild(label);
    for (const f of app.doc.floors) {
      menuItem(menu, f.name, () => app.setActiveFloor(f.id), f.id === app.doc.activeFloorId);
    }
    menuItem(menu, '+ Floor', click('addFloor'));
    menu.hidden = false;
    $('phoneMenuBtn').setAttribute('aria-expanded', 'true');
    $('phoneMenuBtn').classList.add('on');
    const first = menu.querySelector('button');
    if (first) first.focus({ preventScroll: true });
  }

  function closeMenu() {
    $('phoneMenu').hidden = true;
    $('phoneMenuBtn').setAttribute('aria-expanded', 'false');
    $('phoneMenuBtn').classList.remove('on');
  }

  // ---------- Setup ----------

  function enterDrawing() {
    app.setMode('edit');
    FP.interact.setTool('walk');
  }

  function init(el) {
    canvas = el;
    FP.gestures.attach(canvas, handlers);
    const input = $('walkInput');
    $('walkForm').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    input.addEventListener('input', updatePreview);
    input.addEventListener('keydown', onInputKey);
    input.addEventListener('blur', () => {
      // Tapping Pad or Add briefly takes the focus; anything else that does means typing is over.
      setTimeout(() => {
        if (keyboardOn && phone() && document.activeElement !== input && !$('walkPanel').contains(document.activeElement)) setKeyboard(false);
      }, 150);
    });
    if (root.visualViewport) root.visualViewport.addEventListener('resize', watchKeyboard);
    for (const b of document.querySelectorAll('#walkPanel [data-insert]')) {
      // Pad keys leave the focus where it is, so a phone keyboard that's up stays up.
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.addEventListener('click', () => insert(b.dataset.insert, b.dataset.kind));
    }
    $('walkBack').addEventListener('pointerdown', (e) => e.preventDefault());
    $('walkBack').onclick = backspace;
    $('walkUndo').onclick = () => undo();
    $('walkClose').onclick = () => addEntries([{ cmd: 'close', text: 'close' }]);
    $('walkFinish').onclick = () => finish();
    $('walkToWall').onclick = () => {
      // Runs the entry being typed to the wall ahead, keeping any direction already in it.
      const { head, dir } = splitTail(input.value);
      input.value = `${head}${dir} to wall`.replace(/\s+/g, ' ').trim();
      submit();
    };
    $('walkFlip').onclick = () => {
      const w = cur();
      if (!w || !w.count || w.tr.closed) { note = { text: 'Flip moves the thickness to the other side of the walls in this walk, once it has some.' }; refresh(); return; }
      addEntries([{ cmd: 'flip', text: 'flip' }]);
    };
    $('walkType').onclick = () => setType(app.wallType === 'exterior' ? 'interior' : 'exterior');
    $('walkKeyboard').onclick = () => setKeyboard(!keyboardOn);
    $('drawBtn').onclick = enterDrawing;
    $('emptyDrawBtn').onclick = enterDrawing;
    $('viewDoneBtn').onclick = () => app.setMode('view');
    $('phoneMenuBtn').onclick = (e) => { e.stopPropagation(); if ($('phoneMenu').hidden) openMenu(); else closeMenu(); };
    document.addEventListener('pointerdown', (e) => {
      if (!$('phoneMenu').hidden && !$('phoneMenu').contains(e.target) && e.target !== $('phoneMenuBtn')) closeMenu();
    }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('phoneMenu').hidden) { closeMenu(); $('phoneMenuBtn').focus(); } });

    app.on((what) => {
      if (what === 'tool' || what === 'mode') showPanel();
      else if (what === 'doc') { if (active()) sync(); }
      else if (what === 'settings' || what === 'setting') { if (active()) { refreshUnits(); updatePreview(); } }
    });
    showPanel();
  }

  FP.walker = {
    init, drawOverlay, onKey, startAt, submit, undo, finish, addEntries, enterDrawing,
    state: () => ({ walks, current: cur(), note, preview }),
  };
})(globalThis);
