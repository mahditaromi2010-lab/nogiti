-- 0008 Hormozgan coverage map (item 7): project-coverage records behind the interactive map at /coverage-map.
-- DB table (not a static JSON file) so the map's data layer is already admin-editable in the future without
-- touching the frontend/map code — only the query behind the read endpoint changes.
--
-- *** DEMO DATA WARNING ***
-- The rows inserted below are placeholder / illustrative only (is_demo = TRUE), pending Novingity's real,
-- verified project archive for Hormozgan. Coordinates are approximate city centres, not surveyed gas-riser
-- locations. project_count is a nominal 1 per demo area. Do not treat this seed data as real coverage.
-- Replace it later with a dedicated admin tool or a direct UPDATE of these rows; the map UI reads whatever
-- is in this table through one function (readCoverageAreas in src/app.js), so swapping demo data for real
-- data never requires a frontend rewrite.
-- ROLLBACK: db/migrations/0008_coverage_map.down.sql (drops the table; no other data touched).
CREATE TABLE IF NOT EXISTS coverage_areas (
  id BIGSERIAL PRIMARY KEY,
  project_name VARCHAR(200) NOT NULL,
  province VARCHAR(100) NOT NULL DEFAULT 'هرمزگان',
  city VARCHAR(120) NOT NULL,
  district VARCHAR(120) NOT NULL DEFAULT '',
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  approximate_location_label VARCHAR(200) NOT NULL DEFAULT '',
  project_count INTEGER NOT NULL DEFAULT 0,
  service_type VARCHAR(200) NOT NULL DEFAULT '',
  project_status VARCHAR(20) NOT NULL DEFAULT 'under_review'
    CHECK (project_status IN ('completed','in_progress','planned','under_review')),
  gas_service_status VARCHAR(20) NOT NULL DEFAULT 'unknown'
    CHECK (gas_service_status IN ('installed','not_installed','planned','unknown')),
  riser_installation_status VARCHAR(20) NOT NULL DEFAULT 'unknown'
    CHECK (riser_installation_status IN ('installed','not_installed','planned','unknown')),
  riser_locations_identified BOOLEAN NOT NULL DEFAULT FALSE,
  planned_expansion BOOLEAN NOT NULL DEFAULT FALSE,
  description VARCHAR(2000) NOT NULL DEFAULT '',
  is_demo BOOLEAN NOT NULL DEFAULT TRUE,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS coverage_areas_city_idx ON coverage_areas(city);
CREATE INDEX IF NOT EXISTS coverage_areas_status_idx ON coverage_areas(project_status, gas_service_status);

INSERT INTO coverage_areas
  (project_name, province, city, district, lat, lng, approximate_location_label, project_count, service_type,
   project_status, gas_service_status, riser_installation_status, riser_locations_identified, planned_expansion, description, is_demo)
VALUES
  ('بررسی اولیه شبکه گاز بندرعباس', 'هرمزگان', 'بندرعباس', 'مرکز شهر', 27.1865, 56.2808, 'بندرعباس - محدوده مرکزی (تقریبی)', 1,
   'ارزیابی مهندسی گاز، برداشت وضع موجود', 'in_progress', 'not_installed', 'planned', FALSE, TRUE,
   'داده نمونه/آزمایشی برای نمایش قابلیت نقشه؛ تا تکمیل آرشیو واقعی پروژه‌های نوین گیتی، این مقادیر تقریبی هستند.', TRUE),
  ('بررسی وضعیت رایزر جزیره قشم', 'هرمزگان', 'قشم', 'مرکز جزیره', 26.9581, 56.2694, 'قشم - مرکز شهر (تقریبی)', 1,
   'ارزیابی مهندسی گاز، بازبینی فنی', 'under_review', 'unknown', 'unknown', FALSE, FALSE,
   'داده نمونه/آزمایشی برای نمایش قابلیت نقشه؛ اطلاعات واقعی هنوز ثبت نشده است.', TRUE),
  ('امکان‌سنجی پروژه مسکونی میناب', 'هرمزگان', 'میناب', 'مرکز شهر', 27.1376, 57.0801, 'میناب - مرکز شهر (تقریبی)', 1,
   'امکان‌سنجی پروژه، طراحی و محاسبات مهندسی', 'planned', 'planned', 'planned', FALSE, TRUE,
   'داده نمونه/آزمایشی برای نمایش قابلیت نقشه؛ این یک پروژه فرضی است و نشان‌دهنده وجود خدمات واقعی نیست.', TRUE),
  ('برداشت نقشه معماری بندرلنگه', 'هرمزگان', 'بندر لنگه', 'مرکز شهر', 26.5579, 54.8807, 'بندر لنگه - مرکز شهر (تقریبی)', 1,
   'برداشت نقشه معماری، برداشت وضع موجود', 'completed', 'installed', 'installed', TRUE, FALSE,
   'داده نمونه/آزمایشی برای نمایش قابلیت نقشه؛ پروژه نمادین با وضعیت تکمیل‌شده برای تست رنگ سبز راهنمای نقشه.', TRUE),
  ('ارزیابی فنی منطقه بستک', 'هرمزگان', 'بستک', 'مرکز شهر', 27.2039, 54.3652, 'بستک - مرکز شهر (تقریبی)', 1,
   'بازبینی فنی، مشاوره مهندسی', 'under_review', 'unknown', 'unknown', FALSE, FALSE,
   'داده نمونه/آزمایشی برای نمایش قابلیت نقشه؛ در انتظار بررسی میدانی واقعی.', TRUE),
  ('مشاوره مهندسی گاز بندر جاسک', 'هرمزگان', 'جاسک', 'مرکز شهر', 25.6440, 57.7686, 'جاسک - مرکز شهر (تقریبی)', 1,
   'مشاوره مهندسی گاز', 'planned', 'not_installed', 'planned', FALSE, TRUE,
   'داده نمونه/آزمایشی برای نمایش قابلیت نقشه؛ هیچ خدمت گازرسانی تأییدشده‌ای در این رکورد وجود ندارد.', TRUE),
  ('بررسی وضعیت موجود رودان', 'هرمزگان', 'رودان', 'مرکز شهر', 27.4583, 57.0975, 'رودان - مرکز شهر (تقریبی)', 1,
   'برداشت وضع موجود، ارزیابی مهندسی گاز', 'in_progress', 'not_installed', 'unknown', FALSE, FALSE,
   'داده نمونه/آزمایشی برای نمایش قابلیت نقشه؛ بخشی از آرشیو واقعی هنوز جمع‌آوری نشده است.', TRUE)
ON CONFLICT DO NOTHING;
