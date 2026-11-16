// Fixture catalog: standard sizes and top-down vector symbols.
// Symbols are drawn in inches around the centre (0,0), with width along x and depth along y.
// The back of the fixture, which sits against a wall, is at y = -d/2.
(function (root) {
  const FP = (root.FP = root.FP || {});

  // Set from the palette on each draw, so symbols follow the theme.
  let INK = '#2b323c';
  let SOFT = '#7c8694';
  let FILL = '#ffffff';
  let TINT = '#eef1f5';

  function rrect(c, x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }
  function box(c, x, y, w, h, r, fill) {
    rrect(c, x, y, w, h, r || 0);
    c.fillStyle = fill || FILL;
    c.fill();
    c.stroke();
  }
  function ellipse(c, x, y, rx, ry, fill) {
    c.beginPath();
    c.ellipse(x, y, Math.max(rx, 0.01), Math.max(ry, 0.01), 0, 0, Math.PI * 2);
    if (fill) { c.fillStyle = fill; c.fill(); }
    c.stroke();
  }
  function line(c, x1, y1, x2, y2) {
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    c.stroke();
  }
  function tag(c, text, x, y, size) {
    c.save();
    c.fillStyle = SOFT;
    c.font = `600 ${size}px system-ui, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, x, y);
    c.restore();
  }
  const tagSize = (w, d) => Math.max(2, Math.min(w, d) * 0.2);

  function basin(c, x, y, rx, ry) {
    ellipse(c, x, y, rx, ry, TINT);
    ellipse(c, x, y, Math.min(rx, ry) * 0.12, Math.min(rx, ry) * 0.12);
    line(c, x, y - ry - Math.min(ry * 0.25, 2), x, y - ry * 0.55); // faucet
  }

  const draw = {
    toilet(c, w, d) {
      const tank = Math.min(d * 0.27, 8);
      box(c, -w / 2, -d / 2, w, tank, 1.5);
      const bowlH = d - tank - 1;
      const cy = -d / 2 + tank + 1 + bowlH / 2;
      ellipse(c, 0, cy, w * 0.46, bowlH / 2);
      ellipse(c, 0, cy + bowlH * 0.03, w * 0.3, bowlH * 0.34, TINT);
    },
    vanity(c, w, d) {
      box(c, -w / 2, -d / 2, w, d, 0.5);
      basin(c, 0, 0.5, Math.min(w * 0.3, 8), Math.min(d * 0.3, 6));
    },
    double_vanity(c, w, d) {
      box(c, -w / 2, -d / 2, w, d, 0.5);
      for (const x of [-w / 4, w / 4]) basin(c, x, 0.5, Math.min(w * 0.14, 8), Math.min(d * 0.3, 6));
    },
    bathtub(c, w, d) {
      box(c, -w / 2, -d / 2, w, d, 1);
      box(c, -w / 2 + 3, -d / 2 + 3, w - 6, d - 6, Math.min(w, d) * 0.3, TINT);
      ellipse(c, w / 2 - 8, 0, 1.2, 1.2);
    },
    shower(c, w, d) {
      box(c, -w / 2, -d / 2, w, d, 0.5);
      box(c, -w / 2 + 2, -d / 2 + 2, w - 4, d - 4, 1, TINT);
      c.save();
      c.strokeStyle = SOFT;
      line(c, -w / 2 + 2, -d / 2 + 2, w / 2 - 2, d / 2 - 2);
      line(c, w / 2 - 2, -d / 2 + 2, -w / 2 + 2, d / 2 - 2);
      c.restore();
      ellipse(c, 0, 0, 1.5, 1.5, FILL);
    },
    stove(c, w, d) {
      box(c, -w / 2, -d / 2, w, d, 0.5);
      const strip = Math.min(d * 0.14, 3.5);
      line(c, -w / 2, -d / 2 + strip, w / 2, -d / 2 + strip);
      const cols = w >= 42 ? 3 : 2;
      const r = Math.min((w / cols) * 0.3, (d - strip) * 0.15);
      for (let i = 0; i < cols; i++) {
        const x = -w / 2 + ((i + 0.5) * w) / cols;
        for (const y of [-d / 2 + strip + (d - strip) * 0.27, -d / 2 + strip + (d - strip) * 0.73]) {
          ellipse(c, x, y, r, r);
          ellipse(c, x, y, r * 0.45, r * 0.45);
        }
      }
    },
    fridge(c, w, d) {
      box(c, -w / 2, -d / 2, w, d, 0.5, TINT);
      line(c, -w / 2, d / 2 - 3, w / 2, d / 2 - 3);
      if (w >= 33) line(c, 0, d / 2 - 3, 0, d / 2);
      tag(c, 'REF', 0, -1.5, tagSize(w, d));
    },
    kitchen_sink(c, w, d) {
      box(c, -w / 2, -d / 2, w, d, 0.5);
      const gap = 1.5, inset = 2;
      const bw = w >= 30 ? (w - inset * 2 - gap) / 2 : w - inset * 2;
      const by = -d / 2 + 5;
      box(c, -w / 2 + inset, by, bw, d - 7, 1, TINT);
      if (w >= 30) box(c, -w / 2 + inset + bw + gap, by, bw, d - 7, 1, TINT);
      ellipse(c, 0, -d / 2 + 2.5, 0.9, 0.9);
    },
    dishwasher(c, w, d) {
      box(c, -w / 2, -d / 2, w, d, 0.5);
      c.save();
      c.setLineDash([2, 1.5]);
      line(c, -w / 2 + 1.5, d / 2 - 2.5, w / 2 - 1.5, d / 2 - 2.5);
      c.restore();
      tag(c, 'DW', 0, -1.5, tagSize(w, d));
    },
    base_cabinet(c, w, d) {
      box(c, -w / 2, -d / 2, w, d, 0, FILL);
      c.save();
      c.strokeStyle = SOFT;
      line(c, -w / 2, -d / 2, w / 2, d / 2);
      line(c, w / 2, -d / 2, -w / 2, d / 2);
      c.restore();
    },
    upper_cabinet(c, w, d) {
      c.save();
      c.setLineDash([2.5, 1.5]);
      rrect(c, -w / 2, -d / 2, w, d, 0);
      c.stroke();
      line(c, -w / 2, -d / 2, w / 2, d / 2);
      c.restore();
    },
    island(c, w, d) {
      box(c, -w / 2, -d / 2, w, d, 1);
      c.save();
      c.setLineDash([2.5, 1.5]);
      rrect(c, -w / 2 + 3, -d / 2 + 3, w - 6, d - 12 > 6 ? d - 12 : d - 6, 0);
      c.stroke();
      c.restore();
    },
    bed(c, w, d) {
      box(c, -w / 2, -d / 2, w, d, 2);
      const pillows = w >= 50 ? 2 : 1;
      const pw = (w - 6 - (pillows - 1) * 2) / pillows;
      for (let i = 0; i < pillows; i++) {
        box(c, -w / 2 + 3 + i * (pw + 2), -d / 2 + 2.5, pw, Math.min(d * 0.18, 15), 3, TINT);
      }
      const fold = -d / 2 + Math.min(d * 0.3, 26);
      line(c, -w / 2, fold, w / 2, fold);
      line(c, -w / 2, fold + 2.5, w / 2, fold + 2.5);
    },
    nightstand(c, w, d) {
      box(c, -w / 2, -d / 2, w, d, 0.5);
      ellipse(c, 0, 0, Math.min(w, d) * 0.28, Math.min(w, d) * 0.28, TINT);
    },
    dresser(c, w, d) {
      box(c, -w / 2, -d / 2, w, d, 0.5);
      line(c, -w / 2, d / 2 - 2.5, w / 2, d / 2 - 2.5);
      const n = Math.max(2, Math.round(w / 18));
      for (let i = 1; i < n; i++) line(c, -w / 2 + (i * w) / n, d / 2 - 2.5, -w / 2 + (i * w) / n, d / 2);
    },
    sofa(c, w, d) {
      const back = Math.min(d * 0.24, 9);
      const arm = Math.min(w * 0.11, 8);
      box(c, -w / 2, -d / 2, w, d, 2.5, TINT);
      const seats = w >= 76 ? 3 : w >= 50 ? 2 : 1;
      const sw = (w - arm * 2) / seats;
      for (let i = 0; i < seats; i++) box(c, -w / 2 + arm + i * sw, -d / 2 + back, sw, d - back - 1, 1.5);
    },
    dining_table(c, w, d) {
      box(c, -w / 2, -d / 2, w, d, 1);
      c.save();
      c.strokeStyle = SOFT;
      const seats = Math.max(1, Math.round(w / 30));
      for (let i = 0; i < seats; i++) {
        const x = -w / 2 + ((i + 0.5) * w) / seats;
        for (const y of [-d / 2 - 3, d / 2 + 3]) {
          rrect(c, x - 7, y - 3, 14, 6, 1.5);
          c.stroke();
        }
      }
      c.restore();
    },
    washer(c, w, d) {
      box(c, -w / 2, -d / 2, w, d, 1);
      line(c, -w / 2, -d / 2 + 4, w / 2, -d / 2 + 4);
      ellipse(c, 0, 2, Math.min(w, d) * 0.32, Math.min(w, d) * 0.32, TINT);
      tag(c, 'W', 0, 2, tagSize(w, d));
    },
    dryer(c, w, d) {
      box(c, -w / 2, -d / 2, w, d, 1);
      line(c, -w / 2, -d / 2 + 4, w / 2, -d / 2 + 4);
      ellipse(c, 0, 2, Math.min(w, d) * 0.32, Math.min(w, d) * 0.32, TINT);
      tag(c, 'D', 0, 2, tagSize(w, d));
    },
    gas_fireplace(c, w, d) {
      // Unit body, a firebox narrowing toward the back, glass across the front and a hearth line.
      box(c, -w / 2, -d / 2, w, d, 0.5);
      const back = -d / 2 + Math.min(d * 0.15, 3);
      const front = d / 2 - Math.min(d * 0.18, 4);
      const bw = w * 0.32, fw = w * 0.42;
      c.beginPath();
      c.moveTo(-bw, back); c.lineTo(bw, back); c.lineTo(fw, front); c.lineTo(-fw, front);
      c.closePath();
      c.fillStyle = TINT;
      c.fill();
      c.stroke();
      line(c, -w / 2, front, w / 2, front);
      tag(c, 'GAS', 0, (back + front) / 2, tagSize(w * 0.6, front - back));
    },
    generic(c, w, d) {
      box(c, -w / 2, -d / 2, w, d, 0.5);
      line(c, -w / 2, -d / 2 + 1.5, w / 2, -d / 2 + 1.5);
    },
  };

  const S = (label, w, d) => ({ label, w, d });
  const widths = (list, d, suffix) => list.map((w) => S(`${w}"${suffix || ''}`, w, d));

  const KINDS = {
    toilet: { name: 'Toilet', group: 'Bathroom', sizes: [S('Compact', 18, 26), S('Round', 19, 28), S('Elongated', 20, 30)], def: 2 },
    vanity: { name: 'Vanity Sink', group: 'Bathroom', sizes: widths([24, 30, 36, 42, 48], 21), def: 1 },
    double_vanity: { name: 'Double Sink', group: 'Bathroom', sizes: widths([60, 66, 72, 84], 22), def: 0 },
    bathtub: { name: 'Bathtub', group: 'Bathroom', sizes: [S('54 x 30', 54, 30), S('60 x 30', 60, 30), S('60 x 32', 60, 32), S('66 x 32', 66, 32), S('72 x 36', 72, 36)], def: 1 },
    shower: { name: 'Shower', group: 'Bathroom', sizes: [S('32 x 32', 32, 32), S('36 x 36', 36, 36), S('42 x 36', 42, 36), S('48 x 36', 48, 36), S('60 x 36', 60, 36)], def: 1 },
    stove: { name: 'Stove', group: 'Kitchen', sizes: widths([24, 30, 36, 48], 26), def: 1 },
    fridge: { name: 'Refrigerator', group: 'Kitchen', sizes: widths([24, 30, 33, 36, 42], 30), def: 3 },
    kitchen_sink: { name: 'Kitchen Sink', group: 'Kitchen', sizes: widths([24, 30, 33, 36], 22), def: 2 },
    dishwasher: { name: 'Dishwasher', group: 'Kitchen', sizes: widths([18, 24], 24), def: 1 },
    base_cabinet: { name: 'Base Cabinet', group: 'Kitchen', sizes: widths([9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 42, 48], 24), def: 9 },
    upper_cabinet: { name: 'Upper Cabinet', group: 'Kitchen', sizes: widths([9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 42, 48], 12), def: 9 },
    island: { name: 'Island', group: 'Kitchen', sizes: [S('48 x 24', 48, 24), S('48 x 36', 48, 36), S('72 x 36', 72, 36), S('84 x 42', 84, 42), S('96 x 42', 96, 42)], def: 2 },
    bed: { name: 'Bed', group: 'Bedroom', sizes: [S('Twin', 38, 75), S('Twin XL', 38, 80), S('Full', 54, 75), S('Queen', 60, 80), S('King', 76, 80), S('California King', 72, 84)], def: 3 },
    nightstand: { name: 'Nightstand', group: 'Bedroom', sizes: [S('20 x 16', 20, 16), S('24 x 18', 24, 18), S('30 x 18', 30, 18)], def: 1 },
    dresser: { name: 'Dresser', group: 'Bedroom', sizes: widths([36, 48, 60, 72], 18), def: 2 },
    sofa: { name: 'Sofa', group: 'Living & Laundry', sizes: [S('Loveseat', 60, 36), S('Standard', 84, 36), S('Large', 96, 38)], def: 1 },
    gas_fireplace: { name: 'Gas Fireplace', group: 'Living & Laundry', sizes: [S('36"', 36, 20), S('42"', 42, 22), S('48"', 48, 22), S('Linear 60"', 60, 20), S('Linear 72"', 72, 20)], def: 1 },
    dining_table: { name: 'Dining Table', group: 'Living & Laundry', sizes: [S('Square 36', 36, 36), S('48 x 30', 48, 30), S('60 x 36', 60, 36), S('72 x 36', 72, 36), S('84 x 40', 84, 40)], def: 2 },
    washer: { name: 'Washer', group: 'Living & Laundry', sizes: [S('Compact', 24, 24), S('Standard', 27, 30), S('Large', 29, 32)], def: 1 },
    dryer: { name: 'Dryer', group: 'Living & Laundry', sizes: [S('Compact', 24, 24), S('Standard', 27, 30), S('Large', 29, 32)], def: 1 },
    generic: { name: 'Blank Fixture', group: null, sizes: [], def: 0, fallback: { w: 36, d: 24 } },
  };

  const GROUPS = ['Bathroom', 'Kitchen', 'Bedroom', 'Living & Laundry'];

  function defaultSize(kind) {
    const k = KINDS[kind] || KINDS.generic;
    return k.sizes[k.def] || k.fallback;
  }

  // Index of the standard size matching w x d, or -1 for a custom size.
  function matchSize(kind, w, d) {
    const k = KINDS[kind] || KINDS.generic;
    return k.sizes.findIndex((s) => Math.abs(s.w - w) < 0.01 && Math.abs(s.d - d) < 0.01);
  }

  // Draws at the current transform, which must be in inches centred on the fixture.
  function drawSymbol(c, kind, w, d, lineWidth, colors) {
    if (colors) {
      INK = colors.fixInk; SOFT = colors.fixSoft; FILL = colors.fixFill; TINT = colors.fixTint;
    }
    c.lineWidth = lineWidth;
    c.strokeStyle = INK;
    c.setLineDash([]);
    (draw[kind] || draw.generic)(c, w, d);
  }

  FP.fixtures = { KINDS, GROUPS, defaultSize, matchSize, drawSymbol };
})(globalThis);
