// Design options: alternative versions of a floor, such as a renovation tried a few ways.
//
// A floor's lists (walls, fixtures...) always hold what is on screen. While an option is open,
// the as-is plan waits in floor.asIs and the floor shows the option: as-is plus the option's
// changes. An option stores only what differs from as-is, found by comparing when it is left
// or saved, so editing anything in an option changes only the option, and fixes made to the
// as-is plan later show up in every option that didn't change the same thing.
//
// floor.options: [{ id, name, changes: { walls: [item...] ... }, removed: { walls: [id...] ... } }]
// floor.option:  the open option's id, or null for as-is.
// Saved files always hold the as-is plan in the floor's own lists.
(function (root) {
  const FP = (root.FP = root.FP || {});
  const M = FP.model;

  const LISTS = ['nodes', 'walls', 'openings', 'fixtures', 'dims', 'labels', 'rooms', 'guides', 'stairs', 'shapes'];
  const clone = (x) => JSON.parse(JSON.stringify(x));
  // Compared with numbers rounded, so recomputed positions don't count as changes.
  const sig = (x) => JSON.stringify(x, (k, v) => (typeof v === 'number' ? Math.round(v * 1e5) / 1e5 : v));

  const listsOf = (floor) => Object.fromEntries(LISTS.map((k) => [k, floor[k] || []]));

  // What `cur` changes from `base`: items added or edited, and the ids of items removed.
  function diff(base, cur) {
    const changes = {}, removed = {};
    for (const k of LISTS) {
      const before = new Map((base[k] || []).map((x) => [x.id, x]));
      const seen = new Set();
      for (const x of cur[k] || []) {
        seen.add(x.id);
        const old = before.get(x.id);
        if (!old || sig(old) !== sig(x)) (changes[k] = changes[k] || []).push(clone(x));
      }
      for (const x of base[k] || []) if (!seen.has(x.id)) (removed[k] = removed[k] || []).push(x.id);
    }
    return { changes, removed };
  }

  // The lists an option shows: a copy of `base` with its changes made.
  function apply(base, opt) {
    const out = {};
    for (const k of LISTS) {
      const gone = new Set((opt.removed && opt.removed[k]) || []);
      const edits = new Map(((opt.changes && opt.changes[k]) || []).map((x) => [x.id, x]));
      const list = [];
      for (const x of base[k] || []) {
        if (gone.has(x.id)) continue;
        list.push(clone(edits.get(x.id) || x));
        edits.delete(x.id);
      }
      for (const x of edits.values()) list.push(clone(x));
      out[k] = list;
    }
    return repair(out);
  }

  // After as-is changes, an option's items can point at things that are gone: walls whose
  // corners were removed, doors whose wall was removed. Those are dropped or let go.
  function repair(L) {
    const nodeIds = new Set(L.nodes.map((n) => n.id));
    L.walls = L.walls.filter((w) => nodeIds.has(w.a) && nodeIds.has(w.b) && w.a !== w.b);
    const wallIds = new Set(L.walls.map((w) => w.id));
    L.openings = L.openings.filter((o) => wallIds.has(o.wallId));
    for (const n of L.nodes) if (n.host && !wallIds.has(n.host.wallId)) delete n.host;
    for (const d of L.dims) for (const end of [d.a, d.b]) if (end && end.nodeId && !nodeIds.has(end.nodeId)) delete end.nodeId;
    return L;
  }

  const find = (floor, id) => (floor.options || []).find((o) => o.id === id) || null;
  const active = (floor) => (floor.option && floor.asIs ? find(floor, floor.option) : null);

  // Records the open option's changes so far.
  function sync(floor) {
    const opt = active(floor);
    if (opt) Object.assign(opt, diff(floor.asIs, listsOf(floor)));
  }

  // Opens an option, or the as-is plan with id null.
  function open(floor, id) {
    sync(floor);
    const base = floor.asIs || listsOf(floor);
    const opt = id ? find(floor, id) : null;
    const lists = opt ? apply(base, opt) : base;
    for (const k of LISTS) floor[k] = lists[k];
    if (opt) { floor.asIs = base; floor.option = opt.id; }
    else { delete floor.asIs; floor.option = null; }
    M.normalize(floor);
  }

  function nextName(floor) {
    const used = new Set((floor.options || []).map((o) => o.name));
    for (let i = 0; i < 26; i++) {
      const name = `Option ${String.fromCharCode(65 + i)}`;
      if (!used.has(name)) return name;
    }
    return `Option ${(floor.options || []).length + 1}`;
  }

  // A new option, empty or a copy of the open one, which then opens.
  function create(floor, copyOpen) {
    sync(floor);
    const from = copyOpen ? active(floor) : null;
    const opt = { id: M.uid('opt'), name: from ? `${from.name} copy` : nextName(floor), changes: from ? clone(from.changes) : {}, removed: from ? clone(from.removed) : {} };
    floor.options = [...(floor.options || []), opt];
    open(floor, opt.id);
    return opt;
  }

  function remove(floor, id) {
    if (floor.option === id) open(floor, null);
    floor.options = (floor.options || []).filter((o) => o.id !== id);
  }

  // Makes the open option the as-is plan (once the renovation is built). The other options
  // keep looking exactly as they did.
  function promote(floor) {
    const opt = active(floor);
    if (!opt) return false;
    sync(floor);
    const oldBase = floor.asIs;
    const newBase = clone(listsOf(floor));
    for (const o of floor.options) if (o !== opt) Object.assign(o, diff(newBase, apply(oldBase, o)));
    floor.options = floor.options.filter((o) => o !== opt);
    for (const k of LISTS) floor[k] = newBase[k];
    delete floor.asIs;
    floor.option = null;
    M.normalize(floor);
    return true;
  }

  // A stand-in floor showing an option (or as-is with id null) without opening it, for
  // comparisons and exports. `real` is the floor it belongs to.
  const shownCache = new WeakMap();
  function view(floor, id) {
    const base = floor.asIs || listsOf(floor);
    if (!id && floor.asIs) {
      // As-is doesn't change while an option is open, so its stand-in can be kept.
      let v = shownCache.get(floor.asIs);
      if (!v) { v = { id: `${floor.id}~asis`, name: floor.name, real: floor, ...clone(base) }; shownCache.set(floor.asIs, v); }
      return v;
    }
    if (!id || id === floor.option) return floor;
    sync(floor);
    const opt = find(floor, id);
    const v = { id: `${floor.id}~${id}`, name: floor.name, real: floor, ...(opt ? apply(base, opt) : clone(base)) };
    M.normalize(v);
    return v;
  }

  // The floor as it is saved: its as-is plan in its own lists, the options' changes up to date.
  function forSaving(floor) {
    if (!active(floor)) {
      const out = { ...floor };
      delete out.asIs;
      return out;
    }
    sync(floor);
    const out = { ...floor, ...floor.asIs };
    delete out.asIs;
    return out;
  }

  // Tidies options read from a file. The floor's lists already hold its cleaned as-is plan.
  function clean(floor, raw) {
    // Changed items get the same checks as the plan's own; removed items are ids.
    const lists = (o, fn) => Object.fromEntries(LISTS.filter((k) => Array.isArray(o && o[k])).map((k) => [k, o[k].map((x) => fn(k, x)).filter(Boolean)]));
    const changes = (o) => lists(o, (k, x) => M.cleanItem(k, x));
    const removed = (o) => lists(o, (k, x) => (typeof x === 'string' && x ? x : null));
    floor.options = (Array.isArray(raw.options) ? raw.options : [])
      .filter((o) => o && typeof o.id === 'string' && o.id)
      .map((o) => ({ id: o.id, name: typeof o.name === 'string' && o.name ? o.name.slice(0, 100) : 'Option', changes: changes(o.changes), removed: removed(o.removed) }));
    floor.option = null;
    if (raw.option && find(floor, raw.option)) open(floor, raw.option);
  }

  FP.options = { LISTS, diff, apply, sync, open, create, remove, promote, view, forSaving, clean, active, find };
})(globalThis);
