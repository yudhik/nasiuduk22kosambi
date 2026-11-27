use std::collections::{BTreeMap, HashMap};

use axum::{
    extract::{Query, State},
    http::{header, HeaderValue},
    response::IntoResponse,
    Json,
};
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, Timelike};
use serde::Deserialize;
use sqlx::{FromRow, SqlitePool};

use crate::{
    auth::{AuthUser, Role},
    db::{
        begin_write_tx, ensure_daily_stock_snapshot, get_store_day_status_tx, now_iso,
        parse_business_date, today_date,
    },
    error::{AppError, AppResult},
    models::{
        AnalyticsSummary, ChannelPerformanceStat, ChannelSalesSummary, DailyExpense,
        DailyPerformancePoint, DailyReportResponse, MenuSalesSummary, OrderRow, PeakHourStat,
        PerformanceAnalyticsResponse, PromoUsageSummary, RevenueSummary, StockMovement,
        StockReconciliationRow,
        StockVarianceSummary, StoreDayRow, UpdatePhysicalStockRequest, UserOrderIntervalStat,
        WeekdayStat,
    },
    AppState,
};

#[derive(Debug, Deserialize)]
pub struct ReportQuery {
    pub date: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct AnalyticsQuery {
    pub preset: Option<String>, // "today" | "7d" | "30d" | "month" | "custom"
    pub from: Option<String>,
    pub to: Option<String>,
}

#[derive(Debug, FromRow)]
struct RawStockRecRow {
    stock_item_id: i64,
    stock_name: String,
    unit: String,
    current_stock: i64,
    snapshot_initial: Option<i64>,
    snapshot_restocked: Option<i64>,
    snapshot_sold: Option<i64>,
    snapshot_voided: Option<i64>,
    physical_stock: Option<i64>,
    notes: Option<String>,
}

/// Slim projection for analytics so we never load full `OrderRow` text columns into RAM.
#[derive(Debug, FromRow)]
struct SlimOrderAnalyticsRow {
    business_date: String,
    channel_name_snapshot: String,
    waiter_name: String,
    status: String,
    total_amount: i64,
    created_at: String,
}

async fn build_daily_report_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    business_date: &str,
) -> AppResult<DailyReportResponse> {
    let store_status = get_store_day_status_tx(tx, business_date).await?;

    let status_rows: Vec<(String, i64, i64)> = sqlx::query_as(
        r#"
        SELECT status, COUNT(*) as cnt, COALESCE(SUM(total_amount), 0) as total
        FROM orders
        WHERE business_date = ?
        GROUP BY status
        "#,
    )
    .bind(business_date)
    .fetch_all(&mut **tx)
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
        WHERE o.business_date = ? AND o.status = 'PAID'
        "#,
    )
    .bind(business_date)
    .fetch_one(&mut **tx)
    .await?;

    let sales_by_channel: Vec<ChannelSalesSummary> = sqlx::query_as(
        r#"
        SELECT
            channel_name_snapshot AS channel_name,
            COUNT(*) AS order_count,
            COALESCE(SUM(CASE WHEN status = 'PAID' THEN 1 ELSE 0 END), 0) AS paid_count,
            COALESCE(SUM(CASE WHEN status = 'UNPAID' THEN 1 ELSE 0 END), 0) AS unpaid_count,
            COALESCE(SUM(total_amount), 0) AS total_revenue,
            COALESCE(SUM(CASE WHEN status = 'PAID' THEN total_amount ELSE 0 END), 0) AS paid_revenue,
            COALESCE(SUM(CASE WHEN status = 'UNPAID' THEN total_amount ELSE 0 END), 0) AS unpaid_revenue
        FROM orders
        WHERE business_date = ? AND status != 'VOIDED'
        GROUP BY channel_name_snapshot
        ORDER BY total_revenue DESC, order_count DESC
        "#,
    )
    .bind(business_date)
    .fetch_all(&mut **tx)
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
    .fetch_all(&mut **tx)
    .await?;

    let (total_discounts,): (i64,) = sqlx::query_as(
        "SELECT COALESCE(SUM(discount_amount), 0) FROM orders WHERE business_date = ? AND status = 'PAID'",
    )
    .bind(business_date)
    .fetch_one(&mut **tx)
    .await?;

    let promo_summary: Vec<PromoUsageSummary> = sqlx::query_as(
        r#"
        SELECT
            ap.promo_name_snapshot AS promo_name,
            COUNT(*) AS order_count,
            COALESCE(SUM(ap.discount_amount), 0) AS total_discount
        FROM applied_promotions ap
        INNER JOIN orders o ON o.id = ap.order_id
        WHERE o.business_date = ? AND o.status = 'PAID' AND ap.status = 'APPLIED'
        GROUP BY ap.promo_name_snapshot
        ORDER BY total_discount DESC, order_count DESC
        "#,
    )
    .bind(business_date)
    .fetch_all(&mut **tx)
    .await?;

    let expenses: Vec<DailyExpense> = sqlx::query_as(
        "SELECT * FROM daily_expenses WHERE business_date = ? ORDER BY id DESC",
    )
    .bind(business_date)
    .fetch_all(&mut **tx)
    .await?;
    let total_expenses: i64 = expenses.iter().map(|e| e.amount).sum();
    let net_profit = paid_total - total_expenses;

    let is_today = business_date == today_date();
    let raw_stock_rows: Vec<RawStockRecRow> = if is_today {
        sqlx::query_as(
            r#"
            SELECT
                st.id AS stock_item_id,
                st.name AS stock_name,
                st.unit AS unit,
                st.current_stock AS current_stock,
                s.initial_stock AS snapshot_initial,
                s.restocked_qty AS snapshot_restocked,
                s.sold_qty AS snapshot_sold,
                s.voided_qty AS snapshot_voided,
                s.physical_stock AS physical_stock,
                s.notes AS notes
            FROM stock_items st
            LEFT JOIN daily_stock_item_snapshots s
                ON s.stock_item_id = st.id AND s.business_date = ?
            WHERE st.is_active = 1 OR s.id IS NOT NULL
            ORDER BY st.name ASC
            "#,
        )
        .bind(business_date)
        .fetch_all(&mut **tx)
        .await?
    } else {
        sqlx::query_as(
            r#"
            SELECT
                st.id AS stock_item_id,
                st.name AS stock_name,
                st.unit AS unit,
                st.current_stock AS current_stock,
                s.initial_stock AS snapshot_initial,
                s.restocked_qty AS snapshot_restocked,
                s.sold_qty AS snapshot_sold,
                s.voided_qty AS snapshot_voided,
                s.physical_stock AS physical_stock,
                s.notes AS notes
            FROM daily_stock_item_snapshots s
            INNER JOIN stock_items st ON st.id = s.stock_item_id
            WHERE s.business_date = ?
            ORDER BY st.name ASC
            "#,
        )
        .bind(business_date)
        .fetch_all(&mut **tx)
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
                stock_item_id: row.stock_item_id,
                stock_name: row.stock_name,
                unit: row.unit,
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
        store_status,
        revenue: RevenueSummary {
            paid_total,
            paid_count,
            unpaid_total,
            unpaid_count,
            voided_total,
            voided_count,
            total_portions_sold,
            total_discounts,
            total_expenses,
            net_profit,
        },
        sales_by_channel,
        sales_by_menu,
        promo_summary,
        expenses,
        stock_reconciliation,
    })
}

