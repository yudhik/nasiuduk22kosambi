use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    auth::{AuthUser, Role},
    db::{
        begin_write_tx, ensure_daily_stock_snapshot, get_store_day_status_tx, now_business_and_iso,
        now_iso,
    },
    error::{AppError, AppResult},
    models::{
        CreateStockItemRequest, RestockRequest, SetInitialStockRequest, StockItem,
        UpdateStockItemRequest,
    },
    AppState,
};

const MAX_STOCK_QTY: i64 = 1_000_000;

#[derive(Debug, Deserialize)]
pub struct StockQuery {
    pub active_only: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct DeleteStockResponse {
    pub deleted: bool,
    pub soft_deleted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub async fn list_stocks(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(query): Query<StockQuery>,
) -> AppResult<Json<Vec<StockItem>>> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;

    let active_only = query.active_only.unwrap_or(false);
    let items: Vec<StockItem> = if active_only {
        sqlx::query_as("SELECT * FROM stock_items WHERE is_active = 1 ORDER BY name ASC")
            .fetch_all(&state.pool)
            .await?
    } else {
        sqlx::query_as("SELECT * FROM stock_items ORDER BY is_active DESC, name ASC")
            .fetch_all(&state.pool)
            .await?
    };

    Ok(Json(items))
}

pub async fn create_stock(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(req): Json<CreateStockItemRequest>,
) -> AppResult<(StatusCode, Json<StockItem>)> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;

    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(AppError::Validation(
            "Nama item stok wajib diisi (maksimal 120 karakter)".into(),
        ));
    }
    let unit: String = req
        .unit
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("porsi")
        .chars()
        .take(32)
        .collect();

    let now = now_iso();
    let mut tx = begin_write_tx(&state.pool).await?;

    let existing: Option<(i64,)> = sqlx::query_as("SELECT id FROM stock_items WHERE name = ?")
        .bind(name)
        .fetch_optional(&mut *tx)
        .await?;
    if existing.is_some() {
        return Err(AppError::Conflict(format!("Item stok '{name}' sudah ada")));
    }

    let res = sqlx::query(
        r#"
        INSERT INTO stock_items (name, unit, current_stock, is_active, created_at, updated_at)
        VALUES (?, ?, 0, 1, ?, ?)
        "#,
    )
    .bind(name)
    .bind(&unit)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    let created: StockItem = sqlx::query_as("SELECT * FROM stock_items WHERE id = ?")
        .bind(res.last_insert_rowid())
        .fetch_one(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(created)))
}

pub async fn update_stock(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateStockItemRequest>,
) -> AppResult<Json<StockItem>> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;

    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(AppError::Validation(
            "Nama item stok wajib diisi (maksimal 120 karakter)".into(),
        ));
    }
    let unit_raw = req.unit.trim();
    let unit: String = if unit_raw.is_empty() {
        "porsi".to_string()
    } else {
        unit_raw.chars().take(32).collect()
    };

    let now = now_iso();
    let is_active = if req.is_active { 1_i64 } else { 0_i64 };
    let mut tx = begin_write_tx(&state.pool).await?;

    let duplicate: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM stock_items WHERE name = ? AND id != ?")
            .bind(name)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    if duplicate.is_some() {
        return Err(AppError::Conflict(format!(
            "Item stok '{name}' sudah digunakan"
        )));
    }

    if !req.is_active {
        let active_menu_refs: (i64,) = sqlx::query_as(
            r#"
            SELECT COUNT(*)
            FROM menu_stock_requirements msr
            INNER JOIN menu_items m ON m.id = msr.menu_item_id
            WHERE msr.stock_item_id = ? AND m.is_active = 1
            "#,
        )
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        if active_menu_refs.0 > 0 {
            return Err(AppError::Conflict(
                "Item stok masih digunakan oleh menu aktif. Ubah atau nonaktifkan menu terkait terlebih dahulu."
                    .into(),
            ));
        }
    }

    let res = sqlx::query(
        "UPDATE stock_items SET name = ?, unit = ?, is_active = ?, updated_at = ? WHERE id = ?",
    )
    .bind(name)
    .bind(&unit)
    .bind(is_active)
    .bind(&now)
    .bind(id)
    .execute(&mut *tx)
    .await?;

    if res.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Item stok #{id} tidak ditemukan")));
    }

    let updated: StockItem = sqlx::query_as("SELECT * FROM stock_items WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(Json(updated))
}

