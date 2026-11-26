PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS expense_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO expense_categories (name, is_active, sort_order, created_at)
VALUES
    ('Bahan Baku', 1, 1, datetime('now')),
    ('Gas / Listrik', 1, 2, datetime('now')),
    ('Kemasan', 1, 3, datetime('now')),
    ('Operasional', 1, 4, datetime('now')),
    ('Lainnya', 1, 5, datetime('now'));

-- Keep any legacy free-text categories already recorded in daily_expenses selectable.
INSERT OR IGNORE INTO expense_categories (name, is_active, sort_order, created_at)
SELECT DISTINCT TRIM(category), 1, 100, datetime('now')
FROM daily_expenses
WHERE TRIM(category) <> '';
