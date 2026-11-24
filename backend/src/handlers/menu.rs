use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    db::{ensure_daily_snapshot, now_iso, today_date},
    error::{AppError, AppResult},
    models::{
        CreateMenuRequest, MenuItem, RestockRequest, SetInitialStockRequest, StartDayResponse,
        UpdateMenuRequest,
    },
    AppState,
};

#[derive(Debug, Deserialize)]
pub struct MenuQuery {
    pub active_only: Option<bool>,
    pub category: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DeleteMenuResponse {
    pub deleted: bool,
    pub soft_deleted: bool,
}

pub async fn list_menus(
    State(state): State<AppState>,
    Query(query): Query<MenuQuery>,
) -> AppResult<Json<Vec<MenuItem>>> {
    let active_only = query.active_only.unwrap_or(false);
    let category = query
        .category
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let items: Vec<MenuItem> = match (active_only, category) {
        (true, Some(cat)) => {
            sqlx::query_as(
                "SELECT * FROM menu_items WHERE is_active = 1 AND category = ? ORDER BY category ASC, name ASC",
            )
            .bind(cat)
            .fetch_all(&state.pool)
            .await?
        }
        (true, None) => {
            sqlx::query_as(
                "SELECT * FROM menu_items WHERE is_active = 1 ORDER BY category ASC, name ASC",
            )
            .fetch_all(&state.pool)
            .await?
        }
        (false, Some(cat)) => {
            sqlx::query_as(
                "SELECT * FROM menu_items WHERE category = ? ORDER BY is_active DESC, category ASC, name ASC",
            )
            .bind(cat)
            .fetch_all(&state.pool)
            .await?
        }
        (false, None) => {
            sqlx::query_as(
                "SELECT * FROM menu_items ORDER BY is_active DESC, category ASC, name ASC",
            )
            .fetch_all(&state.pool)
            .await?
        }
    };

    Ok(Json(items))
}

pub async fn create_menu(
    State(state): State<AppState>,
    Json(req): Json<CreateMenuRequest>,
) -> AppResult<(StatusCode, Json<MenuItem>)> {
    let name = req.name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("Nama menu tidak boleh kosong".into()));
    }
    if req.price < 0 {
        return Err(AppError::Validation("Harga menu tidak boleh negatif".into()));
    }

    let current_stock = req
        .current_stock
        .or(req.default_daily_stock)
        .unwrap_or(0);
    let default_daily_stock = req.default_daily_stock.unwrap_or(current_stock);
    if current_stock < 0 || default_daily_stock < 0 {
        return Err(AppError::Validation("Stok tidak boleh negatif".into()));
    }

    let category = req
        .category
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Makanan");
    let now = now_iso();
    let today = today_date();

    let mut tx = state.pool.begin().await?;
    let res = sqlx::query(
        r#"
        INSERT INTO menu_items (
            name, category, price, current_stock, default_daily_stock, is_active, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        "#,
    )
    .bind(name)
    .bind(category)
    .bind(req.price)
    .bind(current_stock)
    .bind(default_daily_stock)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    let menu_id = res.last_insert_rowid();
    ensure_daily_snapshot(&mut tx, &today, menu_id, current_stock, &now).await?;

    if current_stock > 0 {
        sqlx::query(
            r#"
            INSERT INTO stock_movements (
                business_date, menu_item_id, order_id, movement_type, qty_delta, stock_after, note, created_at
            )
            VALUES (?, ?, NULL, 'SET_INITIAL', ?, ?, 'Menu baru dibuat', ?)
            "#,
        )
        .bind(&today)
        .bind(menu_id)
        .bind(current_stock)
        .bind(current_stock)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }

    let created: MenuItem = sqlx::query_as("SELECT * FROM menu_items WHERE id = ?")
        .bind(menu_id)
        .fetch_one(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(created)))
}

