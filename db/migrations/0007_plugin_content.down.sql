DROP TABLE IF EXISTS product_demo_steps;
DROP TABLE IF EXISTS product_gallery_images;
ALTER TABLE products DROP COLUMN IF EXISTS usage_guide_intro;
ALTER TABLE products DROP COLUMN IF EXISTS demo_video_url;
