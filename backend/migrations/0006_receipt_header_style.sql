PRAGMA foreign_keys = ON;

ALTER TABLE receipt_settings ADD COLUMN header_bold INTEGER NOT NULL DEFAULT 1 CHECK (header_bold IN (0, 1));
ALTER TABLE receipt_settings ADD COLUMN header_font_size TEXT NOT NULL DEFAULT 'tall' CHECK (header_font_size IN ('normal', 'tall', 'wide', 'large'));
