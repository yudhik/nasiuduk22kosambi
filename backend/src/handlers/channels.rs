use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;

use crate::{
    auth::{AuthUser, Role},
    db::{begin_write_tx, now_iso},
    error::{AppError, AppResult},
    models::{CreateChannelRequest, SalesChannel, UpdateChannelRequest},
    AppState,
};

#[derive(Debug, Deserialize)]
pub struct ChannelQuery {
    pub active_only: Option<bool>,
}

fn slugify_code(name: &str) -> String {
    let mut out = String::new();
    for ch in name.trim().to_ascii_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else if (ch == ' ' || ch == '-' || ch == '_') && !out.ends_with('_') && !out.is_empty() {
            out.push('_');
        }
    }
    out.trim_matches('_').to_string()
}

pub async fn list_channels(
    _auth: AuthUser,
    State(state): State<AppState>,
    Query(query): Query<ChannelQuery>,
) -> AppResult<Json<Vec<SalesChannel>>> {
    let active_only = query.active_only.unwrap_or(false);
    let rows: Vec<SalesChannel> = if active_only {
        sqlx::query_as(
            "SELECT * FROM sales_channels WHERE is_active = 1 ORDER BY sort_order ASC, id ASC",
        )
        .fetch_all(&state.pool)
        .await?
    } else {
        sqlx::query_as("SELECT * FROM sales_channels ORDER BY sort_order ASC, id ASC")
            .fetch_all(&state.pool)
            .await?
    };

    Ok(Json(rows))
}

pub async fn create_channel(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(req): Json<CreateChannelRequest>,
) -> AppResult<(StatusCode, Json<SalesChannel>)> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;

    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > 64 {
        return Err(AppError::Validation(
            "Nama channel wajib diisi (maksimal 64 karakter)".into(),
        ));
    }
    let code = slugify_code(name);
    if code.is_empty() {
        return Err(AppError::Validation(
            "Nama channel harus mengandung huruf atau angka".into(),
        ));
    }

    let now = now_iso();
    let mut tx = begin_write_tx(&state.pool).await?;

    let dup: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM sales_channels WHERE code = ? OR name = ?")
            .bind(&code)
            .bind(name)
            .fetch_optional(&mut *tx)
            .await?;
    if dup.is_some() {
        return Err(AppError::Conflict(format!(
            "Channel '{name}' sudah terdaftar"
        )));
    }

    let max_order: (i64,) =
        sqlx::query_as("SELECT COALESCE(MAX(sort_order), 0) FROM sales_channels")
            .fetch_one(&mut *tx)
            .await?;
    let sort_order = req.sort_order.unwrap_or(max_order.0 + 1);
    let is_auto_paid = if req.is_auto_paid.unwrap_or(true) {
        1_i64
    } else {
        0_i64
    };

    let res = sqlx::query(
        r#"
        INSERT INTO sales_channels (code, name, is_auto_paid, is_active, sort_order, created_at)
        VALUES (?, ?, ?, 1, ?, ?)
        "#,
    )
    .bind(&code)
    .bind(name)
    .bind(is_auto_paid)
    .bind(sort_order)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    let created: SalesChannel = sqlx::query_as("SELECT * FROM sales_channels WHERE id = ?")
        .bind(res.last_insert_rowid())
        .fetch_one(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(created)))
}

pub async fn update_channel(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateChannelRequest>,
) -> AppResult<Json<SalesChannel>> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;

    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > 64 {
        return Err(AppError::Validation(
            "Nama channel wajib diisi (maksimal 64 karakter)".into(),
        ));
    }

    let mut tx = begin_write_tx(&state.pool).await?;
    let target: Option<SalesChannel> =
        sqlx::query_as("SELECT * FROM sales_channels WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let target =
        target.ok_or_else(|| AppError::NotFound(format!("Channel #{id} tidak ditemukan")))?;

    if target.code.eq_ignore_ascii_case("regular") {
        if !req.is_active {
            return Err(AppError::Validation(
                "Channel 'Regular' tidak dapat dinonaktifkan".into(),
            ));
        }
        if req.is_auto_paid {
            return Err(AppError::Validation(
                "Channel 'Regular' harus menggunakan alur pembayaran kasir (tidak auto-paid)".into(),
            ));
        }
    }

    let dup: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM sales_channels WHERE name = ? AND id != ?")
            .bind(name)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    if dup.is_some() {
        return Err(AppError::Conflict(format!(
            "Nama channel '{name}' sudah digunakan"
        )));
    }

    let is_auto_paid = if req.is_auto_paid { 1_i64 } else { 0_i64 };
    let is_active = if req.is_active { 1_i64 } else { 0_i64 };

    sqlx::query(
        "UPDATE sales_channels SET name = ?, is_auto_paid = ?, is_active = ?, sort_order = ? WHERE id = ?",
    )
    .bind(name)
    .bind(is_auto_paid)
    .bind(is_active)
    .bind(req.sort_order)
    .bind(id)
    .execute(&mut *tx)
    .await?;

    let updated: SalesChannel = sqlx::query_as("SELECT * FROM sales_channels WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(Json(updated))
}