pub async fn update_menu(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateMenuRequest>,
) -> AppResult<Json<MenuItem>> {
    let name = req.name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("Nama menu tidak boleh kosong".into()));
    }
    if req.price < 0 {
        return Err(AppError::Validation("Harga menu tidak boleh negatif".into()));
    }
    if req.default_daily_stock < 0 {
        return Err(AppError::Validation(
            "Stok default harian tidak boleh negatif".into(),
        ));
    }

    let category = req.category.trim();
    let category = if category.is_empty() { "Makanan" } else { category };
    let is_active = if req.is_active { 1_i64 } else { 0_i64 };
    let now = now_iso();

    let result = sqlx::query(
        r#"
        UPDATE menu_items
        SET name = ?, category = ?, price = ?, default_daily_stock = ?, is_active = ?, updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(name)
    .bind(category)
    .bind(req.price)
    .bind(req.default_daily_stock)
    .bind(is_active)
    .bind(&now)
    .bind(id)
    .execute(&state.pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Menu #{id} tidak ditemukan")));
    }

    let updated: MenuItem = sqlx::query_as("SELECT * FROM menu_items WHERE id = ?")
        .bind(id)
        .fetch_one(&state.pool)
        .await?;

    Ok(Json(updated))
}

pub async fn delete_menu(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<DeleteMenuResponse>> {
    let mut tx = state.pool.begin().await?;

    let exists: Option<(i64,)> = sqlx::query_as("SELECT id FROM menu_items WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

    if exists.is_none() {
        return Err(AppError::NotFound(format!("Menu #{id} tidak ditemukan")));
    }

    let order_refs: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM order_items WHERE menu_item_id = ?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;

    if order_refs.0 > 0 {
        let now = now_iso();
        sqlx::query("UPDATE menu_items SET is_active = 0, updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(Json(DeleteMenuResponse {
            deleted: true,
            soft_deleted: true,
        }));
    }

    sqlx::query("DELETE FROM stock_movements WHERE menu_item_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM daily_stock_snapshots WHERE menu_item_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM menu_items WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(Json(DeleteMenuResponse {
        deleted: true,
        soft_deleted: false,
    }))
}

