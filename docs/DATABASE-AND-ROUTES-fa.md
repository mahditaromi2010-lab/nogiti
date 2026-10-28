# دیتابیس، مهاجرت‌ها و مسیرها

## مهاجرت‌ها

| نسخه | فایل | محتوا | بازگشت |
|---|---|---|---|
| 0001 | `db/migrations/0001_baseline.sql` | دقیقاً همان `db/schema.sql` نسخهٔ قبلی (همهٔ دستورها idempotent) | ندارد — بازیابی از پشتیبان |
| 0002 | `db/migrations/0002_hardening.sql` | جدول `rate_limit_hits`؛ ساخت صریح `web_sessions` با همان DDL کتابخانه؛ ۶ ایندکس (order_items.product_id، orders(status,created_at)، users.created_at، audit.action، products/articles.updated_at) | `0002_hardening.down.sql` (فقط داده‌های شمارنده و ایندکس‌ها؛ هیچ دادهٔ کاربری) |

اجراکننده (`src/lib/migrations.js`):
- جدول `schema_migrations(version, name, checksum, applied_at)`؛
- هر مهاجرت در یک تراکنش؛ خطا = rollback کامل همان مهاجرت؛
- `pg_advisory_lock` تا چند نمونهٔ برنامه هم‌زمان مهاجرت نکنند (آزموده با سه اجرای هم‌زمان)؛
- اگر فایل مهاجرتِ اعمال‌شده ویرایش شود، اجرا با خطای checksum متوقف می‌شود؛
- بازگشت فقط برای آخرین مهاجرت و با `CONFIRM_ROLLBACK=YES`.

**ارتقای دیتابیس موجود (نسخهٔ v2):** دیتابیس‌هایی که با `schema.sql` قدیمی ساخته شده‌اند جدول `schema_migrations` ندارند؛ اجرای `npm run db:migrate` ابتدا 0001 را (بدون اثر روی داده‌ها، چون idempotent است) و سپس 0002 را اعمال می‌کند. این سناریو با داده‌های نمونه آزموده شد: تعداد ردیف‌ها و نام سفارشی سایت دست‌نخورده ماند. **پیش از ارتقا پشتیبان بگیرید.**

قانون: مهاجرت اعمال‌شده را ویرایش نکنید؛ تغییر بعدی = فایل `0003_….sql` (+ در صورت امکان `0003_….down.sql`).

## مدل داده (خلاصه)

| جدول | نقش | کلیدها و محدودیت‌های مهم |
|---|---|---|
| users | مشتریان (ورود OTP) | `phone` یکتا؛ `role in (user, admin)` — مقدار admin فقط سابقهٔ قدیمی است و دسترسی نمی‌دهد |
| otp_codes | کدهای یک‌بارمصرف (فقط هش) | انقضا ۵ دقیقه، حداکثر ۵ تلاش، `consumed_at` |
| products / product_assets | دوره‌ها و افزونه‌ها / درس‌ها و فایل‌ها | slug یکتا؛ `price_toman >= 0`؛ FK با `ON DELETE CASCADE` برای فایل‌ها؛ محصول حذف فیزیکی نمی‌شود (آرشیو) |
| articles / article_images | مجله | slug یکتا؛ FK cascade |
| orders / order_items | سفارش و اقلام | `authority` یکتا؛ `status in (pending, paid, failed, cancelled)`؛ `UNIQUE(order_id, product_id)`؛ اقلام به محصول FK بدون cascade (حفظ سابقه) |
| site_settings | تنظیمات کلید/مقدار | |
| admin_accounts | هویت مدیران | `username` یکتا؛ `role` CHECK؛ `session_version` |
| admin_audit_logs | گزارش امنیتی | بدون رمز/OTP/بدنهٔ فرم |
| admin_credentials | جدول قدیمی (فقط برای مهاجرت سازگار) | حذف نشد تا دادهٔ قدیمی از دست نرود |
| rate_limit_hits | شمارندهٔ تلاش ورود مدیر | فقط HMAC-SHA256 کلید؛ هر تلاش زیر قفل advisory شمرده می‌شود؛ پاک‌سازی خودکار ردیف‌های بیش از ۲۴ ساعت |
| web_sessions | نشست‌ها | فقط برای بازدیدکنندهٔ دارای فرم/ورود ساخته می‌شود (نه برای هر بازدید)؛ پاک‌سازی دوره‌ای توسط connect-pg-simple |
| schema_migrations | نسخهٔ schema | |

## API و مسیرها

معماری Nogiti رندر سمت سرور با فرم‌های HTML است و این الگو برای همهٔ عملیات فعلی کافی و آزموده است؛ بنابراین **REST API جداگانه ساخته نشد** (ساختنش سطح حمله و نگهداری دوم بدون مصرف‌کننده ایجاد می‌کرد). تنها خروجی‌های JSON:

| مسیر | پاسخ |
|---|---|
| `GET /health` | `{"ok":true,"service":"nogiti-platform"}` (سازگار با قبل) |
| `GET /health/live` | `{"status":"ok"}` |
| `GET /health/ready` | 200 `{"status":"ok","checks":{"database":"ok","migrations":"ok"}}`؛ یا 503 اگر دیتابیس در دسترس نباشد یا هر یک از مهاجرت‌های همین نسخه اعمال نشده باشد (`"pending":["0002"]`) |

### قرارداد فرم‌ها

- همهٔ POSTها: فیلد `_csrf` (توکن نشست) الزامی؛ اگر هدر `Origin` باشد باید برابر `APP_URL` یا میزبان درخواست باشد؛ در غیر این صورت 403.
- پاسخ موفق/ناموفق: redirect (302) + پیام flash؛ خطای اعتبارسنجی تنظیمات: 422 با پیام کنار فیلد.
- شناسهٔ نامعتبر: 404؛ نبود مجوز: 403؛ نشست منقضی مدیر: 401؛ محدودیت نرخ OTP: 429؛ خطای داخلی: 500 با کد پیگیری.

### فهرست مسیرها

عمومی: `GET /`، `/tools`، `/shop` (`?q=&type=course|plugin`)، `/shop/:slug`، `/articles` (`?q=`)، `/articles/:slug`، `/about`

کاربر: `GET /login` (`?next=`)، `POST /auth/request-code`، `POST /auth/verify-code`، `POST /logout`، `GET /account`، `POST /account/profile`، `POST /checkout/:id`، `GET /payments/zarinpal/callback`، `GET /secure-assets/:id`

مدیر (همه با بررسی نقش سمت سرور):

| مسیر | مجوز |
|---|---|
| `GET/POST /admin/login` | عمومی (با شمارندهٔ پایدار) |
| `POST /admin/logout`، `GET /admin/account`، `POST /admin/account/credentials` | self |
| `GET /admin` | overview |
| `/admin/products…`، `/admin/assets/:id/delete`، `/admin/articles…`، `/admin/article-images/:id/delete` | content |
| `GET /admin/orders` (`?q=&status=&page=`) | orders |
| `GET /admin/users` (`?q=&state=&page=`)، `POST /admin/users/:id/toggle` | users |
| `GET/POST /admin/settings` | settings |
| `GET /admin/audit` (`?kind=login|account|mutation&actor=&page=`) | audit |
| `/admin/admins…` | admins (فقط owner) |
