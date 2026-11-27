use std::{
    collections::{HashMap, HashSet},
    fmt::Write as _,
    fs::{self, OpenOptions},
    io::Write as _,
    path::PathBuf,
};

use axum::{extract::State, Json};
use chrono::Local;
use sqlx::{FromRow, Sqlite, Transaction};

use crate::{
    auth::{AuthUser, Role},
    db::{begin_write_tx, ensure_daily_stock_snapshot, now_business_and_iso, today_date},
    error::{AppError, AppResult},
    models::{
        CloseStoreRequest, OpenStoreRequest, ResetStoreDayResponse, StockItem, StoreDayRow,
        StoreStatusResponse,
    },
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

#[derive(FromRow)]
struct BackupOrderRow {
    id: i64,
    order_number: String,
    business_date: String,
    customer_label: String,
    waiter_name: String,
    notes: String,
    status: String,
    subtotal_amount: i64,
    discount_amount: i64,
    total_amount: i64,
    created_at: String,
    paid_at: Option<String>,
    voided_at: Option<String>,
    void_reason: Option<String>,
    channel_id: Option<i64>,
    channel_name_snapshot: String,
    created_by_user_id: Option<i64>,
}

#[derive(FromRow)]
struct BackupAppliedPromotionRow {
    id: i64,
    order_id: i64,
    promo_id: i64,
    promo_name_snapshot: String,
    discount_amount: i64,
    applied_by_username: String,
    status: String,
    created_at: String,
}

#[derive(FromRow)]
struct BackupOrderItemRow {
    id: i64,
    order_id: i64,
    menu_item_id: i64,
    menu_name_snapshot: String,
    unit_price_snapshot: i64,
    quantity: i64,
    subtotal: i64,
    item_note: String,
}

#[derive(FromRow)]
struct BackupOrderStockDeductionRow {
    id: i64,
    order_id: i64,
    stock_item_id: i64,
    stock_name_snapshot: String,
    quantity: i64,
}

#[derive(FromRow)]
struct BackupStockItemSnapshotRow {
    id: i64,
    business_date: String,
    stock_item_id: i64,
    initial_stock: i64,
    restocked_qty: i64,
    sold_qty: i64,
    voided_qty: i64,
    physical_stock: Option<i64>,
    notes: String,
    updated_at: String,
}

#[derive(FromRow)]
struct BackupStockItemMovementRow {
    id: i64,
    business_date: String,
    stock_item_id: i64,
    order_id: Option<i64>,
    movement_type: String,
    qty_delta: i64,
    stock_after: i64,
    note: String,
    created_at: String,
}

#[derive(FromRow)]
struct BackupLegacySnapshotRow {
    id: i64,
    business_date: String,
    menu_item_id: i64,
    initial_stock: i64,
    restocked_qty: i64,
    sold_qty: i64,
    voided_qty: i64,
    physical_stock: Option<i64>,
    notes: String,
    updated_at: String,
}

#[derive(FromRow)]
struct BackupLegacyMovementRow {
    id: i64,
    business_date: String,
    menu_item_id: i64,
    order_id: Option<i64>,
    movement_type: String,
    qty_delta: i64,
    stock_after: i64,
    note: String,
    created_at: String,
}

fn sql_text(val: &str) -> String {
    let cleaned = val.replace('\0', "");
    if !cleaned.contains('\n') && !cleaned.contains('\r') {
        let escaped = cleaned.replace('\'', "''");
        return format!("'{escaped}'");
    }
    // Emit single-line SQLite expression using char(10)/char(13) like `sqlite3 .dump`
    let mut parts: Vec<String> = Vec::new();
    let mut buf = String::new();
    for ch in cleaned.chars() {
        match ch {
            '\n' => {
                if !buf.is_empty() {
                    parts.push(format!("'{}'", buf.replace('\'', "''")));
                    buf.clear();
                }
                parts.push("char(10)".to_string());
            }
            '\r' => {
                if !buf.is_empty() {
                    parts.push(format!("'{}'", buf.replace('\'', "''")));
                    buf.clear();
                }
                parts.push("char(13)".to_string());
            }
            other => buf.push(other),
        }
    }
    if !buf.is_empty() {
        parts.push(format!("'{}'", buf.replace('\'', "''")));
    }
    if parts.is_empty() {
        "''".to_string()
    } else {
        parts.join(" || ")
    }
}

fn sql_opt_text(val: Option<&str>) -> String {
    match val {
        Some(v) => sql_text(v),
        None => "NULL".to_string(),
    }
}

fn sql_opt_i64(val: Option<i64>) -> String {
    match val {
        Some(v) => v.to_string(),
        None => "NULL".to_string(),
    }
}

fn write_force_backup_file(
    backup_dir: PathBuf,
    timestamp: String,
    sql_content: String,
) -> std::io::Result<String> {
    fs::create_dir_all(&backup_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&backup_dir, fs::Permissions::from_mode(0o700));
    }

    let mut last_err = None;
    for attempt in 0..100u32 {
        let filename = if attempt == 0 {
            format!("force-backup-{timestamp}.sql")
        } else {
            format!("force-backup-{timestamp}-{attempt}.sql")
        };
        let path = backup_dir.join(&filename);

        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }

        match opts.open(&path) {
            Ok(mut file) => {
                if let Err(err) = file
                    .write_all(sql_content.as_bytes())
                    .and_then(|_| file.sync_all())
                {
                    let _ = fs::remove_file(&path);
                    return Err(err);
                }
                return Ok(filename);
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                last_err = Some(err);
                continue;
            }
            Err(err) => return Err(err),
        }
    }

    Err(last_err.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "terlalu banyak file backup pada detik yang sama",
        )
    }))
}

