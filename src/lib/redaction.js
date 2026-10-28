'use strict';
/**
 * Log redaction. Adapted from Paradigmshift `apps/api/src/infra/redaction.ts`.
 * Keys that look like credentials are replaced; Iranian mobile numbers are masked.
 */
const SENSITIVE_KEY = /(?:authorization|cookie|set-cookie|password|passwd|secret|token|session|otp|verification.?code|api.?key|merchant.?id|_csrf|code_hash|password_hash)/i;
const PHONE_KEY = /(?:phone|mobile|msisdn|receptor|recipient)/i;

function maskPhone(value) {
  const digits = String(value).replace(/\D/g, '');
  if (digits.length < 7) return '[REDACTED_PHONE]';
  return `${digits.slice(0, 4)}${'*'.repeat(Math.max(3, digits.length - 6))}${digits.slice(-2)}`;
}

function redactString(value) {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    // Kavenegar puts the API key in the URL path: https://api.kavenegar.com/v1/<key>/sms/send.json
    .replace(/(api\.kavenegar\.com\/v1\/)[^/\s]+/gi, '$1[REDACTED]')
    .replace(/\b(?:\+98|0098|0)?9\d{9}\b/g, phone => maskPhone(phone));
}

function redactValue(value, key = '', depth = 0) {
  if (key && SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (key && PHONE_KEY.test(key) && typeof value === 'string') return maskPhone(value);
  if (depth > 6) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactValue(item, '', depth + 1));
  if (value instanceof Error) return { name: value.name, message: redactString(String(value.message || '')), code: value.code };
  if (value && typeof value === 'object') {
    const result = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 100)) result[childKey] = redactValue(childValue, childKey, depth + 1);
    return result;
  }
  if (typeof value === 'string') return redactString(value);
  return value;
}

module.exports = { redactValue, maskPhone };
