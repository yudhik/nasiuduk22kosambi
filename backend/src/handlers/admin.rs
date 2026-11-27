use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Deserialize;
use sqlx::FromRow;

use crate::{
    auth::{
        extract_client_ip, hash_password_async, is_timestamp_in_future, is_user_currently_locked,
        unlock_user_by_username, AuthUser, Role,
    },
    db::{begin_write_tx, now_iso},
    error::{AppError, AppResult},
    models::{
        AdminUserSummary, AuthEventLog, CreateUserRequest, ReceiptSettings, ResetPasswordRequest,
        UpdateReceiptSettingsRequest, UpdateUserRequest, UserRow, UserSessionLog,
    },
    AppState,
};

#[derive(Debug, Deserialize)]
pub struct AuditQuery {
    pub user_id: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Debug, FromRow)]
struct RawSessionRow {
    id: i64,
    user_id: i64,
    username: String,
    full_name: String,
    role: String,
    login_at: String,
    logout_at: Option<String>,
    expires_at: String,
    ip_address: String,
    user_agent: String,
}

fn to_summary(row: UserRow) -> AdminUserSummary {
    let locked_now = is_user_currently_locked(&row);
    AdminUserSummary {
        id: row.id,
        username: row.username,
        full_name: row.full_name,
        role: row.role,
        is_active: row.is_active != 0,
        is_env_admin: row.is_env_admin != 0,
        failed_login_attempts: if locked_now {
            row.failed_login_attempts
        } else if row.is_locked != 0 {
            0
        } else {
            row.failed_login_attempts
        },
        is_locked: locked_now,
        locked_at: if locked_now { row.locked_at } else { None },
        locked_until: if locked_now { row.locked_until } else { None },
        last_login_at: row.last_login_at,
        last_logout_at: row.last_logout_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn validate_username(raw: &str) -> AppResult<&str> {
    let trimmed = raw.trim();
    if trimmed.len() < 3 || trimmed.len() > 32 {
        return Err(AppError::Validation(
            "Username harus terdiri dari 3 hingga 32 karakter".into(),
        ));
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        return Err(AppError::Validation(
            "Username hanya boleh berisi huruf, angka, titik (.), garis bawah (_), atau tanda hubung (-)"
                .into(),
        ));
    }
    Ok(trimmed)
}

fn validate_password(password: &str) -> AppResult<()> {
    if password.len() < 8 {
        return Err(AppError::Validation(
            "Password minimal harus terdiri dari 8 karakter".into(),
        ));
    }
    if password.len() > 128 {
        return Err(AppError::Validation(
            "Password maksimal 128 karakter".into(),
        ));
    }
    Ok(())
}

pub async fn list_users(
    auth: AuthUser,
    State(state): State<AppState>,
) -> AppResult<Json<Vec<AdminUserSummary>>> {
    auth.require_roles(&[Role::Admin])?;

    let rows: Vec<UserRow> =
        sqlx::query_as("SELECT * FROM users ORDER BY is_env_admin DESC, id ASC")
            .fetch_all(&state.pool)
            .await?;

    Ok(Json(rows.into_iter().map(to_summary).collect()))
}

pub async fn create_user(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(req): Json<CreateUserRequest>,
) -> AppResult<(StatusCode, Json<AdminUserSummary>)> {
    auth.require_roles(&[Role::Admin])?;

    let username = validate_username(&req.username)?;
    let full_name = req.full_name.trim();
    if full_name.is_empty() || full_name.chars().count() > 120 {
        return Err(AppError::Validation(
            "Nama lengkap pengguna wajib diisi (maksimal 120 karakter)".into(),
        ));
    }
    validate_password(&req.password)?;
    let role = Role::parse(&req.role).ok_or_else(|| {
        AppError::Validation("Role harus salah satu dari: admin, owner, cashier, waiter".into())
    })?;

    let password_hash = hash_password_async(&state.hash_semaphore, req.password).await?;
    let now = now_iso();

    let mut tx = begin_write_tx(&state.pool).await?;
    let existing: Option<(i64,)> = sqlx::query_as("SELECT id FROM users WHERE username = ?")
        .bind(username)
        .fetch_optional(&mut *tx)
        .await?;

    if existing.is_some() {
        return Err(AppError::Conflict(format!(
            "Username '{username}' sudah digunakan"
        )));
    }

    let res = sqlx::query(
        r#"
        INSERT INTO users (
            username, full_name, password_hash, role, is_active, is_env_admin,
            failed_login_attempts, is_locked, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, 1, 0, 0, 0, ?, ?)
        "#,
    )
    .bind(username)
    .bind(full_name)
    .bind(&password_hash)
    .bind(role.as_str())
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    let created: UserRow = sqlx::query_as("SELECT * FROM users WHERE id = ?")
        .bind(res.last_insert_rowid())
        .fetch_one(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(to_summary(created))))
}

pub async fn update_user(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateUserRequest>,
) -> AppResult<Json<AdminUserSummary>> {
    auth.require_roles(&[Role::Admin])?;

    let full_name = req.full_name.trim();
    if full_name.is_empty() || full_name.chars().count() > 120 {
        return Err(AppError::Validation(
            "Nama lengkap pengguna wajib diisi (maksimal 120 karakter)".into(),
        ));
    }
    let role = Role::parse(&req.role).ok_or_else(|| {
        AppError::Validation("Role harus salah satu dari: admin, owner, cashier, waiter".into())
    })?;

    let now = now_iso();
    let is_active = if req.is_active { 1_i64 } else { 0_i64 };

    let mut tx = begin_write_tx(&state.pool).await?;
    let target: Option<UserRow> = sqlx::query_as("SELECT * FROM users WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

    let target =
        target.ok_or_else(|| AppError::NotFound(format!("Pengguna #{id} tidak ditemukan")))?;

    if target.is_env_admin != 0 && (role != Role::Admin || !req.is_active) {
        return Err(AppError::Validation(
            "Akun admin bawaan (environment variable) tidak dapat diubah perannya atau dinonaktifkan"
                .into(),
        ));
    }

    if target.id == auth.id && (!req.is_active || role != Role::Admin) {
        return Err(AppError::Validation(
            "Anda tidak dapat menonaktifkan atau menurunkan peran akun Anda sendiri".into(),
        ));
    }

    sqlx::query(
        r#"
        UPDATE users
        SET full_name = ?, role = ?, is_active = ?, updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(full_name)
    .bind(role.as_str())
    .bind(is_active)
    .bind(&now)
    .bind(id)
    .execute(&mut *tx)
    .await?;

    if !req.is_active {
        let revoked = sqlx::query(
            "UPDATE user_sessions SET logout_at = ? WHERE user_id = ? AND logout_at IS NULL",
        )
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;

        if revoked.rows_affected() > 0 {
            sqlx::query("UPDATE users SET last_logout_at = ? WHERE id = ?")
                .bind(&now)
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
    }

    let updated: UserRow = sqlx::query_as("SELECT * FROM users WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(Json(to_summary(updated)))
}

pub async fn reset_password(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<ResetPasswordRequest>,
) -> AppResult<Json<AdminUserSummary>> {
    auth.require_roles(&[Role::Admin])?;
    validate_password(&req.new_password)?;

    let password_hash = hash_password_async(&state.hash_semaphore, req.new_password).await?;
    let now = now_iso();

    let mut tx = begin_write_tx(&state.pool).await?;
    let target: Option<UserRow> = sqlx::query_as("SELECT * FROM users WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

    let target =
        target.ok_or_else(|| AppError::NotFound(format!("Pengguna #{id} tidak ditemukan")))?;

    if target.is_env_admin != 0 {
        return Err(AppError::Validation(
            "Password akun admin utama diatur melalui environment variable ADMIN_PASSWORD".into(),
        ));
    }

    sqlx::query(
        r#"
        UPDATE users
        SET password_hash = ?,
            failed_login_attempts = 0,
            is_locked = 0,
            locked_at = NULL,
            locked_until = NULL,
            updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(&password_hash)
    .bind(&now)
    .bind(id)
    .execute(&mut *tx)
    .await?;

    sqlx::query("UPDATE user_sessions SET logout_at = ? WHERE user_id = ? AND logout_at IS NULL")
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;

    let updated: UserRow = sqlx::query_as("SELECT * FROM users WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(Json(to_summary(updated)))
}

pub async fn unlock_user(
    auth: AuthUser,
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> AppResult<Json<AdminUserSummary>> {
    auth.require_roles(&[Role::Admin])?;

    let target: Option<UserRow> = sqlx::query_as("SELECT * FROM users WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?;

    let target =
        target.ok_or_else(|| AppError::NotFound(format!("Pengguna #{id} tidak ditemukan")))?;
    let ip = extract_client_ip(&headers, auth.peer_addr);
    let updated = unlock_user_by_username(
        &state.pool,
        &target.username,
        &format!("Dibuka lebih awal oleh admin '{}'", auth.username),
        &ip,
    )
    .await?;

    Ok(Json(to_summary(updated)))
}

pub async fn list_sessions(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(query): Query<AuditQuery>,
) -> AppResult<Json<Vec<UserSessionLog>>> {
    auth.require_roles(&[Role::Admin])?;

    let limit = query.limit.unwrap_or(100).clamp(1, 500);
    let rows: Vec<RawSessionRow> = match query.user_id {
        Some(uid) => {
            sqlx::query_as(
                r#"
                SELECT
                    s.id, s.user_id, u.username, u.full_name, u.role,
                    s.login_at, s.logout_at, s.expires_at, s.ip_address, s.user_agent
                FROM user_sessions s
                INNER JOIN users u ON u.id = s.user_id
                WHERE s.user_id = ?
                ORDER BY s.id DESC
                LIMIT ?
                "#,
            )
            .bind(uid)
            .bind(limit)
            .fetch_all(&state.pool)
            .await?
        }
        None => {
            sqlx::query_as(
                r#"
                SELECT
                    s.id, s.user_id, u.username, u.full_name, u.role,
                    s.login_at, s.logout_at, s.expires_at, s.ip_address, s.user_agent
                FROM user_sessions s
                INNER JOIN users u ON u.id = s.user_id
                ORDER BY s.id DESC
                LIMIT ?
                "#,
            )
            .bind(limit)
            .fetch_all(&state.pool)
            .await?
        }
    };

    let logs = rows
        .into_iter()
        .map(|r| {
            let status = if r.logout_at.is_some() {
                "LOGGED_OUT"
            } else if is_timestamp_in_future(&r.expires_at) {
                "ACTIVE"
            } else {
                "EXPIRED"
            };
            UserSessionLog {
                id: r.id,
                user_id: r.user_id,
                username: r.username,
                full_name: r.full_name,
                role: r.role,
                login_at: r.login_at,
                logout_at: r.logout_at,
                expires_at: r.expires_at,
                status: status.to_string(),
                ip_address: r.ip_address,
                user_agent: r.user_agent,
            }
        })
        .collect();

    Ok(Json(logs))
}

pub async fn list_auth_events(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(query): Query<AuditQuery>,
) -> AppResult<Json<Vec<AuthEventLog>>> {
    auth.require_roles(&[Role::Admin])?;

    let limit = query.limit.unwrap_or(100).clamp(1, 500);
    let rows: Vec<AuthEventLog> = match query.user_id {
        Some(uid) => {
            sqlx::query_as(
                "SELECT * FROM auth_events WHERE user_id = ? ORDER BY id DESC LIMIT ?",
            )
            .bind(uid)
            .bind(limit)
            .fetch_all(&state.pool)
            .await?
        }
        None => {
            sqlx::query_as("SELECT * FROM auth_events ORDER BY id DESC LIMIT ?")
                .bind(limit)
                .fetch_all(&state.pool)
                .await?
        }
    };

    Ok(Json(rows))
}

const DEFAULT_RECEIPT_HEADER: &str = "Nasi Uduk 22 Kosambi - Mpok Indri";
const DEFAULT_RECEIPT_FOOTER: &str = "Terima kasih atas kunjungan Anda!";
const DEFAULT_RECEIPT_HEADER_FONT_SIZE: &str = "tall";

fn normalize_receipt_font_size(raw: &str) -> AppResult<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "normal" => Ok("normal"),
        "tall" => Ok("tall"),
        "wide" => Ok("wide"),
        "large" => Ok("large"),
        _ => Err(AppError::Validation(
            "Ukuran font header harus salah satu dari: normal, tall, wide, large.".into(),
        )),
    }
}

fn normalize_receipt_text(raw: &str) -> String {
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
    normalized
        .chars()
        .filter(|&c| {
            !(c.is_control() && c != '\n')
                && !matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
        })
        .collect::<String>()
        .trim()
        .to_string()
}

fn validate_review_url(raw: &str, required: bool) -> AppResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        if required {
            return Err(AppError::Validation(
                "Link URL ulasan wajib diisi saat Bagian Ulasan diaktifkan.".into(),
            ));
        }
        return Ok(String::new());
    }
    if trimmed.len() > 200 {
        return Err(AppError::Validation(
            "Link URL ulasan maksimal 200 karakter agar QR thermal 58mm tetap mudah dipindai."
                .into(),
        ));
    }
    if !trimmed.bytes().all(|b| (0x21..=0x7E).contains(&b)) {
        return Err(AppError::Validation(
            "Link URL ulasan tidak boleh mengandung spasi atau karakter khusus non-ASCII.".into(),
        ));
    }
    let (scheme, rest) = if trimmed.len() >= 8 && trimmed[..8].eq_ignore_ascii_case("https://") {
        ("https://", &trimmed[8..])
    } else if trimmed.len() >= 7 && trimmed[..7].eq_ignore_ascii_case("http://") {
        ("http://", &trimmed[7..])
    } else {
        return Err(AppError::Validation(
            "Link URL ulasan harus diawali dengan https:// atau http://.".into(),
        ));
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return Err(AppError::Validation(
            "Link URL ulasan harus memiliki nama domain yang valid tanpa kredensial (@).".into(),
        ));
    }
    let host = match authority.split_once(':') {
        Some((h, port_str)) => {
            let port: u16 = port_str.parse().map_err(|_| {
                AppError::Validation("Port pada link URL ulasan tidak valid.".into())
            })?;
            if port == 0 {
                return Err(AppError::Validation(
                    "Port pada link URL ulasan tidak valid.".into(),
                ));
            }
            h
        }
        None => authority,
    };
    let labels: Vec<&str> = host.split('.').collect();
    let valid_host = labels.len() >= 2
        && labels.iter().all(|lbl| {
            !lbl.is_empty()
                && !lbl.starts_with('-')
                && !lbl.ends_with('-')
                && lbl.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        });
    if !valid_host {
        return Err(AppError::Validation(
            "Link URL ulasan harus memiliki nama domain yang valid (contoh: https://g.page/r/...)."
                .into(),
        ));
    }
    Ok(format!("{scheme}{rest}"))
}

pub async fn get_receipt_settings(
    auth: AuthUser,
    State(state): State<AppState>,
) -> AppResult<Json<ReceiptSettings>> {
    let row: Option<ReceiptSettings> = sqlx::query_as(
        "SELECT header_text, footer_text, header_bold, header_font_size, review_enabled, review_text, review_url, updated_at, updated_by_username FROM receipt_settings WHERE id = 1",
    )
    .fetch_optional(&state.pool)
    .await?;

    let mut settings = row.unwrap_or_else(|| ReceiptSettings {
        header_text: DEFAULT_RECEIPT_HEADER.to_string(),
        footer_text: DEFAULT_RECEIPT_FOOTER.to_string(),
        header_bold: true,
        header_font_size: DEFAULT_RECEIPT_HEADER_FONT_SIZE.to_string(),
        review_enabled: false,
        review_text: String::new(),
        review_url: String::new(),
        updated_at: String::new(),
        updated_by_username: String::new(),
    });
    if auth.role != Role::Admin {
        settings.updated_by_username.clear();
    }

    Ok(Json(settings))
}

pub async fn update_receipt_settings(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(req): Json<UpdateReceiptSettingsRequest>,
) -> AppResult<Json<ReceiptSettings>> {
    auth.require_roles(&[Role::Admin])?;

    let header_text = normalize_receipt_text(&req.header_text);
    let footer_text = normalize_receipt_text(&req.footer_text);
    let header_bold = req.header_bold;
    let header_font_size = normalize_receipt_font_size(&req.header_font_size)?;
    let review_enabled = req.review_enabled;
    let review_text = normalize_receipt_text(&req.review_text);
    let review_url = validate_review_url(&req.review_url, review_enabled)?;

    if header_text.is_empty() {
        return Err(AppError::Validation(
            "Header nota wajib diisi.".into(),
        ));
    }
    if header_text.chars().count() > 300 {
        return Err(AppError::Validation(
            "Header nota maksimal 300 karakter.".into(),
        ));
    }
    if footer_text.chars().count() > 300 {
        return Err(AppError::Validation(
            "Footer nota maksimal 300 karakter.".into(),
        ));
    }
    if header_text.lines().count() > 8 || footer_text.lines().count() > 8 {
        return Err(AppError::Validation(
            "Header dan footer nota maksimal masing-masing 8 baris.".into(),
        ));
    }
    if review_text.chars().count() > 160 {
        return Err(AppError::Validation(
            "Teks bagian ulasan maksimal 160 karakter.".into(),
        ));
    }
    if review_text.lines().count() > 4 {
        return Err(AppError::Validation(
            "Teks bagian ulasan maksimal 4 baris.".into(),
        ));
    }

    let now = now_iso();
    let header_bold_int: i64 = if header_bold { 1 } else { 0 };
    let review_enabled_int: i64 = if review_enabled { 1 } else { 0 };
    let mut tx = begin_write_tx(&state.pool).await?;
    sqlx::query(
        r#"
        INSERT INTO receipt_settings (id, header_text, footer_text, header_bold, header_font_size, review_enabled, review_text, review_url, updated_at, updated_by_username)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            header_text = excluded.header_text,
            footer_text = excluded.footer_text,
            header_bold = excluded.header_bold,
            header_font_size = excluded.header_font_size,
            review_enabled = excluded.review_enabled,
            review_text = excluded.review_text,
            review_url = excluded.review_url,
            updated_at = excluded.updated_at,
            updated_by_username = excluded.updated_by_username
        "#,
    )
    .bind(&header_text)
    .bind(&footer_text)
    .bind(header_bold_int)
    .bind(header_font_size)
    .bind(review_enabled_int)
    .bind(&review_text)
    .bind(&review_url)
    .bind(&now)
    .bind(&auth.username)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    tracing::info!(
        actor = %auth.username,
        header_len = header_text.len(),
        footer_len = footer_text.len(),
        header_bold,
        header_font_size,
        review_enabled,
        review_url_len = review_url.len(),
        "receipt settings updated"
    );

    Ok(Json(ReceiptSettings {
        header_text,
        footer_text,
        header_bold,
        header_font_size: header_font_size.to_string(),
        review_enabled,
        review_text,
        review_url,
        updated_at: now,
        updated_by_username: auth.username,
    }))
}
