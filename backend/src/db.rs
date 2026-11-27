use chrono::{Datelike, Local, NaiveDate};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
    Sqlite, SqlitePool, Transaction,
};
use std::{path::Path, str::FromStr, time::Duration};

use crate::error::{AppError, AppResult};

/// Returns `(business_date YYYY-MM-DD, rfc3339_timestamp)` from a single clock read
/// to prevent midnight split inconsistencies.
pub fn now_business_and_iso() -> (String, String) {
    let now = Local::now();
    (
        now.format("%Y-%m-%d").to_string(),
        now.to_rfc3339(),
    )
}

pub fn today_date() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

pub fn now_iso() -> String {
    Local::now().to_rfc3339()
}

/// Returns `(YYYY-MM-DDTHH:MM, day_of_week 0=Mon..6=Sun, HH:MM)` in local store time from a single clock read.
pub fn now_local_schedule_clock() -> (String, i64, String) {
    let now = Local::now();
    (
        now.format("%Y-%m-%dT%H:%M").to_string(),
        now.weekday().num_days_from_monday() as i64,
        now.format("%H:%M").to_string(),
    )
}

/// Validates and normalizes an optional `YYYY-MM-DD` business date query/body parameter.
pub fn parse_business_date(raw: Option<&str>) -> AppResult<String> {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => {
            let parsed = NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| {
                AppError::Validation("Format tanggal tidak valid (harus YYYY-MM-DD)".into())
            })?;
            Ok(parsed.format("%Y-%m-%d").to_string())
        }
        None => Ok(today_date()),
    }
}

pub async fn init_pool(database_url: &str, seed_defaults: bool) -> Result<SqlitePool, sqlx::Error> {
    let is_memory = database_url.contains(":memory:");

    if !is_memory {
        if let Some(raw_path) = database_url
            .strip_prefix("sqlite://")
            .or_else(|| database_url.strip_prefix("sqlite:"))
        {
            let file_path = raw_path.split('?').next().unwrap_or(raw_path);
            if let Some(parent) = Path::new(file_path).parent() {
                if !parent.as_os_str().is_empty() {
                    let _ = std::fs::create_dir_all(parent);
                }
            }
        }
    }

    let mut connect_opts = SqliteConnectOptions::from_str(database_url)?
        .create_if_missing(true)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5))
        .pragma("temp_store", "MEMORY")
        .pragma("cache_size", "-8000")
        .pragma("mmap_size", "0");

    if !is_memory {
        connect_opts = connect_opts
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal);
    }

    let pool = SqlitePoolOptions::new()
        .max_connections(if is_memory { 1 } else { 5 })
        .acquire_timeout(Duration::from_secs(10))
        .connect_with(connect_opts)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;

    if seed_defaults {
        seed_initial_catalog_if_empty(&pool).await?;
    }

    Ok(pool)
}

/// Opens an existing SQLite DB without creating a new file or running migrations (for CLI commands like `unlock-user`).
pub async fn init_pool_existing_only(database_url: &str) -> Result<SqlitePool, sqlx::Error> {
    let connect_opts = SqliteConnectOptions::from_str(database_url)?
        .create_if_missing(false)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));

    SqlitePoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(5))
        .connect_with(connect_opts)
        .await
}

pub async fn begin_write_tx(pool: &SqlitePool) -> Result<Transaction<'_, Sqlite>, sqlx::Error> {
    pool.begin_with("BEGIN IMMEDIATE").await
}

pub async fn ensure_daily_stock_snapshot(
    tx: &mut Transaction<'_, Sqlite>,
    business_date: &str,
    stock_item_id: i64,
    initial_stock_if_missing: i64,
    now: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO daily_stock_item_snapshots (
            business_date, stock_item_id, initial_stock, restocked_qty, sold_qty, voided_qty, notes, updated_at
        )
        VALUES (?, ?, ?, 0, 0, 0, '', ?)
        ON CONFLICT(business_date, stock_item_id) DO NOTHING
        "#,
    )
    .bind(business_date)
    .bind(stock_item_id)
    .bind(initial_stock_if_missing)
    .bind(now)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

pub async fn get_store_day_status_tx(
    tx: &mut Transaction<'_, Sqlite>,
    business_date: &str,
) -> Result<String, sqlx::Error> {
    let status: Option<(String,)> =
        sqlx::query_as("SELECT status FROM store_days WHERE business_date = ?")
            .bind(business_date)
            .fetch_optional(&mut **tx)
            .await?;

    Ok(status
        .map(|(s,)| s)
        .unwrap_or_else(|| "NOT_OPENED".to_string()))
}

