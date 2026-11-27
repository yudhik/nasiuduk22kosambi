PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS receipt_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    header_text TEXT NOT NULL DEFAULT 'Nasi Uduk 22 Kosambi - Mpok Indri',
    footer_text TEXT NOT NULL DEFAULT 'Terima kasih atas kunjungan Anda!',
    updated_at TEXT NOT NULL,
    updated_by_username TEXT NOT NULL DEFAULT ''
);

INSERT OR IGNORE INTO receipt_settings (id, header_text, footer_text, updated_at, updated_by_username)
VALUES (1, 'Nasi Uduk 22 Kosambi - Mpok Indri', 'Terima kasih atas kunjungan Anda!', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 'system');