pub async fn delete_stock(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<DeleteStockResponse>> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;

    let mut tx = begin_write_tx(&state.pool).await?;
    let exists: Option<(i64,)> = sqlx::query_as("SELECT id FROM stock_items WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!("Item stok #{id} tidak ditemukan")));
    }

    let active_menu_refs: (i64,) = sqlx::query_as(
        r#"
        SELECT COUNT(*)
        FROM menu_stock_requirements msr
        INNER JOIN menu_items m ON m.id = msr.menu_item_id
        WHERE msr.stock_item_id = ? AND m.is_active = 1
        "#,
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if active_menu_refs.0 > 0 {
        return Err(AppError::Conflict(
            "Item stok masih terhubung ke menu aktif. Ubah atau hapus menu terkait terlebih dahulu."
                .into(),
        ));
    }

    let hist_refs: (i64,) = sqlx::query_as(
        r#"
        SELECT (
            (SELECT COUNT(*) FROM order_stock_deductions WHERE stock_item_id = ?) +
            (SELECT COUNT(*) FROM daily_stock_item_snapshots WHERE stock_item_id = ?) +
            (SELECT COUNT(*) FROM stock_item_movements WHERE stock_item_id = ?)
        )
        "#,
    )
    .bind(id)
    .bind(id)
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;

    if hist_refs.0 > 0 {
        let now = now_iso();
        sqlx::query(
            "UPDATE stock_items SET is_active = 0, current_stock = 0, updated_at = ? WHERE id = ?",
        )
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(Json(DeleteStockResponse {
            deleted: true,
            soft_deleted: true,
            reason: Some(
                "Item stok memiliki riwayat mutasi/transaksi, sehingga diarsipkan agar laporan tetap akurat."
                    .to_string(),
            ),
        }));
    }

    sqlx::query("DELETE FROM menu_stock_requirements WHERE stock_item_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM stock_items WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(Json(DeleteStockResponse {
        deleted: true,
        soft_deleted: false,
        reason: None,
    }))
}

pub async fn restock_item(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<RestockRequest>,
) -> AppResult<Json<StockItem>> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;

    if req.quantity <= 0 || req.quantity > MAX_STOCK_QTY {
        return Err(AppError::Validation(format!(
            "Jumlah restock harus antara 1 hingga {MAX_STOCK_QTY}"
        )));
    }

    let (today, now) = now_business_and_iso();
    let note: String = req
        .note
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Penambahan stok tengah hari")
        .chars()
        .take(300)
        .collect();

    let mut tx = begin_write_tx(&state.pool).await?;
    let store_status = get_store_day_status_tx(&mut tx, &today).await?;
    if store_status != "OPEN" {
        return Err(AppError::Conflict(
            "Restock hanya dapat dilakukan saat toko sedang BUKA hari ini".into(),
        ));
    }

    let stock: Option<StockItem> = sqlx::query_as("SELECT * FROM stock_items WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let stock =
        stock.ok_or_else(|| AppError::NotFound(format!("Item stok #{id} tidak ditemukan")))?;
    if stock.is_active == 0 {
        return Err(AppError::Validation("Item stok sedang tidak aktif".into()));
    }

    ensure_daily_stock_snapshot(&mut tx, &today, id, stock.current_stock, &now).await?;
    let new_stock = stock
        .current_stock
        .checked_add(req.quantity)
        .filter(|&v| v <= MAX_STOCK_QTY * 10)
        .ok_or_else(|| AppError::Validation("Total stok melebihi batas".into()))?;

    sqlx::query("UPDATE stock_items SET current_stock = ?, updated_at = ? WHERE id = ?")
        .bind(new_stock)
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        r#"
        UPDATE daily_stock_item_snapshots
        SET restocked_qty = restocked_qty + ?, updated_at = ?
        WHERE business_date = ? AND stock_item_id = ?
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
        INSERT INTO stock_item_movements (
            business_date, stock_item_id, order_id, movement_type, qty_delta, stock_after, note, created_at
        )
        VALUES (?, ?, NULL, 'RESTOCK', ?, ?, ?, ?)
        "#,
    )
    .bind(&today)
    .bind(id)
    .bind(req.quantity)
    .bind(new_stock)
    .bind(&note)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    let updated: StockItem = sqlx::query_as("SELECT * FROM stock_items WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(Json(updated))
}

