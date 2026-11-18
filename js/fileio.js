// Saving and reopening drawings as .fplan files (JSON). This is separate from image/PDF export.
(function (root) {
  const FP = (root.FP = root.FP || {});
  const M = FP.model, app = FP.app;
  const EXT = '.fplan';
  const PICKER_TYPES = [{ description: 'FloorPlanner drawing', accept: { 'application/json': [EXT] } }];

  const hasPicker = () => typeof window.showSaveFilePicker === 'function';
  const baseName = (name) => name.replace(/\.[^.]+$/, '');

  function serialize() {
    return JSON.stringify(M.serializeDoc(app.doc), null, 1);
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // Hands a finished export over: on a phone, the share sheet (Messages, email, Files and so
  // on) where the browser has one; otherwise an ordinary download. Returns 'shared',
  // 'downloaded', 'cancelled', or 'blocked' when the browser wants a fresh tap before it will
  // open the share sheet (building a PDF can take longer than it allows), so call again from
  // the next click.
  async function deliver(blob, filename) {
    const nav = root.navigator;
    const canShareFiles = FP.device && FP.device.phone && nav && typeof nav.share === 'function' &&
      typeof nav.canShare === 'function' && typeof File === 'function';
    if (canShareFiles) {
      const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
      let ok = false;
      try { ok = nav.canShare({ files: [file] }); } catch (err) { ok = false; }
      if (ok) {
        try {
          await nav.share({ files: [file], title: filename });
          return 'shared';
        } catch (err) {
          if (err && err.name === 'AbortError') return 'cancelled';
          if (err && err.name === 'NotAllowedError') return 'blocked';
          // Anything else: the share sheet isn't usable, so download instead.
        }
      }
    }
    // Through the module's own entry, so tests can stand in for a real download.
    FP.fileio.download(blob, filename);
    return 'downloaded';
  }

  function markSaved(name) {
    app.fileName = name;
    app.doc.name = baseName(name);
    app.setDirty(false);
    app.saveSession();
    app.toast(`Saved ${name}`);
  }

  async function writeHandle(handle) {
    const writable = await handle.createWritable();
    await writable.write(serialize());
    await writable.close();
    app.fileHandle = handle;
    app.needsPermission = false;
    rememberHandle(handle);
    markSaved(handle.name);
  }

  // ---------- Reopening the drawing after a refresh ----------

  // The save file's handle is kept in IndexedDB, the only browser storage that can hold one.
  const DB_NAME = 'floorplanner', STORE = 'handles', HANDLE_KEY = 'current';

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!root.indexedDB) { reject(new Error('IndexedDB is unavailable')); return; }
      const req = root.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function withStore(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  function withTimeout(promise, ms) {
    let timer;
    const late = new Promise((r) => { timer = setTimeout(() => r(null), ms); });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
  }

  let handleStore = {
    put: (h) => withStore('readwrite', (s) => (h ? s.put(h, HANDLE_KEY) : s.delete(HANDLE_KEY))),
    get: () => withStore('readonly', (s) => s.get(HANDLE_KEY)),
  };
  // Tests swap in a store of their own.
  const setHandleStore = (store) => { handleStore = store; remembered = undefined; };

  // Only touches storage when the link actually changes, since every New and Open calls this.
  let remembered;
  function rememberHandle(handle) {
    const next = handle || null;
    if (next === remembered) return Promise.resolve();
    remembered = next;
    return withTimeout(Promise.resolve().then(() => handleStore.put(next)).catch(() => {}), 2000);
  }

  function recallHandle() {
    return withTimeout(Promise.resolve().then(() => handleStore.get()).catch(() => null), 2000).then((h) => h || null);
  }

  // Puts the drawing from the last session back, reconnected to its save file when possible.
  async function restoreSession(session, handle) {
    const view = session.view;
    const linked = handle && session.hasHandle && handle.name === session.fileName ? handle : null;
    app.loadDoc(session.doc, linked, session.fileName);
    if (view && Number.isFinite(view.scale) && Number.isFinite(view.ox) && Number.isFinite(view.oy)) {
      Object.assign(app.view, { scale: Math.max(0.2, Math.min(40, view.scale)), ox: view.ox, oy: view.oy });
      if (['show', 'fade', 'hide'].includes(view.stairs)) app.view.stairs = view.stairs;
      if (typeof view.changes === 'boolean') app.view.changes = view.changes;
      app.emit('view');
      app.requestRender();
    }
    if (session.dirty) {
      app.setDirty(true);
      app.saveSession();
      if (!linked) app.toast('Restored your unsaved work from last time.');
    }
    if (linked) await reconnect(false);
  }

  // Checks, or with a click asks for, permission to keep writing to the save file. Browsers
  // usually forget that permission when the page reloads.
  let asking = false;
  async function reconnect(ask) {
    const handle = app.fileHandle;
    if (!handle || asking) return;
    asking = true;
    try {
      let state = handle.queryPermission ? await handle.queryPermission({ mode: 'readwrite' }) : 'granted';
      if (state !== 'granted' && ask && handle.requestPermission) state = await handle.requestPermission({ mode: 'readwrite' });
      if (handle !== app.fileHandle) return;
      app.needsPermission = state !== 'granted';
      app.emit('title');
      if (!app.needsPermission) await catchUp(handle);
    } catch (err) {
      app.needsPermission = true;
      app.emit('title');
    } finally {
      asking = false;
    }
  }

  // Once connected again: unsaved work goes to the file, and if there was none, a file that
  // changed while the page was closed is reloaded.
  async function catchUp(handle) {
    if (app.dirty) { autoSaveToFile(); return; }
    const text = await (await handle.getFile()).text();
    const onDisk = M.sanitizeDoc(JSON.parse(text));
    const same = (d) => JSON.stringify({ ...M.serializeDoc(M.sanitizeDoc(JSON.parse(JSON.stringify(M.serializeDoc(d))))), name: '', activeFloorId: '' });
    if (handle !== app.fileHandle || app.dirty || same(onDisk) === same(app.doc)) return;
    const view = { ...app.view };
    const floorId = app.doc.activeFloorId;
    onDisk.name = baseName(handle.name);
    if (onDisk.floors.some((f) => f.id === floorId)) onDisk.activeFloorId = floorId;
    app.loadDoc(onDisk, handle, handle.name);
    Object.assign(app.view, view);
    app.emit('view');
    app.requestRender();
    app.toast(`Reloaded ${handle.name}, because it was changed outside FloorPlanner.`);
  }

  // A click or key press is what lets the browser ask for permission, so the first one asks.
  function askOnFirstGesture() {
    const handler = () => { if (app.needsPermission && app.fileHandle) reconnect(true); };
    window.addEventListener('pointerdown', handler, true);
    window.addEventListener('keydown', handler, true);
  }

  // Save writes back to the file you opened. Save As, or a browser without file access,
  // creates a new file.
  async function save(asNew) {
    // A phone has nowhere to keep a file link, so a save is handed over like an export: the
    // share sheet (Files, Drive, email) where the browser allows it, or a download. Chrome on
    // Android won't share a drawing file at all (it refuses the type), and a save always comes
    // straight from a tap, so a refusal here means download it instead.
    if (FP.device && FP.device.phone) {
      const filename = `${(app.fileName && baseName(app.fileName)) || app.doc.name || 'floorplan'}${EXT}`;
      // Marked as plain data: Android adds .json to anything marked JSON, and the file would no
      // longer be a .fplan.
      const blob = new Blob([serialize()], { type: 'application/octet-stream' });
      let how = await FP.fileio.deliver(blob, filename);
      if (how === 'blocked') { FP.fileio.download(blob, filename); how = 'downloaded'; }
      if (how === 'shared' || how === 'downloaded') { markSaved(filename); return true; }
      return false;
    }
    try {
      if (!asNew && app.fileHandle) { await writeHandle(app.fileHandle); return true; }
      if (hasPicker()) {
        const handle = await window.showSaveFilePicker({
          suggestedName: (app.fileName && baseName(app.fileName)) || app.doc.name || 'floorplan',
          types: PICKER_TYPES,
        });
        await writeHandle(handle);
        return true;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return false;
      if (app.fileHandle && !asNew) { app.toast(`Could not save: ${err.message}`, true); return false; }
      // Otherwise fall through to a plain download, which works everywhere.
    }
    const filename = `${(app.fileName && baseName(app.fileName)) || app.doc.name || 'floorplan'}${EXT}`;
    download(new Blob([serialize()], { type: 'application/json' }), filename);
    markSaved(filename);
    return true;
  }

  // Writes to the established save file after a change. Quiet unless it can't write.
  let writing = false, writeAgain = false, warned = false;
  async function autoSaveToFile() {
    const handle = app.fileHandle;
    if (!handle || app.needsPermission) return; // the status bar already asks to reconnect
    if (writing) { writeAgain = true; return; }
    writing = true;
    const version = app.changeCount;
    try {
      // A timer can't show a permission prompt, so never let the write ask for one.
      if (handle.queryPermission && (await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
        throw new Error('permission was not granted');
      }
      const writable = await handle.createWritable();
      await writable.write(serialize());
      await writable.close();
      warned = false;
      // Only call it saved if nothing changed while the file was being written.
      if (handle === app.fileHandle && version === app.changeCount) {
        app.setDirty(false);
        app.saveSession();
      }
    } catch (err) {
      if (!warned) {
        warned = true;
        app.toast(`Auto-save couldn't write to ${handle.name}. Press Save to keep your changes.`, true);
      }
    } finally {
      writing = false;
      if (writeAgain) { writeAgain = false; autoSaveToFile(); }
    }
  }

  function loadText(text, handle, name) {
    let doc;
    try {
      doc = M.sanitizeDoc(JSON.parse(text));
    } catch (err) {
      const message = err instanceof SyntaxError ? 'That file is damaged or is not a FloorPlanner drawing.' : err.message;
      app.toast(message, true);
      return false;
    }
    doc.name = baseName(name);
    app.loadDoc(doc, handle, name);
    app.toast(`Opened ${name}`);
    return true;
  }

  // Drawings are a few megabytes at most. Anything far bigger is something else picked by
  // mistake (easy on a phone, whose picker shows every file), so it's refused unread.
  const MAX_FILE_BYTES = 50 * 1024 * 1024;
  async function openFile(file, handle) {
    if (file.size > MAX_FILE_BYTES) {
      app.toast(`${file.name} is too big to be a FloorPlanner drawing.`, true);
      return false;
    }
    return loadText(await file.text(), handle, file.name);
  }

  const okToDiscard = () => !app.dirty || window.confirm('You have unsaved changes. Discard them?');

  async function open() {
    if (!okToDiscard()) return;
    // Phones skip the file system picker: Android's version filters by file type, doesn't
    // know .fplan, and so shows drawings but won't let them be picked. The plain picker below
    // is unfiltered there.
    const phone = !!(FP.device && FP.device.phone);
    if (!phone && typeof window.showOpenFilePicker === 'function') {
      try {
        // Editing asks for write access now, so auto-save works without interrupting later.
        // View-only only reads, and keeps no link to the file, so it can never write to it.
        const [handle] = await window.showOpenFilePicker({ types: PICKER_TYPES, mode: app.readOnly ? 'read' : 'readwrite' });
        const file = await handle.getFile();
        await openFile(file, app.readOnly ? null : handle);
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    const input = document.createElement('input');
    input.type = 'file';
    // Phones filter the picker by file type and don't know .fplan: it arrives as generic
    // binary data, so that type is accepted too or drawings would be greyed out. Listing no
    // image types also keeps the phone from offering (and asking permission for) the camera.
    // Anything that isn't a drawing is refused when it's read.
    input.accept = FP.device && FP.device.phone
      ? `${EXT},application/json,application/octet-stream,text/plain`
      : `${EXT},application/json`;
    input.onchange = async () => {
      if (input.files[0]) await openFile(input.files[0], null);
    };
    input.click();
  }

  function newDoc() {
    if (!okToDiscard()) return;
    app.loadDoc(M.createDoc(FP.prefs.get().defaults));
    app.resetView();
  }

  function initDropTarget() {
    askOnFirstGesture();
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      const file = e.dataTransfer && e.dataTransfer.files[0];
      if (file && okToDiscard()) await openFile(file, null);
    });
    // Refreshing keeps the drawing, so only warn about work that has never been saved to a file.
    window.addEventListener('beforeunload', (e) => {
      if (app.dirty && !app.fileName) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  FP.fileio = {
    save, open, newDoc, loadText, download, deliver, serialize, initDropTarget, autoSaveToFile,
    rememberHandle, recallHandle, restoreSession, reconnect, setHandleStore,
  };
})(globalThis);
