use std::collections::{HashMap, HashSet};

use axum::{extract::State, Json};
use sqlx::{Sqlite, Transaction};

use crate::{
    auth::{AuthUser, Role},
    db::{begin_write_tx, ensure_daily_stock_snapshot, now_business_and_iso, today_date},
    error::{AppError, AppResult},
    models::{CloseStoreRequest, OpenStoreRequest, StockItem, StoreDayRow, StoreStatusResponse},
    AppState,
};

async fn build_store_status(
    pool: &sqlx::SqlitePool,
    business_date: &str,
    role: Role,
) -> AppResult<StoreStatusResponse> {
    let day: Option<StoreDayRow> =
        sqlx::query_as("SELECT * FROM store_days WHERE business_date = ?")
            .bind(business_date)
            .fetch_optional(pool)
            .await?;

    // Only Cashier, Owner, and Admin need unpaid order count; Waiter never sees Cashier counts
    let unpaid_count = if matches!(role, Role::Cashier | Role::Owner | Role::Admin) {
        let (cnt,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM orders WHERE business_date = ? AND status = 'UNPAID'",
        )
        .bind(business_date)
        .fetch_one(pool)
        .await?;
        cnt
    } else {
        0
    };

    // Financial closing_summary (revenue/expenses/net_profit) strictly restricted to Owner & Admin
    let allow_financials = matches!(role, Role::Owner | Role::Admin);

    match day {
        Some(row) => {
            let closing_summary = if row.status == "CLOSED" && allow_financials {
                Some(row.clone())
            } else {
                None
            };
            Ok(StoreStatusResponse {
                business_date: business_date.to_string(),
                status: row.status,
                opened_at: Some(row.opened_at),
                opened_by_username: Some(row.opened_by_username),
                closed_at: row.closed_at,
                closed_by_username: row.closed_by_username,
                unpaid_order_count: unpaid_count,
                closing_summary,
            })
        }
        None => Ok(StoreStatusResponse {
            business_date: business_date.to_string(),
            status: "NOT_OPENED".to_string(),
            opened_at: None,
            opened_by_username: None,
            closed_at: None,
            closed_by_username: None,
            unpaid_order_count: unpaid_count,
            closing_summary: None,
        }),
    }
}

