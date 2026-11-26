use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    auth::{AuthUser, Role},
    db::{begin_write_tx, get_store_day_status_tx, now_iso, parse_business_date},
    error::{AppError, AppResult},
    models::{CreateExpenseRequest, DailyExpense},
    AppState,
};

const MAX_EXPENSE_AMOUNT: i64 = 1_000_000_000;

#[derive(Debug, Deserialize)]
pub struct ExpenseQuery {
    pub date: Option<String>,
}

pub async fn list_expenses(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(query): Query<ExpenseQuery>,
) -> AppResult<Json<Vec<DailyExpense>>> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;

    let business_date = parse_business_date(query.date.as_deref())?;

    let rows: Vec<DailyExpense> = sqlx::query_as(
        "SELECT * FROM daily_expenses WHERE business_date = ? ORDER BY id DESC",
    )
    .bind(&business_date)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(rows))
}

pub async fn create_expense(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(req): Json<CreateExpenseRequest>,
) -> AppResult<(StatusCode, Json<DailyExpense>)> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;

    let title = req.title.trim();
    if title.is_empty() || title.chars().count() > 150 {
        return Err(AppError::Validation(
            "Nama/keterangan pengeluaran wajib diisi (maksimal 150 karakter)".into(),
        ));
    }
    if req.amount <= 0 || req.amount > MAX_EXPENSE_AMOUNT {
        return Err(AppError::Validation(format!(
            "Nominal pengeluaran harus antara Rp 1 hingga Rp {MAX_EXPENSE_AMOUNT}"
        )));
    }

    let business_date = parse_business_date(req.business_date.as_deref())?;
    let category: String = req
        .category
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Operasional")
        .chars()
        .take(64)
        .collect();
    let notes: String = req
        .notes
        .as_deref()
        .unwrap_or("")
        .trim()
        .chars()
        .take(500)
        .collect();
    let now = now_iso();

    let mut tx = begin_write_tx(&state.pool).await?;
    let store_status = get_store_day_status_tx(&mut tx, &business_date).await?;
    if store_status == "CLOSED" {
        return Err(AppError::Conflict(format!(
            "Toko untuk tanggal {business_date} sudah ditutup. Pengeluaran tidak dapat ditambahkan lagi."
        )));
    }

    let res = sqlx::query(
        r#"
        INSERT INTO daily_expenses (
            business_date, title, category, amount, notes, created_by_user_id, created_by_username, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&business_date)
    .bind(title)
    .bind(&category)
    .bind(req.amount)
    .bind(&notes)
    .bind(auth.id)
    .bind(&auth.username)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    let created: DailyExpense = sqlx::query_as("SELECT * FROM daily_expenses WHERE id = ?")
        .bind(res.last_insert_rowid())
        .fetch_one(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(created)))
}

pub async fn delete_expense(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;

    let mut tx = begin_write_tx(&state.pool).await?;
    let existing: Option<DailyExpense> =
        sqlx::query_as("SELECT * FROM daily_expenses WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;

    let existing = existing
        .ok_or_else(|| AppError::NotFound(format!("Pengeluaran #{id} tidak ditemukan")))?;

    let store_status = get_store_day_status_tx(&mut tx, &existing.business_date).await?;
    if store_status == "CLOSED" {
        return Err(AppError::Conflict(format!(
            "Toko untuk tanggal {} sudah ditutup. Pengeluaran tidak dapat dihapus.",
            existing.business_date
        )));
    }

    sqlx::query("DELETE FROM daily_expenses WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(Json(json!({ "deleted": true })))
}