pub async fn get_store_day_status(
    pool: &SqlitePool,
    business_date: &str,
) -> Result<String, sqlx::Error> {
    let status: Option<(String,)> =
        sqlx::query_as("SELECT status FROM store_days WHERE business_date = ?")
            .bind(business_date)
            .fetch_optional(pool)
            .await?;

    Ok(status
        .map(|(s,)| s)
        .unwrap_or_else(|| "NOT_OPENED".to_string()))
}

async fn seed_initial_catalog_if_empty(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let menu_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM menu_items")
        .fetch_one(pool)
        .await?;
    let stock_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM stock_items")
        .fetch_one(pool)
        .await?;

    if menu_count.0 > 0 || stock_count.0 > 0 {
        return Ok(());
    }

    let now = now_iso();
    let stock_names = [
        ("Nasi Uduk", "porsi"),
        ("Ayam Goreng", "potong"),
        ("Ayam Bakar", "potong"),
        ("Tahu / Tempe Goreng", "potong"),
        ("Telur Balado", "butir"),
        ("Perkedel Kentang", "buah"),
        ("Es Teh Manis", "gelas"),
        ("Es Jeruk", "gelas"),
        ("Air Mineral", "botol"),
    ];

    let mut tx = begin_write_tx(pool).await?;
    let mut stock_ids = std::collections::HashMap::<&str, i64>::new();

    for (name, unit) in stock_names {
        let res = sqlx::query(
            r#"
            INSERT INTO stock_items (name, unit, current_stock, is_active, created_at, updated_at)
            VALUES (?, ?, 0, 1, ?, ?)
            "#,
        )
        .bind(name)
        .bind(unit)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        stock_ids.insert(name, res.last_insert_rowid());
    }

    let menus: Vec<(&str, &str, i64, Vec<(&str, i64)>)> = vec![
        ("Nasi Uduk Biasa", "Makanan", 10000, vec![("Nasi Uduk", 1)]),
        (
            "Paket Nasi Uduk Ayam Goreng",
            "Paket",
            26000,
            vec![("Nasi Uduk", 1), ("Ayam Goreng", 1)],
        ),
        (
            "Paket Nasi Uduk Ayam Bakar",
            "Paket",
            28000,
            vec![("Nasi Uduk", 1), ("Ayam Bakar", 1)],
        ),
        ("Ayam Goreng", "Lauk", 18000, vec![("Ayam Goreng", 1)]),
        ("Ayam Bakar", "Lauk", 20000, vec![("Ayam Bakar", 1)]),
        (
            "Tahu / Tempe Goreng",
            "Lauk",
            4000,
            vec![("Tahu / Tempe Goreng", 1)],
        ),
        ("Telur Balado", "Lauk", 8000, vec![("Telur Balado", 1)]),
        (
            "Perkedel Kentang",
            "Lauk",
            5000,
            vec![("Perkedel Kentang", 1)],
        ),
        ("Es Teh Manis", "Minuman", 5000, vec![("Es Teh Manis", 1)]),
        ("Es Jeruk", "Minuman", 8000, vec![("Es Jeruk", 1)]),
        ("Air Mineral", "Minuman", 4000, vec![("Air Mineral", 1)]),
    ];

    for (name, category, price, reqs) in menus {
        let res = sqlx::query(
            r#"
            INSERT INTO menu_items (
                name, category, price, current_stock, default_daily_stock, is_active, created_at, updated_at
            )
            VALUES (?, ?, ?, 0, 0, 1, ?, ?)
            "#,
        )
        .bind(name)
        .bind(category)
        .bind(price)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;

        let menu_id = res.last_insert_rowid();
        for (stock_name, qty) in reqs {
            if let Some(&stock_id) = stock_ids.get(stock_name) {
                sqlx::query(
                    "INSERT INTO menu_stock_requirements (menu_item_id, stock_item_id, qty_per_unit) VALUES (?, ?, ?)",
                )
                .bind(menu_id)
                .bind(stock_id)
                .bind(qty)
                .execute(&mut *tx)
                .await?;
            }
        }
    }

    tx.commit().await?;
    Ok(())
}
