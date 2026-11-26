use std::collections::{HashMap, HashSet};

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderValue, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};

use crate::{
    auth::{AuthUser, Role},
    db::{begin_write_tx, now_iso},
    error::{AppError, AppResult},
    models::{
        CreateMenuRequest, ImportMenuCsvRequest, ImportMenuCsvResponse, MenuItem, MenuItemRow,
        MenuStockRequirementDetail, MenuStockRequirementInput, UpdateMenuRequest,
    },
    AppState,
};

const MAX_MENU_PRICE: i64 = 100_000_000;
const MAX_STOCK_REQS_PER_MENU: usize = 20;
const MAX_QTY_PER_UNIT: i64 = 1_000;

#[derive(Debug, Deserialize)]
pub struct MenuQuery {
    pub active_only: Option<bool>,
    pub category: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DeleteMenuResponse {
    pub deleted: bool,
    pub soft_deleted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, FromRow)]
struct RawMenuStockReq {
    menu_item_id: i64,
    stock_item_id: i64,
    stock_name: String,
    stock_unit: String,
    stock_current: i64,
    qty_per_unit: i64,
}

pub fn compute_available_stock(reqs: &[MenuStockRequirementDetail]) -> i64 {
    if reqs.is_empty() {
        return 0;
    }
    reqs.iter()
        .map(|r| {
            if r.qty_per_unit <= 0 || r.stock_current <= 0 {
                0
            } else {
                r.stock_current / r.qty_per_unit
            }
        })
        .min()
        .unwrap_or(0)
}

async fn hydrate_menus(pool: &SqlitePool, rows: Vec<MenuItemRow>) -> AppResult<Vec<MenuItem>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let reqs: Vec<RawMenuStockReq> = sqlx::query_as(
        r#"
        SELECT
            msr.menu_item_id,
            msr.stock_item_id,
            s.name AS stock_name,
            s.unit AS stock_unit,
            CASE WHEN s.is_active = 1 THEN s.current_stock ELSE 0 END AS stock_current,
            msr.qty_per_unit
        FROM menu_stock_requirements msr
        INNER JOIN stock_items s ON s.id = msr.stock_item_id
        ORDER BY msr.id ASC
        "#,
    )
    .fetch_all(pool)
    .await?;

    let mut reqs_by_menu: HashMap<i64, Vec<MenuStockRequirementDetail>> = HashMap::new();
    for r in reqs {
        reqs_by_menu
            .entry(r.menu_item_id)
            .or_default()
            .push(MenuStockRequirementDetail {
                stock_item_id: r.stock_item_id,
                stock_name: r.stock_name,
                stock_unit: r.stock_unit,
                stock_current: r.stock_current,
                qty_per_unit: r.qty_per_unit,
            });
    }

    Ok(rows
        .into_iter()
        .map(|m| {
            let stock_requirements = reqs_by_menu.remove(&m.id).unwrap_or_default();
            let available_stock = compute_available_stock(&stock_requirements);
            MenuItem {
                id: m.id,
                name: m.name,
                category: m.category,
                price: m.price,
                available_stock,
                is_active: m.is_active,
                created_at: m.created_at,
                updated_at: m.updated_at,
                stock_requirements,
            }
        })
        .collect())
}

async fn fetch_one_hydrated_menu(pool: &SqlitePool, id: i64) -> AppResult<MenuItem> {
    let m: MenuItemRow = sqlx::query_as(
        "SELECT id, name, category, price, is_active, created_at, updated_at FROM menu_items WHERE id = ?",
    )
    .bind(id)
    .fetch_one(pool)
    .await?;

    let stock_requirements: Vec<MenuStockRequirementDetail> = sqlx::query_as(
        r#"
        SELECT
            msr.stock_item_id,
            s.name AS stock_name,
            s.unit AS stock_unit,
            CASE WHEN s.is_active = 1 THEN s.current_stock ELSE 0 END AS stock_current,
            msr.qty_per_unit
        FROM menu_stock_requirements msr
        INNER JOIN stock_items s ON s.id = msr.stock_item_id
        WHERE msr.menu_item_id = ?
        ORDER BY msr.id ASC
        "#,
    )
    .bind(id)
    .fetch_all(pool)
    .await?;

    let available_stock = compute_available_stock(&stock_requirements);
    Ok(MenuItem {
        id: m.id,
        name: m.name,
        category: m.category,
        price: m.price,
        available_stock,
        is_active: m.is_active,
        created_at: m.created_at,
        updated_at: m.updated_at,
        stock_requirements,
    })
}

