PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS promotions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    discount_type TEXT NOT NULL CHECK (discount_type IN ('FIXED', 'PERCENT')),
    discount_value INTEGER NOT NULL CHECK (discount_value > 0),
    max_discount INTEGER CHECK (max_discount IS NULL OR max_discount > 0),
    min_order_amount INTEGER NOT NULL DEFAULT 0 CHECK (min_order_amount >= 0),
    quota_type TEXT NOT NULL DEFAULT 'UNLIMITED' CHECK (quota_type IN ('UNLIMITED', 'TOTAL', 'DAILY')),
    quota_limit INTEGER CHECK (quota_limit IS NULL OR quota_limit > 0),
    start_date TEXT,
    end_date TEXT,
    regular_only INTEGER NOT NULL DEFAULT 1 CHECK (regular_only IN (0, 1)),
    receipt_promo_text TEXT NOT NULL DEFAULT '',
    receipt_media_type TEXT NOT NULL DEFAULT 'NONE' CHECK (receipt_media_type IN ('NONE', 'QR', 'BARCODE')),
    receipt_media_value TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((quota_type = 'UNLIMITED' AND quota_limit IS NULL) OR (quota_type != 'UNLIMITED' AND quota_limit > 0))
);

ALTER TABLE orders ADD COLUMN subtotal_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN discount_amount INTEGER NOT NULL DEFAULT 0 CHECK (discount_amount >= 0);
ALTER TABLE orders ADD COLUMN promo_id INTEGER REFERENCES promotions(id) ON DELETE RESTRICT;
ALTER TABLE orders ADD COLUMN promo_name_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN promo_applied_by_username TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN promo_receipt_text_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN promo_receipt_media_type TEXT NOT NULL DEFAULT 'NONE' CHECK (promo_receipt_media_type IN ('NONE', 'QR', 'BARCODE'));
ALTER TABLE orders ADD COLUMN promo_receipt_media_value TEXT NOT NULL DEFAULT '';

UPDATE orders SET subtotal_amount = total_amount WHERE subtotal_amount = 0;

CREATE INDEX IF NOT EXISTS idx_orders_promo_date_status
    ON orders (promo_id, business_date, status);