pub async fn build_daily_report(
    pool: &SqlitePool,
    business_date: &str,
) -> AppResult<DailyReportResponse> {
    // Single WAL read transaction guarantees point-in-time snapshot consistency across all queries
    let mut tx = pool.begin().await?;
    let report = build_daily_report_in_tx(&mut tx, business_date).await?;
    tx.commit().await?;
    Ok(report)
}

pub async fn get_daily_report(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(query): Query<ReportQuery>,
) -> AppResult<Json<DailyReportResponse>> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;
    let business_date = parse_business_date(query.date.as_deref())?;
    let report = build_daily_report(&state.pool, &business_date).await?;
    Ok(Json(report))
}

pub async fn update_physical_stock(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(req): Json<UpdatePhysicalStockRequest>,
) -> AppResult<Json<DailyReportResponse>> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;
    let business_date = parse_business_date(req.business_date.as_deref())?;
    let now = now_iso();

    let mut tx = begin_write_tx(&state.pool).await?;
    let status = get_store_day_status_tx(&mut tx, &business_date).await?;
    if status == "NOT_OPENED" {
        return Err(AppError::Conflict(format!(
            "Toko untuk tanggal {business_date} belum dibuka. Buka toko terlebih dahulu sebelum mengisi opname stok."
        )));
    }
    if status == "CLOSED" {
        return Err(AppError::Conflict(format!(
            "Toko untuk tanggal {business_date} sudah ditutup. Opname stok tidak dapat diubah lagi."
        )));
    }

    for entry in req.entries {
        if let Some(phys) = entry.physical_stock {
            if phys < 0 || phys > 1_000_000 {
                return Err(AppError::Validation(
                    "Stok fisik harus antara 0 hingga 1.000.000".into(),
                ));
            }
        }

        let stock_row: Option<(i64,)> =
            sqlx::query_as("SELECT current_stock FROM stock_items WHERE id = ?")
                .bind(entry.stock_item_id)
                .fetch_optional(&mut *tx)
                .await?;

        let Some((current_stock,)) = stock_row else {
            return Err(AppError::NotFound(format!(
                "Item stok #{} tidak ditemukan",
                entry.stock_item_id
            )));
        };

        ensure_daily_stock_snapshot(
            &mut tx,
            &business_date,
            entry.stock_item_id,
            current_stock,
            &now,
        )
        .await?;

        let notes: String = entry
            .notes
            .unwrap_or_default()
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
        .bind(&business_date)
        .bind(entry.stock_item_id)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    let report = build_daily_report(&state.pool, &business_date).await?;
    Ok(Json(report))
}