async fn finalize_store_day_tx(
    tx: &mut Transaction<'_, Sqlite>,
    business_date: &str,
    closed_by_user_id: i64,
    closed_by_username: &str,
    closing_notes: &str,
    now: &str,
) -> AppResult<()> {
    let (total_orders, paid_orders, voided_orders, gross_revenue): (i64, i64, i64, i64) =
        sqlx::query_as(
            r#"
            SELECT
                COUNT(*) AS total_orders,
                COALESCE(SUM(CASE WHEN status = 'PAID' THEN 1 ELSE 0 END), 0) AS paid_orders,
                COALESCE(SUM(CASE WHEN status = 'VOIDED' THEN 1 ELSE 0 END), 0) AS voided_orders,
                COALESCE(SUM(CASE WHEN status = 'PAID' THEN total_amount ELSE 0 END), 0) AS gross_revenue
            FROM orders
            WHERE business_date = ?
            "#,
        )
        .bind(business_date)
        .fetch_one(&mut **tx)
        .await?;

    let (total_portions_sold,): (i64,) = sqlx::query_as(
        r#"
        SELECT COALESCE(SUM(oi.quantity), 0)
        FROM order_items oi
        INNER JOIN orders o ON o.id = oi.order_id
        WHERE o.business_date = ? AND o.status = 'PAID'
        "#,
    )
    .bind(business_date)
    .fetch_one(&mut **tx)
    .await?;

    let (total_expenses,): (i64,) = sqlx::query_as(
        "SELECT COALESCE(SUM(amount), 0) FROM daily_expenses WHERE business_date = ?",
    )
    .bind(business_date)
    .fetch_one(&mut **tx)
    .await?;

    let net_profit = gross_revenue.saturating_sub(total_expenses);

    sqlx::query(
        r#"
        UPDATE store_days
        SET status = 'CLOSED',
            closed_at = ?,
            closed_by_user_id = ?,
            closed_by_username = ?,
            total_orders = ?,
            paid_orders = ?,
            voided_orders = ?,
            gross_revenue = ?,
            total_expenses = ?,
            net_profit = ?,
            total_portions_sold = ?,
            closing_notes = ?
        WHERE business_date = ?
        "#,
    )
    .bind(now)
    .bind(closed_by_user_id)
    .bind(closed_by_username)
    .bind(total_orders)
    .bind(paid_orders)
    .bind(voided_orders)
    .bind(gross_revenue)
    .bind(total_expenses)
    .bind(net_profit)
    .bind(total_portions_sold)
    .bind(closing_notes)
    .bind(business_date)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

pub async fn get_store_status(
    auth: AuthUser,
    State(state): State<AppState>,
) -> AppResult<Json<StoreStatusResponse>> {
    let today = today_date();
    let status = build_store_status(&state.pool, &today, auth.role).await?;
    Ok(Json(status))
}

pub async fn open_store(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(req): Json<OpenStoreRequest>,
) -> AppResult<Json<StoreStatusResponse>> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;

    let (today, now) = now_business_and_iso();

    let mut stock_map: HashMap<i64, i64> = HashMap::new();
    for entry in &req.stocks {
        if entry.initial_stock < 0 || entry.initial_stock > 1_000_000 {
            return Err(AppError::Validation(
                "Stok awal harus antara 0 hingga 1.000.000".into(),
            ));
        }
        stock_map.insert(entry.stock_item_id, entry.initial_stock);
    }

    let mut tx = begin_write_tx(&state.pool).await?;

    let existing_day: Option<StoreDayRow> =
        sqlx::query_as("SELECT * FROM store_days WHERE business_date = ?")
            .bind(&today)
            .fetch_optional(&mut *tx)
            .await?;

    if let Some(day) = existing_day {
        if day.status == "CLOSED" {
            return Err(AppError::Conflict(
                "Toko untuk hari ini sudah ditutup secara permanen dan tidak dapat dibuka kembali."
                    .into(),
            ));
        }
        return Err(AppError::Conflict(
            "Toko hari ini sudah dibuka sebelumnya.".into(),
        ));
    }

    // Handle any forgotten prior OPEN days cleanly so cross-day stock corruption can never occur
    let prior_open_days: Vec<(String,)> = sqlx::query_as(
        "SELECT business_date FROM store_days WHERE status = 'OPEN' AND business_date < ? ORDER BY business_date ASC",
    )
    .bind(&today)
    .fetch_all(&mut *tx)
    .await?;

    for (prior_date,) in prior_open_days {
        let (prior_unpaid,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM orders WHERE business_date = ? AND status = 'UNPAID'",
        )
        .bind(&prior_date)
        .fetch_one(&mut *tx)
        .await?;
        if prior_unpaid > 0 {
            return Err(AppError::Conflict(format!(
                "Masih ada {prior_unpaid} nota BELUM BAYAR dari tanggal {prior_date}. Selesaikan dulu di tab Kasir sebelum membuka hari baru."
            )));
        }
        finalize_store_day_tx(
            &mut tx,
            &prior_date,
            auth.id,
            &auth.username,
            "Ditutup otomatis saat membuka hari baru",
            &now,
        )
        .await?;
    }

    let all_stocks: Vec<StockItem> =
        sqlx::query_as("SELECT * FROM stock_items ORDER BY id ASC")
            .fetch_all(&mut *tx)
            .await?;

    let active_ids: HashSet<i64> = all_stocks
        .iter()
        .filter(|s| s.is_active == 1)
        .map(|s| s.id)
        .collect();

    if active_ids.is_empty() {
        return Err(AppError::Validation(
            "Belum ada item stok aktif. Tambahkan item stok terlebih dahulu sebelum membuka toko."
                .into(),
        ));
    }

    for &sid in stock_map.keys() {
        if !active_ids.contains(&sid) {
            return Err(AppError::Validation(format!(
                "Item stok #{sid} tidak ditemukan atau tidak aktif"
            )));
        }
    }

    // Every day starts fresh with zero carried-over stock
    for item in &all_stocks {
        let initial_qty = if item.is_active == 1 {
            *stock_map.get(&item.id).unwrap_or(&0)
        } else {
            0
        };

        sqlx::query("UPDATE stock_items SET current_stock = ?, updated_at = ? WHERE id = ?")
            .bind(initial_qty)
            .bind(&now)
            .bind(item.id)
            .execute(&mut *tx)
            .await?;

        if item.is_active == 1 {
            sqlx::query(
                r#"
                INSERT INTO daily_stock_item_snapshots (
                    business_date, stock_item_id, initial_stock, restocked_qty, sold_qty, voided_qty, physical_stock, notes, updated_at
                )
                VALUES (?, ?, ?, 0, 0, 0, NULL, '', ?)
                ON CONFLICT(business_date, stock_item_id) DO UPDATE SET
                    initial_stock = excluded.initial_stock,
                    restocked_qty = 0,
                    sold_qty = 0,
                    voided_qty = 0,
                    physical_stock = NULL,
                    notes = '',
                    updated_at = excluded.updated_at
                "#,
            )
            .bind(&today)
            .bind(item.id)
            .bind(initial_qty)
            .bind(&now)
            .execute(&mut *tx)
            .await?;

            if initial_qty > 0 {
                sqlx::query(
                    r#"
                    INSERT INTO stock_item_movements (
                        business_date, stock_item_id, order_id, movement_type, qty_delta, stock_after, note, created_at
                    )
                    VALUES (?, ?, NULL, 'SET_INITIAL', ?, ?, ?, ?)
                    "#,
                )
                .bind(&today)
                .bind(item.id)
                .bind(initial_qty)
                .bind(initial_qty)
                .bind(format!("Buka toko oleh {}", auth.username))
                .bind(&now)
                .execute(&mut *tx)
                .await?;
            }
        }
    }

    sqlx::query(
        r#"
        INSERT INTO store_days (
            business_date, status, opened_at, opened_by_user_id, opened_by_username
        )
        VALUES (?, 'OPEN', ?, ?, ?)
        "#,
    )
    .bind(&today)
    .bind(&now)
    .bind(auth.id)
    .bind(&auth.username)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    let status = build_store_status(&state.pool, &today, auth.role).await?;
    Ok(Json(status))
}

