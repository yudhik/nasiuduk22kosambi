PRAGMA foreign_keys = ON;

ALTER TABLE receipt_settings ADD COLUMN review_enabled INTEGER NOT NULL DEFAULT 0 CHECK (review_enabled IN (0, 1));
ALTER TABLE receipt_settings ADD COLUMN review_text TEXT NOT NULL DEFAULT '';
ALTER TABLE receipt_settings ADD COLUMN review_url TEXT NOT NULL DEFAULT '';
