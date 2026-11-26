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
    models::{
        CreateExpenseCategoryRequest, CreateExpenseRequest, DailyExpense, ExpenseCategory,
        UpdateExpenseCategoryRequest, UpdateExpenseRequest,
    },
    AppState,
};

const MAX_EXPENSE_AMOUNT: i64 = 1_000_000_000;
const MAX_CATEGORY_NAME_CHARS: usize = 64;
const MAX_EXPENSE_CATEGORIES: i64 = 100;

#[derive(Debug, Deserialize)]
pub struct CategoryQuery {
    pub active_only: Option<bool>,
}

/// Resolves a requested category to its canonical stored name.
/// Active categories are always accepted; an inactive/legacy category is only accepted when it is
/// the expense's own current category (so editing other fields never gets blocked by a retired label).
async fn resolve_category(
    conn: &mut sqlx::SqliteConnection,
    requested: Option<&str>,
    current: Option<&str>,
) -> AppResult<String> {
    let requested = requested.map(str::trim).filter(|s| !s.is_empty());
    let Some(name) = requested else {
        let first: Option<(String,)> = sqlx::query_as(
            "SELECT name FROM expense_categories WHERE is_active = 1 ORDER BY (name = 'Operasional') DESC, sort_order ASC, id ASC LIMIT 1",
        )
        .fetch_optional(&mut *conn)
        .await?;
        return first.map(|r| r.0).ok_or_else(|| {
            AppError::Validation("Belum ada kategori pengeluaran aktif".into())
        });
    };

    if name.chars().count() > MAX_CATEGORY_NAME_CHARS {
        return Err(AppError::Validation(format!(
            "Nama kategori maksimal {MAX_CATEGORY_NAME_CHARS} karakter"
        )));
    }
    if let Some(cur) = current {
        if cur.trim().eq_ignore_ascii_case(name) {
            return Ok(cur.to_string());
        }
    }

    let found: Option<(String, i64)> =
        sqlx::query_as("SELECT name, is_active FROM expense_categories WHERE name = ?")
            .bind(name)
            .fetch_optional(&mut *conn)
            .await?;
    match found {
        Some((canonical, 1)) => Ok(canonical),
        Some(_) => Err(AppError::Validation(format!(
            "Kategori '{name}' sudah dinonaktifkan"
        ))),
        None => Err(AppError::Validation(format!(
            "Kategori '{name}' tidak ditemukan"
        ))),
    }
}

fn validate_expense_fields(title: &str, amount: i64) -> AppResult<()> {
    if title.is_empty() || title.chars().count() > 150 {
        return Err(AppError::Validation(
            "Nama/keterangan pengeluaran wajib diisi (maksimal 150 karakter)".into(),
        ));
    }
    if amount <= 0 || amount > MAX_EXPENSE_AMOUNT {
        return Err(AppError::Validation(format!(
            "Nominal pengeluaran harus antara Rp 1 hingga Rp {MAX_EXPENSE_AMOUNT}"
        )));
    }
    Ok(())
}

fn clean_notes(notes: Option<&str>) -> String {
    notes.unwrap_or("").trim().chars().take(500).collect()
}

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
    validate_expense_fields(title, req.amount)?;

    let business_date = parse_business_date(req.business_date.as_deref())?;
    let notes = clean_notes(req.notes.as_deref());
    let now = now_iso();

    let mut tx = begin_write_tx(&state.pool).await?;
    let store_status = get_store_day_status_tx(&mut tx, &business_date).await?;
    if store_status == "CLOSED" {
        return Err(AppError::Conflict(format!(
            "Toko untuk tanggal {business_date} sudah ditutup. Pengeluaran tidak dapat ditambahkan lagi."
        )));
    }
    let category = resolve_category(&mut tx, req.category.as_deref(), None).await?;

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

pub async fn update_expense(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateExpenseRequest>,
) -> AppResult<Json<DailyExpense>> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;

    let title = req.title.trim();
    validate_expense_fields(title, req.amount)?;
    let notes = clean_notes(req.notes.as_deref());

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
            "Toko untuk tanggal {} sudah ditutup. Pengeluaran tidak dapat diubah.",
            existing.business_date
        )));
    }

    let category =
        resolve_category(&mut tx, Some(&req.category), Some(&existing.category)).await?;

    sqlx::query(
        "UPDATE daily_expenses SET title = ?, category = ?, amount = ?, notes = ? WHERE id = ?",
    )
    .bind(title)
    .bind(&category)
    .bind(req.amount)
    .bind(&notes)
    .bind(id)
    .execute(&mut *tx)
    .await?;

    let updated: DailyExpense = sqlx::query_as("SELECT * FROM daily_expenses WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;

    tracing::info!(
        actor = %auth.username,
        expense_id = id,
        old_title = %existing.title,
        old_category = %existing.category,
        old_amount = existing.amount,
        new_title = %updated.title,
        new_category = %updated.category,
        new_amount = updated.amount,
        "expense updated"
    );
    tx.commit().await?;
    Ok(Json(updated))
}

