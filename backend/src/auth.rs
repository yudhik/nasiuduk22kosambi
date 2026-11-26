use std::{
    fmt,
    net::{IpAddr, SocketAddr},
    sync::{Arc, OnceLock},
    time::Duration,
};

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Algorithm, Argon2, Params, Version,
};
use axum::{
    async_trait,
    extract::{ConnectInfo, FromRequestParts},
    http::{header::COOKIE, request::Parts, HeaderMap},
};
use chrono::{DateTime, Local};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, SqlitePool};
use tokio::sync::Semaphore;

use crate::{
    db::{begin_write_tx, now_iso},
    error::{AppError, AppResult},
    models::{AuthUserResponse, UserRow},
    AppState,
};

pub const SESSION_COOKIE_NAME: &str = "nota_session";
const SESSION_COOKIE_PREFIX: &str = "nota_session=";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Admin,
    Owner,
    Cashier,
    Waiter,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Admin => "admin",
            Role::Owner => "owner",
            Role::Cashier => "cashier",
            Role::Waiter => "waiter",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "admin" => Some(Role::Admin),
            "owner" => Some(Role::Owner),
            "cashier" => Some(Role::Cashier),
            "waiter" => Some(Role::Waiter),
            _ => None,
        }
    }

    pub fn allowed_tabs(self) -> Vec<String> {
        match self {
            Role::Waiter => vec!["waiter".to_string()],
            Role::Cashier => vec!["cashier".to_string()],
            Role::Owner => vec![
                "waiter".to_string(),
                "cashier".to_string(),
                "menu".to_string(),
                "report".to_string(),
            ],
            Role::Admin => vec![
                "waiter".to_string(),
                "cashier".to_string(),
                "menu".to_string(),
                "report".to_string(),
                "users".to_string(),
            ],
        }
    }
}

#[derive(Clone)]
pub struct AuthConfig {
    pub admin_username: String,
    pub admin_password: String,
    pub max_failed_attempts: i64,
    pub lockout_minutes: i64,
    pub session_ttl_hours: i64,
    pub cookie_secure: bool,
}

impl fmt::Debug for AuthConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AuthConfig")
            .field("admin_username", &self.admin_username)
            .field("admin_password", &"[REDACTED]")
            .field("max_failed_attempts", &self.max_failed_attempts)
            .field("lockout_minutes", &self.lockout_minutes)
            .field("session_ttl_hours", &self.session_ttl_hours)
            .field("cookie_secure", &self.cookie_secure)
            .finish()
    }
}

impl AuthConfig {
    pub fn from_env() -> Result<Self, String> {
        let admin_username = std::env::var("ADMIN_USERNAME")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "admin".to_string());

        let admin_password = std::env::var("ADMIN_PASSWORD")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| {
                "Variabel lingkungan ADMIN_PASSWORD wajib diisi sebelum menjalankan server."
                    .to_string()
            })?;

        if admin_password.len() < 8 {
            return Err("ADMIN_PASSWORD minimal harus terdiri dari 8 karakter.".to_string());
        }
        if admin_password.len() > 128 {
            return Err("ADMIN_PASSWORD maksimal 128 karakter.".to_string());
        }

        let max_failed_attempts = std::env::var("AUTH_MAX_FAILED_ATTEMPTS")
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .map(|v| v.clamp(1, 100))
            .unwrap_or(5);

        let lockout_minutes = std::env::var("AUTH_LOCKOUT_MINUTES")
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .map(|v| v.clamp(0, 525_600))
            .unwrap_or(15);

        let session_ttl_hours = std::env::var("SESSION_TTL_HOURS")
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .map(|v| v.clamp(1, 8_760))
            .unwrap_or(12);

        let cookie_secure = std::env::var("COOKIE_SECURE")
            .ok()
            .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false);

        Ok(Self {
            admin_username,
            admin_password,
            max_failed_attempts,
            lockout_minutes,
            session_ttl_hours,
            cookie_secure,
        })
    }

    /// Returns a copy without the plaintext admin password for long-lived `AppState`.
    pub fn redacted_for_state(&self) -> Self {
        Self {
            admin_username: self.admin_username.clone(),
            admin_password: String::new(),
            max_failed_attempts: self.max_failed_attempts,
            lockout_minutes: self.lockout_minutes,
            session_ttl_hours: self.session_ttl_hours,
            cookie_secure: self.cookie_secure,
        }
    }
}