pub async fn set_initial_stock_item(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<SetInitialStockRequest>,
) -> AppResult<Json<StockItem>> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;

    if req.initial_stock < 0 || req.initial_stock > MAX_STOCK_QTY {
        return Err(AppError::Validation(format!(
            "Stok awal harus antara 0 hingga {MAX_STOCK_QTY}"
        )));
    }

    let (today, now) = now_business_and_iso();
    let note: String = req
        .note
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Penyesuaian stok awal harian")
        .chars()
        .take(300)
        .collect();

    let mut tx = begin_write_tx(&state.pool).await?;
    let store_status = get_store_day_status_tx(&mut tx, &today).await?;
    if store_status != "OPEN" {
        return Err(AppError::Conflict(
            "Penyesuaian stok awal hanya dapat dilakukan saat toko sedang BUKA hari ini".into(),
        ));
    }

    let stock: Option<StockItem> = sqlx::query_as("SELECT * FROM stock_items WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let stock =
        stock.ok_or_else(|| AppError::NotFound(format!("Item stok #{id} tidak ditemukan")))?;
    if stock.is_active == 0 {
        return Err(AppError::Validation("Item stok sedang tidak aktif".into()));
    }

    ensure_daily_stock_snapshot(&mut tx, &today, id, stock.current_stock, &now).await?;
    let (restocked_qty, sold_qty): (i64, i64) = sqlx::query_as(
        "SELECT restocked_qty, sold_qty FROM daily_stock_item_snapshots WHERE business_date = ? AND stock_item_id = ?",
    )
    .bind(&today)
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;

    let supplied = req
        .initial_stock
        .checked_add(restocked_qty)
        .ok_or_else(|| AppError::Validation("Total stok melebihi batas".into()))?;
    let new_current_stock = supplied
        .checked_sub(sold_qty)
        .ok_or_else(|| AppError::Validation("Perhitungan stok tidak valid".into()))?;
    if new_current_stock < 0 {
        return Err(AppError::Validation(format!(
            "Stok awal ({}) + restock ({}) tidak boleh kurang dari jumlah terpakai hari ini ({})",
            req.initial_stock, restocked_qty, sold_qty
        )));
    }

    let delta = new_current_stock - stock.current_stock;

    sqlx::query("UPDATE stock_items SET current_stock = ?, updated_at = ? WHERE id = ?")
        .bind(new_current_stock)
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        "UPDATE daily_stock_item_snapshots SET initial_stock = ?, updated_at = ? WHERE business_date = ? AND stock_item_id = ?",
    )
    .bind(req.initial_stock)
    .bind(&now)
    .bind(&today)
    .bind(id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO stock_item_movements (
            business_date, stock_item_id, order_id, movement_type, qty_delta, stock_after, note, created_at
        )
        VALUES (?, ?, NULL, 'SET_INITIAL', ?, ?, ?, ?)
        "#,
    )
    .bind(&today)
    .bind(id)
    .bind(delta)
    .bind(new_current_stock)
    .bind(&note)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    let updated: StockItem = sqlx::query_as("SELECT * FROM stock_items WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(Json(updated))
}