pub async fn list_stock_movements(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(query): Query<ReportQuery>,
) -> AppResult<Json<Vec<StockMovement>>> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;
    let business_date = parse_business_date(query.date.as_deref())?;
    let limit = query.limit.unwrap_or(250).clamp(1, 1000);

    let rows: Vec<StockMovement> = sqlx::query_as(
        r#"
        SELECT
            sm.id,
            sm.business_date,
            sm.stock_item_id,
            st.name AS stock_name,
            sm.order_id,
            sm.movement_type,
            sm.qty_delta,
            sm.stock_after,
            sm.note,
            sm.created_at
        FROM stock_item_movements sm
        INNER JOIN stock_items st ON st.id = sm.stock_item_id
        WHERE sm.business_date = ?
        ORDER BY sm.id DESC
        LIMIT ?
        "#,
    )
    .bind(&business_date)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(rows))
}

/// Escapes CSV cells and neutralizes spreadsheet formula injection (including leading whitespace).
fn csv_escape_text(s: &str) -> String {
    let trimmed = s.trim_start();
    let sanitized = if trimmed.starts_with(['=', '+', '-', '@'])
        || s.starts_with(['\t', '\r', '\n'])
    {
        format!("'{s}")
    } else {
        s.to_string()
    };

    if sanitized.contains(',')
        || sanitized.contains('"')
        || sanitized.contains('\n')
        || sanitized.contains('\r')
    {
        format!("\"{}\"", sanitized.replace('"', "\"\""))
    } else {
        sanitized
    }
}