fn argon2_instance() -> Argon2<'static> {
    // OWASP-recommended Argon2id baseline (19 MiB RAM, 2 iterations, 1 thread):
    // strong against brute-force while safe on 1 vCPU / 956 MiB RAM servers.
    let params = Params::new(19_456, 2, 1, None).expect("valid Argon2id params");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

pub fn hash_password(password: &str) -> AppResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    argon2_instance()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| AppError::Internal(format!("Gagal mengenkripsi password: {e}")))
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(hash) else {
        return false;
    };
    argon2_instance()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

/// Static dummy Argon2id hash used to equalize login timing for unknown/inactive accounts.
fn dummy_password_hash() -> &'static str {
    static DUMMY: OnceLock<String> = OnceLock::new();
    DUMMY.get_or_init(|| {
        hash_password("dummy-timing-equalization-secret")
            .expect("dummy argon2 hash generation failed")
    })
}

/// Runs Argon2id password hashing on Tokio's blocking pool under a strict concurrency semaphore
/// so 1-vCPU async event loops never stall and concurrent logins cannot OOM the 956 MiB host.
pub async fn hash_password_async(
    semaphore: &Arc<Semaphore>,
    password: String,
) -> AppResult<String> {
    let permit = tokio::time::timeout(Duration::from_secs(3), semaphore.clone().acquire_owned())
        .await
        .map_err(|_| {
            AppError::TooManyRequests(
                "Server sedang sibuk memproses permintaan autentikasi. Coba lagi sebentar.".into(),
            )
        })?
        .map_err(|_| AppError::Internal("Semaphore autentikasi tertutup".into()))?;

    let result = tokio::task::spawn_blocking(move || {
        let _guard = permit;
        hash_password(&password)
    })
    .await
    .map_err(|e| AppError::Internal(format!("Blocking hash task gagal: {e}")))?;

    result
}

/// Runs Argon2id password verification on Tokio's blocking pool under the concurrency semaphore.
pub async fn verify_password_async(
    semaphore: &Arc<Semaphore>,
    password: String,
    hash: String,
) -> AppResult<bool> {
    let permit = tokio::time::timeout(Duration::from_secs(3), semaphore.clone().acquire_owned())
        .await
        .map_err(|_| {
            AppError::TooManyRequests(
                "Terlalu banyak percobaan login bersamaan. Coba lagi dalam beberapa detik.".into(),
            )
        })?
        .map_err(|_| AppError::Internal("Semaphore autentikasi tertutup".into()))?;

    let ok = tokio::task::spawn_blocking(move || {
        let _guard = permit;
        verify_password(&password, &hash)
    })
    .await
    .map_err(|e| AppError::Internal(format!("Blocking verify task gagal: {e}")))?;

    Ok(ok)
}

/// Equalizes response timing when a username does not exist or is inactive.
pub async fn verify_dummy_password_async(
    semaphore: &Arc<Semaphore>,
    password: String,
) -> AppResult<()> {
    let _ = verify_password_async(semaphore, password, dummy_password_hash().to_string()).await?;
    Ok(())
}

pub fn generate_session_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

pub fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

pub fn build_session_cookie(token: &str, max_age_secs: i64, secure: bool) -> String {
    let mut cookie = format!(
        "{SESSION_COOKIE_NAME}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={max_age_secs}"
    );
    if secure {
        cookie.push_str("; Secure");
    }
    cookie
}

pub fn build_clear_cookie(secure: bool) -> String {
    let mut cookie = format!("{SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    if secure {
        cookie.push_str("; Secure");
    }
    cookie
}

/// Iterates ALL `Cookie` headers (HTTP/2 RFC 9113 compatible) to extract `nota_session`.
pub fn extract_session_token(headers: &HeaderMap) -> Option<String> {
    for header_val in headers.get_all(COOKIE) {
        let Ok(raw) = header_val.to_str() else {
            continue;
        };
        for part in raw.split(';') {
            let trimmed = part.trim();
            if let Some(val) = trimmed.strip_prefix(SESSION_COOKIE_PREFIX) {
                let token = val.trim();
                if !token.is_empty() {
                    return Some(token.to_string());
                }
            }
        }
    }
    None
}

