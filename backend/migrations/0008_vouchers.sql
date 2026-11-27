PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS voucher_campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    code_mode TEXT NOT NULL CHECK (code_mode IN ('STATIC', 'DYNAMIC')),
    static_code TEXT,
    code_template TEXT,
    display_format TEXT NOT NULL DEFAULT 'QR' CHECK (display_format IN ('TEXT', 'QR', 'BARCODE')),
    receipt_message TEXT NOT NULL DEFAULT '',
    auto_issue_on_pay INTEGER NOT NULL DEFAULT 1 CHECK (auto_issue_on_pay IN (0, 1)),
    issue_min_order_amount INTEGER NOT NULL DEFAULT 0 CHECK (issue_min_order_amount >= 0),
    issue_regular_only INTEGER NOT NULL DEFAULT 1 CHECK (issue_regular_only IN (0, 1)),
    issue_quota_limit INTEGER NOT NULL CHECK (issue_quota_limit > 0),
    issued_count INTEGER NOT NULL DEFAULT 0 CHECK (issued_count >= 0 AND issued_count <= issue_quota_limit),
    seq_counter INTEGER NOT NULL DEFAULT 0 CHECK (seq_counter >= 0),
    issue_start_at TEXT,
    issue_end_at TEXT,
    discount_type TEXT NOT NULL CHECK (discount_type IN ('FIXED', 'PERCENT')),
    discount_value INTEGER NOT NULL CHECK (discount_value > 0),
    max_discount INTEGER CHECK (max_discount IS NULL OR max_discount > 0),
    redeem_min_order_amount INTEGER NOT NULL DEFAULT 0 CHECK (redeem_min_order_amount >= 0),
    redeem_regular_only INTEGER NOT NULL DEFAULT 1 CHECK (redeem_regular_only IN (0, 1)),
    redeem_quota_limit INTEGER NOT NULL CHECK (redeem_quota_limit > 0),
    redeemed_count INTEGER NOT NULL DEFAULT 0 CHECK (redeemed_count >= 0 AND redeemed_count <= redeem_quota_limit),
    valid_days INTEGER CHECK (valid_days IS NULL OR valid_days > 0),
    redeem_start_at TEXT,
    redeem_end_at TEXT,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
        (code_mode = 'STATIC' AND static_code IS NOT NULL AND code_template IS NULL)
        OR (code_mode = 'DYNAMIC' AND code_template IS NOT NULL AND static_code IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_voucher_campaigns_static_code
    ON voucher_campaigns (static_code)
    WHERE static_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS issued_vouchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES voucher_campaigns(id) ON DELETE RESTRICT,
    source_order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
    code TEXT NOT NULL,
    is_unique_code INTEGER NOT NULL CHECK (is_unique_code IN (0, 1)),
    display_format_snapshot TEXT NOT NULL CHECK (display_format_snapshot IN ('TEXT', 'QR', 'BARCODE')),
    receipt_message_snapshot TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REDEEMED', 'VOIDED')),
    expires_at TEXT,
    issued_by_username TEXT NOT NULL DEFAULT '',
    issued_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_issued_vouchers_dynamic_code
    ON issued_vouchers (code)
    WHERE is_unique_code = 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_issued_vouchers_one_per_order_campaign
    ON issued_vouchers (source_order_id, campaign_id)
    WHERE source_order_id IS NOT NULL AND status != 'VOIDED';

CREATE INDEX IF NOT EXISTS idx_issued_vouchers_source_order
    ON issued_vouchers (source_order_id);

CREATE INDEX IF NOT EXISTS idx_issued_vouchers_code_status
    ON issued_vouchers (code, status);

CREATE TABLE IF NOT EXISTS applied_vouchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    campaign_id INTEGER NOT NULL REFERENCES voucher_campaigns(id) ON DELETE RESTRICT,
    issued_voucher_id INTEGER REFERENCES issued_vouchers(id) ON DELETE RESTRICT,
    code_snapshot TEXT NOT NULL,
    campaign_name_snapshot TEXT NOT NULL,
    discount_amount INTEGER NOT NULL CHECK (discount_amount >= 0),
    applied_by_username TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'APPLIED' CHECK (status IN ('APPLIED', 'VOIDED')),
    created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_applied_vouchers_one_active_per_order
    ON applied_vouchers (order_id)
    WHERE status = 'APPLIED';

CREATE UNIQUE INDEX IF NOT EXISTS idx_applied_vouchers_one_active_per_issued
    ON applied_vouchers (issued_voucher_id)
    WHERE issued_voucher_id IS NOT NULL AND status = 'APPLIED';
