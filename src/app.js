'use strict';
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const compression = require('compression');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const {
  ROLES, ROLE_LABELS, ROLE_HOME, permissionForPath, hasPermission, validAdminUsername, adminPasswordProblem, validRole
} = require('./admin-security');
const { validateStoredFile, uploadFailureMessage } = require('./lib/upload-validation');
const { PgThrottle, ThrottleUnavailableError } = require('./lib/pg-throttle');
const { renderArticleBody } = require('./lib/rich-text');
const { safeNextPath } = require('./lib/safe-next');
const { parsePage, buildWhere, pagination, queryString } = require('./lib/listing');
const { digitsEnglish, normalizeIranMobile, normalizeText, isValidEmail } = require('./lib/text');
const { logger: defaultLogger } = require('./lib/logger');
const { listMigrations } = require('./lib/migrations');
const { i18nMiddleware, resolveLocale, DEFAULT_LOCALE, LOCALE_COOKIE } = require('./lib/i18n');

// Versions shipped with this build; read once at start-up.
const EXPECTED_MIGRATIONS = listMigrations().map(m => m.version);

const ROOT = path.join(__dirname, '..');
const SESSION_COOKIE = 'nugas.sid';
const ADMIN_IDLE_MS = 2 * 60 * 60 * 1000;
const ADMIN_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
// Durable admin-login failure limits (PostgreSQL, shared by all replicas, survive restarts).
const ADMIN_LOGIN_LIMITS = { username: { limit: 8, windowMs: 15 * 60 * 1000 }, ip: { limit: 30, windowMs: 15 * 60 * 1000 } };
const STATUS_LABELS = { draft: 'پیش‌نویس', published: 'منتشرشده', archived: 'آرشیو' };
const ORDER_STATUS_LABELS = { paid: 'موفق', pending: 'در انتظار', failed: 'ناموفق', cancelled: 'لغو شده' };

/**
 * Builds the Express application. No network listener is opened here, so tests can mount it on an
 * ephemeral port against a disposable database.
 * @param {{ pool: import('pg').Pool, logger?: object, uploadDir?: string }} options
 */