/// Extracts client IP safely: trusts `X-Real-IP` only when connecting from a loopback reverse proxy
/// (such as Caddy on `127.0.0.1`) and validates it as a real `IpAddr`, preventing header spoofing.
pub fn extract_client_ip(headers: &HeaderMap, peer: Option<SocketAddr>) -> String {
    let is_trusted_proxy = peer.map(|addr| addr.ip().is_loopback()).unwrap_or(false);
    if is_trusted_proxy {
        if let Some(val) = headers
            .get("x-real-ip")
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
        {
            if let Ok(ip) = val.parse::<IpAddr>() {
                return ip.to_string();
            }
        }
        // Fallback: rightmost entry of X-Forwarded-For appended by the trusted proxy
        if let Some(val) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
        {
            if let Some(last) = val.split(',').next_back().map(str::trim) {
                if let Ok(ip) = last.parse::<IpAddr>() {
                    return ip.to_string();
                }
            }
        }
    }

    peer.map(|addr| addr.ip().to_string()).unwrap_or_default()
}

pub fn is_timestamp_in_future(ts: &str) -> bool {
    DateTime::parse_from_rfc3339(ts)
        .map(|dt| dt > Local::now().fixed_offset())
        .unwrap_or(false)
}

pub fn is_user_currently_locked(user: &UserRow) -> bool {
    if user.is_locked == 0 {
        return false;
    }
    match user.locked_until.as_deref() {
        Some(until) => is_timestamp_in_future(until),
        None => true,
    }
}

