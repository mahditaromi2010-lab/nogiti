'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateMeterConsumption, METER_RULES } = require('../../src/lib/meter-rules');
const { filterCoverageAreas, summarizeCoverageAreas, statusColor, uniqueCities } = require('../../src/lib/coverage-filter');
const { normalizeIranMobile } = require('../../src/lib/text');

// ───────────── Item 3: G2.5 gas meter rule evaluator ─────────────
test('G2.5 meter rule: consumption within 0.1-4 m3/h returns the exact fixed spec', () => {
  for (const value of [0.1, 1, 2.5, 4]) {
    const result = evaluateMeterConsumption(value);
    assert.equal(result.ok, true, `${value} should be covered`);
    assert.equal(result.rule.type, 'G2.5');
    assert.equal(result.rule.replacementPipeLengthCm, 11);
    assert.equal(result.rule.replacementPipeDiameterInch, 1);
    assert.equal(result.rule.spacingCm, 10);
    assert.equal(result.rule.heightCmMin, 180);
    assert.equal(result.rule.heightCmMax, 220);
  }
});

test('G2.5 meter rule: consumption outside 0.1-4 is reported as not covered, not fabricated', () => {
  for (const value of [0.05, 4.01, 10, 100]) {
    const result = evaluateMeterConsumption(value);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_covered');
  }
});

test('G2.5 meter rule: invalid/non-numeric input is rejected distinctly from "not covered"', () => {
  for (const value of [NaN, -1, 0, 'abc', undefined, null]) {
    const result = evaluateMeterConsumption(value);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid');
  }
});

test('meter rules table can grow without changing the evaluator function', () => {
  assert.ok(Array.isArray(METER_RULES));
  assert.equal(METER_RULES.length, 1, 'only G2.5 is defined for now, by design');
});

// ───────────── Item 8: Iranian mobile number validator (reused from src/lib/text.js) ─────────────
test('Iranian mobile validator accepts the documented formats (consultation-request form)', () => {
  for (const input of ['09121234567', '9121234567', '+989121234567', '00989121234567', '989121234567', '0912 123 4567', '0912-123-4567']) {
    assert.equal(normalizeIranMobile(input), '09121234567', input);
  }
});
test('Iranian mobile validator rejects malformed numbers (consultation-request form)', () => {
  for (const input of ['', '0812123456', '091212345', 'abc', '123']) {
    assert.equal(normalizeIranMobile(input), null, input);
  }
});

// ───────────── Item 7: Hormozgan coverage-map data-filtering logic ─────────────
const demoAreas = [
  { projectName: 'A', city: 'بندرعباس', district: 'مرکز', projectStatus: 'completed', gasServiceStatus: 'installed', riserInstallationStatus: 'installed', projectCount: 2 },
  { projectName: 'B', city: 'قشم', district: 'مرکز', projectStatus: 'planned', gasServiceStatus: 'planned', riserInstallationStatus: 'planned', projectCount: 1 },
  { projectName: 'C', city: 'میناب', district: 'مرکز', projectStatus: 'under_review', gasServiceStatus: 'unknown', riserInstallationStatus: 'unknown', projectCount: 1 },
  { projectName: 'D', city: 'بندرعباس', district: 'شرق', projectStatus: 'in_progress', gasServiceStatus: 'not_installed', riserInstallationStatus: 'installed', projectCount: 1 }
];

test('coverage filter: no filters returns everything', () => {
  assert.equal(filterCoverageAreas(demoAreas, {}).length, 4);
});
test('coverage filter: filters by city', () => {
  const result = filterCoverageAreas(demoAreas, { city: 'بندرعباس' });
  assert.equal(result.length, 2);
  assert.ok(result.every(a => a.city === 'بندرعباس'));
});
test('coverage filter: filters by project status and gas service status combined', () => {
  assert.deepEqual(filterCoverageAreas(demoAreas, { status: 'planned' }).map(a => a.projectName), ['B']);
  assert.deepEqual(filterCoverageAreas(demoAreas, { gasService: 'installed' }).map(a => a.projectName), ['A']);
});
test('coverage filter: text search matches project name, city or district (case-insensitive)', () => {
  assert.deepEqual(filterCoverageAreas(demoAreas, { search: 'قشم' }).map(a => a.projectName), ['B']);
  assert.deepEqual(filterCoverageAreas(demoAreas, { search: 'nomatch' }), []);
});

test('coverage summary: totals and area counts are always computed, never hard-coded', () => {
  const summary = summarizeCoverageAreas(demoAreas);
  assert.equal(summary.totalProjects, 5);
  assert.equal(summary.areasCount, 4);
  assert.equal(summary.completedProjects, 2);
  assert.equal(summary.surveyedAreas, 3); // gasServiceStatus !== 'unknown'
  assert.equal(summary.plannedAreas, 1);
  const filtered = filterCoverageAreas(demoAreas, { city: 'بندرعباس' });
  const filteredSummary = summarizeCoverageAreas(filtered);
  assert.equal(filteredSummary.totalProjects, 3);
  assert.equal(filteredSummary.areasCount, 2);
});

test('coverage legend colour never implies gas service unless the data says so', () => {
  assert.equal(statusColor(demoAreas[0]), 'green'); // installed
  assert.equal(statusColor(demoAreas[1]), 'orange'); // planned
  assert.equal(statusColor(demoAreas[2]), 'gray'); // unknown
  assert.equal(statusColor(demoAreas[3]), 'blue'); // not_installed but riser status known/tracked
});

test('coverage unique cities: sorted, de-duplicated', () => {
  assert.deepEqual(uniqueCities(demoAreas), ['بندرعباس', 'قشم', 'میناب'].sort());
});
