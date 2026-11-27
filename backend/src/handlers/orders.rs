use std::collections::HashMap;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use sqlx::FromRow;

use crate::{
    auth::{AuthUser, Role},
    db::{
        begin_write_tx, ensure_daily_stock_snapshot, get_store_day_status_tx, now_business_and_iso,
        parse_business_date,
    },
    error::{AppError, AppResult},
    models::{
        ApplyOrderPromoRequest, CreateOrderRequest, MenuItemRow, OrderDetail, OrderItemDetail,
        OrderRow, PromotionRow, SalesChannel, StockItem, VoidOrderRequest,
    },
    AppState,
};

const MAX_ORDER_ITEMS: usize = 200;
const MAX_ITEM_QTY: i64 = 10_000;

#[derive(Debug, Deserialize)]
pub struct OrderQuery {
    pub date: Option<String>,
    pub status: Option<String>,
    pub channel_id: Option<i64>,
}

#[derive(Debug, FromRow)]
struct StockReqRow {
    stock_item_id: i64,
    qty_per_unit: i64,
}

#[derive(Debug, FromRow)]
struct OrderStockDeductionRow {
    stock_item_id: i64,
    quantity: i64,
}

pub async fn create_order(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(req): Json<CreateOrderRequest>,
) -> AppResult<(StatusCode, Json<OrderDetail>)> {
    auth.require_roles(&[Role::Waiter, Role::Cashier, Role::Owner, Role::Admin])?;
    if req.items.is_empty() {
        return Err(AppError::Validation(
            "Nota harus memiliki minimal 1 item makanan/minuman".into(),
        ));
    }
    if req.items.len() > MAX_ORDER_ITEMS {
        return Err(AppError::Validation(format!(
            "Jumlah baris item dalam satu nota maksimal {MAX_ORDER_ITEMS}"
        )));
    }

    let mut requested_menu_totals: HashMap<i64, i64> = HashMap::new();
    for item in &req.items {
        if item.quantity <= 0 || item.quantity > MAX_ITEM_QTY {
            return Err(AppError::Validation(format!(
                "Jumlah pesanan setiap item harus antara 1 hingga {MAX_ITEM_QTY}"
            )));
        }
        let entry = requested_menu_totals.entry(item.menu_item_id).or_insert(0);
        *entry = entry
            .checked_add(item.quantity)
            .ok_or_else(|| AppError::Validation("Total jumlah pesanan melebihi batas".into()))?;
    }

    let (today, now) = now_business_and_iso();
    let customer_label: String = req
        .customer_label
        .unwrap_or_default()
        .trim()
        .chars()
        .take(120)
        .collect();
    // Waiter identity is strictly locked to the authenticated user's username
    let waiter_name = auth.username.clone();
    let notes: String = req
        .notes
        .unwrap_or_default()
        .trim()
        .chars()
        .take(500)
        .collect();

    let mut tx = begin_write_tx(&state.pool).await?;

    // Store must be OPEN for today before any orders can be created
    let store_status = get_store_day_status_tx(&mut tx, &today).await?;
    if store_status == "NOT_OPENED" {
        return Err(AppError::Conflict(
            "Toko belum dibuka hari ini. Pemilik/Admin harus mengisi stok awal dan membuka toko terlebih dahulu."
                .into(),
        ));
    }
    if store_status == "CLOSED" {
        return Err(AppError::Conflict(
            "Toko hari ini sudah ditutup. Tidak dapat membuat nota baru.".into(),
        ));
    }

    // Resolve single sales channel (defaults to 'regular')
    let channel: Option<SalesChannel> = match req.channel_id {
        Some(cid) => {
            sqlx::query_as("SELECT * FROM sales_channels WHERE id = ?")
                .bind(cid)
                .fetch_optional(&mut *tx)
                .await?
        }
        None => {
            sqlx::query_as("SELECT * FROM sales_channels WHERE code = 'regular' LIMIT 1")
                .fetch_optional(&mut *tx)
                .await?
        }
    };
    let channel = channel.ok_or_else(|| {
        AppError::Validation("Channel penjualan tidak ditemukan".into())
    })?;
    if channel.is_active == 0 {
        return Err(AppError::Validation(format!(
            "Channel '{}' sedang tidak aktif",
            channel.name
        )));
    }

    // Fetch menus and aggregate total required quantity per stock_item_id using checked arithmetic
    let mut menu_map: HashMap<i64, MenuItemRow> = HashMap::new();
    let mut required_stock_totals: HashMap<i64, i64> = HashMap::new();

    for (&menu_id, &total_qty) in &requested_menu_totals {
        let menu: Option<MenuItemRow> = sqlx::query_as(
            "SELECT id, name, category, price, is_active, created_at, updated_at FROM menu_items WHERE id = ?",
        )
        .bind(menu_id)
        .fetch_optional(&mut *tx)
        .await?;

        let menu = menu.ok_or_else(|| {
            AppError::NotFound(format!("Menu dengan ID #{menu_id} tidak ditemukan"))
        })?;

        if menu.is_active == 0 {
            return Err(AppError::Validation(format!(
                "Menu '{}' sedang tidak aktif",
                menu.name
            )));
        }

        let reqs: Vec<StockReqRow> = sqlx::query_as(
            "SELECT stock_item_id, qty_per_unit FROM menu_stock_requirements WHERE menu_item_id = ?",
        )
        .bind(menu_id)
        .fetch_all(&mut *tx)
        .await?;

        if reqs.is_empty() {
            return Err(AppError::Validation(format!(
                "Menu '{}' belum terhubung ke item stok manapun",
                menu.name
            )));
        }

        for r in reqs {
            let needed = r
                .qty_per_unit
                .checked_mul(total_qty)
                .ok_or_else(|| AppError::Validation("Jumlah stok terlalu besar".into()))?;
            let stock_total = required_stock_totals.entry(r.stock_item_id).or_insert(0);
            *stock_total = stock_total
                .checked_add(needed)
                .ok_or_else(|| AppError::Validation("Total kebutuhan stok terlalu besar".into()))?;
        }

        menu_map.insert(menu_id, menu);
    }

    // Validate all linked stock items exist, are active, and have sufficient stock
    let mut stock_map: HashMap<i64, StockItem> = HashMap::new();
    for (&stock_id, &needed_qty) in &required_stock_totals {
        let stock: Option<StockItem> = sqlx::query_as("SELECT * FROM stock_items WHERE id = ?")
            .bind(stock_id)
            .fetch_optional(&mut *tx)
            .await?;

        let stock = stock.ok_or_else(|| {
            AppError::NotFound(format!("Item stok #{stock_id} tidak ditemukan"))
        })?;

        if stock.is_active == 0 {
            return Err(AppError::Validation(format!(
                "Item stok '{}' sedang tidak aktif",
                stock.name
            )));
        }

        if stock.current_stock < needed_qty {
            return Err(AppError::InsufficientStock {
                menu_name: stock.name,
                available: stock.current_stock,
                requested: needed_qty,
            });
        }

        stock_map.insert(stock_id, stock);
    }

    // Calculate total amount safely
    let mut total_amount: i64 = 0;
    for item in &req.items {
        let menu = &menu_map[&item.menu_item_id];
        let line_total = menu
            .price
            .checked_mul(item.quantity)
            .ok_or_else(|| AppError::Validation("Total harga melebihi batas".into()))?;
        total_amount = total_amount
            .checked_add(line_total)
            .ok_or_else(|| AppError::Validation("Total nota melebihi batas".into()))?;
    }

    // Generate sequential daily order number: NOTA-YYYYMMDD-001
    let existing_count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM orders WHERE business_date = ?")
            .bind(&today)
            .fetch_one(&mut *tx)
            .await?;
    let date_compact = today.replace('-', "");
    let order_number = format!("NOTA-{}-{:03}", date_compact, existing_count.0 + 1);

    let is_auto_paid = channel.is_auto_paid != 0;
    let initial_status = if is_auto_paid { "PAID" } else { "UNPAID" };
    let paid_at: Option<&str> = if is_auto_paid { Some(&now) } else { None };

    let order_res = sqlx::query(
        r#"
        INSERT INTO orders (
            order_number, business_date, channel_id, channel_name_snapshot,
            customer_label, waiter_name, created_by_user_id, notes, status,
            subtotal_amount, discount_amount, total_amount, created_at, paid_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
        "#,
    )
    .bind(&order_number)
    .bind(&today)
    .bind(channel.id)
    .bind(&channel.name)
    .bind(&customer_label)
    .bind(&waiter_name)
    .bind(auth.id)
    .bind(&notes)
    .bind(initial_status)
    .bind(total_amount)
    .bind(total_amount)
    .bind(&now)
    .bind(paid_at)
    .execute(&mut *tx)
    .await?;

    let order_id = order_res.last_insert_rowid();

    for item in &req.items {
        let menu = &menu_map[&item.menu_item_id];
        let subtotal = menu.price * item.quantity;
        let item_note: String = item
            .item_note
            .as_deref()
            .unwrap_or("")
            .trim()
            .chars()
            .take(200)
            .collect();

        sqlx::query(
            r#"
            INSERT INTO order_items (
                order_id, menu_item_id, menu_name_snapshot, unit_price_snapshot, quantity, subtotal, item_note
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(order_id)
        .bind(menu.id)
        .bind(&menu.name)
        .bind(menu.price)
        .bind(item.quantity)
        .bind(subtotal)
        .bind(&item_note)
        .execute(&mut *tx)
        .await?;
    }

    for (&stock_id, &needed_qty) in &required_stock_totals {
        let stock = &stock_map[&stock_id];
        ensure_daily_stock_snapshot(&mut tx, &today, stock_id, stock.current_stock, &now).await?;

        let stock_after = stock
            .current_stock
            .checked_sub(needed_qty)
            .ok_or_else(|| AppError::InsufficientStock {
                menu_name: stock.name.clone(),
                available: stock.current_stock,
                requested: needed_qty,
            })?;
        let updated = sqlx::query(
            r#"
            UPDATE stock_items
            SET current_stock = current_stock - ?, updated_at = ?
            WHERE id = ? AND is_active = 1 AND current_stock >= ?
            "#,
        )
        .bind(needed_qty)
        .bind(&now)
        .bind(stock_id)
        .bind(needed_qty)
        .execute(&mut *tx)
        .await?;

        if updated.rows_affected() != 1 {
            return Err(AppError::InsufficientStock {
                menu_name: stock.name.clone(),
                available: stock.current_stock,
                requested: needed_qty,
            });
        }

        sqlx::query(
            r#"
            INSERT INTO order_stock_deductions (order_id, stock_item_id, stock_name_snapshot, quantity)
            VALUES (?, ?, ?, ?)
            "#,
        )
        .bind(order_id)
        .bind(stock_id)
        .bind(&stock.name)
        .bind(needed_qty)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            UPDATE daily_stock_item_snapshots
            SET sold_qty = sold_qty + ?, updated_at = ?
            WHERE business_date = ? AND stock_item_id = ?
            "#,
        )
        .bind(needed_qty)
        .bind(&now)
        .bind(&today)
        .bind(stock_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO stock_item_movements (
                business_date, stock_item_id, order_id, movement_type, qty_delta, stock_after, note, created_at
            )
            VALUES (?, ?, ?, 'ORDER_DEDUCT', ?, ?, ?, ?)
            "#,
        )
        .bind(&today)
        .bind(stock_id)
        .bind(order_id)
        .bind(-needed_qty)
        .bind(stock_after)
        .bind(format!("Pesanan {order_number} ({})", channel.name))
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }

    let order_row: OrderRow = sqlx::query_as("SELECT * FROM orders WHERE id = ?")
        .bind(order_id)
        .fetch_one(&mut *tx)
        .await?;
    let order_items: Vec<OrderItemDetail> =
        sqlx::query_as("SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC")
            .bind(order_id)
            .fetch_all(&mut *tx)
            .await?;

    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(OrderDetail::from_parts(order_row, order_items)),
    ))
}