pub async fn export_daily_csv(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(query): Query<ReportQuery>,
) -> AppResult<impl IntoResponse> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;
    let business_date = parse_business_date(query.date.as_deref())?;

    // Single read transaction guarantees CSV summary and order list are snapshot-consistent
    let mut tx = state.pool.begin().await?;
    let report = build_daily_report_in_tx(&mut tx, &business_date).await?;
    let orders: Vec<OrderRow> =
        sqlx::query_as("SELECT * FROM orders WHERE business_date = ? ORDER BY id ASC")
            .bind(&business_date)
            .fetch_all(&mut *tx)
            .await?;
    tx.commit().await?;

    let mut out = String::new();
    out.push_str(&format!(
        "LAPORAN HARIAN,{}\n",
        csv_escape_text(&business_date)
    ));
    out.push_str(&format!(
        "STATUS TOKO,{}\n",
        csv_escape_text(&report.store_status)
    ));
    out.push_str("Metrik,Jumlah,Total (Rp)\n");
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
    out.push_str(&format!(
        "Total Pengeluaran,{},{}\n",
        report.expenses.len(),
        report.revenue.total_expenses
    ));
    out.push_str(&format!("Laba Bersih,,{}\n\n", report.revenue.net_profit));

    out.push_str("PENJUALAN PER CHANNEL\n");
    out.push_str("Channel,Jumlah Nota,Lunas,Belum Bayar,Total (Rp)\n");
    for ch in &report.sales_by_channel {
        out.push_str(&format!(
            "{},{},{},{},{}\n",
            csv_escape_text(&ch.channel_name),
            ch.order_count,
            ch.paid_count,
            ch.unpaid_count,
            ch.total_revenue
        ));
    }
    out.push('\n');

    out.push_str("PENGELUARAN HARIAN\n");
    out.push_str("Keterangan,Kategori,Nominal (Rp),Catatan,Dicatat Oleh,Waktu\n");
    for ex in &report.expenses {
        out.push_str(&format!(
            "{},{},{},{},{},{}\n",
            csv_escape_text(&ex.title),
            csv_escape_text(&ex.category),
            ex.amount,
            csv_escape_text(&ex.notes),
            csv_escape_text(&ex.created_by_username),
            csv_escape_text(&ex.created_at)
        ));
    }
    out.push('\n');

    out.push_str("REKONSILIASI STOK HARIAN\n");
    out.push_str("Item Stok,Satuan,Stok Awal,Restock,Terpakai,Dibatalkan,Sisa Sistem,Stok Fisik,Selisih,Catatan\n");
    for row in &report.stock_reconciliation {
        let phys = row
            .physical_stock
            .map(|v| v.to_string())
            .unwrap_or_default();
        let var = row.variance.map(|v| v.to_string()).unwrap_or_default();
        out.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{}\n",
            csv_escape_text(&row.stock_name),
            csv_escape_text(&row.unit),
            row.initial_stock,
            row.restocked_qty,
            row.sold_qty,
            row.voided_qty,
            row.system_remaining,
            phys,
            var,
            csv_escape_text(&row.notes),
        ));
    }
    out.push('\n');

    out.push_str("DAFTAR NOTA\n");
    out.push_str("Nomor Nota,Channel,Status,Pelanggan/Meja,Pelayan,Total (Rp),Waktu Buat,Waktu Bayar,Alasan Batal\n");
    for order in &orders {
        out.push_str(&format!(
            "{},{},{},{},{},{},{},{},{}\n",
            csv_escape_text(&order.order_number),
            csv_escape_text(&order.channel_name_snapshot),
            csv_escape_text(&order.status),
            csv_escape_text(&order.customer_label),
            csv_escape_text(&order.waiter_name),
            order.total_amount,
            csv_escape_text(&order.created_at),
            csv_escape_text(order.paid_at.as_deref().unwrap_or("")),
            csv_escape_text(order.void_reason.as_deref().unwrap_or("")),
        ));
    }

    let filename = format!("laporan-{business_date}.csv");
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

