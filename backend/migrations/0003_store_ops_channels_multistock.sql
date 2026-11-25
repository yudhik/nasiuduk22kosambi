PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS stock_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    unit TEXT NOT NULL DEFAULT 'porsi',
    current_stock INTEGER NOT NULL DEFAULT 0 CHECK (current_stock >= 0),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS menu_stock_requirements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
    qty_per_unit INTEGER NOT NULL DEFAULT 1 CHECK (qty_per_unit > 0),
    UNIQUE (menu_item_id, stock_item_id)
);

CREATE INDEX IF NOT EXISTS idx_menu_stock_req_menu
    ON menu_stock_requirements (menu_item_id);

CREATE INDEX IF NOT EXISTS idx_menu_stock_req_stock
    ON menu_stock_requirements (stock_item_id);

CREATE TABLE IF NOT EXISTS sales_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    is_auto_paid INTEGER NOT NULL DEFAULT 0 CHECK (is_auto_paid IN (0, 1)),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO sales_channels (code, name, is_auto_paid, is_active, sort_order, created_at)
VALUES
    ('regular', 'Regular', 0, 1, 1, datetime('now')),
    ('gofood', 'GoFood', 1, 1, 2, datetime('now')),
    ('grabfood', 'GrabFood', 1, 1, 3, datetime('now')),
    ('shopeefood', 'ShopeeFood', 1, 1, 4, datetime('now'));

CREATE TABLE IF NOT EXISTS store_days (
    business_date TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
    opened_at TEXT NOT NULL,
    opened_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    opened_by_username TEXT NOT NULL DEFAULT '',
    closed_at TEXT,
    closed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    closed_by_username TEXT,
    total_orders INTEGER NOT NULL DEFAULT 0,
    paid_orders INTEGER NOT NULL DEFAULT 0,
    voided_orders INTEGER NOT NULL DEFAULT 0,
    gross_revenue INTEGER NOT NULL DEFAULT 0,
    total_expenses INTEGER NOT NULL DEFAULT 0,
    net_profit INTEGER NOT NULL DEFAULT 0,
    total_portions_sold INTEGER NOT NULL DEFAULT 0,
    closing_notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS daily_expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_date TEXT NOT NULL,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Operasional',
    amount INTEGER NOT NULL CHECK (amount >= 0),
    notes TEXT NOT NULL DEFAULT '',
    created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by_username TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_daily_expenses_date
    ON daily_expenses (business_date);

CREATE TABLE IF NOT EXISTS order_stock_deductions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
    stock_name_snapshot TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_order_stock_deductions_order
    ON order_stock_deductions (order_id);

CREATE TABLE IF NOT EXISTS daily_stock_item_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_date TEXT NOT NULL,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
    initial_stock INTEGER NOT NULL DEFAULT 0,
    restocked_qty INTEGER NOT NULL DEFAULT 0,
    sold_qty INTEGER NOT NULL DEFAULT 0,
    voided_qty INTEGER NOT NULL DEFAULT 0,
    physical_stock INTEGER,
    notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE (business_date, stock_item_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_stock_item_date
    ON daily_stock_item_snapshots (business_date);

CREATE TABLE IF NOT EXISTS stock_item_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_date TEXT NOT NULL,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
    order_id INTEGER REFERENCES orders(id),
    movement_type TEXT NOT NULL CHECK (
        movement_type IN ('SET_INITIAL', 'RESTOCK', 'ORDER_DEDUCT', 'ORDER_VOID_RESTORE', 'CLOSE_RESET')
    ),
    qty_delta INTEGER NOT NULL,
    stock_after INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stock_item_movements_date_stock
    ON stock_item_movements (business_date, stock_item_id);

ALTER TABLE orders ADD COLUMN channel_id INTEGER REFERENCES sales_channels(id);
ALTER TABLE orders ADD COLUMN channel_name_snapshot TEXT NOT NULL DEFAULT 'Regular';
ALTER TABLE orders ADD COLUMN created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_channel_date
    ON orders (business_date, channel_id);

CREATE INDEX IF NOT EXISTS idx_orders_user_date
    ON orders (business_date, created_by_user_id, created_at);

UPDATE orders
SET channel_id = (SELECT id FROM sales_channels WHERE code = 'regular')
WHERE channel_id IS NULL;

-- Backfill any pre-existing menu_items into 1:1 stock_items + menu_stock_requirements (active menus take priority)
INSERT OR IGNORE INTO stock_items (name, unit, current_stock, is_active, created_at, updated_at)
SELECT name, 'porsi', 0, MAX(is_active), MIN(created_at), MAX(updated_at)
FROM menu_items
GROUP BY LOWER(name);

INSERT OR IGNORE INTO menu_stock_requirements (menu_item_id, stock_item_id, qty_per_unit)
SELECT m.id, s.id, 1
FROM menu_items m
INNER JOIN stock_items s ON s.name = m.name COLLATE NOCASE;
