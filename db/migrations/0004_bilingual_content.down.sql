-- Rollback for 0004_bilingual_content: drops only the new English columns.
ALTER TABLE products DROP COLUMN IF EXISTS title_en;
ALTER TABLE products DROP COLUMN IF EXISTS subtitle_en;
ALTER TABLE products DROP COLUMN IF EXISTS short_description_en;
ALTER TABLE products DROP COLUMN IF EXISTS description_en;

ALTER TABLE articles DROP COLUMN IF EXISTS title_en;
ALTER TABLE articles DROP COLUMN IF EXISTS excerpt_en;
ALTER TABLE articles DROP COLUMN IF EXISTS content_en;