/// Admin-only force reset & rollback for today's store operational data.
/// Writes a SQL backup of all affected rows to `force-backup-{timestamp}.sql` BEFORE deleting.
/// Preserves `daily_expenses` (Pengeluaran) and all historical days / catalog / users.
pub async fn reset_store_day(
    auth: AuthUser,
    State(state): State<AppState>,
) -> AppResult<Json<ResetStoreDayResponse>> {
    auth.require_roles(&[Role::Admin])?;

    let now_dt = Local::now();
    let today = now_dt.format("%Y-%m-%d").to_string();
    let timestamp = now_dt.format("%Y%m%d-%H%M%S").to_string();
    let now_iso = now_dt.to_rfc3339();

    let mut tx = begin_write_tx(&state.pool).await?;

    let store_day: Option<StoreDayRow> =
        sqlx::query_as("SELECT * FROM store_days WHERE business_date = ?")
            .bind(&today)
            .fetch_optional(&mut *tx)
            .await?;

    let orders: Vec<BackupOrderRow> = sqlx::query_as(
        r#"
        SELECT id, order_number, business_date, customer_label, waiter_name, notes,
               status, subtotal_amount, discount_amount, total_amount,
               created_at, paid_at, voided_at, void_reason,
               channel_id, channel_name_snapshot, created_by_user_id
        FROM orders
        WHERE business_date = ?
        ORDER BY id ASC
        "#,
    )
    .bind(&today)
    .fetch_all(&mut *tx)
    .await?;

    let applied_promotions: Vec<BackupAppliedPromotionRow> = sqlx::query_as(
        r#"
        SELECT ap.id, ap.order_id, ap.promo_id, ap.promo_name_snapshot, ap.discount_amount,
               ap.applied_by_username, ap.status, ap.created_at
        FROM applied_promotions ap
        INNER JOIN orders o ON o.id = ap.order_id
        WHERE o.business_date = ?
        ORDER BY ap.id ASC
        "#,
    )
    .bind(&today)
    .fetch_all(&mut *tx)
    .await?;

    let order_items: Vec<BackupOrderItemRow> = sqlx::query_as(
        r#"
        SELECT oi.id, oi.order_id, oi.menu_item_id, oi.menu_name_snapshot,
               oi.unit_price_snapshot, oi.quantity, oi.subtotal, oi.item_note
        FROM order_items oi
        INNER JOIN orders o ON o.id = oi.order_id
        WHERE o.business_date = ?
        ORDER BY oi.id ASC
        "#,
    )
    .bind(&today)
    .fetch_all(&mut *tx)
    .await?;

    let order_deductions: Vec<BackupOrderStockDeductionRow> = sqlx::query_as(
        r#"
        SELECT osd.id, osd.order_id, osd.stock_item_id, osd.stock_name_snapshot, osd.quantity
        FROM order_stock_deductions osd
        INNER JOIN orders o ON o.id = osd.order_id
        WHERE o.business_date = ?
        ORDER BY osd.id ASC
        "#,
    )
    .bind(&today)
    .fetch_all(&mut *tx)
    .await?;

    let item_snapshots: Vec<BackupStockItemSnapshotRow> = sqlx::query_as(
        r#"
        SELECT id, business_date, stock_item_id, initial_stock, restocked_qty,
               sold_qty, voided_qty, physical_stock, notes, updated_at
        FROM daily_stock_item_snapshots
        WHERE business_date = ?
        ORDER BY id ASC
        "#,
    )
    .bind(&today)
    .fetch_all(&mut *tx)
    .await?;

    let item_movements: Vec<BackupStockItemMovementRow> = sqlx::query_as(
        r#"
        SELECT id, business_date, stock_item_id, order_id, movement_type,
               qty_delta, stock_after, note, created_at
        FROM stock_item_movements
        WHERE business_date = ? OR order_id IN (SELECT id FROM orders WHERE business_date = ?)
        ORDER BY id ASC
        "#,
    )
    .bind(&today)
    .bind(&today)
    .fetch_all(&mut *tx)
    .await?;

    let legacy_snapshots: Vec<BackupLegacySnapshotRow> = sqlx::query_as(
        r#"
        SELECT id, business_date, menu_item_id, initial_stock, restocked_qty,
               sold_qty, voided_qty, physical_stock, notes, updated_at
        FROM daily_stock_snapshots
        WHERE business_date = ?
        ORDER BY id ASC
        "#,
    )
    .bind(&today)
    .fetch_all(&mut *tx)
    .await?;

    let legacy_movements: Vec<BackupLegacyMovementRow> = sqlx::query_as(
        r#"
        SELECT id, business_date, menu_item_id, order_id, movement_type,
               qty_delta, stock_after, note, created_at
        FROM stock_movements
        WHERE business_date = ? OR order_id IN (SELECT id FROM orders WHERE business_date = ?)
        ORDER BY id ASC
        "#,
    )
    .bind(&today)
    .bind(&today)
    .fetch_all(&mut *tx)
    .await?;

    let nonzero_stocks: Vec<(i64, i64, String)> = sqlx::query_as(
        "SELECT id, current_stock, updated_at FROM stock_items WHERE current_stock != 0 ORDER BY id ASC",
    )
    .fetch_all(&mut *tx)
    .await?;

    if store_day.is_none()
        && orders.is_empty()
        && item_snapshots.is_empty()
        && item_movements.is_empty()
        && legacy_snapshots.is_empty()
        && legacy_movements.is_empty()
    {
        return Err(AppError::Conflict(
            "Belum ada data operasional hari ini untuk direset.".into(),
        ));
    }

    // Build SQL backup script containing all rolled-back rows in FK-safe parent-before-child order
    let safe_actor: String = auth
        .username
        .chars()
        .filter(|c| *c != '\r' && *c != '\n')
        .collect();
    let mut sql = String::with_capacity(4096);
    let _ = writeln!(sql, "-- NotaDigital Force Backup (Daily Operational Rollback)");
    let _ = writeln!(sql, "-- Business Date: {today}");
    let _ = writeln!(sql, "-- Triggered By: {safe_actor}");
    let _ = writeln!(sql, "-- Created At: {now_iso}");
    let _ = writeln!(
        sql,
        "-- Note: daily_expenses (Pengeluaran) are preserved and not included."
    );
    let _ = writeln!(
        sql,
        "-- Restore only onto a reset/empty day with: sqlite3 -bail <db> < <this-file>"
    );
    let _ = writeln!(sql, "PRAGMA foreign_keys = ON;");
    let _ = writeln!(sql, "BEGIN TRANSACTION;");

    if let Some(ref day) = store_day {
        let _ = writeln!(
            sql,
            "INSERT INTO store_days (business_date, status, opened_at, opened_by_user_id, opened_by_username, closed_at, closed_by_user_id, closed_by_username, total_orders, paid_orders, voided_orders, gross_revenue, total_expenses, net_profit, total_portions_sold, closing_notes) VALUES ({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {});",
            sql_text(&day.business_date),
            sql_text(&day.status),
            sql_text(&day.opened_at),
            sql_opt_i64(day.opened_by_user_id),
            sql_text(&day.opened_by_username),
            sql_opt_text(day.closed_at.as_deref()),
            sql_opt_i64(day.closed_by_user_id),
            sql_opt_text(day.closed_by_username.as_deref()),
            day.total_orders,
            day.paid_orders,
            day.voided_orders,
            day.gross_revenue,
            day.total_expenses,
            day.net_profit,
            day.total_portions_sold,
            sql_text(&day.closing_notes),
        );
    }

    for o in &orders {
        let _ = writeln!(
            sql,
            "INSERT INTO orders (id, order_number, business_date, customer_label, waiter_name, notes, status, subtotal_amount, discount_amount, total_amount, created_at, paid_at, voided_at, void_reason, channel_id, channel_name_snapshot, created_by_user_id) VALUES ({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {});",
            o.id,
            sql_text(&o.order_number),
            sql_text(&o.business_date),
            sql_text(&o.customer_label),
            sql_text(&o.waiter_name),
            sql_text(&o.notes),
            sql_text(&o.status),
            o.subtotal_amount,
            o.discount_amount,
            o.total_amount,
            sql_text(&o.created_at),
            sql_opt_text(o.paid_at.as_deref()),
            sql_opt_text(o.voided_at.as_deref()),
            sql_opt_text(o.void_reason.as_deref()),
            sql_opt_i64(o.channel_id),
            sql_text(&o.channel_name_snapshot),
            sql_opt_i64(o.created_by_user_id),
        );
    }

    for ap in &applied_promotions {
        let _ = writeln!(
            sql,
            "INSERT INTO applied_promotions (id, order_id, promo_id, promo_name_snapshot, discount_amount, applied_by_username, status, created_at) VALUES ({}, {}, {}, {}, {}, {}, {}, {});",
            ap.id,
            ap.order_id,
            ap.promo_id,
            sql_text(&ap.promo_name_snapshot),
            ap.discount_amount,
            sql_text(&ap.applied_by_username),
            sql_text(&ap.status),
            sql_text(&ap.created_at),
        );
        if ap.status == "APPLIED" {
            let _ = writeln!(
                sql,
                "UPDATE promotions SET used_count = MIN(quota_limit, used_count + 1) WHERE id = {};",
                ap.promo_id
            );
        }
    }

    for oi in &order_items {
        let _ = writeln!(
            sql,
            "INSERT INTO order_items (id, order_id, menu_item_id, menu_name_snapshot, unit_price_snapshot, quantity, subtotal, item_note) VALUES ({}, {}, {}, {}, {}, {}, {}, {});",
            oi.id,
            oi.order_id,
            oi.menu_item_id,
            sql_text(&oi.menu_name_snapshot),
            oi.unit_price_snapshot,
            oi.quantity,
            oi.subtotal,
            sql_text(&oi.item_note),
        );
    }

    for d in &order_deductions {
        let _ = writeln!(
            sql,
            "INSERT INTO order_stock_deductions (id, order_id, stock_item_id, stock_name_snapshot, quantity) VALUES ({}, {}, {}, {}, {});",
            d.id,
            d.order_id,
            d.stock_item_id,
            sql_text(&d.stock_name_snapshot),
            d.quantity,
        );
    }

    for s in &item_snapshots {
        let _ = writeln!(
            sql,
            "INSERT INTO daily_stock_item_snapshots (id, business_date, stock_item_id, initial_stock, restocked_qty, sold_qty, voided_qty, physical_stock, notes, updated_at) VALUES ({}, {}, {}, {}, {}, {}, {}, {}, {}, {});",
            s.id,
            sql_text(&s.business_date),
            s.stock_item_id,
            s.initial_stock,
            s.restocked_qty,
            s.sold_qty,
            s.voided_qty,
            sql_opt_i64(s.physical_stock),
            sql_text(&s.notes),
            sql_text(&s.updated_at),
        );
    }

    for m in &item_movements {
        let _ = writeln!(
            sql,
            "INSERT INTO stock_item_movements (id, business_date, stock_item_id, order_id, movement_type, qty_delta, stock_after, note, created_at) VALUES ({}, {}, {}, {}, {}, {}, {}, {}, {});",
            m.id,
            sql_text(&m.business_date),
            m.stock_item_id,
            sql_opt_i64(m.order_id),
            sql_text(&m.movement_type),
            m.qty_delta,
            m.stock_after,
            sql_text(&m.note),
            sql_text(&m.created_at),
        );
    }

    for s in &legacy_snapshots {
        let _ = writeln!(
            sql,
            "INSERT INTO daily_stock_snapshots (id, business_date, menu_item_id, initial_stock, restocked_qty, sold_qty, voided_qty, physical_stock, notes, updated_at) VALUES ({}, {}, {}, {}, {}, {}, {}, {}, {}, {});",
            s.id,
            sql_text(&s.business_date),
            s.menu_item_id,
            s.initial_stock,
            s.restocked_qty,
            s.sold_qty,
            s.voided_qty,
            sql_opt_i64(s.physical_stock),
            sql_text(&s.notes),
            sql_text(&s.updated_at),
        );
    }

    for m in &legacy_movements {
        let _ = writeln!(
            sql,
            "INSERT INTO stock_movements (id, business_date, menu_item_id, order_id, movement_type, qty_delta, stock_after, note, created_at) VALUES ({}, {}, {}, {}, {}, {}, {}, {}, {});",
            m.id,
            sql_text(&m.business_date),
            m.menu_item_id,
            sql_opt_i64(m.order_id),
            sql_text(&m.movement_type),
            m.qty_delta,
            m.stock_after,
            sql_text(&m.note),
            sql_text(&m.created_at),
        );
    }

    for (stock_id, current_stock, updated_at) in &nonzero_stocks {
        let _ = writeln!(
            sql,
            "UPDATE stock_items SET current_stock = {}, updated_at = {} WHERE id = {};",
            current_stock,
            sql_text(updated_at),
            stock_id,
        );
    }

    let _ = writeln!(sql, "COMMIT;");

    // Persist backup to disk BEFORE deleting any rows; abort rollback on any I/O error
    let backup_dir = state.backup_dir.clone();
    let backup_filename =
        tokio::task::spawn_blocking(move || write_force_backup_file(backup_dir, timestamp, sql))
            .await
            .map_err(|err| {
                tracing::error!(error = %err, "backup task join error during reset_store_day");
                AppError::Internal("Gagal menulis file backup sebelum reset data.".into())
            })?
            .map_err(|err| {
                tracing::error!(error = %err, "failed to write force backup file");
                AppError::Internal("Gagal membuat file backup di server. Reset dibatalkan.".into())
            })?;

    // Delete today's operational rows (child-before-parent for FK integrity); daily_expenses preserved
    sqlx::query(
        "DELETE FROM stock_item_movements WHERE business_date = ? OR order_id IN (SELECT id FROM orders WHERE business_date = ?)",
    )
    .bind(&today)
    .bind(&today)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM daily_stock_item_snapshots WHERE business_date = ?")
        .bind(&today)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "DELETE FROM stock_movements WHERE business_date = ? OR order_id IN (SELECT id FROM orders WHERE business_date = ?)",
    )
    .bind(&today)
    .bind(&today)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM daily_stock_snapshots WHERE business_date = ?")
        .bind(&today)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "DELETE FROM order_stock_deductions WHERE order_id IN (SELECT id FROM orders WHERE business_date = ?)",
    )
    .bind(&today)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE business_date = ?)",
    )
    .bind(&today)
    .execute(&mut *tx)
    .await?;
    // Release promotion quota counts for today's APPLIED promotions before deleting orders
    for ap in &applied_promotions {
        if ap.status == "APPLIED" {
            sqlx::query(
                "UPDATE promotions SET used_count = MAX(0, used_count - 1), updated_at = ? WHERE id = ?",
            )
            .bind(&now_iso)
            .bind(ap.promo_id)
            .execute(&mut *tx)
            .await?;
        }
    }
    sqlx::query(
        "DELETE FROM applied_promotions WHERE order_id IN (SELECT id FROM orders WHERE business_date = ?)",
    )
    .bind(&today)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM orders WHERE business_date = ?")
        .bind(&today)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM store_days WHERE business_date = ?")
        .bind(&today)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE stock_items SET current_stock = 0, updated_at = ? WHERE current_stock != 0")
        .bind(&now_iso)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    let deleted_orders = orders.len() as i64;
    let deleted_snapshots = (item_snapshots.len() + legacy_snapshots.len()) as i64;
    let deleted_movements = (item_movements.len() + legacy_movements.len()) as i64;

    tracing::warn!(
        actor = %auth.username,
        business_date = %today,
        backup_filename = %backup_filename,
        deleted_orders,
        deleted_snapshots,
        deleted_movements,
        "admin force reset store day completed"
    );

    let store_status = build_store_status(&state.pool, &today, auth.role).await?;
    Ok(Json(ResetStoreDayResponse {
        backup_filename,
        deleted_orders,
        deleted_snapshots,
        deleted_movements,
        store_status,
    }))
}
