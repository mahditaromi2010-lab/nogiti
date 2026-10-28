'use strict';
/**
 * Byte-signature ("magic number") validation for uploaded files.
 *
 * Adapted from Paradigmshift `apps/api/src/media/upload-validation.ts` (detectUploadType):
 * the browser-supplied Content-Type and file extension are never trusted on their own.
 * Only the formats Nogiti actually accepts are recognised (no audio, no QuickTime);
 * SVG, HTML, scripts, executables and unknown formats are always rejected.
 */
const fs = require('node:fs');

const SIGNATURE_BYTES = 32;
const NON_VIDEO_BRANDS = new Set(['qt  ', 'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis', 'M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B ', 'crx ']);

function starts(bytes, signature) {
  return bytes.length >= signature.length && signature.every((byte, i) => bytes[i] === byte);
}

/** Returns { kind, mime, ext } for supported formats, otherwise null. */
function detectFileType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4) return null;
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', mime: 'image/png', ext: '.png' };
  if (starts(bytes, [0xff, 0xd8, 0xff])) return { kind: 'image', mime: 'image/jpeg', ext: '.jpg' };
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp', ext: '.webp' };
  const head6 = bytes.toString('ascii', 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return { kind: 'image', mime: 'image/gif', ext: '.gif' };
  if (starts(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { kind: 'pdf', mime: 'application/pdf', ext: '.pdf' };
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    // QuickTime ("qt  ") is deliberately not accepted: Nogiti only serves .mp4/.webm.
    // HEIF/AVIF still images and audio-only M4A use the same ISO-BMFF container; the Paradigmshift
    // detector treated every non-audio brand as video, which would let a HEIC photo pass as an MP4 lesson.
    if (NON_VIDEO_BRANDS.has(bytes.toString('ascii', 8, 12))) return null;
    return { kind: 'video', mime: 'video/mp4', ext: '.mp4' };
  }
  if (starts(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: 'video', mime: 'video/webm', ext: '.webm' };
  // Local file header, empty archive, spanned archive.
  if (starts(bytes, [0x50, 0x4b, 0x03, 0x04]) || starts(bytes, [0x50, 0x4b, 0x05, 0x06]) || starts(bytes, [0x50, 0x4b, 0x07, 0x08])) {
    return { kind: 'zip', mime: 'application/zip', ext: '.zip' };
  }
  return null;
}

async function readSignature(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(SIGNATURE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SIGNATURE_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Validates a file already written by multer.
 * @param {string} filePath
 * @param {{ allowedKinds: string[], expectedExt?: string }} policy
 * @returns {Promise<{ ok: true, detected: object } | { ok: false, reason: 'EMPTY_FILE'|'UNSUPPORTED_FILE'|'KIND_MISMATCH'|'EXTENSION_MISMATCH' }>}
 */
async function validateStoredFile(filePath, policy) {
  const bytes = await readSignature(filePath);
  if (!bytes.length) return { ok: false, reason: 'EMPTY_FILE' };
  const detected = detectFileType(bytes);
  if (!detected) return { ok: false, reason: 'UNSUPPORTED_FILE' };
  if (!policy.allowedKinds.includes(detected.kind)) return { ok: false, reason: 'KIND_MISMATCH' };
  if (policy.expectedExt) {
    const ext = String(policy.expectedExt).toLowerCase();
    const equivalent = ext === '.jpeg' ? '.jpg' : ext;
    if (equivalent !== detected.ext) return { ok: false, reason: 'EXTENSION_MISMATCH' };
  }
  return { ok: true, detected };
}

const FAILURE_MESSAGES = {
  EMPTY_FILE: 'فایل خالی است یا کامل منتقل نشده است؛ دوباره بارگذاری کنید.',
  UNSUPPORTED_FILE: 'محتوای واقعی فایل در قالب‌های مجاز نیست. فقط JPG، PNG، WebP، GIF، PDF، MP4، WebM و ZIP پذیرفته می‌شوند.',
  KIND_MISMATCH: 'محتوای واقعی فایل با نوع انتخاب‌شده هم‌خوانی ندارد.',
  EXTENSION_MISMATCH: 'پسوند فایل با محتوای واقعی آن هم‌خوانی ندارد.'
};

function uploadFailureMessage(reason) {
  return FAILURE_MESSAGES[reason] || FAILURE_MESSAGES.UNSUPPORTED_FILE;
}

module.exports = { detectFileType, validateStoredFile, uploadFailureMessage, SIGNATURE_BYTES };
