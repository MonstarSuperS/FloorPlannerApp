// Shared application state: the document, undo history, view and derived geometry.
(function (root) {
  const FP = (root.FP = root.FP || {});
  const M = FP.model;
  const SESSION_KEY = 'floorplanner.session.v1';
  const OLD_AUTOSAVE_KEY = 'floorplanner.autosave.v1';
  const HISTORY_LIMIT = 200;

  const app = (FP.app = {
    doc: M.createDoc(),
    view: { scale: 2.5, ox: 300, oy: 200 },
    tool: 'select',
    wallType: 'exterior',
    lineKind: 'guide', // what the line tool draws: 'guide' (construction line) or 'divider' (room divider)
    wallSide: -1,
    sel: [],
    hover: null,
    draw: null,
    dimDraft: null,
    place: null,
    drag: null,
    rev: 0,
    dirty: false,
    fileHandle: null,
    fileName: null,
    history: [],
    historyIndex: -1,
    listeners: [],
    mode: 'edit',   // 'edit', or 'view': look, measure and export, with no way to change the drawing
    readOnly: false,
  });

  app.floor = () => app.doc.floors.find((f) => f.id === app.doc.activeFloorId) || app.doc.floors[0];
  app.settings = () => app.doc.settings;
  app.fmt = (inches) => FP.units.format(inches, app.doc.settings.units);
  // Short lengths (thicknesses, widths): inches rather than feet and inches.
  app.fmtShort = (inches) => FP.units.formatShort(inches, app.doc.settings.units);
  app.fmtArea = (sqIn, places) => FP.units.formatArea(sqIn, app.doc.settings.units, places);
  // Typed lengths: a bare number is in the current unit (inches, cm or mm).
  app.parse = (text, opts) => FP.units.parse(text, { ...opts, units: app.doc.settings.units });

  // Called whenever panels should re-read state. what: 'selection' | 'doc' | 'settings' | 'view'
  app.on = (fn) => app.listeners.push(fn);
  app.emit = (what) => app.listeners.forEach((fn) => fn(what));

  let renderFn = null;
  let renderQueued = false;
  app.setRenderer = (fn) => { renderFn = fn; };
  app.requestRender = () => {
    if (renderQueued || !renderFn) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderFn(); });
  };
  app.renderNow = () => { if (renderFn) renderFn(); };

  // Derived geometry, cached until the next edit. Room detection is throttled during drags.
  const geoCache = new WeakMap();
  app.geo = (floor) => {
    floor = floor || app.floor();
    const entry = geoCache.get(floor);
    if (entry && entry.rev === app.rev) return entry.geo;
    const now = performance.now();
    const stale = !!app.drag && entry && now - entry.roomsAt < 120;
    const geo = FP.render.buildGeo(floor, entry && entry.geo, stale);
    geoCache.set(floor, { rev: app.rev, geo, roomsAt: stale ? entry.roomsAt : now });
    return geo;
  };

  // Marks geometry as changed, without creating an undo step (used during drags).
  app.touch = () => {
    M.normalize(app.floor());
    holdLocked();
    app.rev++;
    app.requestRender();
  };

  // Locked walls and dimensions stay where they were through any edit: whatever pulled on
  // them separates instead. lockRef is where they were after the last edit.
  app.lockRef = null;
  const refreshLocks = () => { app.lockRef = M.lockedEnds(app.floor()); };

  // Opens a design option on the current floor (null for as-is) as one undoable step.
  app.openOption = (id, how) => {
    const floor = app.floor();
    if (how === 'new') FP.options.create(floor, false);
    else if (how === 'copy') FP.options.create(floor, true);
    else FP.options.open(floor, id);
    app.sel = [];
    app.draw = null;
    app.dimDraft = null;
    refreshLocks();
    if (app.readOnly) app.viewChange();
    else app.commit();
    app.emit('selection');
  };
  app.refreshLocks = refreshLocks;
  function holdLocked() {
    M.protectLocked(app.floor(), app.lockRef);
    refreshLocks();
  }

  const snapshot = () => JSON.stringify({ floors: app.doc.floors, activeFloorId: app.doc.activeFloorId, customFixtures: app.doc.customFixtures, furniture: app.doc.furniture, name: app.doc.name });

  // Switches between editing and view-only. Anything half-done (a wall being drawn, a drag, an
  // item being placed) is dropped, and the selection cleared, so nothing editable is left open.
  app.setMode = (mode) => {
    mode = mode === 'view' ? 'view' : 'edit';
    if (FP.interact && app.tool !== 'select') FP.interact.setTool('select');
    if (FP.interact && app.place) FP.interact.endPlace();
    app.mode = mode;
    app.readOnly = mode === 'view';
    app.sel = [];
    app.hover = null;
    app.draw = null;
    app.dimDraft = null;
    app.drag = null;
    if (typeof document !== 'undefined') document.documentElement.classList.toggle('view-only', app.readOnly);
    app.emit('mode');
    app.emit('selection');
    app.requestRender();
  };

  // A change to how the drawing is shown rather than what it contains (units, labels, the open
  // design option), made while view-only. It is kept with this browser's session so it survives
  // a refresh, but it doesn't mark the drawing unsaved, join the undo history or reach the file.
  app.viewChange = () => {
    app.rev++;
    M.normalize(app.floor());
    refreshLocks();
    // The current undo step takes on the change rather than a new one being added, so going
    // back to it (or editing later) starts from what's on screen.
    if (app.historyIndex >= 0) app.history[app.historyIndex] = snapshot();
    app.saveSession();
    app.emit('doc');
    app.requestRender();
  };

  // Records a finished edit as one undo step.
  app.commit = () => {
    // View-only can't change the drawing. Every path to an edit is closed off; this is the
    // backstop in case one is missed: whatever changed is put back as it was.
    if (app.readOnly) {
      console.warn('FloorPlanner: an edit was attempted while view-only and has been undone.');
      restore(app.history[app.historyIndex], true);
      return;
    }
    M.normalize(app.floor());
    M.pruneGroups(app.floor());
    holdLocked();
    const dropped = M.followItems(app.floor(), app.settings());
    if (dropped) {
      app.sel = app.sel.filter((s) => s.t !== 'dim' || app.floor().dims.some((d) => d.id === s.id));
      app.toast(`Removed ${dropped} dimension${dropped === 1 ? '' : 's'} attached to something that moved or turned too far. Undo (Ctrl+Z) to bring ${dropped === 1 ? 'it' : 'them'} back.`);
    }
    app.rev++;
    app.geo();
    app.history.length = app.historyIndex + 1;
    app.history.push(snapshot());
    if (app.history.length > HISTORY_LIMIT) app.history.shift();
    app.historyIndex = app.history.length - 1;
    app.setDirty(true);
    app.scheduleAutosave();
    app.emit('doc');
    app.requestRender();
  };

  app.setDirty = (value) => {
    app.dirty = value;
    app.emit('title');
  };

  // quiet: putting back what an edit refused while view-only changed, which leaves the
  // drawing exactly as saved, so it isn't marked unsaved or auto-saved.
  function restore(serialized, quiet) {
    Object.assign(app.doc, JSON.parse(serialized));
    app.rev++;
    const floor = app.floor();
    M.normalize(floor);
    refreshLocks();
    const ok = (s) => {
      return !!M.itemOf(floor, s);
    };
    app.sel = app.sel.filter(ok);
    app.draw = null;
    app.dimDraft = null;
    app.drag = null;
    if (!quiet) {
      app.setDirty(true);
      app.scheduleAutosave();
    }
    app.emit('doc');
    app.emit('selection');
    app.requestRender();
  }

  app.undo = () => {
    if (app.readOnly || app.historyIndex <= 0) return;
    app.historyIndex--;
    restore(app.history[app.historyIndex]);
  };
  app.redo = () => {
    if (app.readOnly || app.historyIndex >= app.history.length - 1) return;
    app.historyIndex++;
    restore(app.history[app.historyIndex]);
  };
  // Throws away an edit in progress by returning to the last recorded state.
  app.revert = () => restore(app.history[app.historyIndex]);

  // Replaces the whole document, e.g. after New or Open.
  app.loadDoc = (doc, fileHandle, fileName) => {
    app.doc = doc;
    app.fileHandle = fileHandle || null;
    app.fileName = fileName || null;
    app.sel = [];
    app.draw = null;
    app.dimDraft = null;
    app.place = null;
    app.drag = null;
    app.rev++;
    app.history = [snapshot()];
    app.historyIndex = 0;
    refreshLocks();
    app.dirty = false;
    app.needsPermission = false;
    app.emit('doc');
    app.emit('settings');
    app.emit('selection');
    app.emit('title');
    app.fitView();
    app.saveSession();
    if (FP.fileio) FP.fileio.rememberHandle(app.fileHandle);
  };

  app.select = (items) => {
    app.sel = items;
    app.emit('selection');
    app.requestRender();
  };
  app.isSelected = (t, id) => app.sel.some((s) => s.t === t && s.id === id);

  app.setActiveFloor = (id) => {
    app.doc.activeFloorId = id;
    app.sel = [];
    app.draw = null;
    app.dimDraft = null;
    app.rev++;
    M.normalize(app.floor());
    refreshLocks();
    app.emit('doc');
    app.emit('selection');
    app.requestRender();
  };

  app.viewport = { width: 800, height: 600 };

  app.resetView = () => {
    app.view.scale = 2.5;
    app.view.ox = app.viewport.width / 2;
    app.view.oy = app.viewport.height / 2;
    app.emit('view');
    app.requestRender();
  };

  app.fitView = () => {
    const floor = app.floor();
    const bounds = M.floorBounds(floor, app.geo(floor), app.settings().showGuides);
    if (!bounds) { app.resetView(); return; }
    const pad = 60;
    const w = Math.max(bounds.maxX - bounds.minX, 24), h = Math.max(bounds.maxY - bounds.minY, 24);
    const s = Math.min((app.viewport.width - pad * 2) / w, (app.viewport.height - pad * 2) / h);
    app.view.scale = Math.max(0.2, Math.min(40, s));
    app.view.ox = app.viewport.width / 2 - ((bounds.minX + bounds.maxX) / 2) * app.view.scale;
    app.view.oy = app.viewport.height / 2 - ((bounds.minY + bounds.maxY) / 2) * app.view.scale;
    app.emit('view');
    app.requestRender();
  };

  app.zoomAt = (sx, sy, factor) => {
    const v = app.view;
    const next = Math.max(0.2, Math.min(40, v.scale * factor));
    const wx = (sx - v.ox) / v.scale, wy = (sy - v.oy) / v.scale;
    v.scale = next;
    v.ox = sx - wx * next;
    v.oy = sy - wy * next;
    app.emit('view');
    app.requestRender();
  };

  // The session keeps the open drawing in the browser, so a refresh or crash picks up where you
  // were: the drawing, its file name, whether it has unsaved changes, and the view. Real saves
  // are files, handled in fileio.js. Once a drawing has a save file, changes also go to it.
  let autosaveTimer = null;
  app.changeCount = 0;
  app.saveSession = () => {
    clearTimeout(autosaveTimer);
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        v: 1,
        doc: M.serializeDoc(app.doc),
        fileName: app.fileName,
        hasHandle: !!app.fileHandle,
        dirty: !!app.dirty,
        view: { ...app.view },
      }));
      localStorage.removeItem(OLD_AUTOSAVE_KEY);
    } catch (e) { /* storage unavailable */ }
  };
  app.scheduleAutosave = () => {
    // Never write to the drawing's file while view-only, even if one is linked.
    if (app.readOnly) { app.saveSession(); return; }
    app.changeCount++;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      app.saveSession();
      if (app.fileHandle) FP.fileio.autoSaveToFile();
    }, 800);
  };
  // Returns { doc, fileName, hasHandle, dirty, view } or null. Older versions kept only the
  // drawing, as unsaved work.
  app.readSession = () => {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        return { ...s, doc: M.sanitizeDoc(s.doc) };
      }
      const old = localStorage.getItem(OLD_AUTOSAVE_KEY);
      return old ? { doc: M.sanitizeDoc(JSON.parse(old)), fileName: null, hasHandle: false, dirty: true, view: null } : null;
    } catch (e) { return null; }
  };
  window.addEventListener('pagehide', () => app.saveSession());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') app.saveSession(); });

  let toastTimer = null;
  app.toast = (message, isError) => {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.className = isError ? 'show error' : 'show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = ''; }, 3500);
  };
})(globalThis);