fn resolve_date_range(query: &AnalyticsQuery) -> AppResult<(String, String)> {
    let today = Local::now().date_naive();
    let preset = query
        .preset
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("7d")
        .to_ascii_lowercase();

    match preset.as_str() {
        "today" => {
            let s = today.format("%Y-%m-%d").to_string();
            Ok((s.clone(), s))
        }
        "7d" => {
            let from = today - Duration::days(6);
            Ok((
                from.format("%Y-%m-%d").to_string(),
                today.format("%Y-%m-%d").to_string(),
            ))
        }
        "30d" => {
            let from = today - Duration::days(29);
            Ok((
                from.format("%Y-%m-%d").to_string(),
                today.format("%Y-%m-%d").to_string(),
            ))
        }
        "month" => {
            let from = NaiveDate::from_ymd_opt(today.year(), today.month(), 1).unwrap_or(today);
            Ok((
                from.format("%Y-%m-%d").to_string(),
                today.format("%Y-%m-%d").to_string(),
            ))
        }
        "custom" => {
            let from_raw = query
                .from
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| AppError::Validation("Tanggal awal (from) wajib diisi".into()))?;
            let to_raw = query
                .to
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| AppError::Validation("Tanggal akhir (to) wajib diisi".into()))?;

            let from_d = NaiveDate::parse_from_str(from_raw, "%Y-%m-%d")
                .map_err(|_| AppError::Validation("Format tanggal awal harus YYYY-MM-DD".into()))?;
            let to_d = NaiveDate::parse_from_str(to_raw, "%Y-%m-%d")
                .map_err(|_| AppError::Validation("Format tanggal akhir harus YYYY-MM-DD".into()))?;
            if from_d > to_d {
                return Err(AppError::Validation(
                    "Tanggal awal tidak boleh lebih besar dari tanggal akhir".into(),
                ));
            }
            if (to_d - from_d).num_days() > 366 {
                return Err(AppError::Validation(
                    "Rentang tanggal analitik maksimal 366 hari".into(),
                ));
            }
            Ok((
                from_d.format("%Y-%m-%d").to_string(),
                to_d.format("%Y-%m-%d").to_string(),
            ))
        }
        _ => Err(AppError::Validation(
            "Preset tidak valid. Gunakan: today, 7d, 30d, month, atau custom".into(),
        )),
    }
}

