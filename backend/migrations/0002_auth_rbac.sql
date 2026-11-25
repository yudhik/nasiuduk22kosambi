PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    full_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'owner', 'cashier', 'waiter')),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    is_env_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_env_admin IN (0, 1)),
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    is_locked INTEGER NOT NULL DEFAULT 0 CHECK (is_locked IN (0, 1)),
    locked_at TEXT,
    locked_until TEXT,
    last_login_at TEXT,
    last_logout_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    login_at TEXT NOT NULL,
    logout_at TEXT,
    expires_at TEXT NOT NULL,
    ip_address TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id_login
    ON user_sessions (user_id, login_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_sessions_token_hash
    ON user_sessions (token_hash);

CREATE TABLE IF NOT EXISTS auth_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (
        event_type IN (
            'LOGIN_SUCCESS',
            'LOGOUT',
            'LOGIN_FAILED',
            'ACCOUNT_LOCKED',
            'ACCOUNT_UNLOCKED'
        )
    ),
    detail TEXT NOT NULL DEFAULT '',
    ip_address TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_events_created_at
    ON auth_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_events_user_id
    ON auth_events (user_id, created_at DESC);
