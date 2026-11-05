/* Hormozgan coverage map — explorer (list + map + detail panel) and the linked consultation form.
   Leaflet is vendored under /public/vendor/leaflet (the CSP only allows scripts from 'self').
   Base-map tiles come from the server (#coverage-map-tiles): Map.ir when a valid key is configured, otherwise
   CARTO/OpenStreetMap — see src/lib/map-tiles.js. All visible text comes from the page (#coverage-map-labels),
   which reads it from src/locales/*.json, so this file holds no translations.
   The filter rules mirror src/lib/coverage-filter.js (there is no bundler to share the module with the browser). */
(() => {
  const mapEl = document.getElementById('coverageMap');
  if (!mapEl) return;

  const readJson = (id, fallback) => {
    try { return JSON.parse(document.getElementById(id)?.textContent || '') ?? fallback; } catch { return fallback; }
  };
  const areas = readJson('coverage-areas-data', []);
  const ui = readJson('coverage-map-labels', {});
  const tiles = readJson('coverage-map-tiles', null);
  const D = ui.detail || {};
  const locale = ui.locale === 'en' ? 'en' : 'fa';
  const numberFormat = new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'fa-IR');
  const nf = n => numberFormat.format(Number(n) || 0);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const byId = new Map(areas.map(a => [String(a.id), a]));

  const $ = id => document.getElementById(id);
  const list = $('areaList');
  const panel = $('mapInfoPanel');
  const stage = mapEl.closest('.cm-stage');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Search folds Arabic/Persian letter variants and digits so «كيش», «کیش» and «۱۲» / «12» all match.
  const fold = s => String(s || '').toLowerCase()
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[ةۀ]/g, 'ه').replace(/[أإآ]/g, 'ا').replace(/‌/g, ' ')
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/\s+/g, ' ').trim();

  function tone(a) {
    if (a.gasServiceStatus === 'installed') return 'green';
    if (a.gasServiceStatus === 'planned' || a.projectStatus === 'planned') return 'orange';
    if (a.gasServiceStatus === 'not_installed' && a.riserInstallationStatus && a.riserInstallationStatus !== 'unknown') return 'blue';
    return 'gray';
  }

  /* ---------- filters ---------- */
  const state = { status: '', city: '', gas: '', riser: '', search: '' };
  function matches(a, f, ignoreStatus) {
    if (!ignoreStatus && f.status && a.projectStatus !== f.status) return false;
    if (f.city && a.city !== f.city) return false;
    if (f.gas && a.gasServiceStatus !== f.gas) return false;
    if (f.riser && a.riserInstallationStatus !== f.riser) return false;
    if (f.search && !fold(`${a.projectName} ${a.city} ${a.district || ''} ${a.approximateLocation || ''}`).includes(fold(f.search))) return false;
    return true;
  }
  const activeFilterCount = () => Object.values(state).filter(Boolean).length;

  /* ---------- map ---------- */
  const leafletReady = typeof L !== 'undefined';
  let map = null;
  const markers = new Map();
  if (leafletReady) {
    mapEl.querySelector('.cm-canvas-loading')?.remove();
    const hormozgan = L.latLngBounds([24.6, 51.8], [29.6, 60.2]);
    map = L.map(mapEl, { scrollWheelZoom: false, maxBounds: hormozgan, maxBoundsViscosity: 0.8, minZoom: 6, zoomSnap: 0.5 });
    map.setView([27.0, 56.3], 7);

    let base = null;
    const addTiles = cfg => {
      if (base) map.removeLayer(base);
      const opts = { attribution: cfg.attribution, maxZoom: cfg.maxZoom || 18, crossOrigin: false };
      if (cfg.subdomains) opts.subdomains = cfg.subdomains;
      base = L.tileLayer(cfg.url, opts).addTo(map);
      mapEl.dataset.tileProvider = cfg.provider;
      return base;
    };
    const fallbackCfg = tiles && tiles.fallback;
    const primary = addTiles(tiles && tiles.url ? tiles : {
      provider: 'carto', url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', subdomains: 'abcd', maxZoom: 19,
      attribution: '&copy; OpenStreetMap &copy; CARTO'
    });
    // If the Iranian tile server is unreachable (network/DNS errors, not "unauthorized" — the server already
    // checked the key's expiry), switch to the fallback provider instead of leaving a blank map.
    if (fallbackCfg) {
      let loaded = 0, failed = 0;
      primary.on('tileload', () => { loaded += 1; });
      primary.on('tileerror', () => {
        failed += 1;
        if (failed >= 4 && loaded === 0) { primary.off(); addTiles(fallbackCfg); }
      });
    }

    const enableWheel = () => { map.scrollWheelZoom.enable(); $('mapHint')?.classList.add('is-gone'); };
    mapEl.addEventListener('click', enableWheel, { once: true });
    mapEl.addEventListener('focus', enableWheel, { once: true });

    areas.forEach(a => {
      if (!Number.isFinite(a.lat) || !Number.isFinite(a.lng)) return;
      const icon = L.divIcon({
        className: 'cm-marker',
        html: `<span class="cm-pin cm-tone--${tone(a)}"><b>${nf(a.projectCount)}</b></span>`,
        iconSize: [36, 44], iconAnchor: [18, 42], tooltipAnchor: [0, -40]
      });
      const m = L.marker([a.lat, a.lng], { icon, title: `${a.projectName} — ${a.city}`, alt: a.projectName, riseOnHover: true, keyboard: true });
      m.bindTooltip(`<b>${esc(a.projectName)}</b><br>${esc(ui.statusLabels?.[a.projectStatus] || a.projectStatus)}`, { direction: 'top', opacity: 1, className: 'cm-tooltip' });
      m.on('click', () => select(a.id, { pan: false, focusPanel: true }));
      markers.set(String(a.id), m);
      m.addTo(map);
    });

    if ('ResizeObserver' in window) new ResizeObserver(() => map.invalidateSize()).observe(mapEl);
  } else {
    mapEl.classList.add('is-unavailable');
  }

  function fitTo(items) {
    if (!map) return;
    const pts = items.filter(a => Number.isFinite(a.lat) && Number.isFinite(a.lng)).map(a => [a.lat, a.lng]);
    if (!pts.length) return;
    if (pts.length === 1) map.setView(pts[0], 10, { animate: !reduceMotion });
    else map.fitBounds(pts, { padding: [48, 48], maxZoom: 10, animate: !reduceMotion });
  }

  /* ---------- rendering ---------- */
  function animateNumber(el, value) {
    if (!el) return;
    if (window.__novingityAnimateCount && !reduceMotion) window.__novingityAnimateCount(el, value);
    else el.textContent = nf(value);
  }

  function apply({ refit = true } = {}) {
    const visible = areas.filter(a => matches(a, state));
    const visibleIds = new Set(visible.map(a => String(a.id)));

    list?.querySelectorAll('.cm-item').forEach(li => { li.hidden = !visibleIds.has(li.dataset.areaId); });
    markers.forEach((m, id) => {
      const el = m.getElement();
      if (visibleIds.has(id)) { if (!map.hasLayer(m)) m.addTo(map); } else if (map.hasLayer(m)) map.removeLayer(m);
      if (el) el.classList.toggle('is-dim', !visibleIds.has(id));
    });

    // chip counts: each status chip shows how many areas it would leave given the other filters
    const base = areas.filter(a => matches(a, state, true));
    document.querySelectorAll('[data-chip-count]').forEach(b => {
      const s = b.dataset.chipCount;
      b.textContent = nf(s ? base.filter(a => a.projectStatus === s).length : base.length);
    });
    document.querySelectorAll('#statusChips .cm-chip').forEach(c => c.setAttribute('aria-pressed', String(c.dataset.status === state.status)));

    const totalProjects = visible.reduce((s, a) => s + (Number(a.projectCount) || 0), 0);
    animateNumber($('statTotalProjects'), totalProjects);
    animateNumber($('statAreas'), visible.length);
    animateNumber($('statCompleted'), visible.filter(a => a.projectStatus === 'completed').reduce((s, a) => s + (Number(a.projectCount) || 0), 0));
    animateNumber($('statPlanned'), visible.filter(a => a.projectStatus === 'planned' || a.gasServiceStatus === 'planned').length);
    $('resultProjectCount') && ($('resultProjectCount').textContent = nf(totalProjects));
    $('resultAreaCount') && ($('resultAreaCount').textContent = nf(visible.length));

    const extra = ['city', 'gas', 'riser'].filter(k => state[k]).length;
    const badge = $('moreFiltersBadge');
    if (badge) { badge.hidden = !extra; badge.textContent = nf(extra); }
    const reset = $('resetFilters');
    if (reset) reset.hidden = activeFilterCount() === 0;
    const empty = $('areaListEmpty');
    if (empty) empty.hidden = visible.length > 0;

    if (selectedId && !visibleIds.has(selectedId)) closePanel();
    if (refit && visible.length) fitTo(visible);
  }

  let selectedId = null;
  function renderPanel(a) {
    const row = (label, value) => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
    const yesNo = v => esc(v ? D.yes : D.no);
    const svc = v => esc(ui.serviceLabels?.[v] || v || '—');
    const updated = a.lastUpdated ? new Date(a.lastUpdated) : null;
    panel.innerHTML = `
      <div class="cm-detail-head">
        <span class="cm-badge cm-badge--${esc(a.projectStatus)}">${esc(ui.statusLabels?.[a.projectStatus] || a.projectStatus)}</span>
        <button type="button" class="cm-detail-close" data-close-panel aria-label="${esc(ui.closeDetails)}">×</button>
      </div>
      <h3 id="mapInfoTitle">${esc(a.projectName)}</h3>
      <p class="cm-detail-loc">${esc(a.city)}${a.district ? ' · ' + esc(a.district) : ''}</p>
      <dl class="cm-detail-list">
        ${row(D.projectCount, `<b class="cm-detail-num">${nf(a.projectCount)}</b>`)}
        ${row(D.gasStatus, `<i class="cm-tone-dot cm-tone--${tone(a)}" aria-hidden="true"></i>${svc(a.gasServiceStatus)}`)}
        ${row(D.riserInstall, svc(a.riserInstallationStatus))}
        ${row(D.riserLocation, yesNo(a.riserLocations))}
        ${row(D.plannedExpansion, yesNo(a.plannedExpansion))}
        ${a.serviceType ? row(D.services, esc(a.serviceType)) : ''}
        ${a.approximateLocation ? row(D.approximate, esc(a.approximateLocation)) : ''}
        ${updated && !Number.isNaN(updated.getTime()) ? row(D.lastUpdated, esc(updated.toLocaleDateString(locale === 'en' ? 'en-US' : 'fa-IR'))) : ''}
      </dl>
      ${a.description ? `<p class="cm-detail-desc">${esc(a.description)}</p>` : ''}
      ${a.isDemo !== false ? `<p class="cm-detail-demo"><span aria-hidden="true">⚠</span> ${esc(D.demoNote)}</p>` : ''}
      <div class="cm-detail-actions">
        <button type="button" class="button button-primary button-block" data-request-for="${esc(a.id)}">${esc(D.request)}</button>
        <button type="button" class="cm-link-button" data-copy-link="${esc(a.id)}">${esc(D.copyLink)}</button>
      </div>`;
    panel.setAttribute('aria-labelledby', 'mapInfoTitle');
  }

  function select(id, { pan = true, focusPanel = false, updateHash = true } = {}) {
    const a = byId.get(String(id));
    if (!a || !panel) return;
    selectedId = String(a.id);
    renderPanel(a);
    panel.hidden = false;
    list?.querySelectorAll('.cm-item').forEach(li => li.classList.toggle('is-active', li.dataset.areaId === selectedId));
    list?.querySelectorAll('.cm-item-link').forEach(l => l.removeAttribute('aria-current'));
    list?.querySelector(`[data-area-id="${selectedId}"] .cm-item-link`)?.setAttribute('aria-current', 'true');
    markers.forEach((m, mid) => m.getElement()?.classList.toggle('is-active', mid === selectedId));
    markers.get(selectedId)?.setZIndexOffset(1000);
    stage?.classList.add('has-detail');
    if (pan && map && Number.isFinite(a.lat)) {
      const zoom = Math.max(map.getZoom(), 9);
      // On wide screens the detail card floats over the right side of the map: centre the pin in the
      // part of the map that stays visible instead of hiding it under the card.
      let target = L.latLng(a.lat, a.lng);
      const floating = getComputedStyle(panel).position === 'absolute';
      if (floating) target = map.unproject(map.project(target, zoom).add([(panel.offsetWidth + 12) / 2, 0]), zoom);
      if (reduceMotion) map.setView(target, zoom, { animate: false });
      else map.flyTo(target, zoom, { duration: 0.6 });
    }
    if (updateHash && history.replaceState) history.replaceState(null, '', `#area-${selectedId}`);
    if (focusPanel) panel.focus({ preventScroll: true });
  }

  function closePanel() {
    if (!panel || panel.hidden) return;
    const was = selectedId;
    selectedId = null;
    panel.hidden = true;
    panel.innerHTML = '';
    stage?.classList.remove('has-detail');
    list?.querySelectorAll('.cm-item').forEach(li => li.classList.remove('is-active'));
    list?.querySelectorAll('.cm-item-link').forEach(l => l.removeAttribute('aria-current'));
    markers.forEach(m => { m.getElement()?.classList.remove('is-active'); m.setZIndexOffset(0); });
    if (history.replaceState && location.hash.startsWith('#area-')) history.replaceState(null, '', location.pathname + location.search);
    return was;
  }

  /* ---------- consultation form link ---------- */
  const chip = $('selectedAreaChip');
  function setFormArea(a) {
    const idField = $('field_coverage_area_id');
    if (idField) idField.value = a ? String(a.id) : '';
    if (a) {
      if ($('field_city')) $('field_city').value = a.city || '';
      if ($('field_district')) $('field_district').value = a.district || '';
    }
    if (!chip) return;
    chip.classList.toggle('is-set', !!a);
    chip.innerHTML = a
      ? `<span class="cm-area-chip-label">${esc(ui.selectedArea)}</span><strong id="selectedAreaName">${esc(a.projectName)} — ${esc(a.city)}</strong><button type="button" class="cm-link-button" id="clearSelectedArea">${esc(ui.clearArea)}</button>`
      : `<span class="cm-area-chip-empty">${esc(chip.dataset.emptyText || '')}</span>`;
  }
  chip?.addEventListener('click', e => {
    if (e.target.closest('#clearSelectedArea')) { setFormArea(null); $('field_city')?.focus(); }
  });
  const preset = byId.get(String($('field_coverage_area_id')?.value || ''));
  if (preset && chip) chip.classList.add('is-set');

  panel?.addEventListener('click', async e => {
    if (e.target.closest('[data-close-panel]')) {
      const was = closePanel();
      list?.querySelector(`[data-area-id="${was}"] .cm-item-link`)?.focus({ preventScroll: true });
      return;
    }
    const copy = e.target.closest('[data-copy-link]');
    if (copy) {
      const url = `${location.origin}${location.pathname}#area-${copy.dataset.copyLink}`;
      try { await navigator.clipboard.writeText(url); copy.textContent = D.linkCopied; setTimeout(() => { copy.textContent = D.copyLink; }, 2000); } catch { /* clipboard blocked: the URL is already in the address bar */ }
      return;
    }
    const req = e.target.closest('[data-request-for]');
    if (!req) return;
    const a = byId.get(req.dataset.requestFor);
    if (!a) return;
    setFormArea(a);
    const form = $('consultation-form');
    form?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    setTimeout(() => $('field_full_name')?.focus({ preventScroll: true }), reduceMotion ? 0 : 450);
  });

  /* ---------- controls ---------- */
  list?.addEventListener('click', e => {
    const link = e.target.closest('[data-select-area]');
    if (!link) return;
    e.preventDefault();
    select(link.dataset.selectArea, { pan: true });
    // on narrow screens the map sits above the list — bring it into view
    if (window.matchMedia('(max-width: 900px)').matches) mapEl.closest('.cm-stage')?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    panel?.focus({ preventScroll: true });
  });

  $('statusChips')?.addEventListener('click', e => {
    const c = e.target.closest('.cm-chip');
    if (!c) return;
    state.status = c.dataset.status || '';
    apply();
  });
  const bindSelect = (id, key) => $(id)?.addEventListener('change', e => { state[key] = e.target.value; apply(); });
  bindSelect('filterCity', 'city'); bindSelect('filterGas', 'gas'); bindSelect('filterRiser', 'riser');
  let t;
  $('filterSearch')?.addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { state.search = e.target.value.trim(); apply(); }, 180); });
  $('mapFilters')?.addEventListener('submit', e => e.preventDefault());

  function resetAll() {
    Object.keys(state).forEach(k => { state[k] = ''; });
    ['filterCity', 'filterGas', 'filterRiser', 'filterSearch'].forEach(id => { const el = $(id); if (el) el.value = ''; });
    apply();
  }
  $('resetFilters')?.addEventListener('click', resetAll);
  document.querySelector('[data-reset-filters]')?.addEventListener('click', resetAll);
  $('fitAllAreas')?.addEventListener('click', () => fitTo(areas.filter(a => matches(a, state))));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && selectedId && panel?.contains(document.activeElement)) {
      const was = closePanel();
      list?.querySelector(`[data-area-id="${was}"] .cm-item-link`)?.focus({ preventScroll: true });
    }
  });

  /* ---------- start ---------- */
  const fromHash = () => { const m = /^#area-(\d+)$/.exec(location.hash); return m && byId.has(m[1]) ? m[1] : null; };
  apply({ refit: !fromHash() });
  const initial = fromHash();
  if (initial) select(initial, { pan: true, updateHash: false });
  window.addEventListener('hashchange', () => { const id = fromHash(); if (id && id !== selectedId) select(id, { pan: true, updateHash: false }); });
})();