pub async fn record_auth_event(
    pool: &SqlitePool,
    user_id: Option<i64>,
    username: &str,
    event_type: &str,
    detail: &str,
    ip_address: &str,
) -> Result<(), sqlx::Error> {
    let now = now_iso();
    let safe_user: String = username.chars().take(64).collect();
    let safe_detail: String = detail.chars().take(255).collect();
    let safe_ip: String = ip_address.chars().take(45).collect();

    sqlx::query(
        r#"
        INSERT INTO auth_events (user_id, username, event_type, detail, ip_address, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(user_id)
    .bind(&safe_user)
    .bind(event_type)
    .bind(&safe_detail)
    .bind(&safe_ip)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(())
}

/// Prunes old expired sessions (>90 days) and keeps auth_events bounded to prevent unbounded disk growth.
pub async fn prune_old_auth_records(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let cutoff = (Local::now() - chrono::Duration::days(90)).to_rfc3339();
    sqlx::query("DELETE FROM user_sessions WHERE expires_at < ?")
        .bind(&cutoff)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM auth_events WHERE created_at < ?")
        .bind(&cutoff)
        .execute(pool)
        .await?;
    Ok(())
}

/// Ensures the environment-configured admin user exists and matches ADMIN_USERNAME / ADMIN_PASSWORD.
/// Revokes active env-admin sessions if `ADMIN_PASSWORD` was rotated.
pub async fn sync_env_admin(pool: &SqlitePool, config: &AuthConfig) -> AppResult<()> {
    let now = now_iso();
    let mut tx = begin_write_tx(pool).await?;

    let existing_env_admin: Option<UserRow> =
        sqlx::query_as("SELECT * FROM users WHERE is_env_admin = 1 LIMIT 1")
            .fetch_optional(&mut *tx)
            .await?;

    if let Some(admin) = existing_env_admin {
        let password_changed = !verify_password(&config.admin_password, &admin.password_hash);
        let new_hash = if password_changed {
            hash_password(&config.admin_password)?
        } else {
            admin.password_hash.clone()
        };

        sqlx::query(
            r#"
            UPDATE users
            SET username = ?, password_hash = ?, role = 'admin', is_active = 1, updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(&config.admin_username)
        .bind(&new_hash)
        .bind(&now)
        .bind(admin.id)
        .execute(&mut *tx)
        .await?;

        if password_changed {
            sqlx::query(
                "UPDATE user_sessions SET logout_at = ? WHERE user_id = ? AND logout_at IS NULL",
            )
            .bind(&now)
            .bind(admin.id)
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;
        return Ok(());
    }

    let password_hash = hash_password(&config.admin_password)?;

    let existing_by_name: Option<UserRow> =
        sqlx::query_as("SELECT * FROM users WHERE username = ? LIMIT 1")
            .bind(&config.admin_username)
            .fetch_optional(&mut *tx)
            .await?;

    if let Some(existing) = existing_by_name {
        sqlx::query(
            r#"
            UPDATE users
            SET password_hash = ?, role = 'admin', is_active = 1, is_env_admin = 1, updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(&password_hash)
        .bind(&now)
        .bind(existing.id)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query(
            r#"
            INSERT INTO users (
                username, full_name, password_hash, role, is_active, is_env_admin,
                failed_login_attempts, is_locked, created_at, updated_at
            )
            VALUES (?, 'Administrator', ?, 'admin', 1, 1, 0, 0, ?, ?)
            "#,
        )
        .bind(&config.admin_username)
        .bind(&password_hash)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

/// Zero-downtime helper to unlock a user directly in SQLite (used by both Admin API and CLI).
pub async fn unlock_user_by_username(
    pool: &SqlitePool,
    username: &str,
    detail: &str,
    ip_address: &str,
) -> AppResult<UserRow> {
    let trimmed = username.trim();
    let mut tx = begin_write_tx(pool).await?;

    let user: Option<UserRow> = sqlx::query_as("SELECT * FROM users WHERE username = ?")
        .bind(trimmed)
        .fetch_optional(&mut *tx)
        .await?;

    let user = user.ok_or_else(|| {
        AppError::NotFound(format!("Pengguna '{trimmed}' tidak ditemukan"))
    })?;

    let now = now_iso();
    sqlx::query(
        r#"
        UPDATE users
        SET failed_login_attempts = 0,
            is_locked = 0,
            locked_at = NULL,
            locked_until = NULL,
            updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(&now)
    .bind(user.id)
    .execute(&mut *tx)
    .await?;

    let updated: UserRow = sqlx::query_as("SELECT * FROM users WHERE id = ?")
        .bind(user.id)
        .fetch_one(&mut *tx)
        .await?;

    tx.commit().await?;

    let _ = record_auth_event(
        pool,
        Some(user.id),
        &user.username,
        "ACCOUNT_UNLOCKED",
        detail,
        ip_address,
    )
    .await;

    Ok(updated)
}

#[derive(Debug, Clone)]
pub struct AuthUser {
    pub id: i64,
    pub username: String,
    pub full_name: String,
    pub role: Role,
    pub is_env_admin: bool,
    pub session_id: i64,
    pub token_hash: String,
    pub peer_addr: Option<SocketAddr>,
}

impl AuthUser {
    pub fn require_roles(&self, allowed: &[Role]) -> AppResult<()> {
        if allowed.contains(&self.role) {
            Ok(())
        } else {
            Err(AppError::Forbidden(
                "Anda tidak memiliki hak akses untuk fitur ini".into(),
            ))
        }
    }

    pub fn to_response(&self) -> AuthUserResponse {
        AuthUserResponse {
            id: self.id,
            username: self.username.clone(),
            full_name: self.full_name.clone(),
            role: self.role.as_str().to_string(),
            is_env_admin: self.is_env_admin,
            allowed_tabs: self.role.allowed_tabs(),
        }
    }
}

#[derive(Debug, FromRow)]
struct SessionWithUser {
    session_id: i64,
    expires_at: String,
    user_id: i64,
    username: String,
    full_name: String,
    role: String,
    is_active: i64,
    is_env_admin: i64,
}

#[async_trait]
impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = extract_session_token(&parts.headers)
            .ok_or_else(|| AppError::Unauthorized("Silakan login terlebih dahulu".into()))?;
        let token_hash = hash_token(&token);
        let peer_addr = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ConnectInfo(addr)| *addr);

        let row: Option<SessionWithUser> = sqlx::query_as(
            r#"
            SELECT
                s.id AS session_id,
                s.expires_at AS expires_at,
                u.id AS user_id,
                u.username AS username,
                u.full_name AS full_name,
                u.role AS role,
                u.is_active AS is_active,
                u.is_env_admin AS is_env_admin
            FROM user_sessions s
            INNER JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ? AND s.logout_at IS NULL
            LIMIT 1
            "#,
        )
        .bind(&token_hash)
        .fetch_optional(&state.pool)
        .await?;

        let row = row.ok_or_else(|| {
            AppError::Unauthorized("Sesi login tidak valid atau telah keluar".into())
        })?;

        if !is_timestamp_in_future(&row.expires_at) {
            return Err(AppError::Unauthorized(
                "Sesi login telah berakhir, silakan login kembali".into(),
            ));
        }

        if row.is_active == 0 {
            return Err(AppError::Unauthorized(
                "Akun Anda telah dinonaktifkan".into(),
            ));
        }

        let role = Role::parse(&row.role)
            .ok_or_else(|| AppError::Unauthorized("Peran akun tidak valid".into()))?;

        Ok(AuthUser {
            id: row.user_id,
            username: row.username,
            full_name: row.full_name,
            role,
            is_env_admin: row.is_env_admin != 0,
            session_id: row.session_id,
            token_hash,
            peer_addr,
        })
    }
}
