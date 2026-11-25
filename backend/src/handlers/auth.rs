use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, State},
    http::{header::SET_COOKIE, HeaderMap, HeaderValue, StatusCode},
    response::IntoResponse,
    Extension, Json,
};
use chrono::{DateTime, Duration, Local};
use serde_json::json;

use crate::{
    auth::{
        build_clear_cookie, build_session_cookie, extract_client_ip, extract_session_token,
        generate_session_token, hash_token, is_timestamp_in_future, record_auth_event,
        verify_dummy_password_async, verify_password_async, AuthUser, Role,
    },
    db::{begin_write_tx, now_iso},
    error::{AppError, AppResult},
    models::{AuthUserResponse, LoginRequest, UserRow},
    AppState,
};

pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    Json(req): Json<LoginRequest>,
) -> AppResult<impl IntoResponse> {
    let username = req.username.trim();
    if username.is_empty() || req.password.is_empty() {
        return Err(AppError::Validation(
            "Username dan password wajib diisi".into(),
        ));
    }
    if username.chars().count() > 64 || req.password.len() > 128 {
        return Err(AppError::Validation(
            "Panjang username atau password melebihi batas yang diizinkan".into(),
        ));
    }

    let peer_addr = peer.map(|Extension(ConnectInfo(addr))| addr);
    let ip = extract_client_ip(&headers, peer_addr);
    let user_agent = headers
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .chars()
        .take(255)
        .collect::<String>();

    let user: Option<UserRow> = sqlx::query_as("SELECT * FROM users WHERE username = ?")
        .bind(username)
        .fetch_optional(&state.pool)
        .await?;

    let Some(user) = user else {
        // Equalize response timing with Argon2id dummy verification to prevent username enumeration
        verify_dummy_password_async(&state.hash_semaphore, req.password).await?;
        let _ = record_auth_event(
            &state.pool,
            None,
            username,
            "LOGIN_FAILED",
            "Username tidak ditemukan",
            &ip,
        )
        .await;
        return Err(AppError::Unauthorized("Username atau password salah".into()));
    };

    if user.is_active == 0 {
        verify_dummy_password_async(&state.hash_semaphore, req.password).await?;
        let _ = record_auth_event(
            &state.pool,
            Some(user.id),
            &user.username,
            "LOGIN_FAILED",
            "Akun nonaktif mencoba login",
            &ip,
        )
        .await;
        return Err(AppError::Unauthorized("Username atau password salah".into()));
    }

    // Check active lockout or atomically auto-clear expired timed lockout
    if user.is_locked != 0 {
        let still_locked = match user.locked_until.as_deref() {
            Some(until) => is_timestamp_in_future(until),
            None => true,
        };

        if still_locked {
            let msg = match user.locked_until.as_deref().and_then(|ts| {
                DateTime::parse_from_rfc3339(ts).ok().map(|dt| {
                    let secs = (dt - Local::now().fixed_offset()).num_seconds().max(1);
                    (secs + 59) / 60
                })
            }) {
                Some(mins) => format!(
                    "Akun terkunci karena terlalu banyak percobaan gagal. Coba lagi dalam {mins} menit atau hubungi Administrator."
                ),
                None => "Akun terkunci karena terlalu banyak percobaan gagal. Hubungi Administrator untuk membuka kunci.".to_string(),
            };

            let _ = record_auth_event(
                &state.pool,
                Some(user.id),
                &user.username,
                "LOGIN_FAILED",
                "Percobaan login saat akun masih terkunci",
                &ip,
            )
            .await;

            return Err(AppError::Locked(msg));
        } else {
            let now = now_iso();
            let mut tx = begin_write_tx(&state.pool).await?;
            sqlx::query(
                r#"
                UPDATE users
                SET failed_login_attempts = 0, is_locked = 0, locked_at = NULL, locked_until = NULL, updated_at = ?
                WHERE id = ? AND is_locked = 1 AND locked_until IS NOT NULL AND locked_until <= ?
                "#,
            )
            .bind(&now)
            .bind(user.id)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
        }
    }

    // Verify Argon2id password off the Tokio async worker thread under the concurrency semaphore
    let password_valid = verify_password_async(
        &state.hash_semaphore,
        req.password,
        user.password_hash.clone(),
    )
    .await?;

    if !password_valid {
        let now = now_iso();
        let max_attempts = state.auth_config.max_failed_attempts;

        // Atomic increment inside BEGIN IMMEDIATE prevents parallel brute-force race conditions
        let mut tx = begin_write_tx(&state.pool).await?;
        let (new_attempts,): (i64,) = sqlx::query_as(
            r#"
            UPDATE users
            SET failed_login_attempts = failed_login_attempts + 1, updated_at = ?
            WHERE id = ?
            RETURNING failed_login_attempts
            "#,
        )
        .bind(&now)
        .bind(user.id)
        .fetch_one(&mut *tx)
        .await?;

        if new_attempts >= max_attempts {
            let locked_until = if state.auth_config.lockout_minutes > 0 {
                Some(
                    (Local::now() + Duration::minutes(state.auth_config.lockout_minutes))
                        .to_rfc3339(),
                )
            } else {
                None
            };

            sqlx::query(
                r#"
                UPDATE users
                SET is_locked = 1, locked_at = ?, locked_until = ?, updated_at = ?
                WHERE id = ?
                "#,
            )
            .bind(&now)
            .bind(&locked_until)
            .bind(&now)
            .bind(user.id)
            .execute(&mut *tx)
            .await?;

            tx.commit().await?;

            let detail = match &locked_until {
                Some(_) => format!(
                    "Akun terkunci otomatis ({} menit) setelah {} kali password salah",
                    state.auth_config.lockout_minutes, new_attempts
                ),
                None => format!(
                    "Akun terkunci permanen setelah {} kali password salah",
                    new_attempts
                ),
            };

            let _ = record_auth_event(
                &state.pool,
                Some(user.id),
                &user.username,
                "ACCOUNT_LOCKED",
                &detail,
                &ip,
            )
            .await;

            let msg = if state.auth_config.lockout_minutes > 0 {
                format!(
                    "Akun dikunci setelah {} kali gagal login. Coba lagi dalam {} menit atau hubungi Administrator.",
                    max_attempts, state.auth_config.lockout_minutes
                )
            } else {
                format!(
                    "Akun dikunci setelah {} kali gagal login. Hubungi Administrator untuk membuka kunci.",
                    max_attempts
                )
            };

            return Err(AppError::Locked(msg));
        }

        tx.commit().await?;

        let _ = record_auth_event(
            &state.pool,
            Some(user.id),
            &user.username,
            "LOGIN_FAILED",
            &format!("Password salah (percobaan {new_attempts}/{max_attempts})"),
            &ip,
        )
        .await;

        return Err(AppError::Unauthorized("Username atau password salah".into()));
    }

    // Re-check active/lockout status atomically inside BEGIN IMMEDIATE before minting a session
    let now = now_iso();
    let ttl_secs = state.auth_config.session_ttl_hours * 3600;
    let expires_at =
        (Local::now() + Duration::hours(state.auth_config.session_ttl_hours)).to_rfc3339();
    let token = generate_session_token();
    let token_hash = hash_token(&token);
    let prior_token_hash = extract_session_token(&headers).map(|t| hash_token(&t));

    let mut tx = begin_write_tx(&state.pool).await?;

    let fresh_user: UserRow = sqlx::query_as("SELECT * FROM users WHERE id = ?")
        .bind(user.id)
        .fetch_one(&mut *tx)
        .await?;

    if fresh_user.is_active == 0 {
        return Err(AppError::Unauthorized("Username atau password salah".into()));
    }
    if fresh_user.is_locked != 0
        && fresh_user
            .locked_until
            .as_deref()
            .map(is_timestamp_in_future)
            .unwrap_or(true)
    {
        return Err(AppError::Locked(
            "Akun terkunci karena terlalu banyak percobaan gagal. Hubungi Administrator.".into(),
        ));
    }

    let role = Role::parse(&fresh_user.role)
        .ok_or_else(|| AppError::Internal(format!("Role tidak valid: {}", fresh_user.role)))?;

    // Revoke any pre-existing session cookie on re-login (session rotation hygiene)
    if let Some(old_hash) = prior_token_hash {
        sqlx::query(
            "UPDATE user_sessions SET logout_at = ? WHERE token_hash = ? AND logout_at IS NULL",
        )
        .bind(&now)
        .bind(&old_hash)
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query(
        r#"
        UPDATE users
        SET failed_login_attempts = 0,
            is_locked = 0,
            locked_at = NULL,
            locked_until = NULL,
            last_login_at = ?,
            updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(&now)
    .bind(&now)
    .bind(fresh_user.id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO user_sessions (user_id, token_hash, login_at, logout_at, expires_at, ip_address, user_agent)
        VALUES (?, ?, ?, NULL, ?, ?, ?)
        "#,
    )
    .bind(fresh_user.id)
    .bind(&token_hash)
    .bind(&now)
    .bind(&expires_at)
    .bind(&ip)
    .bind(&user_agent)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    let _ = record_auth_event(
        &state.pool,
        Some(fresh_user.id),
        &fresh_user.username,
        "LOGIN_SUCCESS",
        &format!("Login berhasil (role: {})", role.as_str()),
        &ip,
    )
    .await;

    let cookie = build_session_cookie(&token, ttl_secs, state.auth_config.cookie_secure);
    let cookie_val = HeaderValue::from_str(&cookie)
        .map_err(|e| AppError::Internal(format!("Invalid cookie header: {e}")))?;

    let body = AuthUserResponse {
        id: fresh_user.id,
        username: fresh_user.username,
        full_name: fresh_user.full_name,
        role: role.as_str().to_string(),
        is_env_admin: fresh_user.is_env_admin != 0,
        allowed_tabs: role.allowed_tabs(),
    };

    Ok((StatusCode::OK, [(SET_COOKIE, cookie_val)], Json(body)))
}

pub async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
) -> AppResult<impl IntoResponse> {
    let peer_addr = peer.map(|Extension(ConnectInfo(addr))| addr);
    let ip = extract_client_ip(&headers, peer_addr);
    let now = now_iso();

    if let Some(token) = extract_session_token(&headers) {
        let token_hash = hash_token(&token);
        let mut tx = begin_write_tx(&state.pool).await?;
        let session: Option<(i64, i64, String)> = sqlx::query_as(
            r#"
            SELECT s.id, s.user_id, u.username
            FROM user_sessions s
            INNER JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ? AND s.logout_at IS NULL
            LIMIT 1
            "#,
        )
        .bind(&token_hash)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some((session_id, user_id, username)) = session {
            sqlx::query("UPDATE user_sessions SET logout_at = ? WHERE id = ?")
                .bind(&now)
                .bind(session_id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE users SET last_logout_at = ?, updated_at = ? WHERE id = ?")
                .bind(&now)
                .bind(&now)
                .bind(user_id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;

            let _ = record_auth_event(
                &state.pool,
                Some(user_id),
                &username,
                "LOGOUT",
                "Logout oleh pengguna",
                &ip,
            )
            .await;
        }
    }

    let clear = build_clear_cookie(state.auth_config.cookie_secure);
    let cookie_val = HeaderValue::from_str(&clear)
        .map_err(|e| AppError::Internal(format!("Invalid cookie header: {e}")))?;

    Ok((
        StatusCode::OK,
        [(SET_COOKIE, cookie_val)],
        Json(json!({ "ok": true })),
    ))
}

pub async fn me(auth: AuthUser) -> AppResult<Json<AuthUserResponse>> {
    Ok(Json(auth.to_response()))
}
