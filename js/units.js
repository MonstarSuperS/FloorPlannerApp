// Length parsing and formatting. All lengths in the app are stored in inches; metric
// modes ('cm', 'mm') only change how they are shown and how a bare typed number is read.
(function (root) {
  const FP = (root.FP = root.FP || {});

  function gcd(a, b) { return b ? gcd(b, a % b) : a; }

  // Inches as text, rounded to 1/16": 4.5 -> "4 1/2"
  function inchText(x) {
    const t = Math.round(x * 16);
    const whole = Math.floor(t / 16);
    const r = t % 16;
    if (!r) return String(whole);
    const g = gcd(r, 16);
    const frac = `${r / g}/${16 / g}`;
    return whole ? `${whole} ${frac}` : frac;
  }

  const MM = 25.4; // mm per inch
  const METRIC = { mm: 1, cm: 10, m: 1000 }; // mm per unit
  const isMetric = (mode) => mode === 'cm' || mode === 'mm';

  // Trims a fixed-decimal number: 243.80 -> "243.8", 12.00 -> "12".
  function num(v, places) {
    const t = v.toFixed(places);
    return places ? t.replace(/\.?0+$/, '') : t;
  }

  function format(inches, mode) {
    const sign = inches < 0 ? '-' : '';
    const abs = Math.abs(inches);
    if (mode === 'mm') return `${sign}${num(abs * MM, 0)} mm`;
    if (mode === 'cm') return `${sign}${num(abs * MM / 10, 1)} cm`;
    if (mode === 'in') return `${sign}${inchText(abs)}"`;
    const t = Math.round(abs * 16);
    const ft = Math.floor(t / 192);
    return `${sign}${ft}' ${inchText((t - ft * 192) / 16)}"`;
  }

  const NUM = String.raw`\d+(?:\.\d+)?`;
  const INCH = String.raw`\d+(?:\s+|-)\d+/\d+|\d+/\d+|${NUM}`;
  const LENGTH_RE = new RegExp(`^(?:(${NUM})\\s*')?\\s*-?\\s*(?:(${INCH})\\s*"?)?$`);

  function inchValue(s) {
    const m = s.match(/^(?:(\d+)(?:\s+|-))?(\d+)\/(\d+)$/);
    if (!m) return parseFloat(s);
    const den = parseInt(m[3], 10);
    if (!den) return NaN;
    return (m[1] ? parseInt(m[1], 10) : 0) + parseInt(m[2], 10) / den;
  }

  // A short length, such as a wall thickness: inches in the imperial modes (4" rather than 0' 4").
  function formatShort(inches, mode) {
    return format(inches, isMetric(mode) ? mode : 'in');
  }

  // Square inches as text: sq ft, or m² in the metric modes.
  function formatArea(sqIn, mode, places) {
    const p = places == null ? (isMetric(mode) ? 2 : 1) : places;
    return isMetric(mode) ? `${(sqIn * MM * MM / 1e6).toFixed(p)} m²` : `${(sqIn / 144).toFixed(p)} sq ft`;
  }

  // Accepts 148, 148", 148.5, 12', 12'4", 12' 4 1/2", 12ft 4in, 3/4, 4-1/2, and metric with a
  // unit (450mm, 45 cm, 1.2m, 1m 20cm). A bare number is in the mode's unit: inches unless
  // opts.units is 'cm' or 'mm'. Returns inches, or null if the text is not a length.
  function parse(text, opts) {
    if (text == null) return null;
    const mode = opts && opts.units;
    let t = String(text).trim().toLowerCase();
    let sign = 1;
    if (opts && opts.signed && t[0] === '-') { sign = -1; t = t.slice(1).trim(); }
    if (!t) return null;
    const metric = parseMetric(t, isMetric(mode) ? mode : null);
    if (metric !== undefined) return metric == null ? null : sign * metric;
    const v = parseImperial(t);
    return v == null ? null : sign * v;
  }

  // Metric text in inches; null if it looks metric but is unreadable; undefined if not metric.
  function parseMetric(t, bareUnit) {
    const parts = t.match(/^(?:\d+(?:\.\d+)?|\.\d+)\s*(?:mm|cm|m)?(?:\s+(?:\d+(?:\.\d+)?|\.\d+)\s*(?:mm|cm|m)?)*$/);
    const hasUnit = /\d\s*(mm|cm|m)(?![a-z])/.test(t);
    if (!hasUnit && !(bareUnit && /^(\d+(\.\d+)?|\.\d+)$/.test(t))) return undefined;
    if (!parts) return null;
    const pieces = [...t.matchAll(/(\d+(?:\.\d+)?|\.\d+)\s*(mm|cm|m)?/g)];
    // Several numbers each need a unit (1m 20cm); a lone number may use the bare unit.
    if (pieces.length > 1 && pieces.some((p) => !p[2])) return null;
    let total = 0;
    for (const p of pieces) {
      const unit = p[2] || bareUnit;
      if (!unit) return null;
      total += parseFloat(p[1]) * METRIC[unit];
    }
    return pieces.length ? total / MM : null;
  }

  function parseImperial(text) {
    let s = text
      .replace(/[′’]/g, "'").replace(/[″”]/g, '"')
      .replace(/\s*(feet|foot|ft)\b/g, "'").replace(/\s*(inches|inch|in)\b/g, '"');
    if (!s) return null;
    const m = s.match(LENGTH_RE);
    if (!m || (m[1] === undefined && m[2] === undefined)) return null;
    const value = (m[1] ? parseFloat(m[1]) * 12 : 0) + (m[2] ? inchValue(m[2].trim()) : 0);
    return Number.isFinite(value) ? value : null;
  }

  // Grid and snap sizes offered for each kind of unit, in inches.
  const GRIDS = {
    imperial: [[0.5, '1/2"'], [1, '1"'], [3, '3"'], [6, '6"'], [12, '12"']],
    metric: [[5, '5 mm'], [10, '1 cm'], [20, '2 cm'], [50, '5 cm'], [100, '10 cm'], [300, '30 cm']].map(([mm, l]) => [mm / MM, l]),
  };
  const gridsFor = (mode) => GRIDS[isMetric(mode) ? 'metric' : 'imperial'];

  // The offered grid size closest to gridSize (by ratio) for this mode.
  function nearestGrid(gridSize, mode) {
    let best = null;
    for (const [v] of gridsFor(mode)) {
      if (best == null || Math.abs(Math.log(v / gridSize)) < Math.abs(Math.log(best / gridSize))) best = v;
    }
    return best;
  }

  const MODES = ['ftin', 'in', 'cm', 'mm'];

  FP.units = { format, formatShort, formatArea, parse, inchText, isMetric, gridsFor, nearestGrid, MODES, MM };
})(globalThis);
