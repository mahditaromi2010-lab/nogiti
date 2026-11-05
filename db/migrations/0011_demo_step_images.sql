-- 0011: a plugin tutorial part ("demo step") can hold several images, not just one. Additive only: the
-- existing product_demo_steps.image_path stays and is still shown first, so nothing already published changes.
-- ROLLBACK: db/migrations/0011_demo_step_images.down.sql
CREATE TABLE IF NOT EXISTS product_demo_step_images (
  id BIGSERIAL PRIMARY KEY,
  step_id BIGINT NOT NULL REFERENCES product_demo_steps(id) ON DELETE CASCADE,
  image_path VARCHAR(500) NOT NULL,
  caption VARCHAR(300) NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_demo_step_images_step_idx ON product_demo_step_images(step_id, sort_order, id);
