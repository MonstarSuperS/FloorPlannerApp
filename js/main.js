// Starts the app once the page has loaded.
(function (root) {
  const FP = root.FP;
  const app = FP.app;

  let started;
  app.ready = new Promise((resolve) => { started = resolve; });

  window.addEventListener('DOMContentLoaded', async () => {
    try { await start(); } finally { started(); }
  });

  async function start() {
    const canvas = document.getElementById('plan');
    FP.interact.init(canvas);
    // Phones open view-only (device.js); set before the panels build so they match from the start.
    app.setMode(FP.device.mode);
    FP.viewer.init(canvas);
    FP.ui.init();
    FP.settingsUI.init();
    FP.fileio.initDropTarget();

    const rect = canvas.parentElement.getBoundingClientRect();
    app.viewport.width = rect.width;
    app.viewport.height = rect.height;

    // Reopen whatever was open last time, so a refresh doesn't lose your place.
    const session = app.readSession();
    try {
      if (!session || !session.doc) throw null;
      const handle = session.hasHandle ? await FP.fileio.recallHandle() : null;
      await FP.fileio.restoreSession(session, handle);
      app.renderNow();
    } catch (err) {
      if (err) console.error(err);
      app.loadDoc(FP.model.createDoc(FP.prefs.get().defaults));
      app.resetView();
      app.renderNow();
      if (err) app.toast('The drawing from last time could not be reopened, so a new one was started.', true);
    }
  }
})(globalThis);
