// Image and PDF export. PDFs are written directly with no libraries: each page holds one
// high-resolution image, placed at exact physical size so true-scale prints measure correctly.
(function (root) {
  const FP = (root.FP = root.FP || {});
  const M = FP.model, Rn = FP.render, app = FP.app;

  const PAPERS = {
    letter: { name: 'Letter (8.5 x 11")', w: 8.5, h: 11 },
    legal: { name: 'Legal (8.5 x 14")', w: 8.5, h: 14 },
    tabloid: { name: 'Tabloid (11 x 17")', w: 11, h: 17 },
    archC: { name: 'Arch C (18 x 24")', w: 18, h: 24 },
    archD: { name: 'Arch D (24 x 36")', w: 24, h: 36 },
    a4: { name: 'A4', w: 8.27, h: 11.69 },
    a3: { name: 'A3', w: 11.69, h: 16.54 },
  };
  // value: paper inches per real foot
  const SCALES = [
    { id: '1/8', label: '1/8" = 1\'', value: 0.125 },
    { id: '3/16', label: '3/16" = 1\'', value: 0.1875 },
    { id: '1/4', label: '1/4" = 1\'', value: 0.25 },
    { id: '3/8', label: '3/8" = 1\'', value: 0.375 },
    { id: '1/2', label: '1/2" = 1\'', value: 0.5 },
    { id: '1', label: '1" = 1\'', value: 1 },
  ];
  const MARGIN = 0.5;
  const TITLE_H = 0.55;
  const MAX_PDF_PIXELS = 60e6;
  const MAX_IMAGE_SIDE = 16000;
  const MAX_IMAGE_PIXELS = 120e6;

  // A design option's stand-in floor (FP.options.view) carries the real floor in .real.
  const realOf = (floor) => (floor && floor.real) || floor;

  // What the floor's design option changes from as-is, when changes are shown.
  function changesOf(o, floor) {
    if (!floor || o.changes === false) return null;
    const isOption = floor.real ? !floor.id.endsWith('~asis') : !!(floor.option && floor.asIs);
    if (!isOption) return null;
    const base = FP.options.view(realOf(floor), null);
    return base === floor ? null : { floor: base, geo: app.geo(base) };
  }

  function seenStairs(floor) {
    if (!floor) return undefined;
    const own = (floor.stairs || []).map((st) => ({ st, mode: st.goes === 'down' ? 'down' : 'up', own: true }));
    return [...own, ...M.stairsSeen(app.doc, realOf(floor)).filter((x) => !x.own)];
  }

  function floorOptions(o, width, height, floor) {
    const s = app.settings();
    return {
      width, height, units: s.units, gridSize: s.gridSize,
      showGrid: !!o.grid, showLengths: !!o.lengths, bothFaces: s.bothFaces, showRooms: !!o.rooms,
      showFixtures: o.fixtures !== false, showDims: o.dims !== false, showLabels: o.labels !== false, showGuides: !!o.guides,
      transparent: !!o.transparent, ghost: null, stairs: seenStairs(floor), changes: changesOf(o, floor),
    };
  }

  function boundsOf(floor, o) {
    let b = M.floorBounds(floor, app.geo(floor), !!(o && o.guides));
    // Stairs from the floors above and below that arrive here are part of this floor's picture too.
    for (const { st } of M.stairsSeen(app.doc, realOf(floor)).filter((x) => !x.own)) {
      for (const poly of FP.stairs.geometry(st).polys) {
        for (const p of poly) {
          b = b ? { minX: Math.min(b.minX, p.x), minY: Math.min(b.minY, p.y), maxX: Math.max(b.maxX, p.x), maxY: Math.max(b.maxY, p.y) } : { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
        }
      }
    }
    if (!b) return null;
    const pad = 12;
    return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad, w: b.maxX - b.minX + pad * 2, h: b.maxY - b.minY + pad * 2 };
  }

  // ---------- Image ----------

  function imageSize(floor, pxPerIn, o) {
    const b = boundsOf(floor, o);
    if (!b) return null;
    let s = pxPerIn;
    s = Math.min(s, MAX_IMAGE_SIDE / b.w, MAX_IMAGE_SIDE / b.h, Math.sqrt(MAX_IMAGE_PIXELS / (b.w * b.h)));
    return { b, s, w: Math.ceil(b.w * s), h: Math.ceil(b.h * s), limited: s < pxPerIn };
  }

  function renderImage(floor, o) {
    const size = imageSize(floor, o.pxPerIn, o);
    if (!size) return null;
    const canvas = document.createElement('canvas');
    canvas.width = size.w;
    canvas.height = size.h;
    const c = canvas.getContext('2d');
    const R = Rn.makeR(c, size.s, -size.b.minX * size.s, -size.b.minY * size.s, Math.max(1, o.pxPerIn / 3));
    Rn.drawPlan(R, floor, app.geo(floor), floorOptions(o, size.w, size.h, floor));
    return canvas;
  }

  // ---------- PDF page layout ----------

  function pageSize(o, floor) {
    const paper = PAPERS[o.paper] || PAPERS.letter;
    let landscape = o.orientation === 'landscape';
    if (o.orientation === 'auto') {
      const b = floor && boundsOf(floor, o);
      landscape = b ? b.w >= b.h : true;
    }
    return landscape ? { w: Math.max(paper.w, paper.h), h: Math.min(paper.w, paper.h) } : { w: Math.min(paper.w, paper.h), h: Math.max(paper.w, paper.h) };
  }

  const usable = (page) => ({ w: page.w - MARGIN * 2, h: page.h - MARGIN * 2 - TITLE_H });

  // Paper inches per real inch. Fit uses one scale across floors so they stay comparable.
  function resolveScale(o, floors) {
    if (o.scale !== 'fit') {
      const s = SCALES.find((x) => x.id === o.scale) || SCALES[2];
      return s.value / 12;
    }
    let best = Infinity;
    for (const floor of floors) {
      const b = boundsOf(floor, o);
      if (!b) continue;
      const area = usable(pageSize(o, floor));
      best = Math.min(best, area.w / b.w, area.h / b.h);
    }
    return best === Infinity ? 1 / 48 : best;
  }

  function scaleName(paperPerInch) {
    const perFoot = paperPerInch * 12;
    const match = SCALES.find((s) => Math.abs(s.value - perFoot) < 1e-6);
    return match ? match.label : `Fit to page (about 1" = ${(1 / perFoot).toFixed(1)}')`;
  }

  // Returns a warning if a true scale will not fit, naming the largest scale that does.
  function fitWarning(o, floors) {
    if (o.scale === 'fit') return null;
    const s = resolveScale(o, floors);
    for (const floor of floors) {
      const b = boundsOf(floor, o);
      if (!b) continue;
      const area = usable(pageSize(o, floor));
      if (b.w * s > area.w + 1e-6 || b.h * s > area.h + 1e-6) {
        const fits = SCALES.filter((x) => (b.w * x.value) / 12 <= area.w && (b.h * x.value) / 12 <= area.h);
        const best = fits.length ? fits[fits.length - 1].label : null;
        return `"${floor.name}" is ${(b.w * s).toFixed(1)}" x ${(b.h * s).toFixed(1)}" at this scale, too big for the printable area (${area.w.toFixed(1)}" x ${area.h.toFixed(1)}"), so it would be cut off. ${best ? `The largest scale that fits is ${best}.` : 'Try larger paper.'}`;
      }
    }
    return null;
  }

  function drawPage(c, floor, o, page, paperPerInch, dpi, pageNo, pageCount, label) {
    const W = Math.round(page.w * dpi), H = Math.round(page.h * dpi);
    const unit = dpi / 96;
    const area = usable(page);
    const pxPerIn = dpi * paperPerInch;
    const b = boundsOf(floor, o);
    const cx = b ? (b.minX + b.maxX) / 2 : 0, cy = b ? (b.minY + b.maxY) / 2 : 0;
    const ox = (MARGIN + area.w / 2) * dpi - cx * pxPerIn;
    const oy = (MARGIN + area.h / 2) * dpi - cy * pxPerIn;
    const R = Rn.makeR(c, pxPerIn, ox, oy, unit);

    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, W, H);
    c.save();
    c.beginPath();
    c.rect(MARGIN * dpi, MARGIN * dpi, area.w * dpi, area.h * dpi);
    c.clip();
    Rn.drawPlan(R, floor, app.geo(floor), floorOptions(o, W, H, floor));
    c.restore();

    // Title strip with scale bar.
    c.setTransform(1, 0, 0, 1, 0, 0);
    const y = (page.h - MARGIN - TITLE_H) * dpi + 0.12 * dpi;
    const left = MARGIN * dpi, right = (page.w - MARGIN) * dpi;
    c.strokeStyle = '#1e2530';
    c.lineWidth = unit;
    c.beginPath();
    c.moveTo(left, y);
    c.lineTo(right, y);
    c.stroke();
    c.fillStyle = '#1e2530';
    c.textBaseline = 'top';
    c.textAlign = 'left';
    c.font = `600 ${12 * unit}px system-ui, sans-serif`;
    c.fillText(`${app.doc.name} - ${floor.name}${label ? ` - ${label}` : ''}`, left, y + 0.08 * dpi);
    c.font = `${9.5 * unit}px system-ui, sans-serif`;
    c.fillStyle = '#5d6775';
    c.fillText(`Scale: ${scaleName(paperPerInch)}`, left, y + 0.26 * dpi);
    c.textAlign = 'right';
    c.fillText(`${new Date().toLocaleDateString()}${pageCount > 1 ? `   Page ${pageNo} of ${pageCount}` : ''}`, right, y + 0.26 * dpi);

    // Scale bar: the largest round length that stays under about 2.2 paper inches.
    const feet = [1, 2, 5, 10, 20, 50, 100].filter((f) => f * 12 * paperPerInch <= 2.2).pop() || 1;
    const barW = feet * 12 * pxPerIn;
    const barX = right - barW, barY = y + 0.13 * dpi, barH = 0.05 * dpi;
    c.fillStyle = '#1e2530';
    for (let i = 0; i < 2; i++) {
      if (i % 2 === 0) c.fillRect(barX, barY, barW / 2, barH);
    }
    c.strokeRect(barX, barY, barW, barH);
    c.textAlign = 'center';
    c.textBaseline = 'bottom';
    c.font = `${8.5 * unit}px system-ui, sans-serif`;
    c.fillText("0", barX, barY - 0.01 * dpi);
    c.fillText(`${feet}'`, barX + barW, barY - 0.01 * dpi);
  }

  // ---------- PDF file writing ----------

  async function deflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function pageImage(canvas) {
    if (typeof CompressionStream === 'function') {
      const { width, height } = canvas;
      const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
      const rgb = new Uint8Array(width * height * 3);
      for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
        rgb[j] = data[i]; rgb[j + 1] = data[i + 1]; rgb[j + 2] = data[i + 2];
      }
      return { width, height, filter: 'FlateDecode', bytes: await deflate(rgb) };
    }
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.95));
    return { width: canvas.width, height: canvas.height, filter: 'DCTDecode', bytes: new Uint8Array(await blob.arrayBuffer()) };
  }

  function writePdf(pages) {
    const enc = new TextEncoder();
    const chunks = [];
    let offset = 0;
    const offsets = [];
    const put = (x) => {
      const b = typeof x === 'string' ? enc.encode(x) : x;
      chunks.push(b);
      offset += b.length;
    };
    put('%PDF-1.4\n');
    put(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
    const object = (id, body) => { offsets[id] = offset; put(`${id} 0 obj\n${body}\nendobj\n`); };

    const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
    object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    object(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
    pages.forEach((p, i) => {
      const pageId = 3 + i * 3, contentId = pageId + 1, imageId = pageId + 2;
      const wPt = (p.wIn * 72).toFixed(2), hPt = (p.hIn * 72).toFixed(2);
      object(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`);
      const content = `q ${wPt} 0 0 ${hPt} 0 0 cm /Im0 Do Q`;
      object(contentId, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      offsets[imageId] = offset;
      put(`${imageId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.image.width} /Height ${p.image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /${p.image.filter} /Length ${p.image.bytes.length} >>\nstream\n`);
      put(p.image.bytes);
      put('\nendstream\nendobj\n');
    });

    const count = 3 + pages.length * 3;
    const xref = offset;
    put(`xref\n0 ${count}\n0000000000 65535 f \n`);
    for (let id = 1; id < count; id++) put(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
    put(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(chunks, { type: 'application/pdf' });
  }

  // A floor's open design option, or "As-is" when it has options but none is open.
  function optionLabel(floor) {
    const opt = FP.options.active(floor);
    return opt ? opt.name : (floor.options || []).length ? 'As-is' : '';
  }

  // The pages to print: [{ floor, label }]. With allOptions, a floor with design options
  // prints its as-is plan and then each option.
  function selectedPages(o) {
    const pages = [];
    for (const f of o.allFloors ? app.doc.floors : [app.floor()]) {
      if (o.allOptions && (f.options || []).length) {
        pages.push({ floor: FP.options.view(f, null), label: 'As-is' });
        for (const opt of f.options) pages.push({ floor: FP.options.view(f, opt.id), label: opt.name });
      } else pages.push({ floor: f, label: optionLabel(f) });
    }
    return pages;
  }

  async function buildPdf(o) {
    const list = selectedPages(o);
    const floors = list.map((p) => p.floor);
    const paperPerInch = resolveScale(o, floors);
    const pages = [];
    for (let i = 0; i < floors.length; i++) {
      const page = pageSize(o, floors[i]);
      const dpi = Math.min(300, Math.sqrt(MAX_PDF_PIXELS / (page.w * page.h)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(page.w * dpi);
      canvas.height = Math.round(page.h * dpi);
      drawPage(canvas.getContext('2d'), floors[i], o, page, paperPerInch, dpi, i + 1, floors.length, list[i].label);
      pages.push({ wIn: page.w, hIn: page.h, image: await pageImage(canvas) });
      canvas.width = canvas.height = 0;
    }
    return writePdf(pages);
  }

  async function buildImage(o) {
    const canvas = renderImage(app.floor(), { ...o, transparent: o.format === 'png' && o.transparent });
    if (!canvas) return null;
    const type = o.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    return new Promise((res) => canvas.toBlob(res, type, 0.95));
  }

  // ---------- Dialog ----------

  const $ = (id) => document.getElementById(id);

  function readOptions() {
    const format = $('exFormat').value;
    return {
      format,
      allFloors: format === 'pdf' && $('exAllFloors').checked,
      allOptions: format === 'pdf' && $('exAllOptions').checked,
      changes: $('exChanges').checked,
      paper: $('exPaper').value,
      orientation: $('exOrientation').value,
      scale: $('exScale').value,
      pxPerIn: parseFloat($('exResolution').value),
      transparent: $('exTransparent').checked,
      grid: $('exGrid').checked,
      lengths: $('exLengths').checked,
      rooms: $('exRooms').checked,
      fixtures: $('exFixtures').checked,
      dims: $('exDims').checked,
      labels: $('exLabels').checked,
      guides: $('exGuides').checked,
    };
  }

  function updatePreview() {
    const o = readOptions();
    const isPdf = o.format === 'pdf';
    document.querySelectorAll('#exportDialog .pdf-only').forEach((el) => { el.hidden = !isPdf; });
    document.querySelectorAll('#exportDialog .image-only').forEach((el) => { el.hidden = isPdf; });
    $('exTransparentRow').hidden = o.format !== 'png';
    const hasOptions = app.doc.floors.some((f) => (f.options || []).length);
    $('exChangesRow').hidden = !hasOptions;
    if (!hasOptions || !isPdf) $('exAllOptionsRow').hidden = true;

    const canvas = $('exPreview');
    const c = canvas.getContext('2d');
    const floor = app.floor();
    const note = $('exNote');
    note.className = 'export-note';
    note.textContent = '';
    if (isPdf) {
      const list = selectedPages(o);
      const floors = list.map((p) => p.floor);
      const page = pageSize(o, floors[0]);
      const dpi = Math.min(440 / page.w, 300 / page.h);
      canvas.width = Math.round(page.w * dpi);
      canvas.height = Math.round(page.h * dpi);
      drawPage(c, floors[0], o, page, resolveScale(o, floors), dpi, 1, floors.length, list[0].label);
      const warning = fitWarning(o, floors);
      if (warning) { note.textContent = warning; note.className = 'export-note warn'; }
      else note.textContent = `${floors.length} page${floors.length > 1 ? 's' : ''}. Scale: ${scaleName(resolveScale(o, floors))}. Print at 100% ("Actual size") for true scale.`;
    } else {
      const size = imageSize(floor, o.pxPerIn, o);
      if (!size) {
        canvas.width = 440; canvas.height = 200;
        c.fillStyle = '#fff';
        c.fillRect(0, 0, 440, 200);
        note.textContent = 'This floor is empty.';
        return;
      }
      const k = Math.min(440 / size.b.w, 300 / size.b.h);
      canvas.width = Math.ceil(size.b.w * k);
      canvas.height = Math.ceil(size.b.h * k);
      const R = Rn.makeR(c, k, -size.b.minX * k, -size.b.minY * k, Math.max(0.5, k / Math.max(o.pxPerIn / 3, 1)));
      Rn.drawPlan(R, floor, app.geo(floor), floorOptions({ ...o, transparent: false }, canvas.width, canvas.height, floor));
      note.textContent = `${size.w} x ${size.h} pixels${size.limited ? ' (reduced to the maximum image size)' : ''}.`;
    }
  }

  function exportName(ext) {
    const base = (app.doc.name || 'floorplan').replace(/[\\/:*?"<>|]+/g, '-');
    return `${base}.${ext}`;
  }

  async function runExport() {
    const o = readOptions();
    const button = $('exGo');
    button.disabled = true;
    button.textContent = 'Exporting...';
    try {
      if (o.format === 'pdf') {
        FP.fileio.download(await buildPdf(o), exportName('pdf'));
      } else {
        const blob = await buildImage(o);
        if (!blob) { app.toast('This floor is empty, so there is nothing to export.', true); return; }
        FP.fileio.download(blob, exportName(o.format === 'jpeg' ? 'jpg' : 'png'));
      }
      $('exportDialog').close();
      app.toast('Export finished.');
    } catch (err) {
      app.toast(`Export failed: ${err.message}`, true);
    } finally {
      button.disabled = false;
      button.textContent = 'Export';
    }
  }

  function initDialog() {
    const fill = (sel, items) => {
      for (const [value, label] of items) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        sel.appendChild(opt);
      }
    };
    fill($('exPaper'), Object.entries(PAPERS).map(([k, p]) => [k, p.name]));
    fill($('exScale'), [['fit', 'Fit to page'], ...SCALES.map((s) => [s.id, s.label])]);
    const dialog = $('exportDialog');
    dialog.addEventListener('input', updatePreview);
    $('exGo').addEventListener('click', runExport);
    $('exCancel').addEventListener('click', () => dialog.close());
  }

  function openDialog() {
    const pref = FP.prefs.get().export;
    $('exPaper').value = pref.paper;
    $('exOrientation').value = pref.orientation;
    $('exScale').value = pref.scale;
    $('exportDialog').showModal();
    updatePreview();
  }

  FP.exporter = { PAPERS, SCALES, initDialog, openDialog, buildPdf, selectedPages, buildImage, renderImage, fitWarning, resolveScale, updatePreview };
})(globalThis);
