-- 0009 engineering consultation / project assessment requests (item 8), linked to the coverage map (item 7).
-- Public form submissions are persisted here (no email is sent anywhere in this app, same convention as
-- the support-ticket tables in 0005). Reviewed by admins at /admin/consultation-requests.
-- ROLLBACK: db/migrations/0009_consultation_requests.down.sql (drops the table; no other data touched).
CREATE TABLE IF NOT EXISTS consultation_requests (
  id BIGSERIAL PRIMARY KEY,
  full_name VARCHAR(160) NOT NULL,
  mobile VARCHAR(20) NOT NULL,
  contact_method VARCHAR(20) NOT NULL DEFAULT 'phone' CHECK (contact_method IN ('phone','sms','whatsapp','email')),
  province VARCHAR(100) NOT NULL DEFAULT 'هرمزگان',
  city VARCHAR(120) NOT NULL DEFAULT '',
  district VARCHAR(120) NOT NULL DEFAULT '',
  coverage_area_id BIGINT REFERENCES coverage_areas(id) ON DELETE SET NULL,
  project_type VARCHAR(160) NOT NULL DEFAULT '',
  project_address VARCHAR(400) NOT NULL DEFAULT '',
  project_description VARCHAR(3000) NOT NULL DEFAULT '',
  request_type VARCHAR(60) NOT NULL DEFAULT 'other'
    CHECK (request_type IN ('engineering_consultation','gas_engineering_assessment','feasibility_study',
      'existing_condition_survey','architectural_survey','engineering_design','technical_review','other')),
  project_status VARCHAR(40) NOT NULL DEFAULT 'other'
    CHECK (project_status IN ('existing_building','under_construction','planned_project','renovation','other')),
  attachment_path VARCHAR(500) NOT NULL DEFAULT '',
  notes VARCHAR(2000) NOT NULL DEFAULT '',
  preferred_contact_time VARCHAR(120) NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewing','contacted','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS consultation_requests_created_idx ON consultation_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS consultation_requests_status_idx ON consultation_requests(status, created_at DESC);
