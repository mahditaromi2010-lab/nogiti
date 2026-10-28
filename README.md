# Nogiti Platform — نسخهٔ 1.1.0

وب‌سایت Nogiti: ابزارهای محاسبات تأسیسات، فروشگاه دوره و افزونهٔ اتوکد، مقالات تخصصی، حساب کاربری با ورود پیامکی و پنل مدیریت نقش‌محور.

- **فناوری:** Node.js 20.11+ (توصیه: 22) · Express 4 · EJS · PostgreSQL 14+ (آزموده با 16)
- **بدون** Redis، صف پس‌زمینه یا سرویس خارجی اجباری. پیامک (Kavenegar) و پرداخت (ZarinPal) اختیاری و قابل پیکربندی‌اند.

مستندات تکمیلی در پوشهٔ `docs/`:

| سند | محتوا |
|---|---|
| `docs/AUDIT-AND-REUSE-fa.md` | ممیزی هر دو پروژه و جدول اجزای Paradigmshift (استفاده‌شده / ردشده و دلیل) |
| `docs/CHANGES-fa.md` | تغییرات بک‌اند و فرانت‌اند، وضعیت پنل مدیریت، نقشهٔ «رابط ← مسیر ← دیتابیس» |
| `docs/DATABASE-AND-ROUTES-fa.md` | مدل داده، مهاجرت‌ها، مسیرها و قرارداد فرم‌ها |
| `docs/TEST-REPORT-fa.md` | نتایج آزمون‌ها (موفق / ناموفق / اجرانشده) |
| `docs/SECURITY-fa.md` | کنترل‌های امنیتی و مشکلات باقی‌مانده |
| `docs/ENVIRONMENT-fa.md` | همهٔ متغیرهای محیطی، قواعد اعتبارسنجی هنگام شروع و نمونهٔ production |
| `docs/DEPLOY-AND-ROLLBACK-fa.md` | استقرار، پشتیبان‌گیری، بازیابی و بازگشت به نسخهٔ قبل |
| `docs/history/` | گزارش‌های نسخهٔ قبلی (فقط برای سابقه) |

## اجرای محلی

### با Docker

```bash
cp .env.example .env          # POSTGRES_PASSWORD و APP_SECRET را عوض کنید (openssl rand -hex 32)
docker compose up --build -d  # مهاجرت‌ها هنگام شروع کانتینر خودکار اجرا می‌شوند
docker compose exec -e ADMIN_USERNAME=site_owner -e ADMIN_PASSWORD='یک-رمز-یکتا-و-طولانی' web npm run admin:create
```

سایت: `http://localhost:3000` — ورود مدیر: `/admin/login`

> فایل `docker-compose.yml` اعتبارسنجی شده ولی image در محیط توسعه ساخته نشد (دسترسی Docker Hub مسدود بود). بار اول وضعیت `healthy` را در `docker compose ps` بررسی کنید.

### بدون Docker

```bash
cp .env.example .env     # DATABASE_URL را به PostgreSQL محلی اشاره دهید
npm ci
npm run db:migrate
ADMIN_USERNAME=site_owner ADMIN_PASSWORD='یک-رمز-یکتا-و-طولانی' npm run admin:create
npm start
```

برای آزمایش ورود پیامکی بدون Kavenegar در محیط توسعه: `SHOW_DEV_OTP=true` (کد روی صفحهٔ ورود نمایش داده می‌شود؛ در production غیرفعال است).

## متغیرهای محیطی

سرور هنگام شروع متغیرها را بررسی می‌کند و با پیکربندی نادرست production اجرا نمی‌شود. جزئیات کامل و نمونهٔ production: `docs/ENVIRONMENT-fa.md`.

