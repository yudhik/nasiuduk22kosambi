use chrono::Local;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
    Sqlite, SqlitePool, Transaction,
};
use std::{path::Path, str::FromStr, time::Duration};

pub fn today_date() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

pub fn now_iso() -> String {
    Local::now().to_rfc3339()
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
        .busy_timeout(Duration::from_secs(5));

    if !is_memory {
        connect_opts = connect_opts.journal_mode(SqliteJournalMode::Wal);
    }

    let pool = SqlitePoolOptions::new()
        .max_connections(if is_memory { 1 } else { 5 })
        .connect_with(connect_opts)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;

    if seed_defaults {
        seed_initial_menu_if_empty(&pool).await?;
    }

    Ok(pool)
}

pub async fn ensure_daily_snapshot(
    tx: &mut Transaction<'_, Sqlite>,
    business_date: &str,
    menu_item_id: i64,
    initial_stock_if_missing: i64,
    now: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO daily_stock_snapshots (
            business_date, menu_item_id, initial_stock, restocked_qty, sold_qty, voided_qty, notes, updated_at
        )
        VALUES (?, ?, ?, 0, 0, 0, '', ?)
        ON CONFLICT(business_date, menu_item_id) DO NOTHING
        "#,
    )
    .bind(business_date)
    .bind(menu_item_id)
    .bind(initial_stock_if_missing)
    .bind(now)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

async fn seed_initial_menu_if_empty(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM menu_items")
        .fetch_one(pool)
        .await?;

    if count.0 > 0 {
        return Ok(());
    }

    let now = now_iso();
    let today = today_date();
    let samples = [
        ("Nasi Uduk Biasa", "Makanan", 10000_i64, 60_i64),
        ("Ayam Goreng", "Lauk", 18000, 40),
        ("Ayam Bakar", "Lauk", 20000, 30),
        ("Tahu / Tempe Goreng", "Lauk", 4000, 50),
        ("Telur Balado", "Lauk", 8000, 30),
        ("Perkedel Kentang", "Lauk", 5000, 30),
        ("Es Teh Manis", "Minuman", 5000, 80),
        ("Es Jeruk", "Minuman", 8000, 40),
        ("Air Mineral", "Minuman", 4000, 50),
    ];

    let mut tx = pool.begin().await?;
    for (name, category, price, stock) in samples {
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
        .bind(price)
        .bind(stock)
        .bind(stock)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;

        let menu_id = res.last_insert_rowid();
        ensure_daily_snapshot(&mut tx, &today, menu_id, stock, &now).await?;
        sqlx::query(
            r#"
            INSERT INTO stock_movements (
                business_date, menu_item_id, order_id, movement_type, qty_delta, stock_after, note, created_at
            )
            VALUES (?, ?, NULL, 'SET_INITIAL', ?, ?, 'Stok awal bawaan', ?)
            "#,
        )
        .bind(&today)
        .bind(menu_id)
        .bind(stock)
        .bind(stock)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}
