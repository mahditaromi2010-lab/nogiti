-- 0007 plugin product content: richer admin-authored content for product_type='plugin' products
-- (a gallery of images, a usage/demo guide with step-by-step text+images, and an optional demo video
-- embed URL). Existing products and the 'course' product type are untouched; new columns default to ''
-- and new tables start empty, so this never changes how an existing (non-plugin) product renders.
-- ROLLBACK: db/migrations/0007_plugin_content.down.sql (drops the new tables and columns only).
ALTER TABLE products ADD COLUMN IF NOT EXISTS demo_video_url VARCHAR(1000) NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS usage_guide_intro VARCHAR(4000) NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS product_gallery_images (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  image_path VARCHAR(500) NOT NULL,
  caption VARCHAR(300) NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_gallery_images_product_idx ON product_gallery_images(product_id, sort_order, id);

CREATE TABLE IF NOT EXISTS product_demo_steps (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  body VARCHAR(2000) NOT NULL DEFAULT '',
  image_path VARCHAR(500) NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_demo_steps_product_idx ON product_demo_steps(product_id, sort_order, id);
