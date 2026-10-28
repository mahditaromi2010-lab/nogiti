# استقرار، پشتیبان‌گیری و بازگشت

## پیش‌نیازهای production

- HTTPS در reverse proxy (Caddy/Nginx/PaaS) و `TRUST_PROXY=true`، `APP_URL=https://دامنه`.
- `APP_SECRET` تصادفی ≥ ۳۲ نویسه (`openssl rand -hex 32`)؛ مقدار نمونه رد می‌شود.
- PostgreSQL 14+ با پشتیبان‌گیری منظم؛ volume پایدار برای `uploads/`.
- `KAVENEGAR_API_KEY` برای ورود کاربران؛ `ZARINPAL_MERCHANT_ID` و آزمون sandbox پیش از `ZARINPAL_SANDBOX=false`.

## استقرار نسخهٔ 1.1.0 روی سرور فعلی (ارتقا از v2)

1. **پشتیبان:** `DATABASE_URL=… UPLOAD_DIR=… ./scripts/backup.sh` و انتقال فایل‌ها به محل امن خارج از سرور.
2. تگ/نگهداری image یا پوشهٔ نسخهٔ فعلی برای بازگشت.
3. استقرار کد جدید و `npm ci --omit=dev` (یا build image).
4. `npm run db:migrate` (در Docker خودکار هنگام شروع) و سپس `npm run db:status`.
5. شروع برنامه؛ بررسی `GET /health/ready` = 200.
6. دود-آزمون: صفحهٔ اصلی، `/shop`، ورود مدیر، ساخت پیش‌نویس مقاله، یک جست‌وجو.

اثر بر کاربران: نام کوکی نشست تغییر نکرده؛ نشست‌های فعلی معتبر می‌مانند. مهاجرت 0002 فقط افزودنی است.

## بازگشت به نسخهٔ قبلی (v2)

نسخهٔ v2 با schema پس از 0002 کار می‌کند (فقط جدول/ایندکس اضافه شده و `web_sessions` همان ساختار را دارد)؛ این در عمل آزموده شد: کد اصلی v2 روی همان دیتابیس مهاجرت‌یافته در حالت production اجرا شد و صفحه‌ها، ورود مدیر و پنل کار کردند. پس معمولاً **فقط کد** برگردانده می‌شود:

1. توقف نسخهٔ 1.1.0 و اجرای image/کد v2.
2. (اختیاری) حذف تغییرات schema: `CONFIRM_ROLLBACK=YES node scripts/migrate.js --down 0002` — پیش از جایگزینی کد، با کد 1.1.0 اجرا شود.
3. اگر دادهٔ نادرست ثبت شده: بازیابی کامل در دیتابیس **جدید و خالی**:
   ```bash
   createdb nugas_restored
   DATABASE_URL=postgres://…/nugas_restored UPLOAD_DIR=./uploads-restored \
   CONFIRM_DESTRUCTIVE_RESTORE=YES ./scripts/restore.sh backups/nogiti-db-<ts>.sql.gz backups/nogiti-uploads-<ts>.tar.gz
   ```
   سپس `DATABASE_URL` برنامه را به دیتابیس بازیابی‌شده تغییر دهید. اسکریپت بازیابی روی دیتابیس غیرخالی اجرا نمی‌شود مگر با `ALLOW_NON_EMPTY_TARGET=YES`.

## پشتیبان‌گیری منظم

`scripts/backup.sh` دیتابیس (pg_dump فشرده، بررسی یکپارچگی gzip) و پوشهٔ uploads (tar) را با فایل SHA-256 می‌سازد؛ دسترسی پوشه 700 و فایل‌ها 600 است. پیشنهاد: اجرای روزانه با cron، نگهداری خارج از سرور با رمزنگاری، و تمرین بازیابی ماهانه.

## Docker

`docker compose up --build -d` — کانتینر web با کاربر غیرریشه، HEALTHCHECK روی `/health/ready`، و اجرای مهاجرت پیش از شروع.

> این image در محیط توسعه ساخته نشد (دسترسی به Docker Hub مسدود بود). در اولین استقرار، پس از `docker compose up --build -d` خروجی `docker compose ps` (وضعیت healthy) و `curl -f http://localhost:3000/health/ready` را بررسی کنید.

## تمرین پشتیبان‌گیری و بازیابی (انجام‌شده)

`backup.sh` → `restore.sh` روی دیتابیس تازه اجرا شد: شمار ردیف همهٔ جدول‌ها (کاربران، محصولات، مقالات، سفارش‌ها، مدیران، گزارش امنیتی، مهاجرت‌ها) برابر، فایل‌های آپلود بایت‌به‌بایت یکسان، `sha256sum -c` موفق؛ اجرای بدون `CONFIRM_DESTRUCTIVE_RESTORE` (کد ۳) و روی دیتابیس غیرخالی (کد ۴) رد شد.
