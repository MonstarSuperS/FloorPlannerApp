// User settings: theme and defaults for new drawings. These belong to the person using the app
// and live in browser storage, never in a drawing file. They can also be backed up to their own file.
// Loaded in <head> so the saved theme applies before the first paint.
(function (root) {
  const FP = (root.FP = root.FP || {});
  const KEY = 'floorplanner.settings.v1';
  const FILE_TAG = 'FloorPlannerSettings';

  function readRaw() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
  }

  const THEMES = ['system', 'light', 'dark'];

  function resolveTheme(theme) {
    if (theme === 'light' || theme === 'dark') return theme;
    const media = root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)');
    return media && media.matches ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    if (root.document) root.document.documentElement.dataset.theme = resolveTheme(theme);
  }

  applyTheme(readRaw().theme);

  // Fills in anything missing or invalid, so old or hand-edited settings stay usable.
  function clean(raw) {
    raw = raw || {};
    return {
      theme: THEMES.includes(raw.theme) ? raw.theme : 'system',
      defaults: FP.model.cleanSettings(raw.defaults),
      export: {
        paper: (raw.export && raw.export.paper) || 'letter',
        orientation: (raw.export && raw.export.orientation) || 'auto',
        scale: (raw.export && raw.export.scale) || 'fit',
      },
    };
  }

  let current = null;
  const listeners = [];

  function get() {
    if (!current) current = clean(readRaw());
    return current;
  }

  function save(next) {
    current = clean(next);
    let stored = true;
    try { localStorage.setItem(KEY, JSON.stringify(current)); } catch (e) { stored = false; }
    applyTheme(current.theme);
    listeners.forEach((fn) => fn());
    return stored;
  }

  function theme() { return resolveTheme(get().theme); }

  function toFile() {
    return JSON.stringify({ app: FILE_TAG, version: 1, ...get() }, null, 1);
  }

  function fromFile(text) {
    const data = JSON.parse(text);
    if (!data || data.app !== FILE_TAG) throw new Error('That is not a FloorPlanner settings file.');
    return clean(data);
  }

  if (root.matchMedia) {
    root.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (get().theme === 'system') { applyTheme('system'); listeners.forEach((fn) => fn()); }
    });
  }

  FP.prefs = { get, save, theme, toFile, fromFile, clean, onChange: (fn) => listeners.push(fn) };
})(globalThis);
