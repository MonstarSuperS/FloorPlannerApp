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

  const okToDiscard = () => !app.dirty || window.confirm('You have unsaved changes. Discard them?');

  async function open() {
    if (!okToDiscard()) return;
    if (typeof window.showOpenFilePicker === 'function') {
      try {
        // Asking for write access now lets auto-save work without interrupting later.
        const [handle] = await window.showOpenFilePicker({ types: PICKER_TYPES, mode: 'readwrite' });
        const file = await handle.getFile();
        loadText(await file.text(), handle, file.name);
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = `${EXT},application/json`;
    input.onchange = async () => {
      if (input.files[0]) loadText(await input.files[0].text(), null, input.files[0].name);
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
      if (file && okToDiscard()) loadText(await file.text(), null, file.name);
    });
    // Refreshing keeps the drawing, so only warn about work that has never been saved to a file.
    window.addEventListener('beforeunload', (e) => {
      if (app.dirty && !app.fileName) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  FP.fileio = {
    save, open, newDoc, loadText, download, serialize, initDropTarget, autoSaveToFile,
    rememberHandle, recallHandle, restoreSession, reconnect, setHandleStore,
  };
})(globalThis);