pub async fn list_expense_categories(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(query): Query<CategoryQuery>,
) -> AppResult<Json<Vec<ExpenseCategory>>> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;

    let rows: Vec<ExpenseCategory> = if query.active_only.unwrap_or(false) {
        sqlx::query_as(
            "SELECT * FROM expense_categories WHERE is_active = 1 ORDER BY sort_order ASC, id ASC",
        )
        .fetch_all(&state.pool)
        .await?
    } else {
        sqlx::query_as("SELECT * FROM expense_categories ORDER BY sort_order ASC, id ASC")
            .fetch_all(&state.pool)
            .await?
    };
    Ok(Json(rows))
}

pub async fn create_expense_category(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(req): Json<CreateExpenseCategoryRequest>,
) -> AppResult<(StatusCode, Json<ExpenseCategory>)> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;

    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > MAX_CATEGORY_NAME_CHARS {
        return Err(AppError::Validation(format!(
            "Nama kategori wajib diisi (maksimal {MAX_CATEGORY_NAME_CHARS} karakter)"
        )));
    }

    let now = now_iso();
    let mut tx = begin_write_tx(&state.pool).await?;

    let dup: Option<(i64,)> = sqlx::query_as("SELECT id FROM expense_categories WHERE name = ?")
        .bind(name)
        .fetch_optional(&mut *tx)
        .await?;
    if dup.is_some() {
        return Err(AppError::Conflict(format!(
            "Kategori '{name}' sudah terdaftar"
        )));
    }

    let max_order: (i64,) =
        sqlx::query_as("SELECT COALESCE(MAX(sort_order), 0) FROM expense_categories")
            .fetch_one(&mut *tx)
            .await?;
    let total: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM expense_categories")
        .fetch_one(&mut *tx)
        .await?;
    if total.0 >= MAX_EXPENSE_CATEGORIES {
        return Err(AppError::Validation(format!(
            "Jumlah kategori pengeluaran maksimal {MAX_EXPENSE_CATEGORIES}"
        )));
    }
    let res = sqlx::query(
        "INSERT INTO expense_categories (name, is_active, sort_order, created_at) VALUES (?, 1, ?, ?)",
    )
    .bind(name)
    .bind(max_order.0 + 1)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    let created: ExpenseCategory = sqlx::query_as("SELECT * FROM expense_categories WHERE id = ?")
        .bind(res.last_insert_rowid())
        .fetch_one(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(created)))
}

/// Renames and/or (de)activates a category. A rename also relabels existing expenses so reports
/// keep grouping them together; categories are never deleted, only deactivated.
pub async fn update_expense_category(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateExpenseCategoryRequest>,
) -> AppResult<Json<ExpenseCategory>> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;

    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > MAX_CATEGORY_NAME_CHARS {
        return Err(AppError::Validation(format!(
            "Nama kategori wajib diisi (maksimal {MAX_CATEGORY_NAME_CHARS} karakter)"
        )));
    }

    let mut tx = begin_write_tx(&state.pool).await?;
    let target: Option<ExpenseCategory> =
        sqlx::query_as("SELECT * FROM expense_categories WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let target =
        target.ok_or_else(|| AppError::NotFound(format!("Kategori #{id} tidak ditemukan")))?;

    let dup: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM expense_categories WHERE name = ? AND id != ?")
            .bind(name)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    if dup.is_some() {
        return Err(AppError::Conflict(format!(
            "Nama kategori '{name}' sudah digunakan"
        )));
    }

    if !req.is_active && target.is_active == 1 {
        let other_active: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM expense_categories WHERE is_active = 1 AND id != ?",
        )
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        if other_active.0 == 0 {
            return Err(AppError::Conflict(
                "Minimal harus ada 1 kategori pengeluaran aktif".into(),
            ));
        }
    }

    sqlx::query("UPDATE expense_categories SET name = ?, is_active = ? WHERE id = ?")
        .bind(name)
        .bind(if req.is_active { 1_i64 } else { 0_i64 })
        .bind(id)
        .execute(&mut *tx)
        .await?;

    if target.name != name {
        sqlx::query(
            "UPDATE daily_expenses SET category = ? WHERE TRIM(category) = ? COLLATE NOCASE",
        )
        .bind(name)
        .bind(target.name.trim())
        .execute(&mut *tx)
        .await?;
        tracing::info!(
            actor = %auth.username,
            category_id = id,
            old_name = %target.name,
            new_name = %name,
            "expense category renamed (existing expenses relabeled, including closed days)"
        );
    }

    let updated: ExpenseCategory = sqlx::query_as("SELECT * FROM expense_categories WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(Json(updated))
}
