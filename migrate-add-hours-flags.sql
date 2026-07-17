-- Adds is_24h / appointment_only flags to the existing weekly operating_hours
-- rows, for TownSquare's owner-dashboard Hours manager (brokered through
-- gettownsquare.app). Additive only — existing override_status/override_note/
-- override_date columns and the current hours/override endpoint are untouched.
--
-- NOTE: schema.sql in this repo DROPs and recreates tables — it is a fresh-setup
-- script, NOT safe to re-run against the live DB. This is the first standalone
-- migrate-*.sql in this repo (mirroring the convention already used in the
-- sibling `townsquare` repo); apply it directly against the live D1 instead.
-- Apply locally:  wrangler d1 execute herald --local --file=migrate-add-hours-flags.sql
-- Apply remote:   wrangler d1 execute herald --remote --file=migrate-add-hours-flags.sql -y

ALTER TABLE operating_hours ADD COLUMN is_24h INTEGER NOT NULL DEFAULT 0;
ALTER TABLE operating_hours ADD COLUMN appointment_only INTEGER NOT NULL DEFAULT 0;
