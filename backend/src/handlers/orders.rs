use std::collections::HashMap;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;

use crate::{
    db::{ensure_daily_snapshot, now_iso, today_date},
    error::{AppError, AppResult},
    models::{CreateOrderRequest, MenuItem, OrderDetail, OrderItemDetail, OrderRow, VoidOrderRequest},
    AppState,
};

#[derive(Debug, Deserialize)]
pub struct OrderQuery {
    pub date: Option<String>,
    pub status: Option<String>,
}

pub async fn create_order(
    State(state): State<AppState>,
    Json(req): Json<CreateOrderRequest>,
) -> AppResult<(StatusCode, Json<OrderDetail>)> {
    if req.items.is_empty() {
        return Err(AppError::Validation(
            "Nota harus memiliki minimal 1 item makanan/minuman".into(),
        ));
    }

    let mut requested_totals: HashMap<i64, i64> = HashMap::new();
    for item in &req.items {
        if item.quantity <= 0 {
            return Err(AppError::Validation(
                "Jumlah pesanan setiap item harus lebih dari 0".into(),
            ));
        }
        *requested_totals.entry(item.menu_item_id).or_insert(0) += item.quantity;
    }

    let today = today_date();
    let now = now_iso();
    let customer_label = req.customer_label.unwrap_or_default().trim().to_string();
    let waiter_name = req.waiter_name.unwrap_or_default().trim().to_string();
    let notes = req.notes.unwrap_or_default().trim().to_string();

    let mut tx = state.pool.begin().await?;

    // Fetch and validate all referenced menu items + stock sufficiency up front
    let mut menu_map: HashMap<i64, MenuItem> = HashMap::new();
    for (&menu_id, &total_qty) in &requested_totals {
        let menu: Option<MenuItem> = sqlx::query_as("SELECT * FROM menu_items WHERE id = ?")
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

        if menu.current_stock < total_qty {
            return Err(AppError::InsufficientStock {
                menu_name: menu.name,
                available: menu.current_stock,
                requested: total_qty,
            });
        }

        menu_map.insert(menu_id, menu);
    }

    // Calculate total amount
    let mut total_amount: i64 = 0;
    for item in &req.items {
        let menu = &menu_map[&item.menu_item_id];
        total_amount += menu.price * item.quantity;
    }

    // Generate sequential daily order number: NOTA-YYYYMMDD-001
    let existing_count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM orders WHERE business_date = ?")
            .bind(&today)
            .fetch_one(&mut *tx)
            .await?;
    let date_compact = today.replace('-', "");
    let order_number = format!("NOTA-{}-{:03}", date_compact, existing_count.0 + 1);

    let order_res = sqlx::query(
        r#"
        INSERT INTO orders (
            order_number, business_date, customer_label, waiter_name, notes, status, total_amount, created_at
        )
        VALUES (?, ?, ?, ?, ?, 'UNPAID', ?, ?)
        "#,
    )
    .bind(&order_number)
    .bind(&today)
    .bind(&customer_label)
    .bind(&waiter_name)
    .bind(&notes)
    .bind(total_amount)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    let order_id = order_res.last_insert_rowid();

    // Insert order items with locked snapshots of name and price
    for item in &req.items {
        let menu = &menu_map[&item.menu_item_id];
        let subtotal = menu.price * item.quantity;
        let item_note = item.item_note.as_deref().unwrap_or("").trim();

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
        .bind(item_note)
        .execute(&mut *tx)
        .await?;
    }

    // Atomically deduct stock, update daily snapshots, and record stock movements
    for (&menu_id, &total_qty) in &requested_totals {
        let menu = &menu_map[&menu_id];
        ensure_daily_snapshot(&mut tx, &today, menu_id, menu.current_stock, &now).await?;

        let stock_after = menu.current_stock - total_qty;
        let updated = sqlx::query(
            r#"
            UPDATE menu_items
            SET current_stock = current_stock - ?, updated_at = ?
            WHERE id = ? AND is_active = 1 AND current_stock >= ?
            "#,
        )
        .bind(total_qty)
        .bind(&now)
        .bind(menu_id)
        .bind(total_qty)
        .execute(&mut *tx)
        .await?;

        if updated.rows_affected() != 1 {
            return Err(AppError::InsufficientStock {
                menu_name: menu.name.clone(),
                available: menu.current_stock,
                requested: total_qty,
            });
        }

        sqlx::query(
            r#"
            UPDATE daily_stock_snapshots
            SET sold_qty = sold_qty + ?, updated_at = ?
            WHERE business_date = ? AND menu_item_id = ?
            "#,
        )
        .bind(total_qty)
        .bind(&now)
        .bind(&today)
        .bind(menu_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO stock_movements (
                business_date, menu_item_id, order_id, movement_type, qty_delta, stock_after, note, created_at
            )
            VALUES (?, ?, ?, 'ORDER_DEDUCT', ?, ?, ?, ?)
            "#,
        )
        .bind(&today)
        .bind(menu_id)
        .bind(order_id)
        .bind(-total_qty)
        .bind(stock_after)
        .bind(format!("Pesanan {order_number}"))
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
    State(state): State<AppState>,
    Query(query): Query<OrderQuery>,
) -> AppResult<Json<Vec<OrderDetail>>> {
    let business_date = query
        .date
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(today_date);

    let status_filter = query
        .status
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("ALL"))
        .map(|s| s.to_uppercase());

    let orders: Vec<OrderRow> = match status_filter {
        Some(status) => {
            sqlx::query_as(
                "SELECT * FROM orders WHERE business_date = ? AND status = ? ORDER BY id DESC",
            )
            .bind(&business_date)
            .bind(&status)
            .fetch_all(&state.pool)
            .await?
        }
        None => {
            sqlx::query_as("SELECT * FROM orders WHERE business_date = ? ORDER BY id DESC")
                .bind(&business_date)
                .fetch_all(&state.pool)
                .await?
        }
    };

    if orders.is_empty() {
        return Ok(Json(Vec::new()));
    }

    let all_items: Vec<OrderItemDetail> = sqlx::query_as(
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
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<OrderDetail>> {
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
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<OrderDetail>> {
    let now = now_iso();
    let mut tx = state.pool.begin().await?;

    let order: Option<OrderRow> = sqlx::query_as("SELECT * FROM orders WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

    let order = order.ok_or_else(|| AppError::NotFound(format!("Nota #{id} tidak ditemukan")))?;

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

pub async fn void_order(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    payload: Option<Json<VoidOrderRequest>>,
) -> AppResult<Json<OrderDetail>> {
    let reason = payload
        .and_then(|Json(body)| body.reason)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Dibatalkan sebelum pembayaran".to_string());

    let now = now_iso();
    let mut tx = state.pool.begin().await?;

    let order: Option<OrderRow> = sqlx::query_as("SELECT * FROM orders WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

    let order = order.ok_or_else(|| AppError::NotFound(format!("Nota #{id} tidak ditemukan")))?;

    match order.status.as_str() {
        "UNPAID" => {}
        "PAID" => {
            return Err(AppError::Conflict(
                "Nota yang sudah lunas tidak dapat dibatalkan".into(),
            ))
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

    let mut restore_by_menu: HashMap<i64, i64> = HashMap::new();
    for item in &items {
        *restore_by_menu.entry(item.menu_item_id).or_insert(0) += item.quantity;
    }

    for (menu_id, qty) in restore_by_menu {
        let (current_stock,): (i64,) =
            sqlx::query_as("SELECT current_stock FROM menu_items WHERE id = ?")
                .bind(menu_id)
                .fetch_one(&mut *tx)
                .await?;

        let stock_after = current_stock + qty;

        sqlx::query("UPDATE menu_items SET current_stock = ?, updated_at = ? WHERE id = ?")
            .bind(stock_after)
            .bind(&now)
            .bind(menu_id)
            .execute(&mut *tx)
            .await?;

        ensure_daily_snapshot(&mut tx, &order.business_date, menu_id, current_stock, &now).await?;
        sqlx::query(
            r#"
            UPDATE daily_stock_snapshots
            SET sold_qty = MAX(0, sold_qty - ?),
                voided_qty = voided_qty + ?,
                updated_at = ?
            WHERE business_date = ? AND menu_item_id = ?
            "#,
        )
        .bind(qty)
        .bind(qty)
        .bind(&now)
        .bind(&order.business_date)
        .bind(menu_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO stock_movements (
                business_date, menu_item_id, order_id, movement_type, qty_delta, stock_after, note, created_at
            )
            VALUES (?, ?, ?, 'ORDER_VOID_RESTORE', ?, ?, ?, ?)
            "#,
        )
        .bind(&order.business_date)
        .bind(menu_id)
        .bind(order.id)
        .bind(qty)
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
