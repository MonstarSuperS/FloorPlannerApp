// The theme toggle and the Settings dialog.
(function (root) {
  const FP = (root.FP = root.FP || {});
  const app = FP.app, P = FP.prefs;
  const $ = (id) => document.getElementById(id);

  const CHECKS = [['stSnap', 'snap'], ['stGrid', 'showGrid'], ['stLengths', 'showLengths'], ['stBoth', 'bothFaces'], ['stRooms', 'showRooms'], ['stGhost', 'showGhost'], ['stGhostAbove', 'showGhostAbove'],['stGuides', 'showGuides']];

  function refreshThemeButton() {
    const dark = P.theme() === 'dark';
    const b = $('themeBtn');
    b.textContent = dark ? '☀' : '☾';
    b.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    b.setAttribute('aria-label', b.title);
  }

  function fillForm(s) {
    $('stTheme').value = s.theme;
    $('stUnits').value = s.defaults.units;
    FP.ui.fillGridSelect($('stGridSize'), s.defaults.units, s.defaults.gridSize);
    $('stAngle').value = String(s.defaults.angleStep);
    const u = s.defaults.units;
    $('stExt').value = FP.units.formatShort(s.defaults.exteriorThickness, u);
    $('stInt').value = FP.units.formatShort(s.defaults.interiorThickness, u);
    $('stDimMove').value = FP.units.formatShort(s.defaults.dimMove, u);
    $('stDimTurn').value = String(s.defaults.dimTurn);
    for (const [id, key] of CHECKS) $(id).checked = !!s.defaults[key];
    $('stPaper').value = s.export.paper;
    $('stOrientation').value = s.export.orientation;
    $('stScale').value = s.export.scale;
    $('stApply').checked = false;
    shownUnits = s.defaults.units;
  }

  // Returns the settings described by the form, or null (with a message) if a value is unreadable.
  function readForm() {
    const units = { units: $('stUnits').value };
    const ext = FP.units.parse($('stExt').value, units), int = FP.units.parse($('stInt').value, units);
    if (!(ext > 0) || !(int > 0)) { app.toast('Enter wall thicknesses such as 6 or 5 1/2.', true); return null; }
    const dimMove = FP.units.parse($('stDimMove').value, units), dimTurn = Number($('stDimTurn').value);
    if (!(dimMove >= 0) || !(dimTurn >= 0 && dimTurn <= 180)) { app.toast('Enter how far an attached dimension follows, such as 12, and a turn from 0 to 180 degrees.', true); return null; }
    const defaults = {
      dimMove,
      dimTurn,
      units: $('stUnits').value,
      gridSize: Number($('stGridSize').value),
      angleStep: Number($('stAngle').value),
      exteriorThickness: ext,
      interiorThickness: int,
    };
    for (const [id, key] of CHECKS) defaults[key] = $(id).checked;
    return {
      theme: $('stTheme').value,
      defaults,
      export: { paper: $('stPaper').value, orientation: $('stOrientation').value, scale: $('stScale').value },
    };
  }

  // The form's values with the unit switched, read in the units they were shown in.
  let shownUnits = null;
  function readFormLoose() {
    const next = $('stUnits').value;
    $('stUnits').value = shownUnits || next;
    const form = readForm();
    $('stUnits').value = next;
    if (!form) return null;
    form.defaults.units = next;
    if (FP.units.isMetric(next) !== FP.units.isMetric(shownUnits || next)) form.defaults.gridSize = FP.units.nearestGrid(form.defaults.gridSize, next);
    return form;
  }

  function saveForm(e) {
    e.preventDefault();
    const next = readForm();
    if (!next) return;
    const stored = P.save(next);
    if ($('stApply').checked) {
      Object.assign(app.settings(), FP.prefs.get().defaults);
      app.setDirty(true);
      app.emit('settings');
    }
    $('settingsDialog').close();
    if (stored) app.toast('Settings saved.');
    else app.toast('This browser blocked saving, so settings last only until you close the page. Use Export to keep a copy.', true);
    app.requestRender();
  }

  function initSelects() {
    const add = (select, items) => {
      for (const [value, label] of items) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        select.appendChild(opt);
      }
    };
    add($('stPaper'), Object.entries(FP.exporter.PAPERS).map(([k, v]) => [k, v.name]));
    add($('stScale'), [['fit', 'Fit to page'], ...FP.exporter.SCALES.map((s) => [s.id, s.label])]);
  }

  function importFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      if (!input.files[0]) return;
      try {
        fillForm(P.fromFile(await input.files[0].text()));
        app.toast('Settings loaded. Press Save to keep them.');
      } catch (err) {
        app.toast(err instanceof SyntaxError ? 'That settings file is damaged.' : err.message, true);
      }
    };
    input.click();
  }

  function init() {
    initSelects();
    refreshThemeButton();
    P.onChange(() => {
      refreshThemeButton();
      app.emit('theme');
      app.requestRender();
    });
    $('themeBtn').onclick = () => {
      P.save({ ...P.get(), theme: P.theme() === 'dark' ? 'light' : 'dark' });
    };
    $('settingsBtn').onclick = () => {
      fillForm(P.get());
      $('settingsDialog').showModal();
    };
    $('stSave').addEventListener('click', saveForm);
    $('stCancel').addEventListener('click', () => $('settingsDialog').close());
    $('stFromDrawing').addEventListener('click', () => {
      const form = readForm();
      if (!form) return;
      form.defaults = { ...app.settings() };
      fillForm(P.clean(form));
    });
    // Changing units in the form re-shows its lengths and grid sizes in the new units.
    $('stUnits').addEventListener('change', () => {
      const form = readFormLoose();
      if (form) fillForm(P.clean(form));
    });
    $('stReset').addEventListener('click', () => fillForm(P.clean({})));
    $('stExport').addEventListener('click', () => {
      FP.fileio.download(new Blob([P.toFile()], { type: 'application/json' }), 'floorplanner-settings.json');
    });
    $('stImport').addEventListener('click', importFile);
  }

  FP.settingsUI = { init };
})(globalThis);
