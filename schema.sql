-- The Herald (Passive Syndication Layer) Database Schema

DROP TABLE IF EXISTS announcements;
DROP TABLE IF EXISTS operating_hours;
DROP TABLE IF EXISTS meta_connections;
DROP TABLE IF EXISTS posts; -- dropping old table
DROP TABLE IF EXISTS businesses;

CREATE TABLE businesses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE meta_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  platform TEXT NOT NULL, -- 'instagram', 'facebook'
  page_id TEXT, -- Facebook Page ID for /posts + /photos pulls
  access_token TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  UNIQUE(business_id, platform)
);

CREATE TABLE operating_hours (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  day_of_week INTEGER NOT NULL, -- 0-6 (Sun-Sat)
  open_time TEXT, -- e.g. '09:00'
  close_time TEXT, -- e.g. '17:00'
  is_closed BOOLEAN DEFAULT 0,
  override_status TEXT, -- 'closed', 'open_special' (applied for today)
  override_note TEXT,
  override_date DATE, -- The date the override applies to
  is_24h INTEGER NOT NULL DEFAULT 0,           -- added by migrate-add-hours-flags.sql
  appointment_only INTEGER NOT NULL DEFAULT 0, -- added by migrate-add-hours-flags.sql
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  UNIQUE(business_id, day_of_week)
);

-- added by migrate-add-hours-exceptions.sql: dated special/holiday hours,
-- independent of the day-of-week "today only" override above.
CREATE TABLE hours_exceptions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id    INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  exception_date DATE NOT NULL,
  status         TEXT NOT NULL,   -- 'closed' | 'open_special' | 'open_24h' | 'appointment_only'
  open_time      TEXT,
  close_time     TEXT,
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(business_id, exception_date)
);
CREATE INDEX idx_hours_exc_biz_date ON hours_exceptions(business_id, exception_date);

CREATE TABLE announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL UNIQUE,
  is_active BOOLEAN DEFAULT 0,
  text TEXT,
  expires_at DATETIME,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
);

CREATE INDEX idx_meta_business ON meta_connections(business_id);

CREATE TABLE crier_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  image_url TEXT,
  source TEXT NOT NULL DEFAULT 'owner', -- 'owner' | 'facebook'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
);
CREATE INDEX idx_crier_business ON crier_posts(business_id, created_at);

CREATE INDEX idx_hours_business ON operating_hours(business_id);

-- Seed Data for Testing
INSERT INTO businesses (name, slug, pin_hash) VALUES
('Warner''s Bakery', 'warners-bakery', 'a3b5a1f81f1cd98c25dbf731174ef6f5e93345d2e0571f5ef63cc1f54cf46d29');

-- (announcement + operating_hours seeds removed — add per-tenant as needed)