pub async fn list_orders(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(query): Query<OrderQuery>,
) -> AppResult<Json<Vec<OrderDetail>>> {
    auth.require_roles(&[Role::Cashier, Role::Owner, Role::Admin])?;
    let business_date = parse_business_date(query.date.as_deref())?;

    let status_filter = query
        .status
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("ALL"))
        .map(|s| s.to_uppercase());

    let (orders, all_items): (Vec<OrderRow>, Vec<OrderItemDetail>) =
        match (status_filter, query.channel_id) {
            (Some(status), Some(cid)) => {
                let o = sqlx::query_as(
                    "SELECT * FROM orders WHERE business_date = ? AND status = ? AND channel_id = ? ORDER BY id DESC",
                )
                .bind(&business_date)
                .bind(&status)
                .bind(cid)
                .fetch_all(&state.pool)
                .await?;
                let i = sqlx::query_as(
                    r#"
                    SELECT oi.*
                    FROM order_items oi
                    INNER JOIN orders o ON o.id = oi.order_id
                    WHERE o.business_date = ? AND o.status = ? AND o.channel_id = ?
                    ORDER BY oi.id ASC
                    "#,
                )
                .bind(&business_date)
                .bind(&status)
                .bind(cid)
                .fetch_all(&state.pool)
                .await?;
                (o, i)
            }
            (Some(status), None) => {
                let o = sqlx::query_as(
                    "SELECT * FROM orders WHERE business_date = ? AND status = ? ORDER BY id DESC",
                )
                .bind(&business_date)
                .bind(&status)
                .fetch_all(&state.pool)
                .await?;
                let i = sqlx::query_as(
                    r#"
                    SELECT oi.*
                    FROM order_items oi
                    INNER JOIN orders o ON o.id = oi.order_id
                    WHERE o.business_date = ? AND o.status = ?
                    ORDER BY oi.id ASC
                    "#,
                )
                .bind(&business_date)
                .bind(&status)
                .fetch_all(&state.pool)
                .await?;
                (o, i)
            }
            (None, Some(cid)) => {
                let o = sqlx::query_as(
                    "SELECT * FROM orders WHERE business_date = ? AND channel_id = ? ORDER BY id DESC",
                )
                .bind(&business_date)
                .bind(cid)
                .fetch_all(&state.pool)
                .await?;
                let i = sqlx::query_as(
                    r#"
                    SELECT oi.*
                    FROM order_items oi
                    INNER JOIN orders o ON o.id = oi.order_id
                    WHERE o.business_date = ? AND o.channel_id = ?
                    ORDER BY oi.id ASC
                    "#,
                )
                .bind(&business_date)
                .bind(cid)
                .fetch_all(&state.pool)
                .await?;
                (o, i)
            }
            (None, None) => {
                let o = sqlx::query_as(
                    "SELECT * FROM orders WHERE business_date = ? ORDER BY id DESC",
                )
                .bind(&business_date)
                .fetch_all(&state.pool)
                .await?;
                let i = sqlx::query_as(
                    r#"
                    SELECT oi.*
                    FROM order_items oi
                    INNER JOIN orders o ON o.id = oi.order_id
                    WHERE o.business_date = ?
                    ORDER BY oi.id ASC
                    "#,
                )
                .bind(&business_date)
                .fetch_all(&state.pool)
                .await?;
                (o, i)
            }
        };

    if orders.is_empty() {
        return Ok(Json(Vec::new()));
    }

    let mut items_by_order: HashMap<i64, Vec<OrderItemDetail>> = HashMap::new();
    for item in all_items {
        items_by_order.entry(item.order_id).or_default().push(item);
    }

    let details = orders
        .into_iter()
        .map(|o| {
            let items = items_by_order.remove(&o.id).unwrap_or_default();
            OrderDetail::from_parts(o, items)
        })
        .collect();

    Ok(Json(details))
}

