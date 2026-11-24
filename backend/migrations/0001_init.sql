PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Makanan',
    price INTEGER NOT NULL CHECK (price >= 0),
    current_stock INTEGER NOT NULL DEFAULT 0 CHECK (current_stock >= 0),
    default_daily_stock INTEGER NOT NULL DEFAULT 0 CHECK (default_daily_stock >= 0),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT NOT NULL UNIQUE,
    business_date TEXT NOT NULL,
    customer_label TEXT NOT NULL DEFAULT '',
    waiter_name TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('UNPAID', 'PAID', 'VOIDED')),
    total_amount INTEGER NOT NULL CHECK (total_amount >= 0),
    created_at TEXT NOT NULL,
    paid_at TEXT,
    voided_at TEXT,
    void_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_business_date_status
    ON orders (business_date, status);

CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
    menu_name_snapshot TEXT NOT NULL,
    unit_price_snapshot INTEGER NOT NULL CHECK (unit_price_snapshot >= 0),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    subtotal INTEGER NOT NULL CHECK (subtotal >= 0),
    item_note TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id
    ON order_items (order_id);

CREATE TABLE IF NOT EXISTS daily_stock_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_date TEXT NOT NULL,
    menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
    initial_stock INTEGER NOT NULL DEFAULT 0,
    restocked_qty INTEGER NOT NULL DEFAULT 0,
    sold_qty INTEGER NOT NULL DEFAULT 0,
    voided_qty INTEGER NOT NULL DEFAULT 0,
    physical_stock INTEGER,
    notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE (business_date, menu_item_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_stock_date
    ON daily_stock_snapshots (business_date);

CREATE TABLE IF NOT EXISTS stock_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_date TEXT NOT NULL,
    menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
    order_id INTEGER REFERENCES orders(id),
    movement_type TEXT NOT NULL CHECK (
        movement_type IN ('SET_INITIAL', 'RESTOCK', 'ORDER_DEDUCT', 'ORDER_VOID_RESTORE')
    ),
    qty_delta INTEGER NOT NULL,
    stock_after INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_date_menu
    ON stock_movements (business_date, menu_item_id);
