PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS promotions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    discount_type TEXT NOT NULL CHECK (discount_type IN ('FIXED', 'PERCENT')),
    discount_value INTEGER NOT NULL CHECK (discount_value > 0),
    max_discount INTEGER CHECK (max_discount IS NULL OR max_discount > 0),
    min_order_amount INTEGER NOT NULL DEFAULT 0 CHECK (min_order_amount >= 0),
    quota_limit INTEGER NOT NULL CHECK (quota_limit > 0),
    used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= quota_limit),
    start_date TEXT,
    end_date TEXT,
    regular_only INTEGER NOT NULL DEFAULT 1 CHECK (regular_only IN (0, 1)),
    receipt_promo_text TEXT NOT NULL DEFAULT '',
    receipt_media_type TEXT NOT NULL DEFAULT 'NONE' CHECK (receipt_media_type IN ('NONE', 'QR', 'BARCODE')),
    receipt_media_value TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

ALTER TABLE orders ADD COLUMN subtotal_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN discount_amount INTEGER NOT NULL DEFAULT 0 CHECK (discount_amount >= 0);

UPDATE orders SET subtotal_amount = total_amount WHERE subtotal_amount = 0;

CREATE TABLE IF NOT EXISTS applied_promotions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    promo_id INTEGER NOT NULL REFERENCES promotions(id) ON DELETE RESTRICT,
    promo_name_snapshot TEXT NOT NULL,
    discount_amount INTEGER NOT NULL CHECK (discount_amount >= 0),
    applied_by_username TEXT NOT NULL DEFAULT '',
    receipt_text_snapshot TEXT NOT NULL DEFAULT '',
    receipt_media_type TEXT NOT NULL DEFAULT 'NONE' CHECK (receipt_media_type IN ('NONE', 'QR', 'BARCODE')),
    receipt_media_value TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'APPLIED' CHECK (status IN ('APPLIED', 'VOIDED')),
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_applied_promotions_order_id
    ON applied_promotions (order_id, status);

CREATE INDEX IF NOT EXISTS idx_applied_promotions_promo_status
    ON applied_promotions (promo_id, status);