pub async fn get_order(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<OrderDetail>> {
    auth.require_roles(&[Role::Cashier, Role::Owner, Role::Admin])?;
    let order: Option<OrderRow> = sqlx::query_as("SELECT * FROM orders WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?;

    let order = order.ok_or_else(|| AppError::NotFound(format!("Nota #{id} tidak ditemukan")))?;
    let items: Vec<OrderItemDetail> =
        sqlx::query_as("SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC")
            .bind(id)
            .fetch_all(&state.pool)
            .await?;

    Ok(Json(OrderDetail::from_parts(order, items)))
}

pub async fn pay_order(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<OrderDetail>> {
    auth.require_roles(&[Role::Cashier, Role::Owner, Role::Admin])?;
    let (_today, now) = now_business_and_iso();
    let mut tx = begin_write_tx(&state.pool).await?;

    let order: Option<OrderRow> = sqlx::query_as("SELECT * FROM orders WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

    let order = order.ok_or_else(|| AppError::NotFound(format!("Nota #{id} tidak ditemukan")))?;

    let day_status = get_store_day_status_tx(&mut tx, &order.business_date).await?;
    if day_status == "CLOSED" {
        return Err(AppError::Conflict(
            "Toko untuk tanggal nota ini sudah ditutup.".into(),
        ));
    }

    match order.status.as_str() {
        "UNPAID" => {}
        "PAID" => return Err(AppError::Conflict("Nota ini sudah dibayar (LUNAS)".into())),
        "VOIDED" => {
            return Err(AppError::Conflict(
                "Nota yang sudah dibatalkan tidak dapat dibayar".into(),
            ))
        }
        _ => return Err(AppError::Conflict("Status nota tidak valid".into())),
    }

    sqlx::query("UPDATE orders SET status = 'PAID', paid_at = ? WHERE id = ?")
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;

    let updated: OrderRow = sqlx::query_as("SELECT * FROM orders WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let items: Vec<OrderItemDetail> =
        sqlx::query_as("SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC")
            .bind(id)
            .fetch_all(&mut *tx)
            .await?;

    tx.commit().await?;
    Ok(Json(OrderDetail::from_parts(updated, items)))
}

pub async fn apply_order_promo(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<ApplyOrderPromoRequest>,
) -> AppResult<Json<OrderDetail>> {
    auth.require_roles(&[Role::Cashier, Role::Owner, Role::Admin])?;
    let mut tx = begin_write_tx(&state.pool).await?;

    let order: OrderRow = sqlx::query_as("SELECT * FROM orders WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Nota #{id} tidak ditemukan")))?;

    let day_status = get_store_day_status_tx(&mut tx, &order.business_date).await?;
    if day_status == "CLOSED" {
        return Err(AppError::Conflict(
            "Toko untuk tanggal nota ini sudah ditutup.".into(),
        ));
    }
    if order.status != "UNPAID" {
        return Err(AppError::Conflict(
            "Promo hanya dapat diterapkan pada nota yang BELUM BAYAR.".into(),
        ));
    }

    let promo: PromotionRow = sqlx::query_as("SELECT * FROM promotions WHERE id = ?")
        .bind(req.promo_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Promo #{} tidak ditemukan", req.promo_id)))?;

    if promo.is_active == 0 {
        return Err(AppError::Conflict("Promo ini sudah tidak aktif.".into()));
    }

    if let Some(ref start) = promo.start_date {
        if order.business_date.as_str() < start.as_str() {
            return Err(AppError::Conflict(format!(
                "Promo ini baru berlaku mulai tanggal {start}."
            )));
        }
    }
    if let Some(ref end) = promo.end_date {
        if order.business_date.as_str() > end.as_str() {
            return Err(AppError::Conflict(format!(
                "Promo ini sudah berakhir pada tanggal {end}."
            )));
        }
    }

    if promo.regular_only != 0 {
        let is_regular = if let Some(cid) = order.channel_id {
            let code: Option<(String,)> =
                sqlx::query_as("SELECT code FROM sales_channels WHERE id = ?")
                    .bind(cid)
                    .fetch_optional(&mut *tx)
                    .await?;
            code.map(|(c,)| c.eq_ignore_ascii_case("regular"))
                .unwrap_or(false)
        } else {
            order.channel_name_snapshot.eq_ignore_ascii_case("regular")
        };
        if !is_regular {
            return Err(AppError::Conflict(
                "Promo ini hanya berlaku untuk saluran Regular (makan di tempat / bungkus)."
                    .into(),
            ));
        }
    }

    if order.subtotal_amount < promo.min_order_amount {
        return Err(AppError::Validation(format!(
            "Minimal belanja untuk promo ini adalah Rp{}.",
            promo.min_order_amount
        )));
    }

    // Atomic quota enforcement (excluding VOIDED orders and excluding current order if re-applying)
    match (promo.quota_type.as_str(), promo.quota_limit) {
        ("TOTAL", Some(limit)) => {
            let (used,): (i64,) = sqlx::query_as(
                "SELECT COUNT(*) FROM orders WHERE promo_id = ? AND status != 'VOIDED' AND id != ?",
            )
            .bind(promo.id)
            .bind(order.id)
            .fetch_one(&mut *tx)
            .await?;
            if used >= limit {
                return Err(AppError::Conflict(format!(
                    "Kuota promo \"{}\" sudah habis ({used}/{limit}).",
                    promo.name
                )));
            }
        }
        ("DAILY", Some(limit)) => {
            let (used,): (i64,) = sqlx::query_as(
                "SELECT COUNT(*) FROM orders WHERE promo_id = ? AND business_date = ? AND status != 'VOIDED' AND id != ?",
            )
            .bind(promo.id)
            .bind(&order.business_date)
            .bind(order.id)
            .fetch_one(&mut *tx)
            .await?;
            if used >= limit {
                return Err(AppError::Conflict(format!(
                    "Kuota harian promo \"{}\" sudah habis ({used}/{limit}).",
                    promo.name
                )));
            }
        }
        ("TOTAL" | "DAILY", None) => {
            return Err(AppError::Conflict(
                "Konfigurasi kuota promo tidak valid.".into(),
            ));
        }
        _ => {}
    }

    let raw_discount = if promo.discount_type == "PERCENT" {
        let pct_disc = ((order.subtotal_amount as i128) * (promo.discount_value as i128) / 100)
            as i64;
        match promo.max_discount {
            Some(cap) => pct_disc.min(cap),
            None => pct_disc,
        }
    } else {
        promo.discount_value
    };
    let discount_amount = raw_discount.clamp(0, order.subtotal_amount.max(0));
    let new_total = order.subtotal_amount - discount_amount;

    sqlx::query(
        r#"
        UPDATE orders
        SET discount_amount = ?,
            total_amount = ?,
            promo_id = ?,
            promo_name_snapshot = ?,
            promo_applied_by_username = ?,
            promo_receipt_text_snapshot = ?,
            promo_receipt_media_type = ?,
            promo_receipt_media_value = ?
        WHERE id = ?
        "#,
    )
    .bind(discount_amount)
    .bind(new_total)
    .bind(promo.id)
    .bind(&promo.name)
    .bind(&auth.username)
    .bind(&promo.receipt_promo_text)
    .bind(&promo.receipt_media_type)
    .bind(&promo.receipt_media_value)
    .bind(order.id)
    .execute(&mut *tx)
    .await?;

    let updated: OrderRow = sqlx::query_as("SELECT * FROM orders WHERE id = ?")
        .bind(order.id)
        .fetch_one(&mut *tx)
        .await?;
    let items: Vec<OrderItemDetail> =
        sqlx::query_as("SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC")
            .bind(order.id)
            .fetch_all(&mut *tx)
            .await?;

    tx.commit().await?;
    tracing::info!(
        actor = %auth.username,
        order_id = order.id,
        promo_id = promo.id,
        discount_amount,
        "promo applied to order"
    );
    Ok(Json(OrderDetail::from_parts(updated, items)))
}

pub async fn remove_order_promo(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<OrderDetail>> {
    auth.require_roles(&[Role::Cashier, Role::Owner, Role::Admin])?;
    let mut tx = begin_write_tx(&state.pool).await?;

    let order: OrderRow = sqlx::query_as("SELECT * FROM orders WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Nota #{id} tidak ditemukan")))?;

    let day_status = get_store_day_status_tx(&mut tx, &order.business_date).await?;
    if day_status == "CLOSED" {
        return Err(AppError::Conflict(
            "Toko untuk tanggal nota ini sudah ditutup.".into(),
        ));
    }
    if order.status != "UNPAID" {
        return Err(AppError::Conflict(
            "Promo hanya dapat dihapus pada nota yang BELUM BAYAR.".into(),
        ));
    }

    sqlx::query(
        r#"
        UPDATE orders
        SET discount_amount = 0,
            total_amount = subtotal_amount,
            promo_id = NULL,
            promo_name_snapshot = '',
            promo_applied_by_username = '',
            promo_receipt_text_snapshot = '',
            promo_receipt_media_type = 'NONE',
            promo_receipt_media_value = ''
        WHERE id = ?
        "#,
    )
    .bind(order.id)
    .execute(&mut *tx)
    .await?;

    let updated: OrderRow = sqlx::query_as("SELECT * FROM orders WHERE id = ?")
        .bind(order.id)
        .fetch_one(&mut *tx)
        .await?;
    let items: Vec<OrderItemDetail> =
        sqlx::query_as("SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC")
            .bind(order.id)
            .fetch_all(&mut *tx)
            .await?;

    tx.commit().await?;
    tracing::info!(actor = %auth.username, order_id = order.id, "promo removed from order");
    Ok(Json(OrderDetail::from_parts(updated, items)))
}

pub async fn void_order(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
    payload: Option<Json<VoidOrderRequest>>,
) -> AppResult<Json<OrderDetail>> {
    auth.require_roles(&[Role::Cashier, Role::Owner, Role::Admin])?;
    let reason: String = payload
        .and_then(|Json(body)| body.reason)
        .map(|s| s.trim().chars().take(500).collect::<String>())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("Dibatalkan oleh {}", auth.username));

    let (today, now) = now_business_and_iso();
    let mut tx = begin_write_tx(&state.pool).await?;

    let order: Option<OrderRow> = sqlx::query_as("SELECT * FROM orders WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

    let order = order.ok_or_else(|| AppError::NotFound(format!("Nota #{id} tidak ditemukan")))?;

    let day_status = get_store_day_status_tx(&mut tx, &order.business_date).await?;
    if day_status == "CLOSED" {
        return Err(AppError::Conflict(
            "Toko untuk tanggal nota ini sudah ditutup. Nota tidak dapat dibatalkan.".into(),
        ));
    }

    match order.status.as_str() {
        "UNPAID" => {}
        "PAID" => {
            if !matches!(auth.role, Role::Owner | Role::Admin) {
                return Err(AppError::Forbidden(
                    "Hanya Pemilik atau Administrator yang dapat membatalkan nota yang sudah LUNAS"
                        .into(),
                ));
            }
        }
        "VOIDED" => {
            return Err(AppError::Conflict(
                "Nota ini sudah dibatalkan sebelumnya".into(),
            ))
        }
        _ => return Err(AppError::Conflict("Status nota tidak valid".into())),
    }

    let items: Vec<OrderItemDetail> =
        sqlx::query_as("SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC")
            .bind(id)
            .fetch_all(&mut *tx)
            .await?;

    // Only restore into live `stock_items.current_stock` if the order belongs to today AND today is OPEN
    // (prevents cross-day voiding from ever corrupting today's live inventory)
    let is_live_today = order.business_date == today && day_status == "OPEN";

    let deductions: Vec<OrderStockDeductionRow> = sqlx::query_as(
        "SELECT stock_item_id, quantity FROM order_stock_deductions WHERE order_id = ?",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;

    for ded in deductions {
        let (current_stock,): (i64,) =
            sqlx::query_as("SELECT current_stock FROM stock_items WHERE id = ?")
                .bind(ded.stock_item_id)
                .fetch_one(&mut *tx)
                .await?;

        let stock_after = if is_live_today {
            let next = current_stock
                .checked_add(ded.quantity)
                .ok_or_else(|| AppError::Validation("Stok melebihi batas".into()))?;
            sqlx::query("UPDATE stock_items SET current_stock = ?, updated_at = ? WHERE id = ?")
                .bind(next)
                .bind(&now)
                .bind(ded.stock_item_id)
                .execute(&mut *tx)
                .await?;
            next
        } else {
            current_stock
        };

        ensure_daily_stock_snapshot(
            &mut tx,
            &order.business_date,
            ded.stock_item_id,
            current_stock,
            &now,
        )
        .await?;

        sqlx::query(
            r#"
            UPDATE daily_stock_item_snapshots
            SET sold_qty = MAX(0, sold_qty - ?),
                voided_qty = voided_qty + ?,
                updated_at = ?
            WHERE business_date = ? AND stock_item_id = ?
            "#,
        )
        .bind(ded.quantity)
        .bind(ded.quantity)
        .bind(&now)
        .bind(&order.business_date)
        .bind(ded.stock_item_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO stock_item_movements (
                business_date, stock_item_id, order_id, movement_type, qty_delta, stock_after, note, created_at
            )
            VALUES (?, ?, ?, 'ORDER_VOID_RESTORE', ?, ?, ?, ?)
            "#,
        )
        .bind(&order.business_date)
        .bind(ded.stock_item_id)
        .bind(order.id)
        .bind(ded.quantity)
        .bind(stock_after)
        .bind(format!("Pembatalan {}: {}", order.order_number, reason))
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query(
        "UPDATE orders SET status = 'VOIDED', voided_at = ?, void_reason = ? WHERE id = ?",
    )
    .bind(&now)
    .bind(&reason)
    .bind(id)
    .execute(&mut *tx)
    .await?;

    let updated: OrderRow = sqlx::query_as("SELECT * FROM orders WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(Json(OrderDetail::from_parts(updated, items)))
}
