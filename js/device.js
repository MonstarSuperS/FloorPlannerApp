// What kind of device the app is running on, decided before the page draws so a phone never
// flashes the desktop layout. Two separate choices come out of it:
//   layout: 'compact' (phone-sized screen) or 'full'
//   mode:   'view' (look, measure and export only) or 'edit'
// Phones get the compact layout in view mode for now. Keeping the two apart means touch
// editing can later be compact + edit without reworking either.
//
// A browser's "Desktop site" setting reports a desktop device, so it gets the full editor.
// For testing on a computer, ?layout=phone or ?layout=desktop overrides the detection.
(function (root) {
  const FP = (root.FP = root.FP || {});

  // uaData: navigator.userAgentData (Chromium browsers), which answers directly. Others are
  // judged by the user agent string: iPhones, iPods and Android phones say "Mobile", while
  // Android tablets don't and iPads report as desktop Safari.
  function isPhone(ua, uaData) {
    if (uaData && typeof uaData.mobile === 'boolean') return uaData.mobile;
    return /iPhone|iPod|Android.*Mobile|Mobile.*Firefox|Windows Phone|IEMobile|Opera Mini/i.test(ua || '');
  }

  function override(search) {
    try {
      const v = new URLSearchParams(search || '').get('layout');
      return v === 'phone' || v === 'desktop' ? v : null;
    } catch (e) { return null; }
  }

  function profile(ua, uaData, search) {
    const forced = override(search);
    const phone = forced ? forced === 'phone' : isPhone(ua, uaData);
    return { phone, layout: phone ? 'compact' : 'full', mode: phone ? 'view' : 'edit', forced: !!forced };
  }

  const nav = root.navigator || {};
  const current = profile(nav.userAgent, nav.userAgentData, root.location && root.location.search);

  function applyLayout(layout) {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle('compact', layout === 'compact');
  }
  applyLayout(current.layout);
  // The mode's class too, right away: app.setMode sets it again at startup, but that waits for
  // every script, and until then a phone would show the full editor's panels.
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('view-only', current.mode === 'view');

  FP.device = { ...current, isPhone, profile, applyLayout };
})(globalThis);
