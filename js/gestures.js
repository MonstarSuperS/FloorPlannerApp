// Turns raw pointer events into gestures: tap, double tap, drag (one finger or the mouse) and
// pinch (two fingers, which also pan). It knows nothing about the drawing: whoever attaches it
// decides what each gesture does, so view-only now and touch editing later can share it.
//
//   const g = FP.gestures.attach(element, {
//     enabled()                      optional; while it returns false, presses are ignored
//     tap(p, info)                   a press and release that didn't move
//     doubleTap(p, info)             a second tap soon after and close to the first
//     dragStart(p, info)             the press moved far enough to be a drag; p is where it began
//     dragMove(p, delta, info)       p is the current point, delta the move since the last call
//     dragEnd(p, info)               info.cancelled when the system took the pointer away
//     pinch({ center, ratio, dx, dy })  since the last call: zoom by ratio about center, pan by dx, dy
//     pinchEnd()
//   });
//   g.detach(); g.cancel(); g.busy()
//
// Points are in CSS pixels relative to the element. info: { pointerType, afterPinch, event }.
// Moves and releases are heard on the window, so a gesture carries on when a finger slides off
// the element, and it works whether or not the browser grants pointer capture.
(function (root) {
  const FP = (root.FP = root.FP || {});

  // How far a press may wander and still count as a tap, by input type. Fingers are imprecise.
  const SLOP = { touch: 10, pen: 6, mouse: 4 };
  const DOUBLE_TAP_MS = 300;
  const DOUBLE_TAP_PX = { touch: 32, pen: 20, mouse: 8 };
  const TAP_MAX_MS = 600; // holding longer than this isn't a tap

  const slopOf = (type) => SLOP[type] || SLOP.touch;
  const now = () => (root.performance ? root.performance.now() : Date.now());

  function attach(el, handlers) {
    const h = handlers || {};
    const call = (name, ...args) => (typeof h[name] === 'function' ? h[name](...args) : undefined);
    const pointers = new Map(); // id -> { x, y, type } in element coordinates, in press order
    let phase = 'idle';         // idle | pending | drag | pinch
    let start = null;           // the press: { x, y, t, type, id }
    let last = null;            // the dragging pointer's previous point
    let pinchPrev = null;       // { center, dist }
    let lastTap = null;         // { x, y, t, type } for spotting a double tap

    const local = (e) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const info = (type, e, extra) => ({ pointerType: type, event: e, afterPinch: false, ...(extra || {}) });

    function twoFingers() {
      const [a, b] = [...pointers.values()];
      return { center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(b.x - a.x, b.y - a.y) };
    }

    function onDown(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (h.enabled && !h.enabled()) return;
      const p = local(e);
      pointers.set(e.pointerId, { ...p, type: e.pointerType || 'touch' });
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* not granted: window listeners cover it */ }
      e.preventDefault();

      if (pointers.size === 1) {
        phase = 'pending';
        start = { ...p, t: now(), type: e.pointerType || 'touch', id: e.pointerId };
        last = p;
      } else if (pointers.size === 2) {
        // A second finger turns whatever the first was doing into a pinch.
        if (phase === 'drag') call('dragEnd', last, info(start.type, e));
        phase = 'pinch';
        pinchPrev = twoFingers();
        lastTap = null;
      }
      // A third finger or more is tracked but doesn't change the gesture.
    }

    function onMove(e) {
      const ptr = pointers.get(e.pointerId);
      if (!ptr) return;
      const p = local(e);
      ptr.x = p.x;
      ptr.y = p.y;

      if (phase === 'pending' && e.pointerId === start.id) {
        if (Math.hypot(p.x - start.x, p.y - start.y) < slopOf(start.type)) return;
        phase = 'drag';
        call('dragStart', { x: start.x, y: start.y }, info(start.type, e));
        call('dragMove', p, { x: p.x - start.x, y: p.y - start.y }, info(start.type, e));
        last = p;
      } else if (phase === 'drag' && e.pointerId === start.id) {
        call('dragMove', p, { x: p.x - last.x, y: p.y - last.y }, info(start.type, e));
        last = p;
      } else if (phase === 'pinch' && pointers.size >= 2) {
        const next = twoFingers();
        const ratio = pinchPrev.dist > 0 ? next.dist / pinchPrev.dist : 1;
        call('pinch', { center: next.center, ratio, dx: next.center.x - pinchPrev.center.x, dy: next.center.y - pinchPrev.center.y });
        pinchPrev = next;
      }
    }

    function onUp(e, cancelled) {
      const ptr = pointers.get(e.pointerId);
      if (!ptr) return;
      pointers.delete(e.pointerId);
      try { el.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
      const p = local(e);

      if (phase === 'pending') {
        phase = 'idle';
        if (cancelled || now() - start.t > TAP_MAX_MS) { lastTap = null; return; }
        const t = now();
        const near = lastTap && lastTap.type === start.type && t - lastTap.t <= DOUBLE_TAP_MS &&
          Math.hypot(p.x - lastTap.x, p.y - lastTap.y) <= (DOUBLE_TAP_PX[start.type] || DOUBLE_TAP_PX.touch);
        if (near) {
          lastTap = null;
          call('doubleTap', p, info(start.type, e));
        } else {
          lastTap = { ...p, t, type: start.type };
          call('tap', p, info(start.type, e));
        }
      } else if (phase === 'drag') {
        if (e.pointerId !== start.id) return;
        phase = pointers.size ? 'spent' : 'idle';
        call('dragEnd', p, info(start.type, e, { cancelled: !!cancelled }));
      } else if (phase === 'pinch' && pointers.size >= 2) {
        pinchPrev = twoFingers(); // a third finger lifted: carry on with the two left, without a jump
      } else if (phase === 'pinch') {
        call('pinchEnd');
        lastTap = null;
        if (pointers.size === 1 && !cancelled) {
          // The finger left on the glass carries on as a drag from where it is now.
          const [id, rest] = [...pointers.entries()][0];
          start = { x: rest.x, y: rest.y, t: now(), type: rest.type, id };
          last = { x: rest.x, y: rest.y };
          phase = 'drag';
          call('dragStart', { ...last }, info(rest.type, e, { afterPinch: true }));
        } else phase = pointers.size ? 'spent' : 'idle';
      }
      if (!pointers.size) phase = 'idle';
    }

    // Drops whatever is in progress, e.g. when the page loses focus or the mode changes.
    function cancel() {
      if (phase === 'drag' && last) call('dragEnd', last, { pointerType: start.type, cancelled: true, afterPinch: false });
      if (phase === 'pinch') call('pinchEnd');
      pointers.clear();
      phase = 'idle';
      lastTap = null;
    }

    const down = (e) => onDown(e);
    const move = (e) => onMove(e);
    const up = (e) => onUp(e, false);
    const lost = (e) => onUp(e, true);
    el.addEventListener('pointerdown', down);
    root.addEventListener('pointermove', move);
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', lost);
    root.addEventListener('blur', cancel);

    return {
      cancel,
      busy: () => phase !== 'idle',
      detach() {
        cancel();
        el.removeEventListener('pointerdown', down);
        root.removeEventListener('pointermove', move);
        root.removeEventListener('pointerup', up);
        root.removeEventListener('pointercancel', lost);
        root.removeEventListener('blur', cancel);
      },
    };
  }

  FP.gestures = { attach, SLOP, DOUBLE_TAP_MS, DOUBLE_TAP_PX, TAP_MAX_MS };
})(globalThis);
