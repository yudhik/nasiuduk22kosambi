use axum::{
    extract::{Query, State},
    http::{header, HeaderValue},
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use sqlx::{FromRow, SqlitePool};

use crate::{
    db::{ensure_daily_snapshot, now_iso, today_date},
    error::{AppError, AppResult},
    models::{
        DailyReportResponse, MenuSalesSummary, OrderRow, RevenueSummary, StockMovement,
        StockReconciliationRow, UpdatePhysicalStockRequest,
    },
    AppState,
};

#[derive(Debug, Deserialize)]
pub struct ReportQuery {
    pub date: Option<String>,
}

#[derive(Debug, FromRow)]
struct RawStockRow {
    menu_item_id: i64,
    menu_name: String,
    category: String,
    current_stock: i64,
    snapshot_initial: Option<i64>,
    snapshot_restocked: Option<i64>,
    snapshot_sold: Option<i64>,
    snapshot_voided: Option<i64>,
    physical_stock: Option<i64>,
    notes: Option<String>,
}

pub async fn build_daily_report(
    pool: &SqlitePool,
    business_date: &str,
) -> AppResult<DailyReportResponse> {
    let status_rows: Vec<(String, i64, i64)> = sqlx::query_as(
        r#"
        SELECT status, COUNT(*) as cnt, COALESCE(SUM(total_amount), 0) as total
        FROM orders
        WHERE business_date = ?
        GROUP BY status
        "#,
    )
    .bind(business_date)
    .fetch_all(pool)
    .await?;

    let mut paid_total = 0_i64;
    let mut paid_count = 0_i64;
    let mut unpaid_total = 0_i64;
    let mut unpaid_count = 0_i64;
    let mut voided_total = 0_i64;
    let mut voided_count = 0_i64;

    for (status, cnt, total) in status_rows {
        match status.as_str() {
            "PAID" => {
                paid_count = cnt;
                paid_total = total;
            }
            "UNPAID" => {
                unpaid_count = cnt;
                unpaid_total = total;
            }
            "VOIDED" => {
                voided_count = cnt;
                voided_total = total;
            }
            _ => {}
        }
    }

    let (total_portions_sold,): (i64,) = sqlx::query_as(
        r#"
        SELECT COALESCE(SUM(oi.quantity), 0)
        FROM order_items oi
        INNER JOIN orders o ON o.id = oi.order_id
        WHERE o.business_date = ? AND o.status != 'VOIDED'
        "#,
    )
    .bind(business_date)
    .fetch_one(pool)
    .await?;

    let sales_by_menu: Vec<MenuSalesSummary> = sqlx::query_as(
        r#"
        SELECT
            oi.menu_item_id,
            oi.menu_name_snapshot AS menu_name,
            COALESCE(SUM(oi.quantity), 0) AS quantity_sold,
            COALESCE(SUM(oi.subtotal), 0) AS total_revenue,
            COALESCE(SUM(CASE WHEN o.status = 'PAID' THEN oi.subtotal ELSE 0 END), 0) AS paid_revenue,
            COALESCE(SUM(CASE WHEN o.status = 'UNPAID' THEN oi.subtotal ELSE 0 END), 0) AS unpaid_revenue
        FROM order_items oi
        INNER JOIN orders o ON o.id = oi.order_id
        WHERE o.business_date = ? AND o.status != 'VOIDED'
        GROUP BY oi.menu_item_id, oi.menu_name_snapshot
        ORDER BY quantity_sold DESC, total_revenue DESC
        "#,
    )
    .bind(business_date)
    .fetch_all(pool)
    .await?;

    let is_today = business_date == today_date();
    let raw_stock_rows: Vec<RawStockRow> = if is_today {
        sqlx::query_as(
            r#"
            SELECT
                m.id AS menu_item_id,
                m.name AS menu_name,
                m.category AS category,
                m.current_stock AS current_stock,
                s.initial_stock AS snapshot_initial,
                s.restocked_qty AS snapshot_restocked,
                s.sold_qty AS snapshot_sold,
                s.voided_qty AS snapshot_voided,
                s.physical_stock AS physical_stock,
                s.notes AS notes
            FROM menu_items m
            LEFT JOIN daily_stock_snapshots s
                ON s.menu_item_id = m.id AND s.business_date = ?
            WHERE m.is_active = 1 OR s.id IS NOT NULL
            ORDER BY m.category ASC, m.name ASC
            "#,
        )
        .bind(business_date)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as(
            r#"
            SELECT
                m.id AS menu_item_id,
                m.name AS menu_name,
                m.category AS category,
                m.current_stock AS current_stock,
                s.initial_stock AS snapshot_initial,
                s.restocked_qty AS snapshot_restocked,
                s.sold_qty AS snapshot_sold,
                s.voided_qty AS snapshot_voided,
                s.physical_stock AS physical_stock,
                s.notes AS notes
            FROM daily_stock_snapshots s
            INNER JOIN menu_items m ON m.id = s.menu_item_id
            WHERE s.business_date = ?
            ORDER BY m.category ASC, m.name ASC
            "#,
        )
        .bind(business_date)
        .fetch_all(pool)
        .await?
    };

    let stock_reconciliation = raw_stock_rows
        .into_iter()
        .map(|row| {
            let initial_stock = row.snapshot_initial.unwrap_or(row.current_stock);
            let restocked_qty = row.snapshot_restocked.unwrap_or(0);
            let sold_qty = row.snapshot_sold.unwrap_or(0);
            let voided_qty = row.snapshot_voided.unwrap_or(0);
            let system_remaining = initial_stock + restocked_qty - sold_qty;
            let variance = row.physical_stock.map(|phys| phys - system_remaining);

            StockReconciliationRow {
                menu_item_id: row.menu_item_id,
                menu_name: row.menu_name,
                category: row.category,
                initial_stock,
                restocked_qty,
                sold_qty,
                voided_qty,
                system_remaining,
                current_stock: row.current_stock,
                physical_stock: row.physical_stock,
                variance,
                notes: row.notes.unwrap_or_default(),
            }
        })
        .collect();

    Ok(DailyReportResponse {
        business_date: business_date.to_string(),
        revenue: RevenueSummary {
            paid_total,
            paid_count,
            unpaid_total,
            unpaid_count,
            voided_total,
            voided_count,
            total_portions_sold,
        },
        sales_by_menu,
        stock_reconciliation,
    })
}

pub async fn get_daily_report(
    State(state): State<AppState>,
    Query(query): Query<ReportQuery>,
) -> AppResult<Json<DailyReportResponse>> {
    let business_date = query
        .date
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(today_date);

    let report = build_daily_report(&state.pool, &business_date).await?;
    Ok(Json(report))
}

pub async fn update_physical_stock(
    State(state): State<AppState>,
    Json(req): Json<UpdatePhysicalStockRequest>,
) -> AppResult<Json<DailyReportResponse>> {
    let business_date = req
        .business_date
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(today_date);
    let now = now_iso();

    let mut tx = state.pool.begin().await?;
    for entry in req.entries {
        if let Some(phys) = entry.physical_stock {
            if phys < 0 {
                return Err(AppError::Validation(
                    "Stok fisik tidak boleh bernilai negatif".into(),
                ));
            }
        }

        let menu_stock: Option<(i64,)> =
            sqlx::query_as("SELECT current_stock FROM menu_items WHERE id = ?")
                .bind(entry.menu_item_id)
                .fetch_optional(&mut *tx)
                .await?;

        let Some((current_stock,)) = menu_stock else {
            return Err(AppError::NotFound(format!(
                "Menu #{} tidak ditemukan",
                entry.menu_item_id
            )));
        };

        ensure_daily_snapshot(&mut tx, &business_date, entry.menu_item_id, current_stock, &now)
            .await?;

        let notes = entry.notes.unwrap_or_default().trim().to_string();
        sqlx::query(
            r#"
            UPDATE daily_stock_snapshots
            SET physical_stock = ?, notes = ?, updated_at = ?
            WHERE business_date = ? AND menu_item_id = ?
            "#,
        )
        .bind(entry.physical_stock)
        .bind(&notes)
        .bind(&now)
        .bind(&business_date)
        .bind(entry.menu_item_id)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    let report = build_daily_report(&state.pool, &business_date).await?;
    Ok(Json(report))
}

pub async fn list_stock_movements(
    State(state): State<AppState>,
    Query(query): Query<ReportQuery>,
) -> AppResult<Json<Vec<StockMovement>>> {
    let business_date = query
        .date
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(today_date);

    let rows: Vec<StockMovement> = sqlx::query_as(
        r#"
        SELECT
            sm.id,
            sm.business_date,
            sm.menu_item_id,
            m.name AS menu_name,
            sm.order_id,
            sm.movement_type,
            sm.qty_delta,
            sm.stock_after,
            sm.note,
            sm.created_at
        FROM stock_movements sm
        INNER JOIN menu_items m ON m.id = sm.menu_item_id
        WHERE sm.business_date = ?
        ORDER BY sm.id DESC
        LIMIT 200
        "#,
    )
    .bind(&business_date)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(rows))
}

fn csv_escape(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

pub async fn export_daily_csv(
    State(state): State<AppState>,
    Query(query): Query<ReportQuery>,
) -> AppResult<impl IntoResponse> {
    let business_date = query
        .date
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(today_date);

    let report = build_daily_report(&state.pool, &business_date).await?;
    let orders: Vec<OrderRow> =
        sqlx::query_as("SELECT * FROM orders WHERE business_date = ? ORDER BY id ASC")
            .bind(&business_date)
            .fetch_all(&state.pool)
            .await?;

    let mut out = String::new();
    out.push_str(&format!("LAPORAN HARIAN,{}\n", csv_escape(&business_date)));
    out.push_str("Metrik,Jumlah Nota,Total (Rp)\n");
    out.push_str(&format!(
        "Pendapatan Lunas (PAID),{},{}\n",
        report.revenue.paid_count, report.revenue.paid_total
    ));
    out.push_str(&format!(
        "Belum Dibayar (UNPAID),{},{}\n",
        report.revenue.unpaid_count, report.revenue.unpaid_total
    ));
    out.push_str(&format!(
        "Dibatalkan (VOIDED),{},{}\n",
        report.revenue.voided_count, report.revenue.voided_total
    ));
    out.push('\n');

    out.push_str("REKONSILIASI STOK HARIAN\n");
    out.push_str("Menu,Kategori,Stok Awal,Restock,Terjual,Dibatalkan,Sisa Sistem,Stok Fisik,Selisih,Catatan\n");
    for row in &report.stock_reconciliation {
        let phys = row
            .physical_stock
            .map(|v| v.to_string())
            .unwrap_or_default();
        let var = row.variance.map(|v| v.to_string()).unwrap_or_default();
        out.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{}\n",
            csv_escape(&row.menu_name),
            csv_escape(&row.category),
            row.initial_stock,
            row.restocked_qty,
            row.sold_qty,
            row.voided_qty,
            row.system_remaining,
            phys,
            var,
            csv_escape(&row.notes),
        ));
    }
    out.push('\n');

    out.push_str("DAFTAR NOTA\n");
    out.push_str("Nomor Nota,Status,Pelanggan/Meja,Pelayan,Total (Rp),Waktu Buat,Waktu Bayar,Alasan Batal\n");
    for order in &orders {
        out.push_str(&format!(
            "{},{},{},{},{},{},{},{}\n",
            csv_escape(&order.order_number),
            csv_escape(&order.status),
            csv_escape(&order.customer_label),
            csv_escape(&order.waiter_name),
            order.total_amount,
            csv_escape(&order.created_at),
            csv_escape(order.paid_at.as_deref().unwrap_or("")),
            csv_escape(order.void_reason.as_deref().unwrap_or("")),
        ));
    }

    let filename = format!("laporan-{}.csv", business_date);
    let headers = [
        (
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/csv; charset=utf-8"),
        ),
        (
            header::CONTENT_DISPOSITION,
            HeaderValue::from_str(&format!("attachment; filename=\"{filename}\""))
                .unwrap_or_else(|_| HeaderValue::from_static("attachment; filename=\"laporan.csv\"")),
        ),
    ];

    Ok((headers, out))
}
