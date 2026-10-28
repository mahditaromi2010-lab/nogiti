# راهنمای پیکربندی متغیرهای محیطی

مقدارها در فایل `.env` (اجرای محلی) یا تنظیمات محیط سرور/کانتینر قرار می‌گیرند. فایل `.env` هرگز نباید وارد Git یا ZIP شود (در `.gitignore` و `.dockerignore` مستثنا شده است). نمونهٔ کامل: `.env.example`.

## بررسی خودکار هنگام شروع

`src/lib/config.js` پیش از باز شدن پورت متغیرها را بررسی می‌کند:

- **خطا** ← سرور شروع نمی‌شود و در لاگ `configuration error` با نام متغیر ثبت می‌شود. مقدار متغیر هرگز چاپ نمی‌شود.
- **هشدار** ← سرور شروع می‌شود و `configuration warning` ثبت می‌شود.

| متغیر | پیش‌فرض | قاعده | در production |
|---|---|---|---|
| `NODE_ENV` | development | `development` / `test` / `production` | باید `production` باشد |
| `DATABASE_URL` | — | الزامی؛ با `postgres://` یا `postgresql://` | الزامی |
| `APP_SECRET` | مقدار توسعه | — | **خطا** اگر کمتر از ۳۲ نویسه یا مقدار نمونه (`replace-…`/`change-…`) باشد. ساخت: `openssl rand -hex 32`. تغییر آن همهٔ نشست‌ها و کدهای OTP در جریان را باطل می‌کند |
| `APP_URL` | `http://localhost:PORT` | نشانی مطلق http(s) | **خطا** اگر خالی باشد؛ **هشدار** اگر `http://` باشد (کوکی بدون Secure) |
| `PORT` | 3000 | عدد ۱ تا ۶۵۵۳۵ | |
| `TRUST_PROXY` | false | `true` / `false` | پشت پروکسی TLS باید `true` باشد؛ با `APP_URL` از نوع https و مقدار غیر `true` هشدار داده می‌شود |
| `PGSSLMODE` | — | `require` برای دیتابیس مدیریت‌شده با TLS | |
| `DB_POOL_SIZE` | 10 | عدد صحیح ۱ تا ۱۰۰ | |
| `UPLOAD_DIR` | `./uploads` | مسیر قابل نوشتن؛ زیرپوشه‌های `covers` و `private` خودکار ساخته می‌شوند | روی volume پایدار و داخل برنامهٔ پشتیبان‌گیری |
| `MAX_UPLOAD_MB` | 100 | عدد ۱ تا ۲۰۴۸ (سقف فایل‌های دوره؛ تصاویر همیشه ۸ مگابایت) | سقف بدنهٔ درخواست در reverse proxy هم باید هم‌اندازه باشد |
| `KAVENEGAR_API_KEY` / `KAVENEGAR_SENDER` | خالی | | خالی ← **هشدار**: ورود پیامکی کاربران غیرفعال است (ورود مدیر کار می‌کند) |
| `ZARINPAL_MERCHANT_ID` | خالی | | خالی ← **هشدار**: خرید غیرفعال است |
| `ZARINPAL_SANDBOX` | true | `true` / `false` | با شناسهٔ درگاه و مقدار غیر `false` ← هشدار (پرداخت به sandbox می‌رود) |
| `SHOW_DEV_OTP` | false | `true` / `false` | در production نادیده گرفته می‌شود (هشدار) |
| `LOG_LEVEL` | info | `debug`/`info`/`warn`/`error`/`silent` | |
| `SHUTDOWN_TIMEOUT_MS` | 10000 | مهلت خاموشی امن | |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | — | فقط برای `npm run admin:create` | اگر `ADMIN_PASSWORD` در محیط اجرای سرور باقی بماند هشدار داده می‌شود؛ پس از ساخت حساب حذف شود |
| `POSTGRES_PASSWORD` | — | فقط docker-compose | |
| `WEB_PORT` | 3000 | فقط docker-compose: پورت میزبان؛ اگر ۳۰۰۰ اشغال است عوض کنید و `APP_URL` را هم هماهنگ کنید | |
| `TEST_DATABASE_URL` | — | فقط آزمون؛ دیتابیس **یک‌بارمصرف** که نامش شامل `test` باشد (schema آن پاک می‌شود) | هرگز روی دیتابیس واقعی تنظیم نشود |
| `BACKUP_DIR` | `./backups` | فقط اسکریپت‌های پشتیبان | |

## نمونهٔ production پشت reverse proxy

```dotenv
NODE_ENV=production
PORT=3000
APP_URL=https://nogiti.ir
TRUST_PROXY=true
APP_SECRET=<خروجی openssl rand -hex 32>
DATABASE_URL=postgres://nugas_user:<رمز>@db:5432/nugas
UPLOAD_DIR=/app/uploads
MAX_UPLOAD_MB=100
KAVENEGAR_API_KEY=<کلید>
KAVENEGAR_SENDER=<شمارهٔ ارسال>
ZARINPAL_MERCHANT_ID=<شناسه>
ZARINPAL_SANDBOX=false
LOG_LEVEL=info
```

خروجی سرور با این پیکربندی هیچ `configuration warning` نخواهد داشت (آزمون واحد `environment validation …` همین را بررسی می‌کند).