fn validate_requirements(
    reqs: &[MenuStockRequirementInput],
) -> AppResult<Vec<MenuStockRequirementInput>> {
    if reqs.is_empty() {
        return Err(AppError::Validation(
            "Setiap menu wajib terhubung dengan minimal 1 item stok".into(),
        ));
    }
    if reqs.len() > MAX_STOCK_REQS_PER_MENU {
        return Err(AppError::Validation(format!(
            "Satu menu maksimal terhubung dengan {MAX_STOCK_REQS_PER_MENU} item stok"
        )));
    }

    let mut seen = HashSet::new();
    let mut cleaned = Vec::with_capacity(reqs.len());
    for req in reqs {
        if req.qty_per_unit <= 0 || req.qty_per_unit > MAX_QTY_PER_UNIT {
            return Err(AppError::Validation(format!(
                "Jumlah pemakaian stok per porsi harus antara 1 hingga {MAX_QTY_PER_UNIT}"
            )));
        }
        if !seen.insert(req.stock_item_id) {
            return Err(AppError::Validation(
                "Item stok yang sama tidak boleh dipilih dua kali dalam satu menu".into(),
            ));
        }
        cleaned.push(req.clone());
    }
    Ok(cleaned)
}

pub async fn list_menus(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(query): Query<MenuQuery>,
) -> AppResult<Json<Vec<MenuItem>>> {
    auth.require_roles(&[Role::Waiter, Role::Owner, Role::Admin])?;
    let active_only = query.active_only.unwrap_or(false);
    let category = query
        .category
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let rows: Vec<MenuItemRow> = match (active_only, category) {
        (true, Some(cat)) => {
            sqlx::query_as(
                "SELECT id, name, category, price, is_active, created_at, updated_at FROM menu_items WHERE is_active = 1 AND category = ? ORDER BY category ASC, name ASC",
            )
            .bind(cat)
            .fetch_all(&state.pool)
            .await?
        }
        (true, None) => {
            sqlx::query_as(
                "SELECT id, name, category, price, is_active, created_at, updated_at FROM menu_items WHERE is_active = 1 ORDER BY category ASC, name ASC",
            )
            .fetch_all(&state.pool)
            .await?
        }
        (false, Some(cat)) => {
            sqlx::query_as(
                "SELECT id, name, category, price, is_active, created_at, updated_at FROM menu_items WHERE category = ? ORDER BY is_active DESC, category ASC, name ASC",
            )
            .bind(cat)
            .fetch_all(&state.pool)
            .await?
        }
        (false, None) => {
            sqlx::query_as(
                "SELECT id, name, category, price, is_active, created_at, updated_at FROM menu_items ORDER BY is_active DESC, category ASC, name ASC",
            )
            .fetch_all(&state.pool)
            .await?
        }
    };

    let hydrated = hydrate_menus(&state.pool, rows).await?;
    Ok(Json(hydrated))
}

