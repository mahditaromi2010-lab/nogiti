'use strict';
/**
 * Pure filtering/aggregation helpers for the Hormozgan coverage-map demo data (item 7).
 * Used by both the /api/coverage-areas endpoint (server-side filters, optional) and unit tests; the
 * browser map applies the same filters client-side over the full dataset it already fetched once.
 * Kept framework-free so it can be unit-tested without a database or a browser.
 */

/**
 * @param {Array<object>} areas coverage records (see db/migrations/0008_coverage_map.sql for the shape)
 * @param {{ city?:string, status?:string, gasService?:string, riser?:string, search?:string }} filters
 */
function filterCoverageAreas(areas, filters = {}) {
  const city = (filters.city || '').trim();
  const status = (filters.status || '').trim();
  const gasService = (filters.gasService || '').trim();
  const riser = (filters.riser || '').trim();
  const search = (filters.search || '').trim().toLowerCase();
  return (areas || []).filter(a => {
    if (city && a.city !== city) return false;
    if (status && a.projectStatus !== status) return false;
    if (gasService && a.gasServiceStatus !== gasService) return false;
    if (riser && a.riserInstallationStatus !== riser) return false;
    if (search && !`${a.projectName} ${a.city} ${a.district}`.toLowerCase().includes(search)) return false;
    return true;
  });
}

/** Totals shown on the summary cards — always computed from the (filtered or full) dataset, never hard-coded. */
function summarizeCoverageAreas(areas) {
  const list = areas || [];
  return {
    totalProjects: list.reduce((sum, a) => sum + (Number(a.projectCount) || 0), 0),
    areasCount: list.length,
    completedProjects: list.filter(a => a.projectStatus === 'completed').reduce((sum, a) => sum + (Number(a.projectCount) || 0), 0),
    surveyedAreas: list.filter(a => a.gasServiceStatus !== 'unknown').length,
    plannedAreas: list.filter(a => a.projectStatus === 'planned' || a.gasServiceStatus === 'planned').length
  };
}

/** Legend/marker colour for a coverage record. Never implies installed service unless explicitly set. */
function statusColor(area) {
  if (area.gasServiceStatus === 'installed') return 'green';
  if (area.gasServiceStatus === 'planned' || area.projectStatus === 'planned') return 'orange';
  // Blue = surveyed/assessed: gas service is confirmed not (yet) installed, but the riser situation has
  // actually been looked at (not merely "unknown"). Never implies service exists.
  if (area.gasServiceStatus === 'not_installed' && area.riserInstallationStatus && area.riserInstallationStatus !== 'unknown') return 'blue';
  return 'gray';
}

function uniqueCities(areas) {
  return [...new Set((areas || []).map(a => a.city).filter(Boolean))].sort();
}

module.exports = { filterCoverageAreas, summarizeCoverageAreas, statusColor, uniqueCities };