pub async fn close_store(
    auth: AuthUser,
    State(state): State<AppState>,
    payload: Option<Json<CloseStoreRequest>>,
) -> AppResult<Json<StoreStatusResponse>> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;

    let (today, now) = now_business_and_iso();
    let req = payload.map(|Json(b)| b);

    let closing_notes: String = req
        .as_ref()
        .and_then(|r| r.closing_notes.as_deref())
        .map(str::trim)
        .unwrap_or("")
        .chars()
        .take(500)
        .collect();

    let mut tx = begin_write_tx(&state.pool).await?;

    let day: Option<StoreDayRow> =
        sqlx::query_as("SELECT * FROM store_days WHERE business_date = ?")
            .bind(&today)
            .fetch_optional(&mut *tx)
            .await?;

    let Some(day) = day else {
        return Err(AppError::Conflict(
            "Toko hari ini belum dibuka sehingga tidak dapat ditutup.".into(),
        ));
    };

    if day.status == "CLOSED" {
        return Err(AppError::Conflict(
            "Toko hari ini sudah ditutup sebelumnya.".into(),
        ));
    }

    // Block closing if any UNPAID orders remain
    let (unpaid_count,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM orders WHERE business_date = ? AND status = 'UNPAID'",
    )
    .bind(&today)
    .fetch_one(&mut *tx)
    .await?;

    if unpaid_count > 0 {
        return Err(AppError::Conflict(format!(
            "Tidak dapat menutup toko: masih ada {unpaid_count} nota yang BELUM BAYAR. Lunasi atau batalkan terlebih dahulu."
        )));
    }

    // Save optional physical stock opname submitted during close
    if let Some(entries) = req.as_ref().and_then(|r| r.physical_stocks.as_ref()) {
        for entry in entries {
            if let Some(phys) = entry.physical_stock {
                if phys < 0 || phys > 1_000_000 {
                    return Err(AppError::Validation(
                        "Stok fisik harus antara 0 hingga 1.000.000".into(),
                    ));
                }
            }
            let current: Option<(i64,)> =
                sqlx::query_as("SELECT current_stock FROM stock_items WHERE id = ?")
                    .bind(entry.stock_item_id)
                    .fetch_optional(&mut *tx)
                    .await?;
            let Some((current_stock,)) = current else {
                return Err(AppError::NotFound(format!(
                    "Item stok #{} tidak ditemukan",
                    entry.stock_item_id
                )));
            };
            ensure_daily_stock_snapshot(&mut tx, &today, entry.stock_item_id, current_stock, &now)
                .await?;
            let notes: String = entry
                .notes
                .as_deref()
                .unwrap_or("")
                .trim()
                .chars()
                .take(300)
                .collect();
            sqlx::query(
                r#"
                UPDATE daily_stock_item_snapshots
                SET physical_stock = ?, notes = ?, updated_at = ?
                WHERE business_date = ? AND stock_item_id = ?
                "#,
            )
            .bind(entry.physical_stock)
            .bind(&notes)
            .bind(&now)
            .bind(&today)
            .bind(entry.stock_item_id)
            .execute(&mut *tx)
            .await?;
        }
    }

    // Reset all stock items to 0 upon daily close (no carried-over stock)
    let remaining_stocks: Vec<(i64, i64)> =
        sqlx::query_as("SELECT id, current_stock FROM stock_items WHERE current_stock > 0")
            .fetch_all(&mut *tx)
            .await?;

    for (stock_id, rem) in remaining_stocks {
        sqlx::query("UPDATE stock_items SET current_stock = 0, updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(stock_id)
            .execute(&mut *tx)
            .await?;

        sqlx::query(
            r#"
            INSERT INTO stock_item_movements (
                business_date, stock_item_id, order_id, movement_type, qty_delta, stock_after, note, created_at
            )
            VALUES (?, ?, NULL, 'CLOSE_RESET', ?, 0, ?, ?)
            "#,
        )
        .bind(&today)
        .bind(stock_id)
        .bind(-rem)
        .bind(format!("Reset tutup toko oleh {}", auth.username))
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }

    finalize_store_day_tx(&mut tx, &today, auth.id, &auth.username, &closing_notes, &now).await?;

    tx.commit().await?;

    let status = build_store_status(&state.pool, &today, auth.role).await?;
    Ok(Json(status))
}