pub async fn create_menu(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(req): Json<CreateMenuRequest>,
) -> AppResult<(StatusCode, Json<MenuItem>)> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;
    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(AppError::Validation(
            "Nama menu wajib diisi (maksimal 120 karakter)".into(),
        ));
    }
    if req.price < 0 || req.price > MAX_MENU_PRICE {
        return Err(AppError::Validation(format!(
            "Harga menu harus antara Rp 0 hingga Rp {MAX_MENU_PRICE}"
        )));
    }
    if let Some(self_qty) = req.create_self_stock_qty {
        if self_qty <= 0 || self_qty > MAX_QTY_PER_UNIT {
            return Err(AppError::Validation(format!(
                "Jumlah pemakaian stok per porsi harus antara 1 hingga {MAX_QTY_PER_UNIT}"
            )));
        }
    }
    if req.stock_requirements.is_empty() && req.create_self_stock_qty.is_none() {
        return Err(AppError::Validation(
            "Setiap menu wajib terhubung dengan minimal 1 item stok".into(),
        ));
    }
    let mut requirements = if req.stock_requirements.is_empty() {
        Vec::new()
    } else {
        validate_requirements(&req.stock_requirements)?
    };

    let category: String = req
        .category
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Makanan")
        .chars()
        .take(64)
        .collect();
    let now = now_iso();

    let mut tx = begin_write_tx(&state.pool).await?;

    let dup: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM menu_items WHERE LOWER(name) = LOWER(?) LIMIT 1")
            .bind(name)
            .fetch_optional(&mut *tx)
            .await?;
    if dup.is_some() {
        return Err(AppError::Conflict(format!("Menu '{name}' sudah terdaftar")));
    }

    if let Some(self_qty) = req.create_self_stock_qty {
        let existing_stock: Option<(i64, i64)> = sqlx::query_as(
            "SELECT id, is_active FROM stock_items WHERE LOWER(name) = LOWER(?) LIMIT 1",
        )
        .bind(name)
        .fetch_optional(&mut *tx)
        .await?;

        let self_stock_id = match existing_stock {
            Some((sid, 1)) => sid,
            Some((sid, _)) => {
                sqlx::query("UPDATE stock_items SET is_active = 1, updated_at = ? WHERE id = ?")
                    .bind(&now)
                    .bind(sid)
                    .execute(&mut *tx)
                    .await?;
                sid
            }
            None => {
                let sres = sqlx::query(
                    r#"
                    INSERT INTO stock_items (name, unit, current_stock, is_active, created_at, updated_at)
                    VALUES (?, 'porsi', 0, 1, ?, ?)
                    "#,
                )
                .bind(name)
                .bind(&now)
                .bind(&now)
                .execute(&mut *tx)
                .await?;
                sres.last_insert_rowid()
            }
        };

        if !requirements.iter().any(|r| r.stock_item_id == self_stock_id) {
            requirements.push(MenuStockRequirementInput {
                stock_item_id: self_stock_id,
                qty_per_unit: self_qty,
            });
        }
    }

    let requirements = validate_requirements(&requirements)?;

    for r in &requirements {
        let stock_active: Option<(i64,)> =
            sqlx::query_as("SELECT is_active FROM stock_items WHERE id = ?")
                .bind(r.stock_item_id)
                .fetch_optional(&mut *tx)
                .await?;
        match stock_active {
            None => {
                return Err(AppError::NotFound(format!(
                    "Item stok #{} tidak ditemukan",
                    r.stock_item_id
                )))
            }
            Some((0,)) => {
                return Err(AppError::Validation(format!(
                    "Item stok #{} sedang tidak aktif",
                    r.stock_item_id
                )))
            }
            _ => {}
        }
    }

    let res = sqlx::query(
        r#"
        INSERT INTO menu_items (
            name, category, price, current_stock, default_daily_stock, is_active, created_at, updated_at
        )
        VALUES (?, ?, ?, 0, 0, 1, ?, ?)
        "#,
    )
    .bind(name)
    .bind(&category)
    .bind(req.price)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    let menu_id = res.last_insert_rowid();
    for r in &requirements {
        sqlx::query(
            "INSERT INTO menu_stock_requirements (menu_item_id, stock_item_id, qty_per_unit) VALUES (?, ?, ?)",
        )
        .bind(menu_id)
        .bind(r.stock_item_id)
        .bind(r.qty_per_unit)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    let created = fetch_one_hydrated_menu(&state.pool, menu_id).await?;
    Ok((StatusCode::CREATED, Json(created)))
}

