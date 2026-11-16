// Panels: top bar, component library, inspector, floor tabs and the custom fixture dialog.
(function (root) {
  const FP = (root.FP = root.FP || {});
  const G = FP.geom, M = FP.model, F = FP.fixtures, Rn = FP.render, app = FP.app;
  const $ = (id) => document.getElementById(id);

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k === 'class') node.className = v;
        else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
        else if (k in node) node[k] = v;
        else node.setAttribute(k, v);
      }
    }
    for (const child of children) if (child != null) node.append(child);
    return node;
  }

  const parseLen = (t) => app.parse(t);

  // ---------- Top bar ----------

  const TOGGLES = [['tSnap', 'snap'], ['tGrid', 'showGrid'], ['tLengths', 'showLengths'], ['tBoth', 'bothFaces'], ['tRooms', 'showRooms'], ['tGuides', 'showGuides']];

  function seg(id, value) {
    document.querySelectorAll(`#${id} button`).forEach((b) => b.classList.toggle('on', b.dataset.value === String(value)));
  }

  function refreshTopBar() {
    const s = app.settings();
    seg('unitsSeg', s.units);
    seg('angleSeg', s.angleStep);
    fillGridSelect($('gridSize'), s.units, s.gridSize);
    for (const [id, key] of TOGGLES) {
      $(id).classList.toggle('on', !!s[key]);
      $(id).setAttribute('aria-pressed', String(!!s[key]));
    }
    $('intThick').value = app.fmtShort(s.interiorThickness);
    $('extThick').value = app.fmtShort(s.exteriorThickness);
    refreshStairToggle();
    refreshUndo();
  }

  // Fills a grid size list with the sizes for these units, keeping a size that isn't offered.
  function fillGridSelect(select, units, gridSize) {
    const items = FP.units.gridsFor(units).slice();
    if (!items.some(([v]) => Math.abs(v - gridSize) < 1e-9)) items.push([gridSize, FP.units.formatShort(gridSize, units)]);
    items.sort((a, b) => a[0] - b[0]);
    select.textContent = '';
    for (const [v, label] of items) select.append(el('option', { value: String(v), textContent: label }));
    select.value = String(items.find(([v]) => Math.abs(v - gridSize) < 1e-9)[0]);
  }

  function refreshStairToggle() {
    $('stairView').value = app.view.stairs || 'show';
  }

  function refreshUndo() {
    $('undoBtn').disabled = app.historyIndex <= 0;
    $('redoBtn').disabled = app.historyIndex >= app.history.length - 1;
  }

  function refreshTitle() {
    const name = app.fileName || `${app.doc.name}`;
    $('docName').textContent = `${app.dirty ? '• ' : ''}${name}`;
    document.title = `${app.dirty ? '* ' : ''}${name} - FloorPlanner`;
    const state = $('saveState');
    state.textContent = '';
    if (app.fileHandle && app.needsPermission) {
      state.append(el('button', {
        id: 'reconnectBtn',
        class: 'link-button',
        textContent: `Click to keep auto-saving to ${app.fileName}`,
        title: 'After a refresh the browser asks once more before writing to the file.',
        on: { click: () => FP.fileio.reconnect(true) },
      }));
      return;
    }
    state.textContent = !app.fileHandle
      ? (app.dirty ? 'Not saved to a file yet' : '')
      : (app.dirty ? 'Auto-saving...' : 'All changes saved');
  }

  function changeSetting(key, value) {
    const s = app.settings();
    // Switching between imperial and metric moves the grid to the nearest size the new units offer.
    if (key === 'units' && FP.units.isMetric(value) !== FP.units.isMetric(s.units)) s.gridSize = FP.units.nearestGrid(s.gridSize, value);
    s[key] = value;
    app.setDirty(true);
    app.scheduleAutosave();
    refreshTopBar();
    refreshInspector();
    if (key === 'units') buildLibrary(); // custom fixture sizes are listed in the current units
    app.requestRender();
    app.emit('cursor');
  }

  function initTopBar() {
    $('newBtn').onclick = () => FP.fileio.newDoc();
    $('openBtn').onclick = () => FP.fileio.open();
    $('saveBtn').onclick = () => FP.fileio.save(false);
    $('saveAsBtn').onclick = () => FP.fileio.save(true);
    $('exportBtn').onclick = () => FP.exporter.openDialog();
    $('undoBtn').onclick = () => app.undo();
    $('redoBtn').onclick = () => app.redo();
    $('zoomIn').onclick = () => app.zoomAt(app.viewport.width / 2, app.viewport.height / 2, 1.25);
    $('zoomOut').onclick = () => app.zoomAt(app.viewport.width / 2, app.viewport.height / 2, 0.8);
    $('fitBtn').onclick = () => app.fitView();
    $('resetBtn').onclick = () => app.resetView();
    document.querySelectorAll('#unitsSeg button').forEach((b) => { b.onclick = () => changeSetting('units', b.dataset.value); });
    document.querySelectorAll('#angleSeg button').forEach((b) => { b.onclick = () => changeSetting('angleStep', Number(b.dataset.value)); });
    $('gridSize').onchange = (e) => changeSetting('gridSize', Number(e.target.value));
    for (const [id, key] of TOGGLES) {
      $(id).onclick = () => changeSetting(key, !app.settings()[key]);
    }
    // Stairs shown, faded or hidden. A view choice, kept with the session, not the drawing.
    $('stairView').onchange = (e) => {
      app.view.stairs = ['show', 'fade', 'hide'].includes(e.target.value) ? e.target.value : 'show';
      if (app.view.stairs !== 'show') app.sel = app.sel.filter((s) => s.t !== 'stair');
      refreshStairToggle();
      app.emit('selection');
      app.saveSession();
      app.requestRender();
    };
    for (const [id, key] of [['intThick', 'interiorThickness'], ['extThick', 'exteriorThickness']]) {
      $(id).onchange = (e) => {
        const v = parseLen(e.target.value);
        if (v > 0) changeSetting(key, v);
        else { app.toast('Enter a thickness, such as 4 or 5 1/2.', true); refreshTopBar(); }
      };
      $(id).onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); };
    }
    document.querySelectorAll('#tools button').forEach((b) => {
      b.onclick = () => FP.interact.setTool(b.dataset.tool, b.dataset.wall || b.dataset.line || b.dataset.shape);
    });
  }

  function refreshTools() {
    document.querySelectorAll('#tools button').forEach((b) => {
      const on = b.dataset.tool === app.tool && (!b.dataset.wall || b.dataset.wall === app.wallType) &&
        (!b.dataset.line || b.dataset.line === app.lineKind) && (!b.dataset.shape || b.dataset.shape === app.shapeKind);
      b.classList.toggle('on', on);
    });
    $('hint').textContent = FP.interact.hintText();
  }

  // ---------- Library ----------

  function fixtureThumb(kind) {
    const canvas = el('canvas', { width: 88, height: 88, class: 'thumb' });
    const c = canvas.getContext('2d');
    const size = F.defaultSize(kind);
    const s = 76 / Math.max(size.w, size.d);
    c.setTransform(s, 0, 0, s, 44, 44);
    F.drawSymbol(c, kind, size.w, size.d, 1.8 / s, Rn.PALETTES[FP.prefs.theme()]);
    return canvas;
  }

  // A library piece drawn to fit its thumbnail.
  function pieceThumb(piece) {
    const canvas = el('canvas', { width: 88, height: 88, class: 'thumb' });
    const s = 76 / Math.max(piece.w, piece.d, 1);
    const R = Rn.makeR(canvas.getContext('2d'), s, 44, 44, 1.6, Rn.PALETTES[FP.prefs.theme()]);
    for (const sh of piece.shapes) FP.shapes.draw(R, sh);
    return canvas;
  }

  function openingThumb(kind) {
    const canvas = el('canvas', { width: 88, height: 88, class: 'thumb' });
    const c = canvas.getContext('2d');
    // A pocket door needs room beside it for the pocket.
    const pocket = kind === 'pocket';
    const width = pocket ? 20 : kind === 'slider' ? 44 : 32, t = 6, length = 52;
    const s = 80 / length;
    const R = Rn.makeR(c, s, 4, ['window', 'cased', 'slider'].includes(kind) || pocket ? 40 : 58, 2, Rn.PALETTES[FP.prefs.theme()]);
    const f = { a: { x: 0, y: 0 }, u: { x: 1, y: 0 }, ns: { x: 0, y: 1 }, t, len: length };
    R.world();
    // The hole in the wall is painted in paper colour, which must blend with the panel here.
    R.colors = { ...R.colors, paper: getComputedStyle(document.documentElement).getPropertyValue('--panel').trim() };
    c.fillStyle = R.colors.exterior;
    c.fillRect(0, 0, length, t);
    Rn.drawOpening(R, f, { kind, width, d: pocket ? 32 : length / 2, panels: 1 });
    return canvas;
  }

  // A library row: dragging it (or clicking, then clicking the plan) places one.
  function libraryRow(thumb, title, control, makeDesc, extra) {
    const row = el('div', { class: 'lib-item', title: 'Drag onto the plan' },
      thumb,
      el('div', { class: 'lib-body' }, el('div', { class: 'lib-name' }, title), control),
      extra);
    row.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('select, button')) return;
      e.preventDefault();
      FP.interact.beginPlace(makeDesc(), e);
    });
    return row;
  }

  function sizeSelect(kind) {
    const k = F.KINDS[kind];
    const select = el('select', { class: 'lib-size', 'aria-label': `${k.name} size` });
    k.sizes.forEach((s, i) => {
      const label = /^\d+"$/.test(s.label) ? `${app.fmtShort(s.w)} wide x ${app.fmtShort(s.d)} deep` : `${s.label} (${sizePair(s.w, s.d)})`;
      select.append(el('option', { value: String(i), textContent: label }));
    });
    select.value = String(k.def);
    select.append(el('option', { value: 'custom', textContent: 'Custom...' }));
    select.addEventListener('change', () => {
      if (select.value !== 'custom') return;
      select.value = String(k.def);
      openCustomDialog({ base: kind, ...F.defaultSize(kind), name: '' });
    });
    return select;
  }

  // A width x depth pair for a size list: 20 x 30 in inches, 51 x 76 cm in metric.
  function sizePair(w, d) {
    const u = app.settings().units;
    if (!FP.units.isMetric(u)) return `${w} x ${d}`;
    return `${FP.units.format(w, u).replace(/ (cm|mm)$/, '')} x ${FP.units.format(d, u)}`;
  }

  function widthSelect(kind) {
    const info = M.OPENING_KINDS[kind];
    const select = el('select', { class: 'lib-size', 'aria-label': `${info.name} width` });
    const add = (w) => {
      const opt = el('option', { value: String(w), textContent: `${app.fmtShort(w)} wide` });
      select.insertBefore(opt, select.querySelector('option[value="custom"]'));
    };
    select.append(el('option', { value: 'custom', textContent: 'Custom width...' }));
    info.sizes.forEach(add);
    select.value = String(info.width);
    let last = select.value;
    select.addEventListener('change', () => {
      if (select.value !== 'custom') { last = select.value; return; }
      select.value = last;
      openWidthDialog(info.name, Number(last), (w) => {
        if (!select.querySelector(`option[value="${w}"]`)) {
          const opt = el('option', { value: String(w), textContent: `${app.fmtShort(w)} wide` });
          select.insertBefore(opt, select.querySelector('option[value="custom"]'));
        }
        select.value = String(w);
        last = select.value;
      });
    });
    return select;
  }

  function buildLibrary() {
    const root = $('library');
    root.textContent = '';
    const section = (title) => {
      const body = el('div', { class: 'lib-group' });
      const d = el('details', { open: true }, el('summary', { textContent: title }), body);
      root.append(d);
      return body;
    };

    const furniture = section('My Furniture');
    for (const piece of app.doc.furniture || []) {
      const info = el('div', { class: 'lib-size-text', textContent: `${app.fmt(piece.w)} x ${app.fmt(piece.d)}` });
      const remove = el('button', {
        class: 'icon-btn', textContent: '×', title: `Remove ${piece.name} from the library`, 'aria-label': `Remove ${piece.name}`,
        on: { click: () => {
          app.doc.furniture = app.doc.furniture.filter((x) => x !== piece);
          app.commit();
        } },
      });
      furniture.append(libraryRow(pieceThumb(piece), piece.name, info, () => ({ cat: 'furniture', pieceId: piece.id }), remove));
    }
    if (!(app.doc.furniture || []).length) {
      furniture.append(el('p', { class: 'muted small', textContent: 'Draw a piece with the Draw tools, select it, and choose Save as furniture in the Inspector. Pieces are saved in this drawing file.' }));
    }

    const openings = section('Doors & Windows');
    for (const kind of Object.keys(M.OPENING_KINDS)) {
      const select = widthSelect(kind);
      openings.append(libraryRow(openingThumb(kind), M.OPENING_KINDS[kind].name, select,
        () => ({ cat: 'opening', kind, width: Number(select.value) })));
    }

    for (const group of F.GROUPS) {
      const body = section(group);
      for (const [kind, k] of Object.entries(F.KINDS)) {
        if (k.group !== group) continue;
        const select = sizeSelect(kind);
        body.append(libraryRow(fixtureThumb(kind), k.name, select, () => {
          const s = k.sizes[Number(select.value)] || F.defaultSize(kind);
          return { cat: 'fixture', kind, w: s.w, d: s.d };
        }));
      }
    }

    const custom = section('My Custom Fixtures');
    custom.append(el('button', { class: 'wide', textContent: '+ New custom fixture', on: { click: () => openCustomDialog({ base: 'generic', w: 36, d: 24, name: '' }) } }));
    for (const item of app.doc.customFixtures) {
      const info = el('div', { class: 'lib-size-text', textContent: `${app.fmt(item.w)} x ${app.fmt(item.d)}` });
      const remove = el('button', {
        class: 'icon-btn', textContent: '×', title: `Remove ${item.name} from the library`, 'aria-label': `Remove ${item.name}`,
        on: { click: () => {
          app.doc.customFixtures = app.doc.customFixtures.filter((x) => x !== item);
          app.commit();
        } },
      });
      custom.append(libraryRow(fixtureThumb(item.base), item.name, info,
        () => ({ cat: 'fixture', kind: item.base, w: item.w, d: item.d, name: item.name, customId: item.id }), remove));
    }
    if (!app.doc.customFixtures.length) {
      custom.append(el('p', { class: 'muted small', textContent: 'Fixtures you create are saved in this drawing file.' }));
    }
  }

  // ---------- Custom fixture dialog ----------

  let widthCallback = null;

  function openCustomDialog(preset) {
    const d = $('customDialog');
    $('cfName').value = preset.name || '';
    const base = $('cfBase');
    base.textContent = '';
    for (const [kind, k] of Object.entries(F.KINDS)) base.append(el('option', { value: kind, textContent: k.name }));
    base.value = preset.base;
    $('cfWidth').value = app.fmt(preset.w);
    $('cfDepth').value = app.fmt(preset.d);
    d.showModal();
    $('cfName').focus();
  }

  function saveCustom(e) {
    e.preventDefault();
    const w = parseLen($('cfWidth').value), dd = parseLen($('cfDepth').value);
    const name = $('cfName').value.trim();
    if (!name) { app.toast('Give the custom fixture a name.', true); return; }
    if (!(w > 0) || !(dd > 0)) { app.toast('Enter a width and depth, such as 36 or 3\'.', true); return; }
    const item = { id: M.uid('c'), name, base: $('cfBase').value, w, d: dd };
    app.doc.customFixtures.push(item);
    $('customDialog').close();
    app.commit();
    app.toast(`${name} added to My Custom Fixtures.`);
  }

  function openWidthDialog(name, value, callback) {
    widthCallback = callback;
    $('wdTitle').textContent = `Custom width: ${name}`;
    $('wdWidth').value = app.fmt(value);
    $('widthDialog').showModal();
    $('wdWidth').select();
  }

  function initDialogs() {
    $('cfSave').addEventListener('click', saveCustom);
    $('cfCancel').addEventListener('click', () => $('customDialog').close());
    $('wdCancel').addEventListener('click', () => $('widthDialog').close());
    $('wdSave').addEventListener('click', (e) => {
      e.preventDefault();
      const w = parseLen($('wdWidth').value);
      if (!(w > 0)) { app.toast('Enter a width, such as 34 or 2\'10".', true); return; }
      $('widthDialog').close();
      if (widthCallback) widthCallback(w);
    });
  }

  // ---------- Inspector ----------

  const ins = () => $('inspector');

  function section(title) {
    const body = ins();
    body.append(el('h3', { textContent: title }));
  }

  function row(label, control, key) {
    const r = el('label', { class: 'field' }, el('span', { textContent: label }), control);
    if (key) control.dataset.key = key;
    ins().append(r);
    return control;
  }

  function lengthField(label, value, onCommit, key, opts) {
    const input = el('input', { type: 'text', value: app.fmt(value), spellcheck: false, autocomplete: 'off' });
    input.addEventListener('change', () => {
      const v = app.parse(input.value, opts);
      if (v == null || (!(opts && opts.signed) && !(v > 0) && !(opts && opts.zero))) {
        app.toast('Could not read that length. Try 148 or 12\'4".', true);
        input.value = app.fmt(value);
        return;
      }
      onCommit(v);
    });
    input.addEventListener('keydown', onFieldKey);
    return row(label, input, key);
  }

  function numberField(label, value, onCommit, key, suffix) {
    const input = el('input', { type: 'text', value: `${Number(value.toFixed(2))}${suffix || ''}`, autocomplete: 'off' });
    input.addEventListener('change', () => {
      const v = parseFloat(input.value);
      if (!Number.isFinite(v)) { input.value = `${Number(value.toFixed(2))}${suffix || ''}`; return; }
      onCommit(v);
    });
    input.addEventListener('keydown', onFieldKey);
    return row(label, input, key);
  }

  function onFieldKey(e) {
    if (e.key === 'Enter') e.target.blur();
    if (e.key === 'Escape') { e.target.blur(); }
    e.stopPropagation();
  }

  function selectField(label, value, options, onCommit, key) {
    const select = el('select');
    for (const [v, t] of options) select.append(el('option', { value: v, textContent: t }));
    select.value = value;
    select.addEventListener('change', () => onCommit(select.value));
    return row(label, select, key);
  }

  function readOnly(label, value) {
    ins().append(el('div', { class: 'field' }, el('span', { textContent: label }), el('output', { textContent: value })));
  }

  function button(label, onClick, cls) {
    const b = el('button', { textContent: label, class: cls || '', on: { click: onClick } });
    return b;
  }

  function actions(...buttons) {
    ins().append(el('div', { class: 'actions' }, ...buttons));
  }

  // Ctrl+click deletes only the unlocked items of a partly locked selection.
  function deleteButton() {
    return button('Delete', (e) => FP.interact.deleteSelection(e.ctrlKey || e.metaKey), 'danger');
  }

  // Stays usable while the item is locked.
  const keep = (b) => { b.dataset.keep = '1'; return b; };
  const note = (text, id) => el('p', { class: 'muted small', textContent: text, ...(id ? { id } : {}) });

  // The lock and group controls under a single item. A locked item's fields are shown but
  // can't be changed until it's unlocked.
  function lockAndGroup(s, item) {
    const box = ins();
    const floor = app.floor();
    const locked = M.isLocked(floor, s);
    const extra = [];
    if (M.LOCKABLE.has(s.t)) {
      const b = keep(button(locked ? 'Unlock' : 'Lock', () => FP.interact.setLocked(!locked)));
      b.id = 'lockBtn';
      b.title = 'Ctrl+L';
      extra.push(b);
    }
    if (item.group) {
      const n = M.groupMembers(floor, item.group).length;
      box.append(note(`Part of a group of ${n}. A click selects the whole group; double-click picks out one item.`, 'groupNote'));
      extra.push(keep(button('Remove from group', () => FP.interact.ungroupSelection())));
    }
    if (extra.length) actions(...extra);
    if (!locked) return;
    for (const c of box.querySelectorAll('input, select, textarea, button')) if (!c.dataset.keep) c.disabled = true;
    const title = box.querySelector('h3');
    const msg = note(s.t === 'node' ? 'Its walls are locked. Unlock them to move this corner.' : 'Locked. Unlock it to make changes.', 'lockNote');
    msg.classList.add('locked-note');
    if (title) title.after(msg); else box.prepend(msg);
  }

  function multiInspector() {
    const floor = app.floor();
    const gid = FP.interact.selectedGroup();
    const n = app.sel.length;
    section(gid ? `Group of ${n} items` : `${n} items selected`);
    ins().append(note(gid
      ? 'Drag to move the group, or its handles to scale or turn it. Double-click an item to edit it alone.'
      : 'Drag any selected item to move them together.'));
    const lockable = app.sel.filter((s) => M.LOCKABLE.has(s.t));
    const nLocked = lockable.filter((s) => M.isLocked(floor, s)).length;
    if (nLocked) {
      const msg = note(nLocked === n ? 'All of these are locked.' : `${nLocked} of these ${nLocked === 1 ? 'is' : 'are'} locked. Hold Ctrl to move or delete only the unlocked ones.`, 'lockNote');
      msg.classList.add('locked-note');
      ins().append(msg);
    }
    const groupable = app.sel.filter((s) => M.GROUPABLE.has(s.t)).length;
    const grouped = app.sel.some((s) => { const x = M.itemOf(floor, s); return x && x.group; });
    const shapes = app.sel.filter((s) => s.t === 'shape').map((s) => M.itemOf(floor, s)).filter(Boolean);
    if (shapes.length) {
      shapeStyleFields(shapes);
      furnitureSave();
    }
    const buttons = [];
    if (app.sel.filter((s) => s.t === 'wall').length >= 2) {
      buttons.push(Object.assign(button('Merge walls', () => FP.interact.mergeSelection()), { id: 'mergeBtn', title: 'Join in-line segments into one wall (Ctrl+M)' }));
    }
    if (!gid && groupable >= 2) buttons.push(Object.assign(button('Group', () => FP.interact.groupSelection()), { id: 'groupBtn', title: 'Ctrl+G' }));
    if (grouped) buttons.push(Object.assign(button('Ungroup', () => FP.interact.ungroupSelection()), { id: 'ungroupBtn', title: 'Ctrl+Shift+G' }));
    if (nLocked < lockable.length) buttons.push(Object.assign(button('Lock all', () => FP.interact.setLocked(true)), { id: 'lockAllBtn', title: 'Ctrl+L' }));
    if (nLocked) buttons.push(Object.assign(button('Unlock all', () => FP.interact.setLocked(false)), { id: 'unlockAllBtn', title: 'Ctrl+L' }));
    buttons.push(deleteButton());
    actions(...buttons);
  }

  let lengthAnchor = 'a';
  let keepAngles = true;

  function wallInspector(wall) {
    const geo = app.geo();
    const f = G.wallFrame(wall, geo.idx);
    const j = geo.joins.get(wall.id);
    section(wall.type === 'exterior' ? 'Exterior Wall' : 'Interior Wall');
    selectField('Type', wall.type, [['interior', 'Interior'], ['exterior', 'Exterior']], (v) => {
      wall.type = v;
      wall.thickness = v === 'exterior' ? app.settings().exteriorThickness : app.settings().interiorThickness;
      app.commit();
    }, 'type');
    lengthField('Length (inside face)', f.len, (v) => {
      const res = M.setWallLength(app.floor(), wall.id, v, lengthAnchor, keepAngles);
      if (!res.ok) app.toast(res.msg, true);
      app.commit();
    }, 'length');
    const anchors = el('div', { class: 'seg small' });
    for (const [v, t] of [['a', 'Start'], ['center', 'Center'], ['b', 'End']]) {
      anchors.append(el('button', {
        textContent: t, class: lengthAnchor === v ? 'on' : '',
        on: { click: (e) => { e.preventDefault(); lengthAnchor = v; refreshInspector(); } },
      }));
    }
    ins().append(el('div', { class: 'field' }, el('span', { textContent: 'Keep fixed' }), anchors));
    const keep = el('input', { type: 'checkbox', checked: keepAngles, on: { change: (e) => { keepAngles = e.target.checked; } } });
    ins().append(el('label', { class: 'check' }, keep, el('span', { textContent: 'Keep connected walls square when length changes' })));
    readOnly('Other face', j ? app.fmt(j.farLen) : '-');
    const thick = lengthField('Thickness', wall.thickness, (v) => {
      wall.thickness = Math.max(1, v);
      app.commit();
    }, 'thickness');
    thick.value = app.fmtShort(wall.thickness);
    numberField('Angle', M.wallAngle(f), (v) => {
      const res = M.setWallAngle(app.floor(), wall.id, v);
      if (!res.ok && res.msg) app.toast(res.msg, true);
      app.commit();
    }, 'angle', '°');
    readOnly('Horizontal run', app.fmt(Math.abs(f.b.x - f.a.x)));
    readOnly('Vertical rise', app.fmt(Math.abs(f.b.y - f.a.y)));
    actions(
      button('Flip thickness side', () => { wall.side *= -1; app.commit(); }),
      deleteButton());
  }

  function nodeInspector(node) {
    const geo = app.geo();
    const walls = geo.idx.byNode.get(node.id) || [];
    section(node.host ? 'T-Junction' : 'Corner');
    readOnly('Connected walls', String(walls.length));
    if (node.host) {
      lengthField('Along wall', node.host.d, (v) => { node.host.d = v; app.commit(); }, 'along', { zero: true });
    } else {
      lengthField('X', node.x, (v) => { node.x = v; app.commit(); }, 'x', { signed: true });
      lengthField('Y', node.y, (v) => { node.y = v; app.commit(); }, 'y', { signed: true });
    }
    const buttons = [];
    if (node.host || walls.length > 1) {
      buttons.push(button(node.host ? 'Detach from wall' : 'Split corner', () => {
        M.splitNode(app.floor(), node.id);
        app.sel = [];
        app.commit();
        app.emit('selection');
      }));
    }
    buttons.push(deleteButton());
    actions(...buttons);
  }

  function fixtureInspector(fx) {
    const k = F.KINDS[fx.kind] || F.KINDS.generic;
    section(fx.name || k.name);
    const customs = app.doc.customFixtures.filter((c) => c.base === fx.kind);
    const options = k.sizes.map((s, i) => [`s${i}`, /^\d+"$/.test(s.label) ? `${app.fmtShort(s.w)} x ${app.fmtShort(s.d)}` : `${s.label} (${sizePair(s.w, s.d)})`]);
    customs.forEach((c) => options.push([`c${c.id}`, `${c.name} (${app.fmtShort(c.w)} x ${app.fmtShort(c.d)})`]));
    options.push(['custom', 'Custom size']);
    const std = F.matchSize(fx.kind, fx.w, fx.d);
    const custom = customs.find((c) => Math.abs(c.w - fx.w) < 0.01 && Math.abs(c.d - fx.d) < 0.01);
    const current = custom ? `c${custom.id}` : std >= 0 ? `s${std}` : 'custom';
    const applySize = (w, d) => {
      fx.w = w;
      fx.d = d;
      FP.interact.snapFixtureToWalls(fx);
      app.commit();
      refreshInspector();
    };
    selectField('Size', current, options, (v) => {
      if (v === 'custom') { const input = ins().querySelector('[data-key="fw"]'); if (input) input.focus(); return; }
      if (v[0] === 's') { const s = k.sizes[Number(v.slice(1))]; applySize(s.w, s.d); }
      else { const c = customs.find((x) => x.id === v.slice(1)); if (c) applySize(c.w, c.d); }
    }, 'size');
    lengthField('Width', fx.w, (v) => { fx.w = Math.max(1, v); app.commit(); refreshInspector(); }, 'fw');
    lengthField('Depth', fx.d, (v) => { fx.d = Math.max(1, v); app.commit(); refreshInspector(); }, 'fd');
    numberField('Rotation', fx.rot, (v) => { fx.rot = ((v % 360) + 360) % 360; app.commit(); refreshInspector(); }, 'rot', '°');
    lengthField('X', fx.x, (v) => { fx.x = v; app.commit(); }, 'x', { signed: true });
    lengthField('Y', fx.y, (v) => { fx.y = v; app.commit(); }, 'y', { signed: true });
    actions(
      keep(button('Save as custom fixture', () => openCustomDialog({ base: fx.kind, w: fx.w, d: fx.d, name: fx.name || '' }))),
      deleteButton());
  }

  function openingInspector(op) {
    const geo = app.geo();
    const wall = geo.idx.walls.get(op.wallId);
    if (!wall) return;
    const f = G.wallFrame(wall, geo.idx);
    const info = M.OPENING_KINDS[op.kind];
    section(info.name);
    selectField('Type', op.kind, Object.entries(M.OPENING_KINDS).map(([k, v]) => [k, v.name]), (v) => { op.kind = v; app.commit(); refreshInspector(); }, 'kind');
    const sizes = info.sizes.includes(op.width) ? info.sizes : [...info.sizes, op.width].sort((a, b) => a - b);
    selectField('Standard width', String(op.width), sizes.map((w) => [String(w), app.fmtShort(w)]), (v) => {
      const width = Number(v);
      const nd = Math.max(width / 2, Math.min(f.len - width / 2, op.d));
      if (!M.openingFits(app.floor(), op.wallId, nd, width, op.id)) { app.toast('That width does not fit here.', true); refreshInspector(); return; }
      op.width = width; op.d = nd; app.commit(); refreshInspector();
    }, 'stdw');
    lengthField('Custom width', op.width, (v) => {
      const nd = Math.max(v / 2, Math.min(f.len - v / 2, op.d));
      if (!M.openingFits(app.floor(), op.wallId, nd, v, op.id)) { app.toast('That width does not fit here.', true); refreshInspector(); return; }
      op.width = v; op.d = nd; app.commit(); refreshInspector();
    }, 'width');
    lengthField('From wall start', op.d - op.width / 2, (v) => {
      const nd = v + op.width / 2;
      if (!M.openingFits(app.floor(), op.wallId, nd, op.width, op.id)) { app.toast('It does not fit at that position.', true); refreshInspector(); return; }
      op.d = nd; app.commit();
    }, 'offset', { zero: true });
    readOnly('To wall end', app.fmt(f.len - op.d - op.width / 2));
    if (info.panels) {
      const choices = op.kind === 'pocket'
        ? [['1', 'Single'], ['2', 'Double, a pocket each side']]
        : [['1', 'Single pair'], ['2', 'Double pair']];
      selectField('Panels', String(op.panels || 1), choices, (v) => { op.panels = Number(v); app.commit(); refreshInspector(); }, 'panels');
    }
    const problem = M.pocketProblem(app.floor(), op);
    if (problem) ins().append(el('p', { class: 'warn small', id: 'pocketWarn', textContent: problem }));
    const buttons = [];
    if (info.swing) buttons.push(button('Flip swing', () => { op.flipSwing = !op.flipSwing; app.commit(); }));
    if (info.side && !(op.kind === 'pocket' && (op.panels || 1) >= 2)) {
      const label = op.kind === 'pocket' ? 'Flip pocket side' : op.kind === 'slider' ? 'Flip sliding side' : 'Flip hinge';
      buttons.push(button(label, () => { op.flipHinge = !op.flipHinge; app.commit(); refreshInspector(); }));
    }
    buttons.push(deleteButton());
    actions(...buttons);
  }

  function stairInspector(st) {
    const S = FP.stairs;
    const change = (fn) => {
      fn();
      Object.assign(st, S.clean(st));
      FP.interact.rememberStair(st);
      app.commit();
      refreshInspector();
    };
    const g = S.geometry(st);
    const k = g.counts;
    const inch16 = (v) => app.fmtShort(Math.round(v * 16) / 16);
    section(st.shape === 'straight' ? 'Straight Stairs' : st.shape === 'L' ? 'L-Shaped Stairs' : 'U-Shaped Stairs');
    const over = M.floorOver(app.doc, app.floor()), under = M.floorUnder(app.doc, app.floor());
    selectField('Goes', st.goes, [['up', `Up to ${over ? over.name : 'the floor above'}`], ['down', `Down to ${under ? under.name : 'the floor below'}`]],
      (v) => change(() => { st.goes = v; }), 'goes');
    if (app.doc.floors.length > 1 && !(st.goes === 'down' ? under : over)) {
      ins().append(el('p', { class: 'muted small', id: 'stairNoFloor', textContent: `There's no floor ${st.goes === 'down' ? 'below' : 'above'} this one, so these stairs only show here.` }));
    }
    selectField('Shape', st.shape, [['straight', 'Straight'], ['L', 'L-shaped, with a landing'], ['U', 'U-shaped, with a landing']], (v) => change(() => { st.shape = v; st.split = null; }), 'shape');
    if (st.shape !== 'straight') {
      selectField('Turns', st.turn, [['right', 'Right'], ['left', 'Left']], (v) => change(() => { st.turn = v; }), 'turn');
      const auto = Math.ceil(k.treads / 2);
      const splits = [['auto', `Auto (${auto})`]];
      for (let n = 1; n < k.treads; n++) splits.push([String(n), String(n)]);
      selectField('Treads before landing', st.split ? String(st.split) : 'auto', splits, (v) => change(() => { st.split = v === 'auto' ? null : Number(v); }), 'split');
    }
    lengthField('Width', st.width, (v) => change(() => { st.width = v; }), 'width');
    lengthField('Floor-to-floor height', st.rise, (v) => change(() => { st.rise = v; }), 'rise');
    lengthField('Max riser height', st.maxRiser, (v) => change(() => { st.maxRiser = v; }), 'maxRiser');
    lengthField('Tread depth', st.tread, (v) => change(() => { st.tread = v; }), 'tread');
    const autoRisers = Math.max(2, Math.ceil(st.rise / st.maxRiser - 1e-9));
    const riserOptions = [['auto', `Auto (${autoRisers})`]];
    for (let n = Math.max(2, autoRisers - 3); n <= autoRisers + 4; n++) riserOptions.push([String(n), String(n)]);
    selectField('Risers', st.risers ? String(st.risers) : 'auto', riserOptions, (v) => change(() => { st.risers = v === 'auto' ? null : Number(v); }), 'risers');
    if (st.shape === 'U') lengthField('Gap between flights', st.gap, (v) => change(() => { st.gap = v; }), 'gap', { zero: true });
    selectField('Beyond the break line', st.upper,[['dashed', 'Dashed outline (see-through)'], ['shown', 'Solid'], ['hidden', 'Hidden']],
      (v) => change(() => { st.upper = v; }), 'upper');
    readOnly('Riser height', inch16(k.riserHeight));
    readOnly('Treads', k.landing ? `${k.first} + landing + ${k.second}` : String(k.treads));
    readOnly('Run', app.fmt(g.run));
    if (k.riserHeight > st.maxRiser + 1e-6) {
      ins().append(el('p', { class: 'warn small', textContent: `Each riser is ${inch16(k.riserHeight)}, taller than the ${inch16(st.maxRiser)} maximum. Add risers or set Risers to Auto.` }));
    }
    const shown = (360 - st.rot) % 360;
    numberField('Direction', shown, (v) => change(() => { st.rot = (((360 - v) % 360) + 360) % 360; }), 'rot', '°');
    lengthField('X', st.x, (v) => change(() => { st.x = v; }), 'x', { signed: true });
    lengthField('Y', st.y, (v) => change(() => { st.y = v; }), 'y', { signed: true });
    ins().append(el('p', { class: 'muted small', textContent: 'The floor above shows these stairs going down. X and Y are the bottom corner.' }));
    actions(
      button('Flip side', () => change(() => { st.side = st.side === 'right' ? 'left' : 'right'; })),
      button('Rotate 90°', () => change(() => FP.interact.rotateStair(st, 90))),
      deleteButton());
  }

  function roomInspector(rec) {
    const geo = app.geo();
    const region = geo.shown && geo.shown.get(rec.id);
    section('Room');
    const name = el('input', { type: 'text', value: rec.name || '', placeholder: 'Kitchen, Bath...', autocomplete: 'off' });
    name.addEventListener('input', () => { rec.name = name.value; app.requestRender(); });
    name.addEventListener('change', () => app.commit());
    name.addEventListener('keydown', onFieldKey);
    row('Name', name, 'roomName');
    readOnly('Floor area', region ? app.fmtArea(region.area) : '-');
    ins().append(el('p', { class: 'muted small', textContent: 'Area is measured between the inside faces of the walls. Drag the name to move it.' }));
  }

  function deleteAllGuidesButton() {
    return button('Delete all construction lines', () => {
      // Room dividers stay: they're part of the plan, not reference lines.
      const floor = app.floor();
      // Locked lines stay too.
      const gone = new Set(floor.guides.filter((g) => !g.divider && !g.locked).map((g) => g.id));
      floor.guides = floor.guides.filter((g) => !gone.has(g.id));
      app.sel = app.sel.filter((s) => !(s.t === 'guide' && gone.has(s.id)));
      app.commit();
      app.emit('selection');
    }, 'danger');
  }

  function guideInspector(g) {
    const len = G.dist(g.a, g.b);
    const u = len > 1e-9 ? G.mul(G.sub(g.b, g.a), 1 / len) : { x: 1, y: 0 };
    section(g.divider ? 'Room Divider' : 'Construction Line');
    if (g.divider) ins().append(el('p', { class: 'muted small', textContent: 'Splits a room in two without a wall. Each end should touch a wall.' }));
    lengthField('Length', len, (v) => {
      g.b = G.add(g.a, G.mul(u, v));
      app.commit();
      refreshInspector();
    }, 'length');
    const angle = ((Math.atan2(-(g.b.y - g.a.y), g.b.x - g.a.x) * 180) / Math.PI + 360) % 360;
    numberField('Angle', angle, (v) => {
      const r = (v * Math.PI) / 180;
      g.b = { x: g.a.x + Math.cos(r) * len, y: g.a.y - Math.sin(r) * len };
      app.commit();
      refreshInspector();
    }, 'angle', '°');
    readOnly('Horizontal run', app.fmt(Math.abs(g.b.x - g.a.x)));
    readOnly('Vertical rise', app.fmt(Math.abs(g.b.y - g.a.y)));
    const swap = button(g.divider ? 'Make construction line' : 'Make room divider', () => {
      if (g.divider) delete g.divider; else g.divider = true;
      app.commit();
      refreshInspector();
    });
    actions(swap, deleteButton(), ...(g.divider ? [] : [deleteAllGuidesButton()]));
  }

  function dimInspector(dim) {
    const geo = app.geo();
    const g = Rn.dimGeometry(app.floor(), dim, geo.idx);
    section('Dimension');
    readOnly('Measured', app.fmt(g.len));
    lengthField('Line offset', dim.offset, (v) => { dim.offset = v; app.commit(); }, 'offset', { signed: true });
    const floor = app.floor();
    const names = [dim.a, dim.b].filter((e) => e.item).map((e) => {
      const list = floor[{ fixture: 'fixtures', opening: 'openings', stair: 'stairs', shape: 'shapes' }[e.item.t]] || [];
      const x = list.find((i) => i.id === e.item.id);
      if (!x) return null;
      if (e.item.t === 'shape') return `the ${FP.shapes.nameOf(x).toLowerCase()}`;
      return e.item.t === 'fixture' ? `the ${(x.name || (F.KINDS[x.kind] && F.KINDS[x.kind].name) || 'fixture').toLowerCase()}`
        : e.item.t === 'stair' ? 'the stairs' : `the ${((M.OPENING_KINDS[x.kind] || {}).name || 'opening').toLowerCase()}`;
    }).filter(Boolean);
    if (names.length) {
      const s = app.settings();
      ins().append(note(`Attached to ${[...new Set(names)].join(' and ')}. It follows ${names.length > 1 ? 'them' : 'it'}, and is removed if the point it's on moves more than ${app.fmt(s.dimMove)} or turns more than ${s.dimTurn}° from where it was drawn.`, 'dimAttachNote'));
    }
    actions(deleteButton());
  }

  // ---------- Shapes ----------

  function shapeInspector(sh) {
    section(FP.shapes.nameOf(sh));
    const done = () => { app.commit(); refreshInspector(); };
    if (sh.kind === 'line') {
      const len = G.dist(sh.a, sh.b);
      const u = len > 1e-9 ? G.mul(G.sub(sh.b, sh.a), 1 / len) : { x: 1, y: 0 };
      lengthField('Length', len, (v) => { sh.b = G.add(sh.a, G.mul(u, v)); done(); }, 'length');
      const angle = ((Math.atan2(-(sh.b.y - sh.a.y), sh.b.x - sh.a.x) * 180) / Math.PI + 360) % 360;
      numberField('Angle', angle, (v) => {
        const r = (v * Math.PI) / 180;
        sh.b = { x: sh.a.x + Math.cos(r) * len, y: sh.a.y - Math.sin(r) * len };
        done();
      }, 'angle', '°');
    } else if (sh.kind === 'poly') {
      readOnly('Points', String(sh.pts.length));
      readOnly(sh.closed ? 'Perimeter' : 'Length', app.fmt(FP.shapes.length(sh)));
      if (sh.pts.length > 2) {
        selectField('Ends', sh.closed ? 'closed' : 'open', [['open', 'Open'], ['closed', 'Closed (last point joins the first)']], (v) => { sh.closed = v === 'closed'; done(); }, 'closed');
      }
    } else if (sh.kind === 'arc') {
      const g = FP.shapes.arcGeom(sh);
      readOnly('Radius', g ? app.fmt(g.r) : '-');
      readOnly('Arc length', app.fmt(FP.shapes.length(sh)));
      readOnly('Between ends', app.fmt(G.dist(sh.a, sh.b)));
      readOnly('Sweep', g ? `${Math.round((Math.abs(g.sweep) * 180) / Math.PI)}°` : '-');
    } else {
      if (sh.circle) lengthField('Diameter', sh.w, (v) => { sh.w = v; sh.d = v; done(); }, 'dia');
      else {
        lengthField('Width', sh.w, (v) => { sh.w = v; done(); }, 'w');
        lengthField('Depth', sh.d, (v) => { sh.d = v; done(); }, 'd');
        numberField('Rotation', sh.rot || 0, (v) => { sh.rot = ((v % 360) + 360) % 360; done(); }, 'rot', '°');
      }
      if (sh.kind === 'rect') {
        lengthField('Corner radius', sh.r || 0, (v) => { sh.r = Math.max(0, Math.min(v, sh.w / 2, sh.d / 2)); done(); }, 'radius', { zero: true });
      }
      lengthField('Centre X', sh.x, (v) => { sh.x = v; done(); }, 'x', { signed: true });
      lengthField('Centre Y', sh.y, (v) => { sh.y = v; done(); }, 'y', { signed: true });
    }
    shapeStyleFields([sh]);
    furnitureSave();
    actions(deleteButton());
  }

  const inkColor = () => Rn.PALETTES[FP.prefs.theme()].ink;
  let lastFill = '#c9d6e3';

  // Line and fill controls for one or more shapes. A change applies to all of them, and new
  // shapes are drawn with it too.
  function shapeStyleFields(shapes) {
    const first = shapes[0];
    const same = (k) => shapes.every((x) => x[k] === first[k]);
    const apply = (style) => {
      for (const x of shapes) Object.assign(x, style);
      FP.interact.rememberShapeStyle(style);
      app.commit();
      refreshInspector();
    };
    ins().append(el('h4', { textContent: 'Style' }));
    // Auto follows the theme, so lines read on light and dark backgrounds alike.
    const stroke = same('stroke') ? first.stroke : undefined;
    const color = el('input', { type: 'color', value: stroke || inkColor(), title: 'Line colour', 'aria-label': 'Line colour' });
    color.addEventListener('change', () => apply({ stroke: color.value }));
    const auto = el('button', {
      type: 'button', textContent: 'Auto', class: stroke === null ? 'toggle on' : 'toggle',
      title: 'Follow the theme: dark lines on light, light lines on dark', on: { click: () => apply({ stroke: null }) },
    });
    row('Line colour', el('div', { class: 'inline-controls' }, color, auto), 'stroke');

    const weights = FP.shapes.WEIGHTS.map(([v, label]) => [String(v), label]);
    if (same('weight') && !weights.some(([v]) => Number(v) === first.weight)) weights.push([String(first.weight), `${first.weight} px`]);
    if (!same('weight')) weights.unshift(['', 'Mixed']);
    selectField('Line weight', same('weight') ? String(first.weight) : '', weights, (v) => { if (v) apply({ weight: Number(v) }); }, 'weight');

    const dashes = [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']];
    if (!same('dash')) dashes.unshift(['', 'Mixed']);
    selectField('Line style', same('dash') ? first.dash : '', dashes, (v) => { if (v) apply({ dash: v }); }, 'dash');

    const closed = shapes.filter((x) => FP.shapes.isClosed(x));
    if (!closed.length) return;
    const fill = closed.every((x) => x.fill === closed[0].fill) ? closed[0].fill : undefined;
    const mode = fill === undefined ? '' : !fill ? 'none' : fill === 'paper' ? 'paper' : 'color';
    const modes = [['none', 'None'], ['paper', 'Background (hides what\'s under it)'], ['color', 'Colour']];
    if (!mode) modes.unshift(['', 'Mixed']);
    selectField('Fill', mode, modes, (v) => {
      if (v === 'none') apply({ fill: null });
      else if (v === 'paper') apply({ fill: 'paper', fillAlpha: 1 });
      else if (v === 'color') apply({ fill: lastFill });
    }, 'fill');
    if (mode !== 'color') return;
    const fillColor = el('input', { type: 'color', value: fill, title: 'Fill colour', 'aria-label': 'Fill colour' });
    fillColor.addEventListener('change', () => { lastFill = fillColor.value; apply({ fill: fillColor.value }); });
    const alpha = closed.every((x) => x.fillAlpha === closed[0].fillAlpha) ? closed[0].fillAlpha : null;
    const opacity = el('select', { 'aria-label': 'Fill opacity' });
    const levels = [[1, 'Solid'], [0.75, '75%'], [0.5, '50%'], [0.25, '25%']];
    if (alpha != null && !levels.some(([v]) => v === alpha)) levels.push([alpha, `${Math.round(alpha * 100)}%`]);
    if (alpha == null) opacity.append(el('option', { value: '', textContent: 'Mixed' }));
    for (const [v, label] of levels) opacity.append(el('option', { value: String(v), textContent: label }));
    opacity.value = alpha == null ? '' : String(alpha);
    opacity.addEventListener('change', () => { if (opacity.value) apply({ fillAlpha: Number(opacity.value) }); });
    row('Fill colour', el('div', { class: 'inline-controls' }, fillColor, opacity), 'fillColor');
  }

  // Saves the selected shapes as a library piece.
  function furnitureSave() {
    ins().append(el('h4', { textContent: 'Furniture' }));
    const input = keep(el('input', { type: 'text', placeholder: 'Name, such as Sectional sofa', autocomplete: 'off', spellcheck: false }));
    const save = () => FP.interact.saveFurniture(input.value);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } e.stopPropagation(); });
    row('Name', input, 'furnName');
    actions(keep(Object.assign(button('Save as furniture', save), { id: 'saveFurnBtn', title: 'Add to My Furniture in the library, to place more copies' })));
  }

  function labelInspector(l) {
    section('Text');
    const text = el('input', { type: 'text', value: l.text, autocomplete: 'off' });
    text.addEventListener('input', () => { l.text = text.value; app.requestRender(); });
    text.addEventListener('change', () => app.commit());
    text.addEventListener('keydown', onFieldKey);
    row('Text', text, 'labelText');
    lengthField('Height', l.size, (v) => { l.size = Math.max(1, v); app.commit(); }, 'size');
    numberField('Rotation', l.rot, (v) => { l.rot = ((v % 360) + 360) % 360; app.commit(); }, 'rot', '°');
    actions(deleteButton());
  }

  // ---------- Design options ----------

  let designSig = null;
  function refreshDesignBar() {
    const floor = app.floor();
    const opts = floor.options || [];
    const select = $('optionSelect');
    const sig = JSON.stringify([floor.id, floor.option, opts.map((o) => [o.id, o.name])]);
    if (sig !== designSig) {
      designSig = sig;
      select.textContent = '';
      select.append(el('option', { value: '', textContent: 'As-is' }));
      for (const o of opts) select.append(el('option', { value: o.id, textContent: o.name }));
      select.append(el('option', { disabled: true, textContent: '──────────' }));
      select.append(el('option', { value: '+new', textContent: '+ New option' }));
      if (floor.option) select.append(el('option', { value: '+copy', textContent: '+ Copy of this option' }));
    }
    select.value = floor.option || '';
    $('changesRow').hidden = !floor.option;
    $('tChanges').checked = app.view.changes !== false;
    $('canvasWrap').classList.toggle('in-option', !!floor.option);
  }

  function optionCount(floor) {
    const opt = FP.options.active(floor);
    if (!opt) return 0;
    FP.options.sync(floor);
    const ids = (o, k) => ((o && o[k]) || []).map((x) => (typeof x === 'string' ? x : x.id));
    let n = 0;
    for (const k of ['openings', 'fixtures', 'dims', 'labels', 'guides', 'stairs']) n += ids(opt.changes, k).length + ids(opt.removed, k).length;
    // A wall counts as changed when it or either of its corners changed.
    const walls = new Set([...ids(opt.changes, 'walls'), ...ids(opt.removed, 'walls')]);
    const nodes = new Set(ids(opt.changes, 'nodes'));
    for (const w of floor.walls) if (nodes.has(w.a) || nodes.has(w.b)) walls.add(w.id);
    return n + walls.size;
  }

  // Shown in the Inspector with nothing selected while a design option is open.
  function optionSummary(floor) {
    const opt = FP.options.active(floor);
    section('Design Option');
    const name = el('input', { type: 'text', value: opt.name, autocomplete: 'off' });
    name.addEventListener('change', () => { opt.name = name.value.trim() || opt.name; app.commit(); });
    name.addEventListener('keydown', onFieldKey);
    row('Name', name, 'optionName');
    const n = optionCount(floor);
    readOnly('Changed from as-is', n ? itemCount(n) : 'Nothing yet');
    ins().append(note('Edits here change only this option; the as-is plan stays as it is. Fixes made to the as-is plan show up in every option.'));
    actions(
      Object.assign(button('Back to as-is', () => app.openOption(null)), { id: 'optAsIs' }),
      Object.assign(button('Duplicate', () => app.openOption(null, 'copy')), { id: 'optCopy' }),
      Object.assign(button('Make this the as-is', () => {
        if (!window.confirm(`Make "${opt.name}" the as-is plan, for when the work is done? The other options keep their designs. You can undo this.`)) return;
        FP.options.promote(floor);
        app.sel = [];
        app.refreshLocks();
        app.commit();
        app.toast(`"${opt.name}" is now the as-is plan.`);
      }), { id: 'optPromote' }),
      Object.assign(button('Delete option', () => {
        if (!window.confirm(`Delete the design option "${opt.name}"? You can undo this.`)) return;
        FP.options.remove(floor, opt.id);
        app.sel = [];
        app.refreshLocks();
        app.commit();
      }, 'danger'), { id: 'optDelete' }));
    const merge = mergeAllButton(floor);
    if (merge) actions(merge);
  }
  const itemCount = (n) => `${n} item${n === 1 ? '' : 's'}`;

  function planSummary() {
    const floor = app.floor();
    const geo = app.geo();
    if (floor.option && FP.options.active(floor)) { optionSummary(floor); return; }
    section(floor.name);
    let area = 0;
    if (geo.shown) for (const region of geo.shown.values()) area += region.area;
    readOnly('Walls', String(floor.walls.length));
    readOnly('Rooms', String(geo.shown ? geo.shown.size : 0));
    readOnly('Total room area', app.fmtArea(area));
    readOnly('Doors & windows', String(floor.openings.length));
    readOnly('Fixtures', String(floor.fixtures.length));
    if ((floor.shapes || []).length) readOnly('Drawn shapes', String(floor.shapes.length));
    if (floor.stairs.length) readOnly('Stairs', String(floor.stairs.length));
    ins().append(el('p', { class: 'muted small', textContent: 'Select something on the plan to edit it here.' }));
    const nOpts = (floor.options || []).length;
    ins().append(note(nOpts
      ? `This floor has ${nOpts} design option${nOpts === 1 ? '' : 's'}. Open one from the Design menu at the top left of the plan.`
      : 'To try a renovation without changing this plan, pick "+ New option" in the Design menu at the top left of the plan.'));
    const tidy = [mergeAllButton(floor)].filter(Boolean);
    if (floor.guides.some((g) => !g.divider)) tidy.push(deleteAllGuidesButton());
    if (tidy.length) actions(...tidy);
  }

  // Offered when walls on the floor are drawn as separate in-line segments.
  function mergeAllButton(floor) {
    const runs = FP.merge.straightRuns(floor);
    if (!runs.length) return null;
    const segs = runs.reduce((n, r) => n + r.length, 0);
    return Object.assign(button(`Merge segmented walls (${runs.length})`, () => FP.interact.mergeAllWalls()), {
      id: 'mergeAllBtn',
      title: `Join ${segs} in-line wall segments into ${runs.length} wall${runs.length === 1 ? '' : 's'}`,
    });
  }

  function refreshInspector() {
    const box = ins();
    const active = document.activeElement;
    const focusKey = active && box.contains(active) ? active.dataset.key : null;
    box.textContent = '';
    const floor = app.floor();
    if (app.sel.length === 1) {
      const s = app.sel[0];
      const item = M.itemOf(floor, s);
      if (item) {
        ({ wall: wallInspector, node: nodeInspector, fixture: fixtureInspector, opening: openingInspector, room: roomInspector, dim: dimInspector, label: labelInspector, guide: guideInspector, stair: stairInspector, shape: shapeInspector })[s.t](item);
        lockAndGroup(s, item);
      } else planSummary();
    } else if (app.sel.length > 1) {
      multiInspector();
    } else {
      planSummary();
    }
    if (focusKey) {
      const again = box.querySelector(`[data-key="${focusKey}"]`);
      if (again) again.focus();
    }
  }

  // ---------- Floors ----------

  const EYE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><path d="M3 13 13 3"/></svg>';

  let tabSig = null;      // tabs are only rebuilt when this changes, so a double-click survives
  let renaming = null;
  let suppressClick = false;

  const floorById = (id) => app.doc.floors.find((f) => f.id === id);

  function buildFloorTab(floor) {
    const eye = el('button', {
      class: 'floor-eye',
      innerHTML: floor.hidden ? EYE_OFF : EYE,
      on: {
        // Looked up on each click: undo, reopening or a restored session replace the floor
        // objects, while a tab with the same name and state is kept.
        click: () => {
          const current = floorById(floor.id);
          if (!current) return;
          current.hidden = !current.hidden;
          app.commit();
        },
      },
    });
    const name = el('button', {
      class: 'tab',
      textContent: floor.name,
      title: 'Click to view, double-click to rename, drag to reorder. Floors run lowest to highest, left to right.',
      on: {
        pointerdown: (e) => beginFloorDrag(e, floor),
        click: () => {
          if (suppressClick) { suppressClick = false; return; }
          if (floor.id !== app.doc.activeFloorId) app.setActiveFloor(floor.id);
        },
        dblclick: () => startRename(floor.id),
      },
    });
    return el('div', { class: floor.hidden ? 'floor-tab is-hidden' : 'floor-tab', 'data-id': floor.id }, eye, name);
  }

  function refreshFloors() {
    const floors = app.doc.floors;
    const at = floors.indexOf(app.floor());
    $('delFloor').disabled = floors.length < 2;
    $('floorDown').disabled = at <= 0;
    $('floorUp').disabled = at >= floors.length - 1;
    $('tGhost').checked = !!app.settings().showGhost;
    $('tGhostAbove').checked = !!app.settings().showGhostAbove;
    if (renaming) return;

    const box = $('floorTabs');
    const sig = JSON.stringify(floors.map((f) => [f.id, f.name, !!f.hidden]));
    if (sig !== tabSig) {
      tabSig = sig;
      box.textContent = '';
      for (const floor of floors) box.append(buildFloorTab(floor));
    }
    for (const wrap of box.children) {
      const floor = floorById(wrap.getAttribute('data-id'));
      const active = floor.id === app.doc.activeFloorId;
      wrap.querySelector('.tab').classList.toggle('on', active);
      const eye = wrap.querySelector('.floor-eye');
      eye.disabled = active;
      eye.setAttribute('aria-pressed', String(!!floor.hidden));
      eye.setAttribute('aria-label', `${floor.hidden ? 'Show' : 'Hide'} ${floor.name}`);
      eye.title = active
        ? 'This is the floor you are editing, so it always shows.'
        : floor.hidden
          ? 'Hidden. Click to show it faintly on the floors above.'
          : 'Shows faintly on the floors above. Click to hide it.';
    }
  }

  function startRename(id) {
    const floor = floorById(id);
    const wrap = $('floorTabs').querySelector(`[data-id="${id}"]`);
    if (!floor || !wrap || renaming) return;
    renaming = id;
    const finish = (save) => {
      if (renaming !== id) return;
      renaming = null;
      const name = input.value.trim();
      tabSig = null;
      if (save && name && name !== floor.name) {
        floor.name = name;
        app.commit();
      } else refreshFloors();
    };
    const input = el('input', {
      class: 'floor-name',
      type: 'text',
      value: floor.name,
      maxLength: 40,
      'aria-label': 'Floor name',
      on: {
        keydown: (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') finish(true);
          else if (e.key === 'Escape') finish(false);
        },
        blur: () => finish(true),
      },
    });
    wrap.querySelector('.tab').replaceWith(input);
    input.focus();
    input.select();
  }

  // Dragging a tab reorders the floors. A press that doesn't move stays an ordinary click.
  function beginFloorDrag(e, floor) {
    if (e.button !== 0 || renaming) return;
    suppressClick = false;
    const box = $('floorTabs');
    const startX = e.clientX, startY = e.clientY;
    const self = box.querySelector(`[data-id="${floor.id}"]`);
    let dragging = false;
    let drop = null;

    const clearMarks = () => {
      for (const t of box.children) t.classList.remove('drop-before', 'drop-after');
    };
    const onMove = (ev) => {
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      dragging = true;
      self.classList.add('dragging');
      clearMarks();
      let best = null, bestD = Infinity;
      for (const t of box.children) {
        const r = t.getBoundingClientRect();
        const d = Math.hypot(ev.clientX - (r.left + r.right) / 2, ev.clientY - (r.top + r.bottom) / 2);
        if (d < bestD) { bestD = d; best = { t, before: ev.clientX < (r.left + r.right) / 2 }; }
      }
      drop = best && best.t !== self ? best : null;
      if (drop) drop.t.classList.add(drop.before ? 'drop-before' : 'drop-after');
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      clearMarks();
      self.classList.remove('dragging');
      if (!dragging) return;
      suppressClick = true;
      if (!drop) return;
      const tabs = [...box.children];
      const from = tabs.indexOf(self);
      let to = tabs.indexOf(drop.t) + (drop.before ? 0 : 1);
      if (to > from) to--;
      if (M.moveFloor(app.doc, floor.id, to)) app.commit();
    };
    const onCancel = () => { drop = null; onUp(); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  function shiftActiveFloor(by) {
    const floor = app.floor();
    if (M.moveFloor(app.doc, floor.id, app.doc.floors.indexOf(floor) + by)) app.commit();
  }

  function initFloors() {
    $('floorDown').onclick = () => shiftActiveFloor(-1);
    $('floorUp').onclick = () => shiftActiveFloor(1);
    $('renFloor').onclick = () => startRename(app.doc.activeFloorId);
    $('addFloor').onclick = () => {
      const floor = M.createFloor(`Floor ${app.doc.floors.length + 1}`);
      app.doc.floors.push(floor);
      app.doc.activeFloorId = floor.id;
      app.sel = [];
      app.commit();
      app.emit('selection');
    };
    $('dupFloor').onclick = () => {
      const source = app.floor();
      const copy = JSON.parse(JSON.stringify(source));
      copy.id = M.uid('f');
      copy.name = `${source.name} copy`;
      copy.hidden = false;
      app.doc.floors.push(copy);
      app.doc.activeFloorId = copy.id;
      app.sel = [];
      app.commit();
      app.emit('selection');
    };
    $('delFloor').onclick = () => {
      if (app.doc.floors.length < 2) return;
      const floor = app.floor();
      if (!window.confirm(`Delete ${floor.name}? You can undo this.`)) return;
      app.doc.floors = app.doc.floors.filter((f) => f !== floor);
      app.doc.activeFloorId = app.doc.floors[0].id;
      app.sel = [];
      app.commit();
      app.emit('selection');
    };
    $('optionSelect').onchange = (e) => {
      const v = e.target.value;
      if (v === '+new') app.openOption(null, 'new');
      else if (v === '+copy') app.openOption(null, 'copy');
      else app.openOption(v || null);
      $('plan').focus({ preventScroll: true });
    };
    $('tChanges').onchange = (e) => {
      app.view.changes = e.target.checked;
      app.emit('view');
      app.requestRender();
    };
    $('tGhost').onchange = (e) => changeSetting('showGhost', e.target.checked);
    $('tGhostAbove').onchange = (e) => changeSetting('showGhostAbove', e.target.checked);
  }

  // ---------- Status ----------

  function refreshStatus() {
    const m = FP.interact.mouse;
    $('coords').textContent = m.inside ? `X ${app.fmt(m.x)}   Y ${app.fmt(m.y)}` : '';
    $('zoomLabel').textContent = `${Math.round((app.view.scale / 2.5) * 100)}%`;
    $('hint').textContent = FP.interact.hintText();
  }

  let libSig = null;

  function init() {
    initTopBar();
    initDialogs();
    initFloors();
    FP.exporter.initDialog();
    app.on((what) => {
      if (what === 'doc') {
        refreshUndo();
        refreshFloors();
        refreshDesignBar();
        refreshInspector();
        const sig = JSON.stringify([app.doc.customFixtures, app.doc.furniture]);
        if (sig !== libSig) { libSig = sig; buildLibrary(); }
      } else if (what === 'selection') { refreshInspector(); refreshStatus(); }
      else if (what === 'settings') {
        refreshTopBar();
        buildLibrary();
      } else if (what === 'title') refreshTitle();
      else if (what === 'tool') refreshTools();
      else if (what === 'theme') buildLibrary();
      else if (what === 'view' || what === 'cursor') { refreshStatus(); if (what === 'view') refreshStairToggle(); }
      else if (what === 'live') { refreshInspector(); refreshStatus(); }
      else if (what === 'focus-text') {
        const input = ins().querySelector('[data-key="labelText"]');
        if (input) { input.focus(); input.select(); }
      }
    });
    const refreshAll = () => {
      refreshTopBar();
      refreshTools();
      refreshFloors();
      refreshDesignBar();
      refreshInspector();
      refreshTitle();
      refreshStatus();
      libSig = JSON.stringify([app.doc.customFixtures, app.doc.furniture]);
      buildLibrary();
    };
    refreshAll();
  }

  FP.ui = { init, refreshInspector, openCustomDialog, fillGridSelect };
})(globalThis);