function createApp({ pool, logger = defaultLogger, uploadDir } = {}) {
  if (!pool) throw new Error('createApp requires a pg pool');
  const app = express();
  const IS_PROD = process.env.NODE_ENV === 'production';
  const PORT = Number(process.env.PORT || 3000);
  const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
  const APP_ORIGIN = new URL(APP_URL).origin;
  const UPLOAD_DIR = path.resolve(ROOT, uploadDir || process.env.UPLOAD_DIR || 'uploads');
  const COVERS_DIR = path.join(UPLOAD_DIR, 'covers');
  const PRIVATE_DIR = path.join(UPLOAD_DIR, 'private');
  const MAX_UPLOAD_MB = Math.max(1, Number(process.env.MAX_UPLOAD_MB || 100));
  const SECRET = process.env.APP_SECRET || 'local-development-only-change-this-secret';
  let settingsCache = { site_name: 'Nogiti', site_tagline: 'ابزارهای مهندسی و آموزش تخصصی تأسیسات' };
  const throttle = new PgThrottle(pool, SECRET);
  const dummyAdminHashPromise = bcrypt.hash('invalid-login-dummy-password', 12);

  for (const dir of [UPLOAD_DIR, COVERS_DIR, PRIVATE_DIR]) fs.mkdirSync(dir, { recursive: true });
  if (IS_PROD && (!process.env.APP_SECRET || process.env.APP_SECRET.length < 32 || /^(replace|change|your)[-_]/i.test(process.env.APP_SECRET))) {
    throw new Error('در محیط production باید APP_SECRET تصادفی و حداقل ۳۲ نویسه باشد.');
  }

  app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  if (IS_PROD) app.set('view cache', true);
  app.disable('x-powered-by');

  // Correlation id for logs and the user-facing 500 page (pattern from Paradigmshift HttpExceptionFilter).
  app.use((req, res, next) => {
    req.id = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  });
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        mediaSrc: ["'self'", 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'", 'https://www.zarinpal.com', 'https://sandbox.zarinpal.com'],
        frameAncestors: ["'self'"],
        upgradeInsecureRequests: IS_PROD ? [] : null
      }
    },
    crossOriginEmbedderPolicy: false
  }));
  app.use(compression());
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(express.json({ limit: '256kb' }));
  app.use(i18nMiddleware());
  app.use('/public/fonts', express.static(path.join(ROOT, 'public', 'fonts'), { maxAge: IS_PROD ? '365d' : 0, immutable: IS_PROD, index: false }));
  app.use('/public', express.static(path.join(ROOT, 'public'), { maxAge: IS_PROD ? '7d' : 0, index: false }));
  app.use('/media/covers', express.static(COVERS_DIR, { maxAge: IS_PROD ? '1d' : 0, index: false, dotfiles: 'deny' }));

  // Health endpoints (live/ready split from Paradigmshift HealthController). Mounted before sessions so probes never create sessions.
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'nogiti-platform' }));
  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      // Ready only when every migration shipped with this build is applied (a new release whose
      // migration failed must not receive traffic).
      const table = await pool.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present");
      const applied = table.rows[0].present ? new Set((await pool.query('SELECT version FROM schema_migrations')).rows.map(r => r.version)) : new Set();
      const pending = EXPECTED_MIGRATIONS.filter(v => !applied.has(v));
      if (pending.length) return res.status(503).json({ status: 'unavailable', checks: { database: 'ok', migrations: 'pending' }, pending });
      res.json({ status: 'ok', checks: { database: 'ok', migrations: 'ok' } });
    } catch {
      res.status(503).json({ status: 'unavailable', checks: { database: 'unavailable' } });
    }
  });

  app.use(session({
    store: new PgSession({ pool, tableName: 'web_sessions', createTableIfMissing: false, pruneSessionInterval: process.env.NODE_ENV === 'test' ? false : 15 * 60 }),
    name: SESSION_COOKIE,
    secret: SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, secure: IS_PROD && APP_URL.startsWith('https://'), sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 7 }
  }));

  const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const slugBase = text => String(text || '').trim().toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 160) || `item-${Date.now()}`;
  const money = value => `${new Intl.NumberFormat('fa-IR').format(Number(value || 0))} تومان`;
  const safeEqual = (a, b) => {
    const ba = Buffer.from(String(a || ''));
    const bb = Buffer.from(String(b || ''));
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  };
  const isHttpsUrl = s => { try { return new URL(s).protocol === 'https:'; } catch { return false; } };
  const setFlash = (req, type, message) => { req.session.flash = { type, message }; };
  const renderError = (res, status, title, message, extra = {}) => res.status(status).render('error', { title, message, ...extra });
  const removeUploaded = req => {
    const files = [req.file, ...Object.values(req.files || {}).flat()].filter(Boolean);
    for (const f of files) if (f.path) fs.rmSync(f.path, { force: true });
  };

  // Cross-site request rejection before any body/file is processed (pattern from Paradigmshift
  // AdminPasswordController.assertTrustedOrigin). Complements the per-session CSRF token.
  const originGuard = (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (!origin || origin === 'null') return next(); // token check below still applies
    const hostOrigin = `${req.protocol}://${req.get('host')}`;
    if (origin === APP_ORIGIN || origin === hostOrigin) return next();
    logger.warn('cross-origin state-changing request rejected', { requestId: req.id, route: req.path });
    return renderError(res, 403, 'درخواست نامعتبر', 'این درخواست از مبدأ نامعتبر ارسال شده است.');
  };

  const csrfGuard = (req, res, next) => {
    if (req.method !== 'POST' || req.is('multipart/form-data')) return next();
    if (!safeEqual(req.session.csrfToken, req.body?._csrf)) return renderError(res, 403, 'درخواست نامعتبر', 'اعتبار فرم منقضی شده است. صفحه را تازه‌سازی کنید و دوباره تلاش کنید.');
    next();
  };
  app.use((req, res, next) => {
    // The CSRF token (and therefore the session row + cookie) is created only when a rendered page
    // actually contains a form. Previously every anonymous page view, including crawlers and health
    // checkers, inserted a row into web_sessions.
    // (A getter on res.locals would not work: Express copies locals into the render options.
    // EJS converts `<%= csrfToken %>` with String(), so the token is created at that moment.)
    const csrfToken = () => {
      if (!req.session) return ''; // session already destroyed (logout / expiry page): no form can be submitted
      if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      return req.session.csrfToken;
    };
    res.locals.csrfToken = { toString: csrfToken, valueOf: csrfToken, toJSON: csrfToken };
    res.locals.money = money;
    res.locals.siteName = settingsCache.site_name || 'Nogiti';
    res.locals.siteTagline = settingsCache.site_tagline || 'مهندسی با اطمینان';
    res.locals.siteEmail = settingsCache.contact_email || '';
    res.locals.currentUser = null;
    res.locals.currentAdmin = null;
    res.locals.can = () => false;
    res.locals.roleHome = null;
    res.locals.currentPath = req.path;
    res.locals.requestId = req.id;
    res.locals.flash = req.session.flash || null;
    res.locals.statusLabels = STATUS_LABELS;
    res.locals.orderStatusLabels = ORDER_STATUS_LABELS;
    res.locals.roleLabels = ROLE_LABELS;
    res.locals.qs = queryString;
    delete req.session.flash;
    next();
  });
  app.use(originGuard);
  app.use(csrfGuard);
  app.use(asyncRoute(async (req, res, next) => {
    if (req.session.userId) {
      const u = await pool.query('SELECT id, phone, first_name, last_name, role, branch, field, is_active FROM users WHERE id=$1', [req.session.userId]);
      if (!u.rowCount || !u.rows[0].is_active) {
        req.session.userId = null;
        req.session.role = null;
      } else {
        req.user = u.rows[0];
        res.locals.currentUser = req.user;
      }
    }
    next();
  }));
  app.use(asyncRoute(async (req, res, next) => {
    if (req.session.adminAccountId) {
      const result = await pool.query('SELECT id,username,role,is_active,session_version,last_login_at FROM admin_accounts WHERE id=$1', [req.session.adminAccountId]);
      const admin = result.rows[0];
      if (!admin || !admin.is_active || Number(admin.session_version) !== Number(req.session.adminSessionVersion)) {
        // Revoked (deactivated, role/password changed): start a clean anonymous session so the page that
        // follows - typically the admin login form - carries a valid CSRF token.
        return req.session.regenerate(error => next(error));
      }
      req.admin = admin;
      res.locals.currentAdmin = admin;
      res.locals.can = permission => hasPermission(admin.role, permission);
      res.locals.roleHome = ROLE_HOME[admin.role];
    }
    next();
  }));

  // Numeric route ids: malformed values are a 404, never a database error (previously HTTP 500).
  app.param('id', (req, res, next, value) => {
    if (!/^[1-9]\d{0,17}$/.test(String(value))) return renderError(res, 404, 'پیدا نشد', 'شناسهٔ درخواست‌شده معتبر نیست.');
    next();
  });

  const rateOptions = (limit, windowMs = 15 * 60 * 1000) => rateLimit({
    windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false,
    handler: (req, res) => renderError(res, 429, 'درخواست‌های زیاد', 'تعداد درخواست‌ها بیش از حد مجاز است. کمی بعد دوباره امتحان کنید.')
  });
  // Coarse per-process flood control on public OTP endpoints (credential-failure counting for admins is durable, see PgThrottle).
  const verifyCodeLimiter = rateOptions(8);
  const otpLimiter = rateOptions(3, 10 * 60 * 1000);
  const requireAuth = (req, res, next) => {
    if (!req.user) {
      if (req.method === 'GET') req.session.returnTo = safeNextPath(req.originalUrl, '/account');
      setFlash(req, 'info', 'برای ادامه ابتدا وارد حساب کاربری شوید.');
      return req.session.save(() => res.redirect('/login'));
    }
    next();
  };

  const requireAdmin = (req, res, next) => {
    if (!req.admin || !req.admin.is_active) {
      if (req.method === 'GET') return renderError(res, 403, 'دسترسی مجاز نیست', 'این بخش فقط برای مدیران واردشده مجاز است.', { actionHref: '/admin/login', actionLabel: 'ورود مدیر' });
      return res.status(403).send('Forbidden');
    }
    const permission = permissionForPath(req.path);
    if (permission === 'overview' && !hasPermission(req.admin.role, 'overview')) {
      const destination = ROLE_HOME[req.admin.role];
      if (destination && destination !== '/admin' && req.method === 'GET') return res.redirect(destination);
    }
    if (!hasPermission(req.admin.role, permission)) {
      if (req.method === 'GET') return renderError(res, 403, 'مجوز کافی نیست', 'نقش مدیریتی شما اجازهٔ دسترسی به این بخش را ندارد.');
      return res.status(403).send('Forbidden');
    }
    next();
  };

  // Admin routes are never cached. Inactivity expires privileged sessions after two hours, absolute limit 12 hours.
  app.use('/admin', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    if (req.path === '/login' || req.path === '/login/') return next();
    if (req.admin) {
      const now = Date.now();
      const last = Number(req.session.adminLastActivity || now);
      const started = Number(req.session.adminSessionStartedAt || now);
      if (now - last > ADMIN_IDLE_MS || now - started > ADMIN_ABSOLUTE_MS) {
        const adminId = req.admin.id;
        res.locals.currentAdmin = null;
        res.locals.can = () => false;
        return req.session.destroy(() => {
          void writeAdminAudit(adminId, 'admin.session.expired', req, 401);
          res.clearCookie(SESSION_COOKIE);
          renderError(res, 401, 'نشست منقضی شد', 'به دلیل عدم فعالیت یا پایان مدت مجاز، نشست مدیریت پایان یافته است. دوباره وارد شوید.', { actionHref: '/admin/login', actionLabel: 'ورود دوباره' });
        });
      }
      req.session.adminLastActivity = now;
    }
    next();
  });

  async function writeAdminAudit(actorId, action, req, statusCode = 200) {
    if (actorId === undefined) return;
    try {
      await pool.query(
        'INSERT INTO admin_audit_logs(admin_account_id,action,method,route,status_code,ip_address,user_agent) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [actorId, String(action).slice(0, 120), req.method, String(req.originalUrl || req.path).split('?')[0].slice(0, 500), statusCode,
          String(req.ip || '').slice(0, 80), String(req.get('user-agent') || '').slice(0, 300)]
      );
    } catch (error) {
      // Auditing failure is visible to operators but never exposes request contents or blocks the action.
      logger.error('admin audit write failed', { requestId: req.id, error });
    }
  }
  // Generic mutation audit. Requests that ended with an error flash are recorded as "rejected" instead of as a success.
  app.use('/admin', (req, res, next) => {
    if (!req.admin || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || req.path === '/login' || req.path.startsWith('/admins') || req.path.startsWith('/account') || req.path === '/logout') return next();
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      const rejected = req.session?.flash?.type === 'error';
      void writeAdminAudit(req.admin.id, `admin.mutation${rejected ? '.rejected' : ''}:${req.method.toLowerCase()} ${req.route?.path || req.path}`, req, rejected ? 422 : res.statusCode);
    });
    next();
  });

  const coverExtensionByType = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
  const coverStorage = multer.diskStorage({ destination: (_req, _file, cb) => cb(null, COVERS_DIR), filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${coverExtensionByType[file.mimetype] || '.img'}`) });
  const privateStorage = multer.diskStorage({ destination: (_req, _file, cb) => cb(null, PRIVATE_DIR), filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`) });
  const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  const allowedAssetMimesByExtension = {
    '.pdf': new Set(['application/pdf', 'application/octet-stream']),
    '.mp4': new Set(['video/mp4', 'application/octet-stream']),
    '.webm': new Set(['video/webm', 'application/octet-stream']),
    '.zip': new Set(['application/zip', 'application/x-zip-compressed', 'application/octet-stream'])
  };
  const imageFilter = (_req, file, cb) => cb(allowedImageTypes.has(file.mimetype) ? null : new Error('File type rejected'), allowedImageTypes.has(file.mimetype));
  const coverUpload = multer({ storage: coverStorage, limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 40 }, fileFilter: imageFilter });
  const articleUpload = multer({ storage: coverStorage, limits: { fileSize: 8 * 1024 * 1024, files: 11, fields: 40 }, fileFilter: imageFilter }).fields([{ name: 'cover', maxCount: 1 }, { name: 'inline_images', maxCount: 10 }]);
  const assetUpload = multer({ storage: privateStorage, limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 40 }, fileFilter: (_req, file, cb) => { const ext = path.extname(file.originalname).toLowerCase(); const ok = !!allowedAssetMimesByExtension[ext]?.has(file.mimetype); cb(ok ? null : new Error('File type rejected'), ok); } });
  // Multipart CSRF check runs after multer parsed the token; any file already written is removed on failure.
  const multipartCsrf = (req, res, next) => {
    if (!safeEqual(req.session.csrfToken, req.body?._csrf)) {
      removeUploaded(req);
      return renderError(res, 403, 'درخواست نامعتبر', 'اعتبار فرم منقضی شده است. صفحه را تازه‌سازی کنید و دوباره تلاش کنید.');
    }
    next();
  };
  // Content sniffing of every stored upload (magic bytes; adapted from Paradigmshift upload-validation.ts).
  const verifyUploads = (policyFor, redirectTo) => asyncRoute(async (req, res, next) => {
    const files = [req.file, ...Object.values(req.files || {}).flat()].filter(Boolean);
    for (const f of files) {
      const policy = policyFor(f, req);
      const result = await validateStoredFile(f.path, policy);
      if (!result.ok) {
        removeUploaded(req);
        setFlash(req, 'error', uploadFailureMessage(result.reason));
        return res.redirect(typeof redirectTo === 'function' ? redirectTo(req) : redirectTo);
      }
      // Public images are stored under a server-chosen name; make its extension match the verified bytes
      // (a PNG the browser labelled image/jpeg is served as .png), so express.static sends the right type.
      if (policy.renameToDetected && path.extname(f.filename) !== result.detected.ext) {
        const filename = `${path.basename(f.filename, path.extname(f.filename))}${result.detected.ext}`;
        const target = path.join(path.dirname(f.path), filename);
        await fs.promises.rename(f.path, target);
        f.filename = filename;
        f.path = target;
      }
    }
    next();
  });
  // Image covers: the stored extension comes from the server, not the client, so it is corrected rather than rejected.
  const imagePolicy = () => ({ allowedKinds: ['image'], renameToDetected: true });
  const assetKinds = { video: ['video'], pdf: ['pdf'], download: ['zip', 'pdf'], link: [] };
  const assetPolicy = (file, req) => ({ allowedKinds: assetKinds[req.body.asset_kind] || assetKinds.download, expectedExt: path.extname(file.originalname) });

  async function getSettings() {
    try {
      const r = await pool.query('SELECT setting_key, setting_value FROM site_settings');
      settingsCache = { ...settingsCache, ...Object.fromEntries(r.rows.map(x => [x.setting_key, x.setting_value])) };
    } catch { /* Keep the last known public settings when storage is temporarily unavailable. */ }
    return { ...settingsCache };
  }
  async function uniqueSlug(table, title, id = null) {
    if (!['products', 'articles'].includes(table)) throw new Error('Invalid table');
    const base = slugBase(title);
    let slug = base;
    let i = 2;
    while (true) {
      const args = id ? [slug, id] : [slug];
      const q = id ? `SELECT 1 FROM ${table} WHERE slug=$1 AND id<>$2 LIMIT 1` : `SELECT 1 FROM ${table} WHERE slug=$1 LIMIT 1`;
      const found = await pool.query(q, args);
      if (!found.rowCount) return slug;
      slug = `${base}-${i++}`;
    }
  }
  function acceptableCoverValue(file, value) {
    if (file) return `/media/covers/${file.filename}`;
    const v = String(value || '').trim();
    if (!v) return '';
    if (/^\/media\/covers\/[A-Za-z0-9-]+\.(?:jpg|png|webp|gif)$/.test(v)) return v;
    return isHttpsUrl(v) && v.length <= 500 ? v : '';
  }
  // Deletes a replaced cover file once no product, article or article image refers to it any more
  // (the same /media/covers path may have been pasted into another item's cover field).
  async function removeCoverIfUnused(oldPath, newPath) {
    if (!oldPath || oldPath === newPath || !/^\/media\/covers\/[A-Za-z0-9-]+\.(?:jpg|png|webp|gif)$/.test(oldPath)) return;
    const used = await pool.query(`SELECT (SELECT COUNT(*) FROM products WHERE cover_image=$1) + (SELECT COUNT(*) FROM articles WHERE cover_image=$1)
      + (SELECT COUNT(*) FROM article_images WHERE image_path=$1) AS n`, [oldPath]);
    if (Number(used.rows[0].n) === 0) await fs.promises.rm(path.join(COVERS_DIR, path.basename(oldPath)), { force: true });
  }
  const intInRange = (value, min, max, fallback) => {
    const n = Number.parseInt(digitsEnglish(value), 10);
    return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
  };

  // ───────────── Language switcher (cookie only; no account/session state) ─────────────
  // A same-site-only redirect check (same rules as safeNextPath) without its narrower allow-list,
  // since switching language can happen from any public page, not just the post-login destinations.
  const safeLocalPath = (value, fallback = '/') => {
    if (typeof value !== 'string' || !value || value.length > 512) return fallback;
    if (!value.startsWith('/') || value.startsWith('//')) return fallback;
    if (value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return fallback;
    try { const u = new URL(value, 'https://site.invalid'); return u.origin === 'https://site.invalid' ? `${u.pathname}${u.search}` : fallback; } catch { return fallback; }
  };
  app.get('/lang/:code', (req, res) => {
    const locale = resolveLocale(req.params.code) || DEFAULT_LOCALE;
    res.cookie(LOCALE_COOKIE, locale, { maxAge: 1000 * 60 * 60 * 24 * 365, httpOnly: false, sameSite: 'lax', secure: IS_PROD && APP_URL.startsWith('https://') });
    res.redirect(safeLocalPath(req.query.next, '/'));
  });

  // ───────────── Public pages ─────────────
  app.get('/', asyncRoute(async (req, res) => {
    const [settings, products, articles] = await Promise.all([
      getSettings(),
      pool.query("SELECT * FROM products WHERE status='published' ORDER BY featured DESC, created_at DESC LIMIT 3"),
      pool.query("SELECT * FROM articles WHERE status='published' ORDER BY published_at DESC NULLS LAST, created_at DESC LIMIT 3")
    ]);
    res.render('home', { title: 'خانه', settings, products: products.rows, articles: articles.rows });
  }));
  app.get('/shop', asyncRoute(async (req, res) => {
    const type = ['course', 'plugin'].includes(req.query.type) ? req.query.type : '';
    const { where, params, q } = buildWhere({ q: req.query.q, searchColumns: ['title', 'short_description', 'category'], filters: [['product_type', type]], base: ["status='published'"] });
    const products = await pool.query(`SELECT * FROM products ${where} ORDER BY featured DESC, created_at DESC`, params);
    res.render('shop', { title: 'فروشگاه', products: products.rows, type, q });
  }));
  app.get('/shop/:slug', asyncRoute(async (req, res) => {
    const p = await pool.query("SELECT * FROM products WHERE slug=$1 AND status='published'", [req.params.slug]);
    if (!p.rowCount) return renderError(res, 404, 'محصول پیدا نشد', 'این محصول وجود ندارد یا در حال حاضر منتشر نشده است.');
    const product = p.rows[0];
    let owned = false;
    if (req.user) {
      const own = await pool.query("SELECT 1 FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.user_id=$1 AND o.status='paid' AND oi.product_id=$2 LIMIT 1", [req.user.id, product.id]);
      owned = !!own.rowCount;
    }
    const assets = await pool.query('SELECT id,title,asset_kind,is_preview,sort_order FROM product_assets WHERE product_id=$1 ORDER BY sort_order,id', [product.id]);
    res.render('product', { title: product.title, product, assets: assets.rows, owned });
  }));
  app.get('/articles', asyncRoute(async (req, res) => {
    const { where, params, q } = buildWhere({ q: req.query.q, searchColumns: ['title', 'excerpt', 'category'], base: ["status='published'"] });
    const articles = await pool.query(`SELECT * FROM articles ${where} ORDER BY published_at DESC NULLS LAST, created_at DESC`, params);
    res.render('articles', { title: 'مقالات تخصصی', articles: articles.rows, q });
  }));
  app.get('/articles/:slug', asyncRoute(async (req, res) => {
    const r = await pool.query("SELECT * FROM articles WHERE slug=$1 AND status='published'", [req.params.slug]);
    if (!r.rowCount) return renderError(res, 404, 'مقاله پیدا نشد', 'این مقاله وجود ندارد یا منتشر نشده است.');
    const article = r.rows[0];
    const images = await pool.query('SELECT id,image_path,alt_text,sort_order FROM article_images WHERE article_id=$1 ORDER BY sort_order,id', [article.id]);
    const bodySource = (req.locale === 'en' && article.content_en) ? article.content_en : article.content;
    res.render('article', { title: article.title, article, contentHtml: renderArticleBody(bodySource, images.rows) });
  }));
  app.get('/about', asyncRoute(async (req, res) => {
    const [settings, team] = await Promise.all([getSettings(), pool.query('SELECT * FROM team_members WHERE is_active ORDER BY display_order,id')]);
    res.render('about', { title: 'درباره Nogiti', settings, teamMembers: team.rows });
  }));
  app.get('/tools', (_req, res) => res.render('tools', { title: 'ابزارهای تأسیسات' }));

  // ───────────── OTP authentication ─────────────
  const otpHash = (phone, code) => crypto.createHash('sha256').update(`${phone}:${code}:${process.env.APP_SECRET || 'dev'}`).digest('hex');
  app.get('/login', (req, res) => {
    if (req.query.next) req.session.returnTo = safeNextPath(String(req.query.next), '/account');
    if (req.user && req.query.step !== 'code') return res.redirect(safeNextPath(req.session.returnTo, '/account'));
    res.render('login', { title: 'ورود به حساب', step: req.query.step === 'code' ? 'code' : 'phone', devOtp: !IS_PROD && process.env.SHOW_DEV_OTP === 'true' ? req.session.devOtp : null, draftPhone: req.session.loginDraft?.phone || '' });
  });
  app.post('/auth/request-code', otpLimiter, asyncRoute(async (req, res) => {
    const phone = normalizeIranMobile(String(req.body.phone || ''));
    const firstName = normalizeText(req.body.firstName, 100);
    const lastName = normalizeText(req.body.lastName, 100);
    if (!phone) { setFlash(req, 'error', 'شمارهٔ موبایل معتبر نیست؛ نمونهٔ درست: 09121234567'); return res.redirect('/login'); }
    const recent = await pool.query("SELECT 1 FROM otp_codes WHERE phone=$1 AND created_at > NOW() - INTERVAL '60 seconds' AND consumed_at IS NULL LIMIT 1", [phone]);
    if (recent.rowCount) { setFlash(req, 'info', 'برای این شماره اخیراً کد صادر شده است؛ یک دقیقه صبر کنید.'); return res.redirect('/login'); }
    const code = String(crypto.randomInt(100000, 1000000));
    await pool.query('INSERT INTO otp_codes(phone,code_hash,expires_at) VALUES($1,$2,NOW()+INTERVAL \'5 minutes\')', [phone, otpHash(phone, code)]);
    const message = `کد ورود Nogiti: ${code}\nاعتبار: ۵ دقیقه`;
    if (process.env.KAVENEGAR_API_KEY) {
      try {
        const body = new URLSearchParams({ receptor: phone, message });
        if (process.env.KAVENEGAR_SENDER) body.set('sender', process.env.KAVENEGAR_SENDER);
        const response = await fetch(`https://api.kavenegar.com/v1/${encodeURIComponent(process.env.KAVENEGAR_API_KEY)}/sms/send.json`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(8000) });
        const result = await response.json();
        if (!response.ok || result?.return?.status !== 200) throw new Error(`SMS provider rejected request (status ${result?.return?.status ?? response.status})`);
        req.session.devOtp = null;
      } catch (err) {
        logger.error('kavenegar request failed', { requestId: req.id, error: err });
        setFlash(req, 'error', 'ارسال پیامک ناموفق بود. کمی بعد دوباره تلاش کنید.');
        return res.redirect('/login');
      }
    } else if (IS_PROD) {
      setFlash(req, 'error', 'سرویس پیامک هنوز پیکربندی نشده است. با مدیر سایت تماس بگیرید.');
      return res.redirect('/login');
    } else {
      if (process.env.SHOW_DEV_OTP === 'true') logger.info('development OTP issued (visible on the login page only)', { phone });
      req.session.devOtp = process.env.SHOW_DEV_OTP === 'true' ? code : null;
    }
    req.session.loginDraft = { phone, firstName, lastName };
    setFlash(req, 'success', 'کد تأیید ارسال شد. کد تا ۵ دقیقه معتبر است.');
    res.redirect('/login?step=code');
  }));
  app.post('/auth/verify-code', verifyCodeLimiter, asyncRoute(async (req, res) => {
    const code = digitsEnglish(req.body.code).trim();
    const draft = req.session.loginDraft;
    if (!draft || !/^\d{6}$/.test(code)) { setFlash(req, 'error', 'درخواست ورود نامعتبر است؛ دوباره کد بگیرید.'); return res.redirect('/login'); }
    const q = await pool.query('SELECT * FROM otp_codes WHERE phone=$1 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1', [draft.phone]);
    if (!q.rowCount || new Date(q.rows[0].expires_at) < new Date() || q.rows[0].attempts >= 5) {
      setFlash(req, 'error', 'کد منقضی شده یا تعداد تلاش‌ها بیش از حد مجاز است.'); return res.redirect('/login');
    }
    // Atomically consume one attempt; concurrent guesses cannot exceed the 5-attempt budget.
    const attempt = await pool.query('UPDATE otp_codes SET attempts=attempts+1 WHERE id=$1 AND attempts<5 AND consumed_at IS NULL RETURNING id', [q.rows[0].id]);
    if (!attempt.rowCount) { setFlash(req, 'error', 'کد منقضی شده یا تعداد تلاش‌ها بیش از حد مجاز است.'); return res.redirect('/login'); }
    if (!safeEqual(otpHash(draft.phone, code), q.rows[0].code_hash)) { setFlash(req, 'error', 'کد واردشده درست نیست.'); return res.redirect('/login?step=code'); }
    const consumed = await pool.query('UPDATE otp_codes SET consumed_at=NOW() WHERE id=$1 AND consumed_at IS NULL RETURNING id', [q.rows[0].id]);
    if (!consumed.rowCount) { setFlash(req, 'error', 'این کد قبلاً استفاده شده است؛ دوباره کد بگیرید.'); return res.redirect('/login'); }
    const userRes = await pool.query(`INSERT INTO users(phone,first_name,last_name) VALUES($1,$2,$3)
      ON CONFLICT(phone) DO UPDATE SET first_name=CASE WHEN EXCLUDED.first_name<>'' THEN EXCLUDED.first_name ELSE users.first_name END,
      last_name=CASE WHEN EXCLUDED.last_name<>'' THEN EXCLUDED.last_name ELSE users.last_name END,updated_at=NOW() RETURNING id,role,is_active`, [draft.phone, draft.firstName, draft.lastName]);
    if (userRes.rows[0].role === 'admin') {
      req.session.loginDraft = null;
      req.session.devOtp = null;
      setFlash(req, 'info', 'حساب کاربری عادی مجوز مدیریت ندارد؛ از نام کاربری و گذرواژهٔ اختصاصی مدیر استفاده کنید.');
      return res.redirect('/admin/login');
    }
    if (!userRes.rows[0].is_active) {
      req.session.loginDraft = null;
      setFlash(req, 'error', 'این حساب کاربری غیرفعال شده است. با پشتیبانی تماس بگیرید.');
      return res.redirect('/login');
    }
    const returnTo = safeNextPath(req.session.returnTo, '/account');
    await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
    req.session.userId = userRes.rows[0].id;
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    setFlash(req, 'success', 'با موفقیت وارد حساب کاربری شدید.');
    res.redirect(returnTo);
  }));
  app.post('/logout', (req, res) => req.session.destroy(() => { res.clearCookie(SESSION_COOKIE); res.redirect('/'); }));

  // ───────────── Customer account and learning library ─────────────
  app.get('/account', requireAuth, asyncRoute(async (req, res) => {
    const [orders, library] = await Promise.all([
      pool.query('SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30', [req.user.id]),
      pool.query("SELECT p.*, MAX(o.paid_at) AS paid_at, COALESCE((SELECT json_agg(json_build_object('id',a.id,'title',a.title,'asset_kind',a.asset_kind) ORDER BY a.sort_order,a.id) FROM product_assets a WHERE a.product_id=p.id),'[]'::json) AS assets FROM products p JOIN order_items oi ON oi.product_id=p.id JOIN orders o ON o.id=oi.order_id WHERE o.user_id=$1 AND o.status='paid' GROUP BY p.id ORDER BY MAX(o.paid_at) DESC", [req.user.id])
    ]);
    res.render('account', { title: 'حساب کاربری', orders: orders.rows, library: library.rows });
  }));
  app.post('/account/profile', requireAuth, asyncRoute(async (req, res) => {
    const firstName = normalizeText(req.body.firstName, 100);
    const lastName = normalizeText(req.body.lastName, 100);
    const branch = ['', 'نظارت', 'طراحی', 'اجرا'].includes(req.body.branch) ? req.body.branch : '';
    const field = ['', 'مهندسی مکانیک', 'مهندسی برق', 'مهندسی عمران', 'مهندسی معماری', 'سایر'].includes(req.body.field) ? req.body.field : '';
    if (!firstName || !lastName) { setFlash(req, 'error', 'نام و نام خانوادگی الزامی است.'); return res.redirect('/account#profile'); }
    await pool.query('UPDATE users SET first_name=$1,last_name=$2,branch=$3,field=$4,updated_at=NOW() WHERE id=$5', [firstName, lastName, branch, field, req.user.id]);
    setFlash(req, 'success', 'پروفایل به‌روزرسانی شد.'); res.redirect('/account#profile');
  }));

  // ───────────── Customer support tickets (no email notifications; in-app only) ─────────────
  const TICKET_CATEGORIES = ['order', 'product', 'account', 'technical', 'other'];
  const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
  const TICKET_STATUSES = ['open', 'pending', 'answered', 'closed'];
  app.get('/account/tickets', requireAuth, asyncRoute(async (req, res) => {
    const r = await pool.query('SELECT * FROM tickets WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]);
    res.render('tickets', { title: 'پشتیبانی', tickets: r.rows });
  }));
  app.get('/account/tickets/new', requireAuth, (_req, res) => res.render('ticket-new', { title: 'درخواست جدید' }));
  app.post('/account/tickets', requireAuth, asyncRoute(async (req, res) => {
    const subject = normalizeText(req.body.subject, 200);
    const message = normalizeText(req.body.message, 4000);
    const category = TICKET_CATEGORIES.includes(req.body.category) ? req.body.category : 'other';
    const priority = TICKET_PRIORITIES.includes(req.body.priority) ? req.body.priority : 'normal';
    if (!subject || !message) { setFlash(req, 'error', 'موضوع و متن پیام الزامی است.'); return res.redirect('/account/tickets/new'); }
    const client = await pool.connect();
    let id;
    try {
      await client.query('BEGIN');
      const created = await client.query('INSERT INTO tickets(user_id,subject,category,priority,status) VALUES($1,$2,$3,$4,\'open\') RETURNING id', [req.user.id, subject, category, priority]);
      id = created.rows[0].id;
      await client.query('INSERT INTO ticket_messages(ticket_id,author_type,author_id,body) VALUES($1,\'user\',$2,$3)', [id, req.user.id, message]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
    setFlash(req, 'success', 'درخواست با موفقیت ثبت شد.');
    res.redirect(`/account/tickets/${id}`);
  }));
  app.get('/account/tickets/:id', requireAuth, asyncRoute(async (req, res) => {
    const t = await pool.query('SELECT * FROM tickets WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!t.rowCount) return renderError(res, 404, 'پیدا نشد', 'این درخواست پیدا نشد.');
    const messages = await pool.query('SELECT * FROM ticket_messages WHERE ticket_id=$1 ORDER BY created_at,id', [req.params.id]);
    res.render('ticket', { title: t.rows[0].subject, ticket: t.rows[0], messages: messages.rows });
  }));
  app.post('/account/tickets/:id/reply', requireAuth, asyncRoute(async (req, res) => {
    const t = await pool.query('SELECT * FROM tickets WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!t.rowCount) return renderError(res, 404, 'پیدا نشد', 'این درخواست پیدا نشد.');
    if (t.rows[0].status === 'closed') { setFlash(req, 'error', 'این تیکت بسته شده و دیگر قابل پاسخ‌دهی نیست.'); return res.redirect(`/account/tickets/${req.params.id}`); }
    const message = normalizeText(req.body.message, 4000);
    if (!message) { setFlash(req, 'error', 'متن پاسخ الزامی است.'); return res.redirect(`/account/tickets/${req.params.id}`); }
    await pool.query('INSERT INTO ticket_messages(ticket_id,author_type,author_id,body) VALUES($1,\'user\',$2,$3)', [req.params.id, req.user.id, message]);
    await pool.query("UPDATE tickets SET status='pending',updated_at=NOW() WHERE id=$1", [req.params.id]);
    res.redirect(`/account/tickets/${req.params.id}`);
  }));

  // ───────────── Orders and verified ZarinPal checkout ─────────────
  // No access is granted from the callback query alone; the gateway's verify response is authoritative.
  app.post('/checkout/:id', requireAuth, asyncRoute(async (req, res) => {
    const productRes = await pool.query("SELECT * FROM products WHERE id=$1 AND status='published'", [req.params.id]);
    if (!productRes.rowCount) { setFlash(req, 'error', 'محصول در دسترس نیست.'); return res.redirect('/shop'); }
    const product = productRes.rows[0];
    const already = await pool.query("SELECT 1 FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.user_id=$1 AND o.status='paid' AND oi.product_id=$2", [req.user.id, product.id]);
    if (already.rowCount) { setFlash(req, 'info', 'این محصول قبلاً در کتابخانهٔ شما فعال شده است.'); return res.redirect('/account'); }
    if (!process.env.ZARINPAL_MERCHANT_ID) { setFlash(req, 'error', 'درگاه پرداخت هنوز تنظیم نشده است؛ لطفاً بعداً مراجعه کنید.'); return res.redirect(`/shop/${product.slug}`); }
    const client = await pool.connect();
    let orderId;
    try {
      await client.query('BEGIN');
      const o = await client.query("INSERT INTO orders(user_id,total_toman,status) VALUES($1,$2,'pending') RETURNING id", [req.user.id, product.price_toman]);
      orderId = o.rows[0].id;
      await client.query('INSERT INTO order_items(order_id,product_id,title_snapshot,price_toman) VALUES($1,$2,$3,$4)', [orderId, product.id, product.title, product.price_toman]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    try {
      const amountRial = Number(product.price_toman) * 10;
      if (!Number.isSafeInteger(amountRial) || amountRial < 1000) throw new Error('Product amount is below the gateway minimum.');
      const callback = `${APP_URL}/payments/zarinpal/callback?orderId=${encodeURIComponent(orderId)}`;
      const base = process.env.ZARINPAL_SANDBOX === 'false' ? 'https://api.zarinpal.com' : 'https://sandbox.zarinpal.com';
      const response = await fetch(`${base}/pg/v4/payment/request.json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ merchant_id: process.env.ZARINPAL_MERCHANT_ID, amount: amountRial, currency: 'IRR', description: `خرید ${product.title}`.slice(0, 240), callback_url: callback, metadata: { mobile: req.user.phone } }), signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      if (!response.ok || data?.data?.code !== 100 || !data.data.authority) throw new Error(`ZarinPal request failed: ${data?.errors?.message || data?.data?.message || response.status}`);
      await pool.query('UPDATE orders SET authority=$1,updated_at=NOW() WHERE id=$2 AND status=\'pending\'', [data.data.authority, orderId]);
      const gateway = process.env.ZARINPAL_SANDBOX === 'false' ? 'https://www.zarinpal.com' : 'https://sandbox.zarinpal.com';
      return res.redirect(`${gateway}/pg/StartPay/${encodeURIComponent(data.data.authority)}`);
    } catch (err) {
      logger.error('payment request failed', { requestId: req.id, orderId, error: err });
      await pool.query("UPDATE orders SET status='failed',updated_at=NOW() WHERE id=$1 AND status='pending'", [orderId]);
      setFlash(req, 'error', 'ایجاد تراکنش ناموفق بود. کمی بعد دوباره تلاش کنید.');
      res.redirect(`/shop/${product.slug}`);
    }
  }));
  app.get('/payments/zarinpal/callback', asyncRoute(async (req, res) => {
    const orderId = digitsEnglish(req.query.orderId).trim();
    const authority = String(req.query.Authority || '').trim().slice(0, 100);
    const status = String(req.query.Status || '').toUpperCase();
    if (!/^[1-9]\d{0,17}$/.test(orderId) || !authority) return res.status(400).render('payment-result', { title: 'پرداخت نامعتبر', ok: false, message: 'اطلاعات بازگشت از درگاه کامل نیست.' });
    const found = await pool.query('SELECT * FROM orders WHERE id=$1 AND authority=$2', [orderId, authority]);
    if (!found.rowCount) return res.status(404).render('payment-result', { title: 'سفارش پیدا نشد', ok: false, message: 'سفارش متناظر با این پرداخت پیدا نشد.' });
    const order = found.rows[0];
    if (order.status === 'paid') return res.render('payment-result', { title: 'پرداخت موفق', ok: true, message: 'پرداخت قبلاً تأیید شده و محصول در کتابخانهٔ شما فعال است.' });
    if (status !== 'OK' || order.status !== 'pending') {
      await pool.query("UPDATE orders SET status='failed',updated_at=NOW() WHERE id=$1 AND status='pending'", [order.id]);
      return res.render('payment-result', { title: 'پرداخت انجام نشد', ok: false, message: 'پرداخت لغو شد یا توسط درگاه تأیید نشد. در صورت کسر وجه با پشتیبانی درگاه تماس بگیرید.' });
    }
    try {
      const amountRial = Number(order.total_toman) * 10;
      const base = process.env.ZARINPAL_SANDBOX === 'false' ? 'https://api.zarinpal.com' : 'https://sandbox.zarinpal.com';
      const response = await fetch(`${base}/pg/v4/payment/verify.json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ merchant_id: process.env.ZARINPAL_MERCHANT_ID, amount: amountRial, authority }), signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      const code = Number(data?.data?.code);
      if (!response.ok || ![100, 101].includes(code) || !data?.data?.ref_id) throw new Error(`ZarinPal verification rejected: ${data?.errors?.message || data?.data?.message || code}`);
      const ref = String(data.data.ref_id).slice(0, 100);
      const changed = await pool.query("UPDATE orders SET status='paid',ref_id=$1,paid_at=NOW(),updated_at=NOW() WHERE id=$2 AND status='pending' AND authority=$3 RETURNING id", [ref, order.id, authority]);
      if (!changed.rowCount) {
        const fresh = await pool.query('SELECT status FROM orders WHERE id=$1', [order.id]);
        if (fresh.rows[0]?.status !== 'paid') throw new Error('Order state changed during verification');
      }
      return res.render('payment-result', { title: 'پرداخت موفق', ok: true, message: `پرداخت تأیید شد. کد پیگیری: ${ref}. محصول در حساب کاربری فعال شده است.` });
    } catch (err) {
      logger.error('payment verification failed', { requestId: req.id, orderId: order.id, error: err });
      return res.status(502).render('payment-result', { title: 'تأیید پرداخت ناموفق', ok: false, message: 'در حال حاضر تأیید پرداخت از درگاه ممکن نشد. از تکرار پرداخت خودداری کنید و با پشتیبانی تماس بگیرید.' });
    }
  }));

  // ───────────── Gated course/plugin files (never exposed through express.static) ─────────────
  app.get('/secure-assets/:id', asyncRoute(async (req, res) => {
    const result = await pool.query(`SELECT a.*,p.id AS parent_product_id,p.slug AS product_slug,p.title AS product_title,p.status AS product_status
      FROM product_assets a JOIN products p ON p.id=a.product_id WHERE a.id=$1`, [req.params.id]);
    if (!result.rowCount) return renderError(res, 404, 'فایل پیدا نشد', 'این فایل در دسترس نیست.');
    const asset = result.rows[0];
    // Only administrators who manage content may preview gated files (previously any admin role).
    let allowed = (!!req.admin && hasPermission(req.admin.role, 'content')) || (asset.is_preview && asset.product_status === 'published');
    if (!allowed && req.user) {
      const paid = await pool.query("SELECT 1 FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.user_id=$1 AND o.status='paid' AND oi.product_id=$2 LIMIT 1", [req.user.id, asset.parent_product_id]);
      allowed = !!paid.rowCount;
    }
    if (!allowed && !req.user) { req.session.returnTo = asset.product_status === 'published' ? `/shop/${asset.product_slug}` : '/account'; setFlash(req, 'info', 'برای دسترسی به محتوای کامل ابتدا وارد حساب شوید.'); return req.session.save(() => res.redirect('/login')); }
    if (!allowed && asset.product_status !== 'published') return renderError(res, 404, 'محتوا در دسترس نیست', 'این محتوا اکنون منتشر نشده است.');
    if (!allowed) { setFlash(req, 'info', 'برای دسترسی به این محتوا ابتدا محصول را خریداری کنید.'); return req.session.save(() => res.redirect(`/shop/${asset.product_slug}`)); }
    res.setHeader('Cache-Control', 'private, no-store');
    if (asset.external_url) return res.redirect(asset.external_url);
    if (!asset.file_key) return renderError(res, 404, 'فایل موجود نیست', 'فایل هنوز بارگذاری نشده است.');
    const filePath = path.join(PRIVATE_DIR, path.basename(asset.file_key));
    if (!fs.existsSync(filePath)) return renderError(res, 404, 'فایل موجود نیست', 'فایل از فضای ذخیره‌سازی پیدا نشد.');
    if (asset.asset_kind === 'video') res.setHeader('Content-Type', asset.file_key.endsWith('.webm') ? 'video/webm' : 'video/mp4');
    else if (asset.asset_kind === 'pdf') res.setHeader('Content-Type', 'application/pdf');
    else res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(asset.file_key))}`);
    // res.sendFile supports HTTP Range requests, so videos can seek without downloading the whole file.
    res.sendFile(filePath);
  }));

  // ───────────── Admin authentication ─────────────
  app.get('/admin/login', (req, res) => {
    if (req.admin) return res.redirect(ROLE_HOME[req.admin.role] || '/admin');
    res.render('admin/login', { title: 'ورود مدیر' });
  });
  app.post('/admin/login', asyncRoute(async (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase().slice(0, 80);
    const password = String(req.body.password || '');
    const usernameKey = `admin-login:user:${username || 'invalid'}`;
    const ipKey = `admin-login:ip:${req.ip || 'unknown'}`;
    const lockedMessage = 'به دلیل تلاش‌های ناموفق متعدد، ورود موقتاً مسدود شده است. حدود ۱۵ دقیقه بعد دوباره تلاش کنید.';
    // Atomic check-and-reserve: every attempt is counted before the password is checked, so a burst of
    // parallel requests cannot exceed the limit. A successful login removes the reservation again, which
    // means only failed attempts accumulate.
    let gate;
    try {
      gate = await throttle.reserve([
        { key: usernameKey, ...ADMIN_LOGIN_LIMITS.username },
        { key: ipKey, ...ADMIN_LOGIN_LIMITS.ip }
      ]);
    } catch (error) {
      if (error instanceof ThrottleUnavailableError) { setFlash(req, 'error', 'سرویس ورود موقتاً در دسترس نیست. کمی بعد دوباره تلاش کنید.'); return res.redirect('/admin/login'); }
      throw error;
    }
    if (!gate.allowed) {
      await writeAdminAudit(null, 'admin.login.locked', req, 429);
      res.setHeader('Retry-After', String(Math.ceil(gate.retryAfterMs / 1000)));
      setFlash(req, 'error', lockedMessage);
      return req.session.save(() => res.redirect('/admin/login'));
    }
    const row = validAdminUsername(username) ? await pool.query('SELECT id,username,password_hash,role,is_active,session_version FROM admin_accounts WHERE username=$1', [username]) : { rowCount: 0, rows: [] };
    // Comparable-cost password operation for unknown usernames reduces timing-based enumeration.
    const hashForCheck = row.rowCount ? row.rows[0].password_hash : await dummyAdminHashPromise;
    const passwordMatches = password.length > 0 && password.length <= 200 && await bcrypt.compare(password, hashForCheck);
    const valid = Boolean(row.rowCount && row.rows[0].is_active && passwordMatches);
    if (!valid) {
      // The reservation made above stays in place and is this attempt's failure record.
      await writeAdminAudit(row.rowCount ? row.rows[0].id : null, 'admin.login.failure', req, 401);
      setFlash(req, 'error', 'نام کاربری یا گذرواژه مدیر صحیح نیست.'); return res.redirect('/admin/login');
    }
    await throttle.clear(usernameKey);
    await throttle.release(gate.reservation, [ipKey]);
    await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
    req.session.adminAccountId = row.rows[0].id;
    req.session.adminSessionVersion = row.rows[0].session_version;
    req.session.adminLastActivity = Date.now();
    req.session.adminSessionStartedAt = Date.now();
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    await pool.query('UPDATE admin_accounts SET last_login_at=NOW(),updated_at=NOW() WHERE id=$1', [row.rows[0].id]);
    await writeAdminAudit(row.rows[0].id, 'admin.login.success', req, 302);
    setFlash(req, 'success', 'ورود مدیر موفق بود.'); res.redirect(ROLE_HOME[row.rows[0].role] || '/admin');
  }));
  app.post('/admin/logout', requireAdmin, asyncRoute(async (req, res) => {
    await writeAdminAudit(req.admin.id, 'admin.logout', req, 302);
    req.session.destroy(() => { res.clearCookie(SESSION_COOKIE); res.redirect('/admin/login'); });
  }));

  // ───────────── Admin accounts (owner only) ─────────────
  app.get('/admin/admins', requireAdmin, asyncRoute(async (req, res) => {
    const result = await pool.query('SELECT id,username,role,is_active,last_login_at,created_at,password_changed_at FROM admin_accounts ORDER BY is_active DESC, created_at DESC');
    const owners = result.rows.filter(a => a.role === 'owner' && a.is_active).length;
    res.render('admin/admins', { title: 'مدیریت مدیران', admins: result.rows, roles: ROLES, activeOwners: owners });
  }));
  app.post('/admin/admins/create', requireAdmin, asyncRoute(async (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const role = String(req.body.role || 'admin');
    if (!validAdminUsername(username) || !validRole(role)) {
      setFlash(req, 'error', 'نام کاربری باید ۳ تا ۶۴ نویسهٔ انگلیسی، عدد، نقطه، خط تیره یا زیرخط باشد و نقش معتبر لازم است.'); return res.redirect('/admin/admins');
    }
    const problem = adminPasswordProblem(password, username);
    if (problem) { setFlash(req, 'error', problem); return res.redirect('/admin/admins'); }
    try {
      const hash = await bcrypt.hash(password, 12);
      const created = await pool.query('INSERT INTO admin_accounts(username,password_hash,role,created_by) VALUES($1,$2,$3,$4) RETURNING id', [username, hash, role, req.admin.id]);
      await writeAdminAudit(req.admin.id, `admin.account.create:${created.rows[0].id}:${role}`, req, 201);
      setFlash(req, 'success', `حساب مدیریتی «${username}» با نقش ${ROLE_LABELS[role]} ساخته شد.`);
    } catch (error) {
      if (error.code === '23505') setFlash(req, 'error', 'این نام کاربری قبلاً ثبت شده است.');
      else throw error;
    }
    res.redirect('/admin/admins');
  }));
  app.post('/admin/admins/:id/update', requireAdmin, asyncRoute(async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const username = String(req.body.username || '').trim().toLowerCase();
    const role = String(req.body.role || 'admin');
    if (!validAdminUsername(username) || !validRole(role)) { setFlash(req, 'error', 'اطلاعات واردشده معتبر نیست.'); return res.redirect('/admin/admins'); }
    if (id === Number(req.admin.id)) { setFlash(req, 'error', 'برای تغییر نام کاربری حساب خود، از بخش «حساب من» و تأیید رمز فعلی استفاده کنید.'); return res.redirect('/admin/admins'); }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize owner-role changes so two concurrent requests cannot remove the last active owner.
      await client.query('LOCK TABLE admin_accounts IN EXCLUSIVE MODE');
      const target = await client.query('SELECT id,role,is_active FROM admin_accounts WHERE id=$1 FOR UPDATE', [id]);
      if (!target.rowCount) { await client.query('ROLLBACK'); setFlash(req, 'error', 'حساب مدیر پیدا نشد.'); return res.redirect('/admin/admins'); }
      if (target.rows[0].role === 'owner' && role !== 'owner' && target.rows[0].is_active) {
        const owners = await client.query("SELECT COUNT(*)::int AS n FROM admin_accounts WHERE role='owner' AND is_active=TRUE");
        if (owners.rows[0].n <= 1) { await client.query('ROLLBACK'); setFlash(req, 'error', 'تغییر نقش آخرین مدیر اصلی مجاز نیست.'); return res.redirect('/admin/admins'); }
      }
      await client.query('UPDATE admin_accounts SET username=$1,role=$2,session_version=session_version+1,updated_at=NOW() WHERE id=$3', [username, role, id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') { setFlash(req, 'error', 'این نام کاربری قبلاً ثبت شده است.'); return res.redirect('/admin/admins'); }
      throw error;
    } finally { client.release(); }
    await writeAdminAudit(req.admin.id, `admin.account.update:${id}:${role}`, req, 200);
    setFlash(req, 'success', 'مشخصات حساب مدیر به‌روزرسانی شد و نشست‌های قبلی او باطل شدند.'); res.redirect('/admin/admins');
  }));
  app.post('/admin/admins/:id/password', requireAdmin, asyncRoute(async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const password = String(req.body.password || '');
    if (id === Number(req.admin.id)) { setFlash(req, 'error', 'برای تغییر رمز حساب خود، از بخش «حساب من» و تأیید رمز فعلی استفاده کنید.'); return res.redirect('/admin/admins'); }
    const target = await pool.query('SELECT id,username FROM admin_accounts WHERE id=$1', [id]);
    if (!target.rowCount) { setFlash(req, 'error', 'حساب مدیر پیدا نشد.'); return res.redirect('/admin/admins'); }
    const problem = adminPasswordProblem(password, target.rows[0].username);
    if (problem) { setFlash(req, 'error', problem); return res.redirect('/admin/admins'); }
    const hash = await bcrypt.hash(password, 12);
    await pool.query('UPDATE admin_accounts SET password_hash=$1,password_changed_at=NOW(),session_version=session_version+1,updated_at=NOW() WHERE id=$2', [hash, id]);
    await throttle.clear(`admin-login:user:${target.rows[0].username}`);
    await writeAdminAudit(req.admin.id, `admin.account.password_reset:${id}`, req, 200);
    setFlash(req, 'success', 'رمز جدید ثبت شد و نشست‌های قبلی این مدیر باطل شدند.'); res.redirect('/admin/admins');
  }));
  app.post('/admin/admins/:id/toggle', requireAdmin, asyncRoute(async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (id === Number(req.admin.id)) { setFlash(req, 'error', 'برای جلوگیری از قفل‌شدن پنل، حساب خود را از این فهرست غیرفعال نکنید.'); return res.redirect('/admin/admins'); }
    const client = await pool.connect();
    let nextActive;
    try {
      await client.query('BEGIN');
      // Keep the last-owner invariant safe under concurrent account-management requests.
      await client.query('LOCK TABLE admin_accounts IN EXCLUSIVE MODE');
      const target = await client.query('SELECT id,role,is_active FROM admin_accounts WHERE id=$1 FOR UPDATE', [id]);
      if (!target.rowCount) { await client.query('ROLLBACK'); setFlash(req, 'error', 'حساب مدیر پیدا نشد.'); return res.redirect('/admin/admins'); }
      nextActive = !target.rows[0].is_active;
      if (!nextActive && target.rows[0].role === 'owner') {
        const owners = await client.query("SELECT COUNT(*)::int AS n FROM admin_accounts WHERE role='owner' AND is_active=TRUE");
        if (owners.rows[0].n <= 1) { await client.query('ROLLBACK'); setFlash(req, 'error', 'غیرفعال‌کردن آخرین مدیر اصلی مجاز نیست.'); return res.redirect('/admin/admins'); }
      }
      await client.query('UPDATE admin_accounts SET is_active=$1,session_version=session_version+1,updated_at=NOW() WHERE id=$2', [nextActive, id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
    await writeAdminAudit(req.admin.id, `admin.account.${nextActive ? 'activate' : 'deactivate'}:${id}`, req, 200);
    setFlash(req, 'success', nextActive ? 'حساب مدیر فعال شد.' : 'حساب مدیر غیرفعال شد و نشست‌های قبلی باطل شدند.'); res.redirect('/admin/admins');
  }));
  app.get('/admin/account', requireAdmin, (req, res) => res.render('admin/admin-account', { title: 'حساب من' }));
  app.post('/admin/account/credentials', requireAdmin, asyncRoute(async (req, res) => {
    const currentPassword = String(req.body.current_password || '');
    const username = String(req.body.username || '').trim().toLowerCase();
    const newPassword = String(req.body.new_password || '');
    const account = await pool.query('SELECT password_hash FROM admin_accounts WHERE id=$1', [req.admin.id]);
    if (!account.rowCount || currentPassword.length > 200 || !(await bcrypt.compare(currentPassword, account.rows[0].password_hash))) {
      await writeAdminAudit(req.admin.id, 'admin.account.self_credentials_rejected', req, 401);
      setFlash(req, 'error', 'رمز فعلی صحیح نیست.'); return res.redirect('/admin/account');
    }
    if (!validAdminUsername(username)) { setFlash(req, 'error', 'نام کاربری معتبر نیست.'); return res.redirect('/admin/account'); }
    if (newPassword) {
      const problem = adminPasswordProblem(newPassword, username);
      if (problem) { setFlash(req, 'error', problem); return res.redirect('/admin/account'); }
      if (newPassword === currentPassword) { setFlash(req, 'error', 'رمز جدید باید با رمز فعلی متفاوت باشد.'); return res.redirect('/admin/account'); }
    }
    try {
      if (newPassword) {
        const hash = await bcrypt.hash(newPassword, 12);
        await pool.query('UPDATE admin_accounts SET username=$1,password_hash=$2,password_changed_at=NOW(),session_version=session_version+1,updated_at=NOW() WHERE id=$3', [username, hash, req.admin.id]);
      } else {
        await pool.query('UPDATE admin_accounts SET username=$1,session_version=session_version+1,updated_at=NOW() WHERE id=$2', [username, req.admin.id]);
      }
    } catch (error) {
      if (error.code === '23505') { setFlash(req, 'error', 'این نام کاربری قبلاً ثبت شده است.'); return res.redirect('/admin/account'); }
      throw error;
    }
    await writeAdminAudit(req.admin.id, newPassword ? 'admin.account.self_credentials_changed' : 'admin.account.self_username_changed', req, 200);
    req.session.destroy(() => { res.clearCookie(SESSION_COOKIE); res.redirect('/admin/login'); });
  }));

  // ───────────── Dashboard ─────────────
  app.get('/admin', requireAdmin, asyncRoute(async (req, res) => {
    const q = sql => pool.query(sql).then(r => r.rows);
    const [counts, sales, recentOrders, recentAudit, drafts] = await Promise.all([
      q(`SELECT
          (SELECT COUNT(*)::int FROM users WHERE role='user' AND is_active) AS active_users,
          (SELECT COUNT(*)::int FROM users WHERE role='user' AND created_at > NOW() - INTERVAL '30 days') AS new_users_30d,
          (SELECT COUNT(*)::int FROM products WHERE status='published') AS published_products,
          (SELECT COUNT(*)::int FROM articles WHERE status='published') AS published_articles,
          (SELECT COUNT(*)::int FROM orders WHERE status='paid') AS paid_orders,
          (SELECT COUNT(*)::int FROM orders WHERE status='pending' AND created_at > NOW() - INTERVAL '24 hours') AS pending_orders,
          (SELECT COUNT(*)::int FROM orders WHERE status='failed' AND created_at > NOW() - INTERVAL '7 days') AS failed_orders_7d`),
      q(`SELECT COALESCE(SUM(total_toman),0)::bigint AS total,
          COALESCE(SUM(total_toman) FILTER (WHERE paid_at > NOW() - INTERVAL '30 days'),0)::bigint AS last_30d,
          COALESCE(SUM(total_toman) FILTER (WHERE paid_at > NOW() - INTERVAL '7 days'),0)::bigint AS last_7d
         FROM orders WHERE status='paid'`),
      q('SELECT o.*,u.phone,u.first_name,u.last_name FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT 8'),
      hasPermission(req.admin.role, 'audit')
        ? q(`SELECT l.action,l.created_at,l.status_code,a.username FROM admin_audit_logs l LEFT JOIN admin_accounts a ON a.id=l.admin_account_id ORDER BY l.created_at DESC,l.id DESC LIMIT 6`)
        : Promise.resolve([]),
      q(`SELECT (SELECT COUNT(*)::int FROM products WHERE status='draft') AS products, (SELECT COUNT(*)::int FROM articles WHERE status='draft') AS articles`)
    ]);
    const openTickets = hasPermission(req.admin.role, 'support') ? (await pool.query("SELECT COUNT(*)::int AS n FROM tickets WHERE status IN ('open','pending')")).rows[0].n : 0;
    res.render('admin/dashboard', { title: 'مدیریت سایت', counts: counts[0], sales: sales[0], orders: recentOrders, audit: recentAudit, drafts: drafts[0], openTickets });
  }));

  // ───────────── Products ─────────────
  app.get('/admin/products', requireAdmin, asyncRoute(async (req, res) => {
    const status = ['draft', 'published', 'archived'].includes(req.query.status) ? req.query.status : '';
    const type = ['course', 'plugin'].includes(req.query.type) ? req.query.type : '';
    const { where, params, q } = buildWhere({ q: req.query.q, searchColumns: ['p.title', 'p.slug', 'p.category'], filters: [['p.status', status], ['p.product_type', type]] });
    const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM products p ${where}`, params)).rows[0].n;
    const pg = pagination(parsePage(req.query.page), 25, total);
    const r = await pool.query(`SELECT p.*, (SELECT COUNT(*)::int FROM product_assets a WHERE a.product_id=p.id) AS asset_count FROM products p ${where} ORDER BY p.updated_at DESC, p.id DESC LIMIT ${pg.pageSize} OFFSET ${pg.offset}`, params);
    res.render('admin/products', { title: 'مدیریت محصولات', products: r.rows, filters: { q, status, type }, pg });
  }));
  app.get('/admin/products/new', requireAdmin, (_req, res) => res.render('admin/product-form', { title: 'محصول جدید', product: null, assets: [], maxUploadMb: MAX_UPLOAD_MB }));
  const readProductForm = req => ({
    title: normalizeText(req.body.title, 180),
    type: ['course', 'plugin'].includes(req.body.product_type) ? req.body.product_type : null,
    price: Number(digitsEnglish(req.body.price_toman)),
    status: ['draft', 'published', 'archived'].includes(req.body.status) ? req.body.status : 'draft',
    titleEn: normalizeText(req.body.title_en, 180),
    subtitleEn: normalizeText(req.body.subtitle_en, 240),
    shortDescriptionEn: normalizeText(req.body.short_description_en, 500),
    descriptionEn: normalizeText(req.body.description_en, 20000)
  });
  app.post('/admin/products', requireAdmin, coverUpload.single('cover'), multipartCsrf, verifyUploads(imagePolicy, '/admin/products/new'), asyncRoute(async (req, res) => {
    const form = readProductForm(req);
    if (!form.title || !Number.isSafeInteger(form.price) || form.price < 100) { removeUploaded(req); setFlash(req, 'error', 'عنوان و قیمت معتبر (حداقل ۱۰۰ تومان) الزامی است.'); return res.redirect('/admin/products/new'); }
    const slug = await uniqueSlug('products', normalizeText(req.body.slug, 160) || form.title);
    const cover = acceptableCoverValue(req.file, req.body.cover_url);
    const saved = await pool.query(`INSERT INTO products(slug,title,subtitle,product_type,category,short_description,description,price_toman,cover_image,status,featured,title_en,subtitle_en,short_description_en,description_en)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`, [slug, form.title, normalizeText(req.body.subtitle, 240), form.type || 'course', normalizeText(req.body.category, 100), normalizeText(req.body.short_description, 500), normalizeText(req.body.description, 20000), form.price, cover, form.status, req.body.featured === 'on', form.titleEn, form.subtitleEn, form.shortDescriptionEn, form.descriptionEn]);
    setFlash(req, 'success', 'محصول ساخته شد. حالا می‌توانید محتوا و فایل‌هایش را اضافه کنید.'); res.redirect(`/admin/products/${saved.rows[0].id}/edit`);
  }));
  app.get('/admin/products/:id/edit', requireAdmin, asyncRoute(async (req, res) => {
    const [p, a] = await Promise.all([pool.query('SELECT * FROM products WHERE id=$1', [req.params.id]), pool.query('SELECT * FROM product_assets WHERE product_id=$1 ORDER BY sort_order,id', [req.params.id])]);
    if (!p.rowCount) return renderError(res, 404, 'محصول پیدا نشد', 'این محصول وجود ندارد.');
    res.render('admin/product-form', { title: 'ویرایش محصول', product: p.rows[0], assets: a.rows, maxUploadMb: MAX_UPLOAD_MB });
  }));
  app.post('/admin/products/:id/edit', requireAdmin, coverUpload.single('cover'), multipartCsrf, verifyUploads(imagePolicy, req => `/admin/products/${req.params.id}/edit`), asyncRoute(async (req, res) => {
    const existing = await pool.query('SELECT * FROM products WHERE id=$1', [req.params.id]);
    if (!existing.rowCount) { removeUploaded(req); return renderError(res, 404, 'محصول پیدا نشد', 'این محصول وجود ندارد.'); }
    const form = readProductForm(req);
    if (!form.title || !Number.isSafeInteger(form.price) || form.price < 100) { removeUploaded(req); setFlash(req, 'error', 'عنوان و قیمت معتبر (حداقل ۱۰۰ تومان) الزامی است.'); return res.redirect(`/admin/products/${req.params.id}/edit`); }
    const slug = await uniqueSlug('products', normalizeText(req.body.slug, 160) || form.title, req.params.id);
    const cover = acceptableCoverValue(req.file, req.body.cover_url) || (req.body.cover_url === '' && req.body.remove_cover === 'on' ? '' : existing.rows[0].cover_image);
    await pool.query(`UPDATE products SET slug=$1,title=$2,subtitle=$3,product_type=$4,category=$5,short_description=$6,description=$7,price_toman=$8,cover_image=$9,status=$10,featured=$11,title_en=$12,subtitle_en=$13,short_description_en=$14,description_en=$15,updated_at=NOW() WHERE id=$16`, [slug, form.title, normalizeText(req.body.subtitle, 240), form.type || existing.rows[0].product_type, normalizeText(req.body.category, 100), normalizeText(req.body.short_description, 500), normalizeText(req.body.description, 20000), form.price, cover, form.status, req.body.featured === 'on', form.titleEn, form.subtitleEn, form.shortDescriptionEn, form.descriptionEn, req.params.id]);
    await removeCoverIfUnused(existing.rows[0].cover_image, cover);
    setFlash(req, 'success', 'محصول به‌روزرسانی شد.'); res.redirect(`/admin/products/${req.params.id}/edit`);
  }));
  app.post('/admin/products/:id/assets', requireAdmin, assetUpload.single('assetFile'), multipartCsrf, verifyUploads(assetPolicy, req => `/admin/products/${req.params.id}/edit`), asyncRoute(async (req, res) => {
    const back = `/admin/products/${req.params.id}/edit`;
    const product = await pool.query('SELECT id FROM products WHERE id=$1', [req.params.id]);
    if (!product.rowCount) { removeUploaded(req); return renderError(res, 404, 'محصول پیدا نشد', 'این محصول وجود ندارد.'); }
    const title = normalizeText(req.body.asset_title, 180);
    const kind = ['video', 'pdf', 'download', 'link'].includes(req.body.asset_kind) ? req.body.asset_kind : 'download';
    const uploadedExt = req.file ? path.extname(req.file.originalname).toLowerCase() : '';
    const kindAllowed = { video: ['.mp4', '.webm'], pdf: ['.pdf'], download: ['.zip', '.pdf'], link: [] };
    if (req.file && !kindAllowed[kind].includes(uploadedExt)) { removeUploaded(req); setFlash(req, 'error', 'پسوند فایل با نوع محتوای انتخاب‌شده سازگار نیست.'); return res.redirect(back); }
    const externalUrl = normalizeText(req.body.external_url, 1000);
    if (!title || (!req.file && !externalUrl)) { removeUploaded(req); setFlash(req, 'error', 'نام محتوا و یک فایل یا نشانی معتبر HTTPS لازم است.'); return res.redirect(back); }
    if (!req.file && !isHttpsUrl(externalUrl)) { setFlash(req, 'error', 'فقط پیوندهای HTTPS پذیرفته می‌شوند.'); return res.redirect(back); }
    const sortOrder = intInRange(req.body.sort_order, -100000, 100000, 0);
    await pool.query('INSERT INTO product_assets(product_id,title,asset_kind,file_key,external_url,is_preview,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7)', [req.params.id, title, kind, req.file?.filename || '', req.file ? '' : externalUrl, req.body.is_preview === 'on', sortOrder]);
    setFlash(req, 'success', 'محتوا به محصول اضافه شد.'); res.redirect(back);
  }));
  app.post('/admin/assets/:id/delete', requireAdmin, asyncRoute(async (req, res) => {
    const r = await pool.query('DELETE FROM product_assets WHERE id=$1 RETURNING product_id,file_key', [req.params.id]);
    if (r.rowCount && r.rows[0].file_key) fs.rmSync(path.join(PRIVATE_DIR, path.basename(r.rows[0].file_key)), { force: true });
    setFlash(req, r.rowCount ? 'success' : 'error', r.rowCount ? 'محتوا حذف شد.' : 'این محتوا پیدا نشد.'); res.redirect(r.rowCount ? `/admin/products/${r.rows[0].product_id}/edit` : '/admin/products');
  }));
  app.post('/admin/products/:id/delete', requireAdmin, asyncRoute(async (req, res) => {
    const r = await pool.query("UPDATE products SET status='archived',updated_at=NOW() WHERE id=$1 RETURNING id", [req.params.id]);
    setFlash(req, r.rowCount ? 'success' : 'error', r.rowCount ? 'محصول آرشیو شد. برای حفظ سوابق سفارش‌ها، حذف فیزیکی انجام نشد.' : 'محصول پیدا نشد.'); res.redirect('/admin/products');
  }));

  // ───────────── Articles ─────────────
  app.get('/admin/articles', requireAdmin, asyncRoute(async (req, res) => {
    const status = ['draft', 'published', 'archived'].includes(req.query.status) ? req.query.status : '';
    const { where, params, q } = buildWhere({ q: req.query.q, searchColumns: ['title', 'slug', 'category'], filters: [['status', status]] });
    const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM articles ${where}`, params)).rows[0].n;
    const pg = pagination(parsePage(req.query.page), 25, total);
    const r = await pool.query(`SELECT * FROM articles ${where} ORDER BY updated_at DESC, id DESC LIMIT ${pg.pageSize} OFFSET ${pg.offset}`, params);
    res.render('admin/articles', { title: 'مدیریت مقالات', articles: r.rows, filters: { q, status }, pg });
  }));
  app.get('/admin/articles/new', requireAdmin, (_req, res) => res.render('admin/article-form', { title: 'مقاله جدید', article: null, articleImages: [] }));
  app.post('/admin/articles', requireAdmin, articleUpload, multipartCsrf, verifyUploads(imagePolicy, '/admin/articles/new'), asyncRoute(async (req, res) => {
    const title = normalizeText(req.body.title, 220);
    const files = req.files || {};
    if (!title) { removeUploaded(req); setFlash(req, 'error', 'عنوان مقاله الزامی است.'); return res.redirect('/admin/articles/new'); }
    const slug = await uniqueSlug('articles', normalizeText(req.body.slug, 160) || title);
    const status = ['draft', 'published', 'archived'].includes(req.body.status) ? req.body.status : 'draft';
    const cover = acceptableCoverValue(files.cover?.[0], req.body.cover_url);
    const client = await pool.connect();
    let id;
    try {
      await client.query('BEGIN');
      const created = await client.query(`INSERT INTO articles(slug,title,excerpt,content,category,cover_image,status,published_at,title_en,excerpt_en,content_en) VALUES($1,$2,$3,$4,$5,$6,$7::varchar,CASE WHEN $7::varchar='published' THEN NOW() ELSE NULL END,$8,$9,$10) RETURNING id`, [slug, title, normalizeText(req.body.excerpt, 600), normalizeText(req.body.content, 50000), normalizeText(req.body.category, 100) || 'مقالات تخصصی', cover, status, normalizeText(req.body.title_en, 220), normalizeText(req.body.excerpt_en, 600), normalizeText(req.body.content_en, 50000)]);
      id = created.rows[0].id;
      for (const [i, f] of (files.inline_images || []).entries()) await client.query('INSERT INTO article_images(article_id,image_path,alt_text,sort_order) VALUES($1,$2,$3,$4)', [id, `/media/covers/${f.filename}`, normalizeText(req.body.inline_alt, 180), i]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); removeUploaded(req); throw error; } finally { client.release(); }
    setFlash(req, 'success', 'مقاله ذخیره شد. اکنون کد تصاویر داخل متن را می‌توانید از همین صفحه بردارید.'); res.redirect(`/admin/articles/${id}/edit`);
  }));
  app.get('/admin/articles/:id/edit', requireAdmin, asyncRoute(async (req, res) => {
    const [r, images] = await Promise.all([pool.query('SELECT * FROM articles WHERE id=$1', [req.params.id]), pool.query('SELECT * FROM article_images WHERE article_id=$1 ORDER BY sort_order,id', [req.params.id])]);
    if (!r.rowCount) return renderError(res, 404, 'مقاله پیدا نشد', 'این مقاله وجود ندارد.');
    res.render('admin/article-form', { title: 'ویرایش مقاله', article: r.rows[0], articleImages: images.rows });
  }));
  app.post('/admin/articles/:id/edit', requireAdmin, articleUpload, multipartCsrf, verifyUploads(imagePolicy, req => `/admin/articles/${req.params.id}/edit`), asyncRoute(async (req, res) => {
    const old = await pool.query('SELECT * FROM articles WHERE id=$1', [req.params.id]);
    const files = req.files || {};
    if (!old.rowCount) { removeUploaded(req); return renderError(res, 404, 'مقاله پیدا نشد', 'این مقاله وجود ندارد.'); }
    const title = normalizeText(req.body.title, 220);
    if (!title) { removeUploaded(req); setFlash(req, 'error', 'عنوان مقاله الزامی است.'); return res.redirect(`/admin/articles/${req.params.id}/edit`); }
    const slug = await uniqueSlug('articles', normalizeText(req.body.slug, 160) || title, req.params.id);
    const status = ['draft', 'published', 'archived'].includes(req.body.status) ? req.body.status : 'draft';
    const cover = acceptableCoverValue(files.cover?.[0], req.body.cover_url) || old.rows[0].cover_image;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE articles SET slug=$1,title=$2,excerpt=$3,content=$4,category=$5,cover_image=$6,status=$7::varchar,published_at=CASE WHEN $7::varchar='published' THEN COALESCE(published_at,NOW()) ELSE NULL END,title_en=$8,excerpt_en=$9,content_en=$10,updated_at=NOW() WHERE id=$11`, [slug, title, normalizeText(req.body.excerpt, 600), normalizeText(req.body.content, 50000), normalizeText(req.body.category, 100) || 'مقالات تخصصی', cover, status, normalizeText(req.body.title_en, 220), normalizeText(req.body.excerpt_en, 600), normalizeText(req.body.content_en, 50000), req.params.id]);
      for (const f of (files.inline_images || [])) await client.query('INSERT INTO article_images(article_id,image_path,alt_text,sort_order) VALUES($1,$2,$3,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM article_images WHERE article_id=$1))', [req.params.id, `/media/covers/${f.filename}`, normalizeText(req.body.inline_alt, 180)]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); removeUploaded(req); throw error; } finally { client.release(); }
    await removeCoverIfUnused(old.rows[0].cover_image, cover);
    setFlash(req, 'success', 'مقاله به‌روزرسانی شد.'); res.redirect(`/admin/articles/${req.params.id}/edit`);
  }));
  app.post('/admin/article-images/:id/delete', requireAdmin, asyncRoute(async (req, res) => {
    const r = await pool.query('DELETE FROM article_images WHERE id=$1 RETURNING article_id,image_path', [req.params.id]);
    if (r.rowCount && r.rows[0].image_path.startsWith('/media/covers/')) fs.rmSync(path.join(COVERS_DIR, path.basename(r.rows[0].image_path)), { force: true });
    setFlash(req, r.rowCount ? 'success' : 'error', r.rowCount ? 'تصویر مقاله حذف شد.' : 'تصویر پیدا نشد.'); res.redirect(r.rowCount ? `/admin/articles/${r.rows[0].article_id}/edit` : '/admin/articles');
  }));
  app.post('/admin/articles/:id/delete', requireAdmin, asyncRoute(async (req, res) => {
    const r = await pool.query("UPDATE articles SET status='archived',updated_at=NOW() WHERE id=$1 RETURNING id", [req.params.id]);
    setFlash(req, r.rowCount ? 'success' : 'error', r.rowCount ? 'مقاله آرشیو شد.' : 'مقاله پیدا نشد.'); res.redirect('/admin/articles');
  }));

  // ───────────── Orders, users, audit ─────────────
  app.get('/admin/orders', requireAdmin, asyncRoute(async (req, res) => {
    const status = Object.keys(ORDER_STATUS_LABELS).includes(req.query.status) ? req.query.status : '';
    const raw = digitsEnglish(normalizeText(req.query.q, 100));
    const orderIdQuery = /^#?\d{1,18}$/.test(raw) ? raw.replace('#', '') : null;
    const phoneQuery = normalizeIranMobile(raw);
    const spec = { q: orderIdQuery || phoneQuery ? '' : raw, searchColumns: ['u.first_name', 'u.last_name', 'o.ref_id'], filters: [['o.status', status]] };
    const built = buildWhere(spec);
    let { where } = built;
    const { params } = built;
    if (orderIdQuery || phoneQuery) {
      let clause;
      if (phoneQuery) { params.push(phoneQuery); clause = `u.phone=$${params.length}`; }
      else { params.push(orderIdQuery, orderIdQuery); clause = `(o.id=$${params.length - 1}::bigint OR o.ref_id=$${params.length})`; }
      where = where ? `${where} AND ${clause}` : `WHERE ${clause}`;
    }
    const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM orders o JOIN users u ON u.id=o.user_id ${where}`, params)).rows[0].n;
    const pg = pagination(parsePage(req.query.page), 30, total);
    const r = await pool.query(`SELECT o.*,u.phone,u.first_name,u.last_name,(SELECT STRING_AGG(oi.title_snapshot, '، ' ORDER BY oi.id) FROM order_items oi WHERE oi.order_id=o.id) AS items
      FROM orders o JOIN users u ON u.id=o.user_id ${where} ORDER BY o.created_at DESC, o.id DESC LIMIT ${pg.pageSize} OFFSET ${pg.offset}`, params);
    res.render('admin/orders', { title: 'سفارش‌ها', orders: r.rows, filters: { q: raw, status }, pg });
  }));
  app.get('/admin/users', requireAdmin, asyncRoute(async (req, res) => {
    const state = ['active', 'inactive'].includes(req.query.state) ? req.query.state : '';
    const raw = digitsEnglish(normalizeText(req.query.q, 100));
    const phoneQuery = normalizeIranMobile(raw);
    const built = buildWhere({ q: phoneQuery ? '' : raw, searchColumns: ['u.first_name', 'u.last_name', 'u.phone'], base: ["u.role='user'"] });
    let { where } = built;
    const { params } = built;
    if (phoneQuery) { params.push(phoneQuery); where += ` AND u.phone=$${params.length}`; }
    if (state) where += state === 'active' ? ' AND u.is_active' : ' AND NOT u.is_active';
    const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM users u ${where}`, params)).rows[0].n;
    const pg = pagination(parsePage(req.query.page), 30, total);
    const r = await pool.query(`SELECT u.*,(SELECT COUNT(*)::int FROM orders o WHERE o.user_id=u.id AND o.status='paid') AS paid_orders FROM users u ${where} ORDER BY u.created_at DESC, u.id DESC LIMIT ${pg.pageSize} OFFSET ${pg.offset}`, params);
    res.render('admin/users', { title: 'کاربران', users: r.rows, filters: { q: raw, state }, pg });
  }));
  app.post('/admin/users/:id/toggle', requireAdmin, asyncRoute(async (req, res) => {
    const r = await pool.query("UPDATE users SET is_active=NOT is_active,updated_at=NOW() WHERE id=$1 AND role='user' RETURNING is_active", [req.params.id]);
    if (!r.rowCount) setFlash(req, 'error', 'کاربر پیدا نشد.');
    else setFlash(req, 'success', r.rows[0].is_active ? 'حساب کاربر فعال شد.' : 'حساب کاربر غیرفعال شد؛ نشست فعلی او در درخواست بعدی پایان می‌یابد.');
    const back = String(req.body.back || '');
    res.redirect(/^\/admin\/users(?:\?[A-Za-z0-9=&%._+-]*)?$/.test(back) && back.length < 300 ? back : '/admin/users');
  }));
  app.get('/admin/audit', requireAdmin, asyncRoute(async (req, res) => {
    const kind = ['login', 'account', 'mutation'].includes(req.query.kind) ? req.query.kind : '';
    const params = [];
    const clauses = [];
    if (kind) { params.push(`admin.${kind}%`); clauses.push(`l.action LIKE $${params.length}`); }
    const actor = normalizeText(req.query.actor, 64).toLowerCase();
    if (actor) { params.push(actor); clauses.push(`a.username=$${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = (await pool.query(`SELECT COUNT(*)::int AS total FROM admin_audit_logs l LEFT JOIN admin_accounts a ON a.id=l.admin_account_id ${where}`, params)).rows[0].total;
    const pg = pagination(parsePage(req.query.page), 50, total);
    const items = await pool.query(`SELECT l.id,l.actor_id,l.admin_account_id,l.action,l.method,l.route,l.status_code,l.ip_address,l.user_agent,l.created_at,
        COALESCE(a.username, u.phone) AS phone, COALESCE(a.username, u.first_name) AS first_name, u.last_name FROM admin_audit_logs l LEFT JOIN users u ON u.id=l.actor_id LEFT JOIN admin_accounts a ON a.id=l.admin_account_id
        ${where} ORDER BY l.created_at DESC,l.id DESC LIMIT ${pg.pageSize} OFFSET ${pg.offset}`, params);
    res.render('admin/audit', { title: 'گزارش رویدادهای امنیتی', items: items.rows, page: pg.page, pageSize: pg.pageSize, total, pg, filters: { kind, actor } });
  }));

  // ───────────── Settings ─────────────
  app.get('/admin/settings', requireAdmin, asyncRoute(async (_req, res) => res.render('admin/settings', { title: 'تنظیمات سایت', settings: await getSettings(), errors: {} })));
  app.post('/admin/settings', requireAdmin, asyncRoute(async (req, res) => {
    const fields = { site_name: 100, site_tagline: 200, contact_email: 180, contact_phone: 40, instagram: 100, about_text: 2000 };
    const values = Object.fromEntries(Object.entries(fields).map(([key, max]) => [key, normalizeText(req.body[key], max)]));
    values.contact_phone = digitsEnglish(values.contact_phone);
    const errors = {};
    if (!values.site_name) errors.site_name = 'نام وب‌سایت نمی‌تواند خالی باشد.';
    if (values.contact_email && !isValidEmail(values.contact_email)) errors.contact_email = 'نشانی ایمیل معتبر نیست.';
    if (values.contact_phone && !/^[0-9+\-\s()]{5,40}$/.test(values.contact_phone)) errors.contact_phone = 'شمارهٔ تماس فقط می‌تواند شامل رقم، فاصله، + و - باشد.';
    if (values.instagram && !/^@?[A-Za-z0-9._]{1,60}$/.test(values.instagram)) errors.instagram = 'شناسهٔ اینستاگرام فقط شامل حروف انگلیسی، عدد، نقطه و زیرخط است.';
    if (Object.keys(errors).length) {
      res.locals.flash = { type: 'error', message: 'برخی فیلدها معتبر نیستند؛ موارد مشخص‌شده را اصلاح کنید.' };
      return res.status(422).render('admin/settings', { title: 'تنظیمات سایت', settings: { ...settingsCache, ...values }, errors });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [key, value] of Object.entries(values)) {
        await client.query('INSERT INTO site_settings(setting_key,setting_value) VALUES($1,$2) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()', [key, value]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
    Object.assign(settingsCache, values);
    setFlash(req, 'success', 'تنظیمات سایت ذخیره شد.'); res.redirect('/admin/settings');
  }));

  // ───────────── Admin: support tickets ─────────────
  app.get('/admin/tickets', requireAdmin, asyncRoute(async (req, res) => {
    const status = TICKET_STATUSES.includes(req.query.status) ? req.query.status : '';
    const priority = TICKET_PRIORITIES.includes(req.query.priority) ? req.query.priority : '';
    const { where, params, q } = buildWhere({ q: req.query.q, searchColumns: ['tk.subject'], filters: [['tk.status', status], ['tk.priority', priority]] });
    const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM tickets tk ${where}`, params)).rows[0].n;
    const pg = pagination(parsePage(req.query.page), 30, total);
    const r = await pool.query(`SELECT tk.*,u.phone,u.first_name,u.last_name FROM tickets tk JOIN users u ON u.id=tk.user_id ${where} ORDER BY tk.updated_at DESC,tk.id DESC LIMIT ${pg.pageSize} OFFSET ${pg.offset}`, params);
    res.render('admin/tickets', { title: 'تیکت‌های پشتیبانی', tickets: r.rows, filters: { q, status, priority }, pg });
  }));
  app.get('/admin/tickets/:id', requireAdmin, asyncRoute(async (req, res) => {
    const t = await pool.query('SELECT tk.*,u.phone,u.first_name,u.last_name FROM tickets tk JOIN users u ON u.id=tk.user_id WHERE tk.id=$1', [req.params.id]);
    if (!t.rowCount) return renderError(res, 404, 'پیدا نشد', 'این تیکت پیدا نشد.');
    const messages = await pool.query('SELECT * FROM ticket_messages WHERE ticket_id=$1 ORDER BY created_at,id', [req.params.id]);
    res.render('admin/ticket-detail', { title: t.rows[0].subject, ticket: t.rows[0], messages: messages.rows });
  }));
  app.post('/admin/tickets/:id/reply', requireAdmin, asyncRoute(async (req, res) => {
    const t = await pool.query('SELECT id,status FROM tickets WHERE id=$1', [req.params.id]);
    if (!t.rowCount) return renderError(res, 404, 'پیدا نشد', 'این تیکت پیدا نشد.');
    const message = normalizeText(req.body.message, 4000);
    if (!message) { setFlash(req, 'error', 'متن پاسخ الزامی است.'); return res.redirect(`/admin/tickets/${req.params.id}`); }
    await pool.query('INSERT INTO ticket_messages(ticket_id,author_type,author_id,body) VALUES($1,\'admin\',$2,$3)', [req.params.id, req.admin.id, message]);
    await pool.query("UPDATE tickets SET status='answered',updated_at=NOW() WHERE id=$1", [req.params.id]);
    setFlash(req, 'success', 'پاسخ شما ثبت شد.');
    res.redirect(`/admin/tickets/${req.params.id}`);
  }));
  app.post('/admin/tickets/:id/status', requireAdmin, asyncRoute(async (req, res) => {
    const status = TICKET_STATUSES.includes(req.body.status) ? req.body.status : null;
    const priority = TICKET_PRIORITIES.includes(req.body.priority) ? req.body.priority : null;
    if (!status || !priority) { setFlash(req, 'error', 'مقدار واردشده معتبر نیست.'); return res.redirect(`/admin/tickets/${req.params.id}`); }
    const r = await pool.query('UPDATE tickets SET status=$1,priority=$2,updated_at=NOW() WHERE id=$3 RETURNING id', [status, priority, req.params.id]);
    setFlash(req, r.rowCount ? 'success' : 'error', r.rowCount ? 'وضعیت تیکت به‌روزرسانی شد.' : 'این تیکت پیدا نشد.');
    res.redirect(`/admin/tickets/${req.params.id}`);
  }));

  // ───────────── Admin: "About us" team members ─────────────
  app.get('/admin/team', requireAdmin, asyncRoute(async (req, res) => {
    const r = await pool.query('SELECT * FROM team_members ORDER BY display_order,id');
    res.render('admin/team', { title: 'اعضای تیم', members: r.rows });
  }));
  app.get('/admin/team/new', requireAdmin, (_req, res) => res.render('admin/team-form', { title: 'عضو جدید', member: null }));
  app.post('/admin/team', requireAdmin, coverUpload.single('photo'), multipartCsrf, verifyUploads(imagePolicy, '/admin/team/new'), asyncRoute(async (req, res) => {
    const name = normalizeText(req.body.name, 160);
    if (!name) { removeUploaded(req); setFlash(req, 'error', 'نام عضو تیم الزامی است.'); return res.redirect('/admin/team/new'); }
    const photo = req.file ? `/media/covers/${req.file.filename}` : '';
    const linkUrl = normalizeText(req.body.link_url, 500);
    await pool.query('INSERT INTO team_members(name,role,bio,photo_path,link_url,display_order,is_active) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [name, normalizeText(req.body.role, 160), normalizeText(req.body.bio, 1200), photo, isHttpsUrl(linkUrl) ? linkUrl : '', intInRange(req.body.display_order, -100000, 100000, 0), req.body.is_active === 'on']);
    setFlash(req, 'success', 'عضو تیم اضافه شد.'); res.redirect('/admin/team');
  }));
  app.get('/admin/team/:id/edit', requireAdmin, asyncRoute(async (req, res) => {
    const r = await pool.query('SELECT * FROM team_members WHERE id=$1', [req.params.id]);
    if (!r.rowCount) return renderError(res, 404, 'پیدا نشد', 'این عضو تیم پیدا نشد.');
    res.render('admin/team-form', { title: 'ویرایش عضو تیم', member: r.rows[0] });
  }));
  app.post('/admin/team/:id/edit', requireAdmin, coverUpload.single('photo'), multipartCsrf, verifyUploads(imagePolicy, req => `/admin/team/${req.params.id}/edit`), asyncRoute(async (req, res) => {
    const existing = await pool.query('SELECT * FROM team_members WHERE id=$1', [req.params.id]);
    if (!existing.rowCount) { removeUploaded(req); return renderError(res, 404, 'پیدا نشد', 'این عضو تیم پیدا نشد.'); }
    const name = normalizeText(req.body.name, 160);
    if (!name) { removeUploaded(req); setFlash(req, 'error', 'نام عضو تیم الزامی است.'); return res.redirect(`/admin/team/${req.params.id}/edit`); }
    const photo = req.file ? `/media/covers/${req.file.filename}` : existing.rows[0].photo_path;
    const linkUrl = normalizeText(req.body.link_url, 500);
    await pool.query('UPDATE team_members SET name=$1,role=$2,bio=$3,photo_path=$4,link_url=$5,display_order=$6,is_active=$7,updated_at=NOW() WHERE id=$8',
      [name, normalizeText(req.body.role, 160), normalizeText(req.body.bio, 1200), photo, isHttpsUrl(linkUrl) ? linkUrl : '', intInRange(req.body.display_order, -100000, 100000, 0), req.body.is_active === 'on', req.params.id]);
    if (req.file) await removeCoverIfUnused(existing.rows[0].photo_path, photo);
    setFlash(req, 'success', 'عضو تیم به‌روزرسانی شد.'); res.redirect('/admin/team');
  }));
  app.post('/admin/team/:id/delete', requireAdmin, asyncRoute(async (req, res) => {
    const r = await pool.query('DELETE FROM team_members WHERE id=$1 RETURNING photo_path', [req.params.id]);
    if (r.rowCount && r.rows[0].photo_path) await removeCoverIfUnused(r.rows[0].photo_path, '');
    setFlash(req, r.rowCount ? 'success' : 'error', r.rowCount ? 'عضو تیم حذف شد.' : 'این عضو تیم پیدا نشد.');
    res.redirect('/admin/team');
  }));

  app.use((req, res) => renderError(res, 404, 'صفحه پیدا نشد', 'نشانی واردشده وجود ندارد. از منوی سایت به صفحهٔ موردنظر بروید.'));
  app.use((err, req, res, _next) => {
    removeUploaded(req);
    if (err instanceof multer.MulterError) {
      const imageField = ['cover', 'inline_images'].includes(err.field);
      const limit = imageField ? 8 : MAX_UPLOAD_MB;
      const message = err.code === 'LIMIT_FILE_SIZE' ? `حجم فایل بیشتر از حد مجاز (${limit} مگابایت) است.` : 'بارگذاری فایل انجام نشد.';
      return renderError(res, 400, 'خطا در بارگذاری فایل', message);
    }
    if (err.message === 'File type rejected') return renderError(res, 400, 'نوع فایل مجاز نیست', 'نوع فایل انتخاب‌شده پشتیبانی نمی‌شود.');
    if (err.type === 'entity.too.large') return renderError(res, 413, 'درخواست بیش از حد بزرگ است', 'حجم اطلاعات ارسالی بیش از حد مجاز است.');
    logger.error('unhandled request error', { requestId: req.id, method: req.method, route: req.path, error: err, stack: IS_PROD ? undefined : err.stack });
    if (res.headersSent) return;
    renderError(res, 500, 'خطای داخلی', 'خطایی در پردازش درخواست رخ داد. دوباره تلاش کنید؛ اگر مشکل ادامه داشت، کد پیگیری زیر را به پشتیبانی بدهید.', { requestId: req.id });
  });

  getSettings().catch(() => {});
  const retention = setInterval(() => { void throttle.purgeExpired(); }, 10 * 60 * 1000);
  retention.unref();
  return { app, throttle, close: () => clearInterval(retention) };
}

module.exports = { createApp, ADMIN_LOGIN_LIMITS };
