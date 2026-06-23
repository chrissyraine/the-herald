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
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  UNIQUE(business_id, day_of_week)
);

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
CREATE INDEX idx_hours_business ON operating_hours(business_id);

-- Seed Data for Testing
INSERT INTO businesses (name, slug, pin_hash) VALUES 
('Titusville Mill', 'titusville-mill', 'a3b5a1f81f1cd98c25dbf731174ef6f5e93345d2e0571f5ef63cc1f54cf46d29'), -- Hash for "admin"
('Warner''s Bakery', 'warners-bakery', 'a3b5a1f81f1cd98c25dbf731174ef6f5e93345d2e0571f5ef63cc1f54cf46d29');

INSERT INTO announcements (business_id, is_active, text, expires_at) VALUES
(1, 1, 'Closed Tuesday for a private event.', '2026-06-24 23:59:59');

INSERT INTO operating_hours (business_id, day_of_week, open_time, close_time) VALUES
(1, 1, '11:00', '21:00'),
(1, 2, '11:00', '21:00'),
(1, 3, '11:00', '21:00'),
(1, 4, '11:00', '21:00'),
(1, 5, '11:00', '22:00'),
(1, 6, '11:00', '22:00'),
(1, 0, '11:00', '19:00');