pub async fn update_menu(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateMenuRequest>,
) -> AppResult<Json<MenuItem>> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;
    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(AppError::Validation(
            "Nama menu wajib diisi (maksimal 120 karakter)".into(),
        ));
    }
    if req.price < 0 || req.price > MAX_MENU_PRICE {
        return Err(AppError::Validation(format!(
            "Harga menu harus antara Rp 0 hingga Rp {MAX_MENU_PRICE}"
        )));
    }
    let requirements = validate_requirements(&req.stock_requirements)?;

    let cat_raw = req.category.trim();
    let category: String = if cat_raw.is_empty() {
        "Makanan".to_string()
    } else {
        cat_raw.chars().take(64).collect()
    };
    let is_active = if req.is_active { 1_i64 } else { 0_i64 };
    let now = now_iso();

    let mut tx = begin_write_tx(&state.pool).await?;

    let exists: Option<(i64,)> = sqlx::query_as("SELECT id FROM menu_items WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!("Menu #{id} tidak ditemukan")));
    }

    let dup: Option<(i64,)> = sqlx::query_as(
        "SELECT id FROM menu_items WHERE LOWER(name) = LOWER(?) AND id != ? LIMIT 1",
    )
    .bind(name)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    if dup.is_some() {
        return Err(AppError::Conflict(format!("Menu '{name}' sudah digunakan")));
    }

    for r in &requirements {
        let stock_exists: Option<(i64,)> =
            sqlx::query_as("SELECT is_active FROM stock_items WHERE id = ?")
                .bind(r.stock_item_id)
                .fetch_optional(&mut *tx)
                .await?;
        match stock_exists {
            None => {
                return Err(AppError::NotFound(format!(
                    "Item stok #{} tidak ditemukan",
                    r.stock_item_id
                )))
            }
            Some((0,)) if req.is_active => {
                return Err(AppError::Validation(format!(
                    "Item stok #{} sedang tidak aktif",
                    r.stock_item_id
                )))
            }
            _ => {}
        }
    }

    sqlx::query(
        r#"
        UPDATE menu_items
        SET name = ?, category = ?, price = ?, is_active = ?, updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(name)
    .bind(&category)
    .bind(req.price)
    .bind(is_active)
    .bind(&now)
    .bind(id)
    .execute(&mut *tx)
    .await?;

    sqlx::query("DELETE FROM menu_stock_requirements WHERE menu_item_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;

    for r in &requirements {
        sqlx::query(
            "INSERT INTO menu_stock_requirements (menu_item_id, stock_item_id, qty_per_unit) VALUES (?, ?, ?)",
        )
        .bind(id)
        .bind(r.stock_item_id)
        .bind(r.qty_per_unit)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    let updated = fetch_one_hydrated_menu(&state.pool, id).await?;
    Ok(Json(updated))
}

pub async fn delete_menu(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<DeleteMenuResponse>> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;
    let mut tx = begin_write_tx(&state.pool).await?;

    let exists: Option<(i64,)> = sqlx::query_as("SELECT id FROM menu_items WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

    if exists.is_none() {
        return Err(AppError::NotFound(format!("Menu #{id} tidak ditemukan")));
    }

    let (total_refs, voided_refs): (i64, i64) = sqlx::query_as(
        r#"
        SELECT
            COUNT(*),
            COALESCE(SUM(CASE WHEN o.status = 'VOIDED' THEN 1 ELSE 0 END), 0)
        FROM order_items oi
        INNER JOIN orders o ON o.id = oi.order_id
        WHERE oi.menu_item_id = ?
        "#,
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;

    if total_refs > 0 {
        let now = now_iso();
        sqlx::query("UPDATE menu_items SET is_active = 0, updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        let reason = if voided_refs == total_refs {
            "Menu pernah tercatat pada nota yang dibatalkan (VOID), sehingga diarsipkan agar riwayat nota tetap utuh."
        } else {
            "Menu pernah tercatat pada riwayat transaksi nota, sehingga diarsipkan agar laporan tetap akurat."
        };
        return Ok(Json(DeleteMenuResponse {
            deleted: true,
            soft_deleted: true,
            reason: Some(reason.to_string()),
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
    sqlx::query("DELETE FROM menu_stock_requirements WHERE menu_item_id = ?")
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
        reason: None,
    }))
}

fn parse_csv_line(line: &str, delimiter: char) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut chars = line.chars().peekable();
    let mut in_quotes = false;

    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    current.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                current.push(ch);
            }
        } else if ch == '"' && current.is_empty() {
            in_quotes = true;
        } else if ch == delimiter {
            fields.push(current.trim().to_string());
            current.clear();
        } else {
            current.push(ch);
        }
    }
    fields.push(current.trim().to_string());
    fields
}

/// Parses price strings safely, handling Indonesian thousand separators (10.000) and Excel decimal
/// exports (10000.00 / 10000,00) without 100x inflation.
fn parse_csv_price(raw: &str) -> Result<i64, String> {
    let cleaned = raw
        .trim()
        .trim_start_matches("Rp")
        .trim_start_matches("rp")
        .trim()
        .replace(' ', "");

    if cleaned.is_empty() {
        return Err("harga kosong".into());
    }

    // Strip trailing .00 or ,00 decimal cents (e.g. Excel exporting 10000.00 or 10.000,00)
    let without_cents = if let Some(prefix) = cleaned.strip_suffix(".00") {
        prefix
    } else if let Some(prefix) = cleaned.strip_suffix(",00") {
        prefix
    } else {
        cleaned.as_str()
    };

    // Strip thousand separators (dots or commas) only if remaining string is pure digits
    let digits = without_cents.replace(['.', ','], "");
    let price = digits
        .parse::<i64>()
        .map_err(|_| format!("harga '{raw}' tidak valid"))?;

    if price < 0 || price > MAX_MENU_PRICE {
        return Err(format!("harga harus antara 0 hingga {MAX_MENU_PRICE}"));
    }
    Ok(price)
}

fn parse_stock_items_spec(spec: &str, fallback_name: &str) -> Result<Vec<(String, i64)>, String> {
    let trimmed = spec.trim();
    if trimmed.is_empty() {
        return Ok(vec![(fallback_name.to_string(), 1)]);
    }

    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for part in trimmed.split('|') {
        let p = part.trim();
        if p.is_empty() {
            continue;
        }
        if out.len() >= MAX_STOCK_REQS_PER_MENU {
            return Err(format!(
                "maksimal {MAX_STOCK_REQS_PER_MENU} item stok per menu"
            ));
        }
        let (sname, qty) = match p.rsplit_once(':') {
            Some((left, right)) => {
                let q = right
                    .trim()
                    .parse::<i64>()
                    .map_err(|_| format!("jumlah stok tidak valid pada '{p}'"))?;
                if q <= 0 || q > MAX_QTY_PER_UNIT {
                    return Err(format!(
                        "jumlah stok harus antara 1 hingga {MAX_QTY_PER_UNIT} pada '{p}'"
                    ));
                }
                (left.trim().to_string(), q)
            }
            None => (p.to_string(), 1),
        };
        if sname.is_empty() || sname.chars().count() > 120 {
            return Err(format!("nama item stok tidak valid pada '{p}'"));
        }
        let key = sname.to_ascii_lowercase();
        if !seen.insert(key) {
            return Err(format!("item stok duplikat '{sname}' dalam satu menu"));
        }
        out.push((sname, qty));
    }

    if out.is_empty() {
        Ok(vec![(fallback_name.to_string(), 1)])
    } else {
        Ok(out)
    }
}

pub async fn import_menus_csv(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(req): Json<ImportMenuCsvRequest>,
) -> AppResult<Json<ImportMenuCsvResponse>> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;

    const MAX_CSV_BYTES: usize = 1024 * 1024;
    const MAX_CSV_ROWS: usize = 1000;

    let raw = req.csv_content.trim_start_matches('\u{feff}').trim();
    if raw.is_empty() {
        return Err(AppError::Validation("Isi file CSV tidak boleh kosong".into()));
    }
    if raw.len() > MAX_CSV_BYTES {
        return Err(AppError::Validation(
            "Ukuran file CSV melebihi batas maksimal 1 MB".into(),
        ));
    }

    let lines: Vec<&str> = raw
        .lines()
        .map(|l| l.trim_end_matches('\r'))
        .filter(|l| !l.trim().is_empty())
        .collect();

    if lines.is_empty() {
        return Err(AppError::Validation("File CSV tidak memiliki data".into()));
    }
    if lines.len() > MAX_CSV_ROWS + 1 {
        return Err(AppError::Validation(format!(
            "Jumlah baris CSV melebihi batas maksimal ({MAX_CSV_ROWS} baris)"
        )));
    }

    let header_line = lines[0];
    let delimiter = if header_line.matches(';').count() > header_line.matches(',').count() {
        ';'
    } else {
        ','
    };

    let first_fields = parse_csv_line(header_line, delimiter);
    let has_header = first_fields
        .first()
        .map(|s| {
            let lower = s.to_ascii_lowercase();
            matches!(lower.as_str(), "name" | "nama" | "nama_menu" | "menu")
        })
        .unwrap_or(false);

    let data_lines = if has_header { &lines[1..] } else { &lines[..] };
    if data_lines.is_empty() {
        return Err(AppError::Validation(
            "File CSV hanya berisi header tanpa baris menu".into(),
        ));
    }

    let now = now_iso();
    let mut tx = begin_write_tx(&state.pool).await?;

    let existing_menus: Vec<(String,)> = sqlx::query_as("SELECT name FROM menu_items")
        .fetch_all(&mut *tx)
        .await?;
    let mut known_menu_names: HashSet<String> = existing_menus
        .into_iter()
        .map(|(n,)| n.trim().to_ascii_lowercase())
        .collect();

    // Track (stock_id, is_active) so inactive stock items are reactivated when linked by a newly imported active menu
    let existing_stocks: Vec<(i64, String, i64)> =
        sqlx::query_as("SELECT id, name, is_active FROM stock_items")
            .fetch_all(&mut *tx)
            .await?;
    let mut stock_by_lower: HashMap<String, (i64, bool)> = existing_stocks
        .into_iter()
        .map(|(id, n, active)| (n.trim().to_ascii_lowercase(), (id, active != 0)))
        .collect();

    let mut imported_count = 0_usize;
    let mut skipped_names = Vec::new();
    let mut created_stock_items = 0_usize;
    let mut errors = Vec::new();

    for (idx, line) in data_lines.iter().enumerate() {
        let row_num = if has_header { idx + 2 } else { idx + 1 };
        let fields = parse_csv_line(line, delimiter);
        if fields.len() < 3 {
            errors.push(format!(
                "Baris {row_num}: minimal 3 kolom (name,category,price)"
            ));
            continue;
        }

        let name = fields[0].trim();
        let category = fields[1].trim();
        let stock_spec = fields.get(3).map(String::as_str).unwrap_or("");

        if name.is_empty() || name.chars().count() > 120 {
            errors.push(format!(
                "Baris {row_num}: nama menu kosong atau lebih dari 120 karakter"
            ));
            continue;
        }

        let lower_name = name.to_ascii_lowercase();
        if known_menu_names.contains(&lower_name) {
            skipped_names.push(name.to_string());
            continue;
        }

        let price = match parse_csv_price(&fields[2]) {
            Ok(p) => p,
            Err(e) => {
                errors.push(format!("Baris {row_num} ('{name}'): {e}"));
                continue;
            }
        };

        let req_specs = match parse_stock_items_spec(stock_spec, name) {
            Ok(v) => v,
            Err(e) => {
                errors.push(format!("Baris {row_num} ('{name}'): {e}"));
                continue;
            }
        };

        let cat: String = if category.is_empty() {
            "Makanan".to_string()
        } else {
            category.chars().take(64).collect()
        };

        let menu_res = sqlx::query(
            r#"
            INSERT INTO menu_items (
                name, category, price, current_stock, default_daily_stock, is_active, created_at, updated_at
            )
            VALUES (?, ?, ?, 0, 0, 1, ?, ?)
            "#,
        )
        .bind(name)
        .bind(&cat)
        .bind(price)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;

        let menu_id = menu_res.last_insert_rowid();

        for (stock_name, qty) in req_specs {
            let key = stock_name.to_ascii_lowercase();
            let stock_id = if let Some(&(sid, was_active)) = stock_by_lower.get(&key) {
                if !was_active {
                    sqlx::query(
                        "UPDATE stock_items SET is_active = 1, updated_at = ? WHERE id = ?",
                    )
                    .bind(&now)
                    .bind(sid)
                    .execute(&mut *tx)
                    .await?;
                    stock_by_lower.insert(key, (sid, true));
                }
                sid
            } else {
                let sres = sqlx::query(
                    r#"
                    INSERT INTO stock_items (name, unit, current_stock, is_active, created_at, updated_at)
                    VALUES (?, 'porsi', 0, 1, ?, ?)
                    "#,
                )
                .bind(&stock_name)
                .bind(&now)
                .bind(&now)
                .execute(&mut *tx)
                .await?;
                let sid = sres.last_insert_rowid();
                stock_by_lower.insert(key, (sid, true));
                created_stock_items += 1;
                sid
            };

            sqlx::query(
                "INSERT INTO menu_stock_requirements (menu_item_id, stock_item_id, qty_per_unit) VALUES (?, ?, ?)",
            )
            .bind(menu_id)
            .bind(stock_id)
            .bind(qty)
            .execute(&mut *tx)
            .await?;
        }

        known_menu_names.insert(lower_name);
        imported_count += 1;
    }

    tx.commit().await?;

    Ok(Json(ImportMenuCsvResponse {
        imported_count,
        skipped_count: skipped_names.len(),
        skipped_names,
        created_stock_items,
        errors,
    }))
}

pub async fn download_menu_csv_template(auth: AuthUser) -> AppResult<impl IntoResponse> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;

    let template = "\
name,category,price,stock_items
Nasi Uduk Biasa,Makanan,10000,Nasi Uduk:1
Ayam Goreng,Lauk,18000,Ayam Goreng:1
Paket Nasi Uduk Ayam Goreng,Paket,26000,Nasi Uduk:1|Ayam Goreng:1
Es Teh Manis,Minuman,5000,Es Teh Manis:1
";

    let headers = [
        (
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/csv; charset=utf-8"),
        ),
        (
            header::CONTENT_DISPOSITION,
            HeaderValue::from_static("attachment; filename=\"template-menu.csv\""),
        ),
    ];

    Ok((headers, template))
}
