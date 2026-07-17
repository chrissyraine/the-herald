-- New table for DATED special/holiday hours. The existing operating_hours
-- override_* columns only ever apply to "today" (override_date is stamped at
-- write time) — there is no way to schedule a change for a future date. This
-- table is additive and orthogonal: the public feed checks it for TODAY's date
-- first, and it wins over operating_hours.override_* when both exist for today.
-- Apply locally:  wrangler d1 execute herald --local --file=migrate-add-hours-exceptions.sql
-- Apply remote:   wrangler d1 execute herald --remote --file=migrate-add-hours-exceptions.sql -y

CREATE TABLE IF NOT EXISTS hours_exceptions (
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
CREATE INDEX IF NOT EXISTS idx_hours_exc_biz_date ON hours_exceptions(business_id, exception_date);