pub async fn set_initial_stock(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<SetInitialStockRequest>,
) -> AppResult<Json<MenuItem>> {
    if req.initial_stock < 0 {
        return Err(AppError::Validation("Stok awal tidak boleh negatif".into()));
    }

    let today = today_date();
    let now = now_iso();
    let note = req
        .note
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Penyesuaian stok awal harian");

    let mut tx = state.pool.begin().await?;
    let menu: Option<MenuItem> = sqlx::query_as("SELECT * FROM menu_items WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

    let menu = menu.ok_or_else(|| AppError::NotFound(format!("Menu #{id} tidak ditemukan")))?;
    ensure_daily_snapshot(&mut tx, &today, id, menu.current_stock, &now).await?;

    let (restocked_qty, sold_qty): (i64, i64) = sqlx::query_as(
        "SELECT restocked_qty, sold_qty FROM daily_stock_snapshots WHERE business_date = ? AND menu_item_id = ?",
    )
    .bind(&today)
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;

    let new_current_stock = req.initial_stock + restocked_qty - sold_qty;
    if new_current_stock < 0 {
        return Err(AppError::Validation(format!(
            "Stok awal ({}) + restock ({}) tidak boleh kurang dari jumlah terjual hari ini ({})",
            req.initial_stock, restocked_qty, sold_qty
        )));
    }

    let delta = new_current_stock - menu.current_stock;

    sqlx::query("UPDATE menu_items SET current_stock = ?, updated_at = ? WHERE id = ?")
        .bind(new_current_stock)
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        r#"
        UPDATE daily_stock_snapshots
        SET initial_stock = ?, updated_at = ?
        WHERE business_date = ? AND menu_item_id = ?
        "#,
    )
    .bind(req.initial_stock)
    .bind(&now)
    .bind(&today)
    .bind(id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO stock_movements (
            business_date, menu_item_id, order_id, movement_type, qty_delta, stock_after, note, created_at
        )
        VALUES (?, ?, NULL, 'SET_INITIAL', ?, ?, ?, ?)
        "#,
    )
    .bind(&today)
    .bind(id)
    .bind(delta)
    .bind(new_current_stock)
    .bind(note)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    let updated: MenuItem = sqlx::query_as("SELECT * FROM menu_items WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(Json(updated))
}

pub async fn restock_menu(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<RestockRequest>,
) -> AppResult<Json<MenuItem>> {
    if req.quantity <= 0 {
        return Err(AppError::Validation(
            "Jumlah restock harus lebih dari 0".into(),
        ));
    }

    let today = today_date();
    let now = now_iso();
    let note = req
        .note
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Penambahan stok tengah hari");

    let mut tx = state.pool.begin().await?;
    let menu: Option<MenuItem> = sqlx::query_as("SELECT * FROM menu_items WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

    let menu = menu.ok_or_else(|| AppError::NotFound(format!("Menu #{id} tidak ditemukan")))?;
    ensure_daily_snapshot(&mut tx, &today, id, menu.current_stock, &now).await?;

    let new_stock = menu.current_stock + req.quantity;

    sqlx::query("UPDATE menu_items SET current_stock = ?, updated_at = ? WHERE id = ?")
        .bind(new_stock)
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        r#"
        UPDATE daily_stock_snapshots
        SET restocked_qty = restocked_qty + ?, updated_at = ?
        WHERE business_date = ? AND menu_item_id = ?
        "#,
    )
    .bind(req.quantity)
    .bind(&now)
    .bind(&today)
    .bind(id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO stock_movements (
            business_date, menu_item_id, order_id, movement_type, qty_delta, stock_after, note, created_at
        )
        VALUES (?, ?, NULL, 'RESTOCK', ?, ?, ?, ?)
        "#,
    )
    .bind(&today)
    .bind(id)
    .bind(req.quantity)
    .bind(new_stock)
    .bind(note)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    let updated: MenuItem = sqlx::query_as("SELECT * FROM menu_items WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(Json(updated))
}

pub async fn start_day(State(state): State<AppState>) -> AppResult<Json<StartDayResponse>> {
    let today = today_date();
    let now = now_iso();
    let mut initialized_count = 0_usize;
    let mut skipped_with_sales = 0_usize;

    let mut tx = state.pool.begin().await?;
    let active_menus: Vec<MenuItem> =
        sqlx::query_as("SELECT * FROM menu_items WHERE is_active = 1 ORDER BY id ASC")
            .fetch_all(&mut *tx)
            .await?;

    for menu in active_menus {
        let existing_sold: Option<(i64,)> = sqlx::query_as(
            "SELECT sold_qty FROM daily_stock_snapshots WHERE business_date = ? AND menu_item_id = ?",
        )
        .bind(&today)
        .bind(menu.id)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some((sold_qty,)) = existing_sold {
            if sold_qty > 0 {
                skipped_with_sales += 1;
                continue;
            }
        }

        let target = menu.default_daily_stock;
        let delta = target - menu.current_stock;

        sqlx::query("UPDATE menu_items SET current_stock = ?, updated_at = ? WHERE id = ?")
            .bind(target)
            .bind(&now)
            .bind(menu.id)
            .execute(&mut *tx)
            .await?;

        sqlx::query(
            r#"
            INSERT INTO daily_stock_snapshots (
                business_date, menu_item_id, initial_stock, restocked_qty, sold_qty, voided_qty, notes, updated_at
            )
            VALUES (?, ?, ?, 0, 0, 0, '', ?)
            ON CONFLICT(business_date, menu_item_id) DO UPDATE SET
                initial_stock = excluded.initial_stock,
                restocked_qty = 0,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(&today)
        .bind(menu.id)
        .bind(target)
        .bind(&now)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO stock_movements (
                business_date, menu_item_id, order_id, movement_type, qty_delta, stock_after, note, created_at
            )
            VALUES (?, ?, NULL, 'SET_INITIAL', ?, ?, 'Mulai hari baru (reset stok default)', ?)
            "#,
        )
        .bind(&today)
        .bind(menu.id)
        .bind(delta)
        .bind(target)
        .bind(&now)
        .execute(&mut *tx)
        .await?;

        initialized_count += 1;
    }

    tx.commit().await?;
    Ok(Json(StartDayResponse {
        business_date: today,
        initialized_count,
        skipped_with_sales,
    }))
}
