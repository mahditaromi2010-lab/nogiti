'use strict';
/**
 * Gas meter selection rules for the "ابزارهای مهندسی" (engineering tools) calculators.
 * A small table of {type, min, max, spec} rows instead of one hard-coded if-statement, so a new meter
 * type/rule can be added later by appending a row (see public/js/tools.js for the client-side mirror of
 * this same table — the project ships no bundler, so the browser calculator keeps its own copy of the
 * rules array; this module exists so the rule logic itself is unit-testable and documented in one place).
 */
const METER_RULES = Object.freeze([
  Object.freeze({
    type: 'G2.5',
    min: 0.1,
    max: 4,
    unit: 'm3h', // مترمکعب بر ساعت
    replacementPipeLengthCm: 11,
    replacementPipeDiameterInch: 1,
    spacingCm: 10,
    heightCmMin: 180,
    heightCmMax: 220
  })
]);

/**
 * Finds the meter rule covering a consumption value (m3/h).
 * @param {number} consumption
 * @returns {{ok:true, rule:object}|{ok:false, reason:'invalid'|'not_covered'}}
 */
function evaluateMeterConsumption(consumption) {
  const value = Number(consumption);
  if (!Number.isFinite(value) || value <= 0) return { ok: false, reason: 'invalid' };
  const rule = METER_RULES.find(r => value >= r.min && value <= r.max);
  if (!rule) return { ok: false, reason: 'not_covered' };
  return { ok: true, rule };
}

module.exports = { METER_RULES, evaluateMeterConsumption };
