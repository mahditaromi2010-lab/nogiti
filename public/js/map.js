/* Hormozgan coverage map (item 7). Leaflet + OpenStreetMap tiles, vendored locally under /public/vendor/leaflet
   (no CDN script, consistent with the site's CSP which only allows scripts from 'self').
   Mirrors the filtering/colour logic in src/lib/coverage-filter.js (no bundler ships a shared module to the
   browser here, same reasoning as the G2.5 rules table duplication in tools.js). */
(() => {
  const mapEl = document.getElementById('coverageMap');
  if (!mapEl || typeof L === 'undefined') return;

  const PROJECT_STATUS_LABELS = { completed: 'تکمیل‌شده', in_progress: 'در حال اجرا', planned: 'برنامه‌ریزی‌شده', under_review: 'در حال بررسی' };
  const GAS_STATUS_LABELS = { installed: 'نصب‌شده', not_installed: 'نصب‌نشده', planned: 'برنامه‌ریزی‌شده', unknown: 'نامشخص' };
  const RISER_STATUS_LABELS = { installed: 'نصب‌شده', not_installed: 'نصب‌نشده', planned: 'برنامه‌ریزی‌شده', unknown: 'نامشخص' };

  function statusColor(area) {
    if (area.gasServiceStatus === 'installed') return '#10b981';
    if (area.gasServiceStatus === 'planned' || area.projectStatus === 'planned') return '#f59e0b';
    if (area.gasServiceStatus === 'not_installed' && area.riserInstallationStatus && area.riserInstallationStatus !== 'unknown') return '#2563eb';
    return '#9ca3af';
  }

  function filterAreas(areas, f) {
    return areas.filter(a => {
      if (f.city && a.city !== f.city) return false;
      if (f.status && a.projectStatus !== f.status) return false;
      if (f.gasService && a.gasServiceStatus !== f.gasService) return false;
      if (f.riser && a.riserInstallationStatus !== f.riser) return false;
      if (f.search && !(`${a.projectName} ${a.city} ${a.district}`.toLowerCase().includes(f.search.toLowerCase()))) return false;
      return true;
    });
  }
  function summarize(areas) {
    return {
      totalProjects: areas.reduce((s, a) => s + (Number(a.projectCount) || 0), 0),
      areasCount: areas.length,
      completedProjects: areas.filter(a => a.projectStatus === 'completed').reduce((s, a) => s + (Number(a.projectCount) || 0), 0),
      surveyedAreas: areas.filter(a => a.gasServiceStatus !== 'unknown').length,
      plannedAreas: areas.filter(a => a.projectStatus === 'planned' || a.gasServiceStatus === 'planned').length
    };
  }

  let allAreas = [];
  try { allAreas = JSON.parse(document.getElementById('coverage-areas-data').textContent || '[]'); } catch { allAreas = []; }
  let labels = { requestTypeLabels: {}, projectStatusFormLabels: {} };
  try { labels = JSON.parse(document.getElementById('coverage-map-labels').textContent || '{}'); } catch { /* ignore */ }

  // One clean data-fetching function: uses the data already embedded in the page when there is no active
  // filter (no extra request), and the live /api/coverage-areas endpoint when filters are applied — so a
  // future real data source only has to change what that endpoint reads from, not this file.
  const apiUrl = mapEl.dataset.areasApi || '/api/coverage-areas';
  async function fetchCoverageAreas(filters) {
    const hasFilter = Object.values(filters).some(Boolean);
    if (!hasFilter) return allAreas;
    const qs = new URLSearchParams();
    if (filters.city) qs.set('city', filters.city);
    if (filters.status) qs.set('status', filters.status);
    if (filters.gasService) qs.set('gasService', filters.gasService);
    if (filters.riser) qs.set('riser', filters.riser);
    if (filters.search) qs.set('q', filters.search);
    try {
      const r = await fetch(`${apiUrl}?${qs.toString()}`);
      if (!r.ok) throw new Error('bad status');
      const data = await r.json();
      return data.areas;
    } catch {
      return filterAreas(allAreas, filters); // offline-safe fallback: filter the embedded dataset client-side
    }
  }

  const map = L.map('coverageMap', { scrollWheelZoom: false }).setView([27.2, 56.5], 8);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    maxZoom: 18
  }).addTo(map);
  mapEl.addEventListener('click', () => map.scrollWheelZoom.enable(), { once: true });

  let markers = L.layerGroup().addTo(map);
  const panel = document.getElementById('mapInfoPanel');

  function renderPanel(area) {
    const reqOptions = Object.entries(labels.requestTypeLabels || {}).map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    panel.innerHTML = `
      <div class="map-info-card">
        <h3>${escapeHtml(area.projectName)}</h3>
        <p class="map-info-location">${escapeHtml(area.city)}${area.district ? ' - ' + escapeHtml(area.district) : ''}</p>
        <dl class="map-info-list">
          <div><dt>تعداد پروژه (نمونه)</dt><dd>${area.projectCount}</dd></div>
          <div><dt>وضعیت پروژه</dt><dd>${PROJECT_STATUS_LABELS[area.projectStatus] || area.projectStatus}</dd></div>
          <div><dt>وضعیت رایزر گاز</dt><dd>${GAS_STATUS_LABELS[area.gasServiceStatus] || area.gasServiceStatus}</dd></div>
          <div><dt>نصب رایزر</dt><dd>${RISER_STATUS_LABELS[area.riserInstallationStatus] || area.riserInstallationStatus}</dd></div>
          <div><dt>شناسایی محل رایزر</dt><dd>${area.riserLocations ? 'بله' : 'خیر'}</dd></div>
          <div><dt>توسعهٔ آتی برنامه‌ریزی‌شده</dt><dd>${area.plannedExpansion ? 'بله' : 'خیر'}</dd></div>
          <div><dt>خدمات مهندسی موجود</dt><dd>${escapeHtml(area.serviceType || '—')}</dd></div>
        </dl>
        ${area.description ? `<p class="map-info-desc">${escapeHtml(area.description)}</p>` : ''}
        <p class="map-info-demo-note">⚠ این رکورد نمونه/آزمایشی است و نشان‌دهندهٔ وضعیت تأییدشدهٔ واقعی نیست.</p>
        <button type="button" class="button button-primary button-block" data-request-for="${area.id}" data-city="${escapeHtml(area.city)}" data-district="${escapeHtml(area.district || '')}">درخواست مشاوره برای این منطقه ←</button>
      </div>`;
  }
  function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  panel.addEventListener('click', event => {
    const btn = event.target.closest('[data-request-for]');
    if (!btn) return;
    const idField = document.getElementById('field_coverage_area_id');
    const cityField = document.getElementById('field_city');
    const districtField = document.getElementById('field_district');
    if (idField) idField.value = btn.dataset.requestFor;
    if (cityField) cityField.value = btn.dataset.city || '';
    if (districtField) districtField.value = btn.dataset.district || '';
    document.getElementById('consultation-form')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  });

  function renderMarkers(areas) {
    markers.clearLayers();
    areas.forEach(area => {
      if (!Number.isFinite(area.lat) || !Number.isFinite(area.lng)) return;
      const marker = L.circleMarker([area.lat, area.lng], {
        radius: 10, color: '#0b2e26', weight: 2, fillColor: statusColor(area), fillOpacity: 0.9
      });
      marker.bindTooltip(area.projectName, { direction: 'top' });
      marker.on('click', () => renderPanel(area));
      marker.addTo(markers);
    });
  }

  function updateCounts(areas) {
    const s = summarize(areas);
    const set = (id, v) => { const el = document.getElementById(id); if (el) animateCount(el, v); };
    set('statTotalProjects', s.totalProjects);
    set('statCompleted', s.completedProjects);
    set('statSurveyed', s.surveyedAreas);
    set('statPlanned', s.plannedAreas);
    const pc = document.getElementById('resultProjectCount'); if (pc) pc.textContent = s.totalProjects;
    const ac = document.getElementById('resultAreaCount'); if (ac) ac.textContent = s.areasCount;
  }
  // Exposed so public/js/motion.js's generic counter can be reused here without duplicating the easing code.
  function animateCount(el, target) {
    if (window.__novingityAnimateCount) return window.__novingityAnimateCount(el, target);
    el.textContent = target;
  }

  async function applyFilters() {
    const filters = {
      city: document.getElementById('filterCity')?.value || '',
      status: document.getElementById('filterStatus')?.value || '',
      gasService: document.getElementById('filterGas')?.value || '',
      riser: document.getElementById('filterRiser')?.value || '',
      search: document.getElementById('filterSearch')?.value.trim() || ''
    };
    const areas = await fetchCoverageAreas(filters);
    renderMarkers(areas);
    updateCounts(areas);
  }

  ['filterCity', 'filterStatus', 'filterGas', 'filterRiser'].forEach(id => document.getElementById(id)?.addEventListener('change', applyFilters));
  let searchDebounce;
  document.getElementById('filterSearch')?.addEventListener('input', () => { clearTimeout(searchDebounce); searchDebounce = setTimeout(applyFilters, 250); });
  document.getElementById('resetFilters')?.addEventListener('click', () => {
    ['filterCity', 'filterStatus', 'filterGas', 'filterRiser'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    const s = document.getElementById('filterSearch'); if (s) s.value = '';
    applyFilters();
  });

  renderMarkers(allAreas);
  updateCounts(allAreas);
})();