| متغیر | الزامی | توضیح |
|---|---|---|
| `DATABASE_URL` | بله | نشانی PostgreSQL |
| `APP_SECRET` | بله (production) | حداقل ۳۲ نویسهٔ تصادفی؛ مقدار نمونه در production رد می‌شود. امضای نشست، هش OTP و کلید HMAC شمارندهٔ ورود |
| `APP_URL` | بله (production) | نشانی عمومی؛ با `https://` کوکی `Secure` می‌شود و callback پرداخت از آن ساخته می‌شود |
| `NODE_ENV` | — | `production` در سرور |
| `PORT` | — | پیش‌فرض 3000 |
| `TRUST_PROXY` | — | پشت reverse proxy با TLS مقدار `true` |
| `POSTGRES_PASSWORD` | Docker | فقط برای docker-compose |
| `PGSSLMODE` | — | `require` برای دیتابیس مدیریت‌شده با TLS |
| `DB_POOL_SIZE` | — | پیش‌فرض 10 |
| `UPLOAD_DIR` / `MAX_UPLOAD_MB` | — | محل فایل‌ها (پیش‌فرض `./uploads`) و سقف حجم فایل دوره (پیش‌فرض 100) |
| `KAVENEGAR_API_KEY` / `KAVENEGAR_SENDER` | برای OTP در production | بدون کلید، ورود پیامکی در production غیرفعال است |
| `ZARINPAL_MERCHANT_ID` / `ZARINPAL_SANDBOX` | برای فروش | بدون شناسه، خرید با پیام روشن متوقف می‌شود و سفارشی ساخته نمی‌شود |
| `SHOW_DEV_OTP` | — | فقط توسعه |
| `LOG_LEVEL` | — | `debug`/`info`/`warn`/`error` — لاگ‌ها JSON و پاک‌سازی‌شده (رمز، توکن، OTP و موبایل ماسک می‌شوند) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | فقط هنگام `admin:create` | پس از ساخت حساب از محیط حذف شوند |
| `TEST_DATABASE_URL` | فقط آزمون | دیتابیس **یک‌بارمصرف** که نامش شامل `test` باشد (schema آن پاک می‌شود) |

## دستورها

| دستور | کار |
|---|---|
| `npm start` | اجرای سرور |
| `npm run db:migrate` | اعمال مهاجرت‌های معوق (تراکنشی، با قفل advisory) |
| `npm run db:status` | فهرست مهاجرت‌های اعمال‌شده/معوق و تشخیص ویرایش مهاجرت اعمال‌شده |
| `CONFIRM_ROLLBACK=YES node scripts/migrate.js --down 0002` | بازگشت آخرین مهاجرت (پس از پشتیبان‌گیری) |
| `npm run admin:create` | ساخت/بازنشانی حساب مدیر اصلی از محیط امن سرور |
| `npm run check` | بررسی نحوی همهٔ JS و کامپایل همهٔ قالب‌های EJS + آزمون‌های واحد |
| `npm run test:integration` | آزمون‌های یکپارچه روی PostgreSQL واقعی (`TEST_DATABASE_URL`) |
| `npm run test:all` | آزمون‌های واحد و یکپارچه |
| `npm run test:ui` | آزمون مرورگر (اختیاری؛ نیازمند Playwright و یک سرور در حال اجرا؛ `BASE_URL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`) |
| `scripts/backup.sh` / `scripts/restore.sh` | پشتیبان‌گیری و بازیابی دیتابیس و فایل‌ها |

## نقش‌های مدیریتی

| نقش | دسترسی |
|---|---|
| `owner` | همه‌چیز + مدیریت مدیران |
| `admin` | همه‌چیز به‌جز مدیریت مدیران |
| `content` | محصولات، فایل‌های دوره، مقالات و تصاویر |
| `orders` | سفارش‌ها |
| `users` | کاربران (فعال/غیرفعال‌سازی) |

همهٔ مسیرهای `/admin/*` در سرور بر اساس نقش بررسی می‌شوند؛ پنهان‌بودن منو فقط برای راحتی است.

## محدودیت مهم محاسبات تأسیسات

جدول‌ها و فرمول‌های ابزارها از فایل HTML اصلی منتقل شده‌اند و **اعتبارسنجی مقرراتی نشده‌اند**. پیش از استفادهٔ اجرایی باید با ویرایش جاری مبحث ۱۷ و منابع رسمی توسط متخصص کنترل شوند. این نسخه منطق محاسباتی را تغییر نداده است.