pub async fn get_performance_analytics(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(query): Query<AnalyticsQuery>,
) -> AppResult<Json<PerformanceAnalyticsResponse>> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;
    let (from_date, to_date) = resolve_date_range(&query)?;

    let mut tx = state.pool.begin().await?;

    let store_days: Vec<StoreDayRow> = sqlx::query_as(
        "SELECT * FROM store_days WHERE business_date BETWEEN ? AND ? ORDER BY business_date ASC",
    )
    .bind(&from_date)
    .bind(&to_date)
    .fetch_all(&mut *tx)
    .await?;

    let mut store_day_map: HashMap<String, StoreDayRow> = HashMap::new();
    let mut closed_days_count = 0_i64;
    for d in store_days {
        if d.status == "CLOSED" {
            closed_days_count += 1;
        }
        store_day_map.insert(d.business_date.clone(), d);
    }

    // Slim column projection avoids loading notes/customer_label/void_reason into RAM
    let orders: Vec<SlimOrderAnalyticsRow> = sqlx::query_as(
        r#"
        SELECT business_date, channel_name_snapshot, waiter_name, status, total_amount, created_at
        FROM orders
        WHERE business_date BETWEEN ? AND ?
        ORDER BY business_date ASC, created_at ASC, id ASC
        "#,
    )
    .bind(&from_date)
    .bind(&to_date)
    .fetch_all(&mut *tx)
    .await?;

    let exp_by_date_rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT business_date, COALESCE(SUM(amount), 0) FROM daily_expenses WHERE business_date BETWEEN ? AND ? GROUP BY business_date",
    )
    .bind(&from_date)
    .bind(&to_date)
    .fetch_all(&mut *tx)
    .await?;
    let exp_by_date: HashMap<String, i64> = exp_by_date_rows.into_iter().collect();

    // Aligned strictly on PAID orders (consistent with Daily Report net profit & Close Store snapshot)
    let portions_by_date_rows: Vec<(String, i64)> = sqlx::query_as(
        r#"
        SELECT o.business_date, COALESCE(SUM(oi.quantity), 0)
        FROM order_items oi
        INNER JOIN orders o ON o.id = oi.order_id
        WHERE o.business_date BETWEEN ? AND ? AND o.status = 'PAID'
        GROUP BY o.business_date
        "#,
    )
    .bind(&from_date)
    .bind(&to_date)
    .fetch_all(&mut *tx)
    .await?;
    let portions_by_date: HashMap<String, i64> = portions_by_date_rows.into_iter().collect();

    let mut daily_map: BTreeMap<String, DailyPerformancePoint> = BTreeMap::new();
    for (date, day) in &store_day_map {
        let exp = *exp_by_date.get(date).unwrap_or(&0);
        daily_map.insert(
            date.clone(),
            DailyPerformancePoint {
                business_date: date.clone(),
                store_status: day.status.clone(),
                revenue: 0,
                expenses: exp,
                net_profit: -exp,
                order_count: 0,
                portions_sold: *portions_by_date.get(date).unwrap_or(&0),
            },
        );
    }
    for (date, &exp_amt) in &exp_by_date {
        daily_map
            .entry(date.clone())
            .or_insert_with(|| DailyPerformancePoint {
                business_date: date.clone(),
                store_status: store_day_map
                    .get(date)
                    .map(|d| d.status.clone())
                    .unwrap_or_else(|| "NOT_OPENED".to_string()),
                revenue: 0,
                expenses: exp_amt,
                net_profit: -exp_amt,
                order_count: 0,
                portions_sold: *portions_by_date.get(date).unwrap_or(&0),
            });
    }

    let mut total_revenue = 0_i64;
    let mut total_orders = 0_i64;
    let mut paid_orders = 0_i64;
    let mut voided_orders = 0_i64;

    let mut channel_agg: HashMap<String, (i64, i64)> = HashMap::new();
    let mut hour_agg: HashMap<i64, (i64, i64)> = HashMap::new();
    let mut weekday_agg: HashMap<u32, (i64, i64)> = HashMap::new();
    let mut user_day_timestamps: HashMap<(String, String), Vec<i64>> = HashMap::new();
    let mut user_order_counts: HashMap<String, i64> = HashMap::new();

    for o in &orders {
        total_orders += 1;
        let parsed_dt = DateTime::parse_from_rfc3339(&o.created_at).ok();

        let actor = if o.waiter_name.trim().is_empty() {
            "unknown".to_string()
        } else {
            o.waiter_name.clone()
        };
        *user_order_counts.entry(actor.clone()).or_insert(0) += 1;
        if let Some(dt) = parsed_dt {
            user_day_timestamps
                .entry((actor, o.business_date.clone()))
                .or_default()
                .push(dt.timestamp());
        }

        if o.status == "VOIDED" {
            voided_orders += 1;
            continue;
        }
        if o.status != "PAID" {
            // Keep revenue & net profit aligned strictly on PAID orders (consistent with Daily Report & Close Store)
            continue;
        }

        paid_orders += 1;
        total_revenue += o.total_amount;

        let pt = daily_map
            .entry(o.business_date.clone())
            .or_insert_with(|| DailyPerformancePoint {
                business_date: o.business_date.clone(),
                store_status: store_day_map
                    .get(&o.business_date)
                    .map(|d| d.status.clone())
                    .unwrap_or_else(|| "OPEN".to_string()),
                revenue: 0,
                expenses: *exp_by_date.get(&o.business_date).unwrap_or(&0),
                net_profit: 0,
                order_count: 0,
                portions_sold: *portions_by_date.get(&o.business_date).unwrap_or(&0),
            });
        pt.revenue += o.total_amount;
        pt.order_count += 1;
        pt.net_profit = pt.revenue - pt.expenses;

        let ch_entry = channel_agg
            .entry(o.channel_name_snapshot.clone())
            .or_insert((0, 0));
        ch_entry.0 += 1;
        ch_entry.1 += o.total_amount;

        if let Some(dt) = parsed_dt {
            let local_dt = dt.with_timezone(&Local);
            let h = local_dt.hour() as i64;
            let he = hour_agg.entry(h).or_insert((0, 0));
            he.0 += 1;
            he.1 += o.total_amount;

            let wd = local_dt.weekday().num_days_from_monday();
            let we = weekday_agg.entry(wd).or_insert((0, 0));
            we.0 += 1;
            we.1 += o.total_amount;
        }
    }

    let daily_trend: Vec<DailyPerformancePoint> = daily_map.into_values().collect();
    let total_expenses: i64 = exp_by_date.values().sum();
    let total_portions: i64 = portions_by_date.values().sum();
    let avg_order_value = if paid_orders > 0 {
        total_revenue / paid_orders
    } else {
        0
    };
    let active_days_count = daily_trend.len() as i64;

    let mut by_channel: Vec<ChannelPerformanceStat> = channel_agg
        .into_iter()
        .map(|(channel_name, (order_count, revenue))| {
            let share_percent = if total_revenue > 0 {
                ((revenue as f64 / total_revenue as f64) * 1000.0).round() / 10.0
            } else {
                0.0
            };
            ChannelPerformanceStat {
                channel_name,
                order_count,
                revenue,
                share_percent,
            }
        })
        .collect();
    by_channel.sort_by(|a, b| {
        b.revenue
            .cmp(&a.revenue)
            .then_with(|| b.order_count.cmp(&a.order_count))
    });

    let all_menu_sales: Vec<MenuSalesSummary> = sqlx::query_as(
        r#"
        SELECT
            oi.menu_item_id,
            oi.menu_name_snapshot AS menu_name,
            COALESCE(SUM(oi.quantity), 0) AS quantity_sold,
            COALESCE(SUM(oi.subtotal), 0) AS total_revenue,
            COALESCE(SUM(oi.subtotal), 0) AS paid_revenue,
            0 AS unpaid_revenue
        FROM order_items oi
        INNER JOIN orders o ON o.id = oi.order_id
        WHERE o.business_date BETWEEN ? AND ? AND o.status = 'PAID'
        GROUP BY oi.menu_item_id, oi.menu_name_snapshot
        ORDER BY quantity_sold DESC, total_revenue DESC
        "#,
    )
    .bind(&from_date)
    .bind(&to_date)
    .fetch_all(&mut *tx)
    .await?;

    let top_menus: Vec<MenuSalesSummary> = all_menu_sales
        .iter()
        .take(10)
        .map(|m| MenuSalesSummary {
            menu_item_id: m.menu_item_id,
            menu_name: m.menu_name.clone(),
            quantity_sold: m.quantity_sold,
            total_revenue: m.total_revenue,
            paid_revenue: m.paid_revenue,
            unpaid_revenue: m.unpaid_revenue,
        })
        .collect();

    let mut bottom_menus: Vec<MenuSalesSummary> = all_menu_sales
        .iter()
        .rev()
        .take(5)
        .map(|m| MenuSalesSummary {
            menu_item_id: m.menu_item_id,
            menu_name: m.menu_name.clone(),
            quantity_sold: m.quantity_sold,
            total_revenue: m.total_revenue,
            paid_revenue: m.paid_revenue,
            unpaid_revenue: m.unpaid_revenue,
        })
        .collect();
    bottom_menus.sort_by(|a, b| a.quantity_sold.cmp(&b.quantity_sold));

    #[derive(Debug, FromRow)]
    struct StockAggRow {
        stock_item_id: i64,
        stock_name: String,
        unit: String,
        total_supplied: i64,
        total_sold: i64,
        total_leftover: i64,
        total_variance: i64,
        opname_days: i64,
    }

    let stock_rows: Vec<StockAggRow> = sqlx::query_as(
        r#"
        SELECT
            s.stock_item_id,
            st.name AS stock_name,
            st.unit AS unit,
            COALESCE(SUM(s.initial_stock + s.restocked_qty), 0) AS total_supplied,
            COALESCE(SUM(s.sold_qty), 0) AS total_sold,
            COALESCE(SUM(s.initial_stock + s.restocked_qty - s.sold_qty), 0) AS total_leftover,
            COALESCE(SUM(CASE WHEN s.physical_stock IS NOT NULL THEN s.physical_stock - (s.initial_stock + s.restocked_qty - s.sold_qty) ELSE 0 END), 0) AS total_variance,
            COALESCE(SUM(CASE WHEN s.physical_stock IS NOT NULL THEN 1 ELSE 0 END), 0) AS opname_days
        FROM daily_stock_item_snapshots s
        INNER JOIN stock_items st ON st.id = s.stock_item_id
        WHERE s.business_date BETWEEN ? AND ?
        GROUP BY s.stock_item_id, st.name, st.unit
        ORDER BY total_sold DESC, st.name ASC
        "#,
    )
    .bind(&from_date)
    .bind(&to_date)
    .fetch_all(&mut *tx)
    .await?;

    tx.commit().await?;

    let stock_summary: Vec<StockVarianceSummary> = stock_rows
        .into_iter()
        .map(|r| StockVarianceSummary {
            stock_item_id: r.stock_item_id,
            stock_name: r.stock_name,
            unit: r.unit,
            total_supplied: r.total_supplied,
            total_sold: r.total_sold,
            total_leftover: r.total_leftover,
            total_variance: r.total_variance,
            opname_days: r.opname_days,
        })
        .collect();

    let mut peak_hours: Vec<PeakHourStat> = hour_agg
        .into_iter()
        .map(|(h, (order_count, revenue))| PeakHourStat {
            hour: h,
            label: format!("{:02}:00", h),
            order_count,
            revenue,
        })
        .collect();
    peak_hours.sort_by_key(|p| p.hour);

    let day_names = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"];
    let by_weekday: Vec<WeekdayStat> = (0_u32..7)
        .map(|idx| {
            let (order_count, revenue) = weekday_agg.get(&idx).copied().unwrap_or((0, 0));
            WeekdayStat {
                weekday_index: idx,
                label: day_names[idx as usize].to_string(),
                order_count,
                revenue,
            }
        })
        .collect();

    let mut intervals_by_user: HashMap<String, Vec<i64>> = HashMap::new();
    for ((username, _day), mut timestamps) in user_day_timestamps {
        timestamps.sort_unstable();
        for pair in timestamps.windows(2) {
            let diff = (pair[1] - pair[0]).max(0);
            intervals_by_user.entry(username.clone()).or_default().push(diff);
        }
    }

    let mut user_order_intervals: Vec<UserOrderIntervalStat> = user_order_counts
        .into_iter()
        .map(|(username, orders_created)| {
            let samples = intervals_by_user.remove(&username).unwrap_or_default();
            if samples.is_empty() {
                UserOrderIntervalStat {
                    username,
                    orders_created,
                    interval_samples: 0,
                    avg_interval_seconds: None,
                    min_interval_seconds: None,
                    max_interval_seconds: None,
                }
            } else {
                let sum: i64 = samples.iter().sum();
                let avg = sum / (samples.len() as i64);
                let min = samples.iter().copied().min();
                let max = samples.iter().copied().max();
                UserOrderIntervalStat {
                    username,
                    orders_created,
                    interval_samples: samples.len() as i64,
                    avg_interval_seconds: Some(avg),
                    min_interval_seconds: min,
                    max_interval_seconds: max,
                }
            }
        })
        .collect();
    user_order_intervals.sort_by(|a, b| b.orders_created.cmp(&a.orders_created));

    Ok(Json(PerformanceAnalyticsResponse {
        from_date,
        to_date,
        summary: AnalyticsSummary {
            total_revenue,
            total_expenses,
            net_profit: total_revenue - total_expenses,
            total_orders,
            paid_orders,
            voided_orders,
            total_portions,
            avg_order_value,
            closed_days_count,
            active_days_count,
        },
        daily_trend,
        by_channel,
        top_menus,
        bottom_menus,
        stock_summary,
        peak_hours,
        by_weekday,
        user_order_intervals,
    }))
}
