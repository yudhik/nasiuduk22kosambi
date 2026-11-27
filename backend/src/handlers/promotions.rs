use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::NaiveDate;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    auth::{AuthUser, Role},
    db::{begin_write_tx, now_iso, today_date},
    error::{AppError, AppResult},
    models::{
        CreatePromotionRequest, PromotionResponse, PromotionRow, UpdatePromotionRequest,
    },
    AppState,
};

#[derive(Debug, Deserialize)]
pub struct ListPromotionsQuery {
    pub active_only: Option<bool>,
}

fn is_disallowed_unicode(c: char) -> bool {
    matches!(
        c,
        '\u{061C}'
            | '\u{200E}'
            | '\u{200F}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2066}'..='\u{2069}'
    )
}

fn sanitize_promo_multiline(raw: &str) -> String {
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
    normalized
        .chars()
        .filter(|&c| !(c.is_control() && c != '\n') && !is_disallowed_unicode(c))
        .collect::<String>()
        .trim()
        .to_string()
}

fn sanitize_media_value(raw: &str) -> String {
    raw.chars()
        .filter(|&c| !c.is_control() && !is_disallowed_unicode(c))
        .collect::<String>()
        .trim()
        .to_string()
}

fn parse_optional_date(raw: Option<&str>, field_label: &str) -> AppResult<Option<String>> {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => {
            let parsed = NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| {
                AppError::Validation(format!(
                    "{field_label} tidak valid (harus format YYYY-MM-DD)."
                ))
            })?;
            Ok(Some(parsed.format("%Y-%m-%d").to_string()))
        }
        None => Ok(None),
    }
}

struct ValidatedPromo {
    name: String,
    discount_type: &'static str,
    discount_value: i64,
    max_discount: Option<i64>,
    min_order_amount: i64,
    quota_type: &'static str,
    quota_limit: Option<i64>,
    start_date: Option<String>,
    end_date: Option<String>,
    regular_only: i64,
    receipt_promo_text: String,
    receipt_media_type: &'static str,
    receipt_media_value: String,
}

#[allow(clippy::too_many_arguments)]
fn validate_promo_fields(
    name: &str,
    discount_type: &str,
    discount_value: i64,
    max_discount: Option<i64>,
    min_order_amount: i64,
    quota_type: &str,
    quota_limit: Option<i64>,
    start_date: Option<&str>,
    end_date: Option<&str>,
    regular_only: bool,
    receipt_promo_text: Option<&str>,
    receipt_media_type: Option<&str>,
    receipt_media_value: Option<&str>,
) -> AppResult<ValidatedPromo> {
    let cleaned_name = sanitize_media_value(name);
    if cleaned_name.is_empty() || cleaned_name.chars().count() > 80 {
        return Err(AppError::Validation(
            "Nama promo wajib diisi (maksimal 80 karakter).".into(),
        ));
    }

    let dtype: &'static str = match discount_type.trim().to_ascii_uppercase().as_str() {
        "FIXED" => "FIXED",
        "PERCENT" => "PERCENT",
        _ => {
            return Err(AppError::Validation(
                "Tipe diskon harus FIXED atau PERCENT.".into(),
            ))
        }
    };

    if dtype == "FIXED" {
        if discount_value <= 0 || discount_value > 100_000_000 {
            return Err(AppError::Validation(
                "Nominal diskon harus antara Rp1 hingga Rp100.000.000.".into(),
            ));
        }
    } else if !(1..=100).contains(&discount_value) {
        return Err(AppError::Validation(
            "Persentase diskon harus antara 1% hingga 100%.".into(),
        ));
    }

    let clean_max_discount = if dtype == "PERCENT" {
        match max_discount {
            Some(v) if v <= 0 || v > 100_000_000 => {
                return Err(AppError::Validation(
                    "Batas maksimal diskon harus antara Rp1 hingga Rp100.000.000.".into(),
                ));
            }
            other => other,
        }
    } else {
        None
    };

    if !(0..=100_000_000).contains(&min_order_amount) {
        return Err(AppError::Validation(
            "Minimal belanja harus antara Rp0 hingga Rp100.000.000.".into(),
        ));
    }

    let qtype: &'static str = match quota_type.trim().to_ascii_uppercase().as_str() {
        "UNLIMITED" => "UNLIMITED",
        "TOTAL" => "TOTAL",
        "DAILY" => "DAILY",
        _ => {
            return Err(AppError::Validation(
                "Tipe kuota harus UNLIMITED, TOTAL, atau DAILY.".into(),
            ))
        }
    };

    let clean_quota_limit = match qtype {
        "UNLIMITED" => None,
        "TOTAL" | "DAILY" => match quota_limit {
            Some(v) if (1..=1_000_000).contains(&v) => Some(v),
            _ => {
                return Err(AppError::Validation(
                    "Jumlah kuota wajib diisi antara 1 hingga 1.000.000.".into(),
                ))
            }
        },
        _ => None,
    };

    let clean_start = parse_optional_date(start_date, "Tanggal mulai")?;
    let clean_end = parse_optional_date(end_date, "Tanggal berakhir")?;
    if let (Some(s), Some(e)) = (&clean_start, &clean_end) {
        if s > e {
            return Err(AppError::Validation(
                "Tanggal mulai tidak boleh melebihi tanggal berakhir.".into(),
            ));
        }
    }

    let clean_promo_text = sanitize_promo_multiline(receipt_promo_text.unwrap_or(""));
    if clean_promo_text.chars().count() > 300 {
        return Err(AppError::Validation(
            "Teks bagian promo struk maksimal 300 karakter.".into(),
        ));
    }
    if clean_promo_text.lines().count() > 6 {
        return Err(AppError::Validation(
            "Teks bagian promo struk maksimal 6 baris.".into(),
        ));
    }

    let mtype: &'static str = match receipt_media_type
        .unwrap_or("NONE")
        .trim()
        .to_ascii_uppercase()
        .as_str()
    {
        "NONE" | "" => "NONE",
        "QR" => "QR",
        "BARCODE" => "BARCODE",
        _ => {
            return Err(AppError::Validation(
                "Tipe media struk harus NONE, QR, atau BARCODE.".into(),
            ))
        }
    };

    let clean_media_val = match mtype {
        "NONE" => String::new(),
        "QR" => {
            let v = sanitize_media_value(receipt_media_value.unwrap_or(""));
            if v.is_empty() || v.len() > 500 {
                return Err(AppError::Validation(
                    "Link / teks QR Code wajib diisi (maksimal 500 byte).".into(),
                ));
            }
            v
        }
        "BARCODE" => {
            let v = sanitize_media_value(receipt_media_value.unwrap_or(""));
            if v.is_empty()
                || v.len() > 48
                || !v
                    .bytes()
                    .all(|b| (0x20..=0x7E).contains(&b) && b != b'{')
            {
                return Err(AppError::Validation(
                    "Nilai Barcode (CODE128) wajib berupa karakter ASCII standar tanpa '{' (1–48 karakter)."
                        .into(),
                ));
            }
            v
        }
        _ => String::new(),
    };

    Ok(ValidatedPromo {
        name: cleaned_name,
        discount_type: dtype,
        discount_value,
        max_discount: clean_max_discount,
        min_order_amount,
        quota_type: qtype,
        quota_limit: clean_quota_limit,
        start_date: clean_start,
        end_date: clean_end,
        regular_only: if regular_only { 1 } else { 0 },
        receipt_promo_text: clean_promo_text,
        receipt_media_type: mtype,
        receipt_media_value: clean_media_val,
    })
}

async fn hydrate_promotion_response(
    pool: &sqlx::SqlitePool,
    row: PromotionRow,
    today: &str,
) -> AppResult<PromotionResponse> {
    let (used_total, used_today): (i64, i64) = sqlx::query_as(
        r#"
        SELECT
            COUNT(*) AS used_total,
            COALESCE(SUM(CASE WHEN business_date = ? THEN 1 ELSE 0 END), 0) AS used_today
        FROM orders
        WHERE promo_id = ? AND status != 'VOIDED'
        "#,
    )
    .bind(today)
    .bind(row.id)
    .fetch_one(pool)
    .await?;

    Ok(PromotionResponse::from_row(row, used_total, used_today))
}

pub async fn list_promotions(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(query): Query<ListPromotionsQuery>,
) -> AppResult<Json<Vec<PromotionResponse>>> {
    auth.require_roles(&[Role::Cashier, Role::Owner, Role::Admin])?;
    let today = today_date();

    let active_only = auth.role == Role::Cashier || query.active_only.unwrap_or(false);
    let rows: Vec<PromotionRow> = if active_only {
        sqlx::query_as(
            "SELECT * FROM promotions WHERE is_active = 1 ORDER BY id DESC",
        )
        .fetch_all(&state.pool)
        .await?
    } else {
        sqlx::query_as("SELECT * FROM promotions ORDER BY is_active DESC, id DESC")
            .fetch_all(&state.pool)
            .await?
    };

    let usage_rows: Vec<(i64, i64, i64)> = sqlx::query_as(
        r#"
        SELECT
            promo_id,
            COUNT(*) AS used_total,
            COALESCE(SUM(CASE WHEN business_date = ? THEN 1 ELSE 0 END), 0) AS used_today
        FROM orders
        WHERE promo_id IS NOT NULL AND status != 'VOIDED'
        GROUP BY promo_id
        "#,
    )
    .bind(&today)
    .fetch_all(&state.pool)
    .await?;

    let usage_map: std::collections::HashMap<i64, (i64, i64)> = usage_rows
        .into_iter()
        .map(|(pid, total, day)| (pid, (total, day)))
        .collect();

    let result = rows
        .into_iter()
        .map(|row| {
            let (used_total, used_today) = usage_map.get(&row.id).copied().unwrap_or((0, 0));
            PromotionResponse::from_row(row, used_total, used_today)
        })
        .collect();

    Ok(Json(result))
}

pub async fn create_promotion(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(req): Json<CreatePromotionRequest>,
) -> AppResult<(StatusCode, Json<PromotionResponse>)> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;

    let v = validate_promo_fields(
        &req.name,
        &req.discount_type,
        req.discount_value,
        req.max_discount,
        req.min_order_amount.unwrap_or(0),
        req.quota_type.as_deref().unwrap_or("UNLIMITED"),
        req.quota_limit,
        req.start_date.as_deref(),
        req.end_date.as_deref(),
        req.regular_only.unwrap_or(true),
        req.receipt_promo_text.as_deref(),
        req.receipt_media_type.as_deref(),
        req.receipt_media_value.as_deref(),
    )?;

    let now = now_iso();
    let mut tx = begin_write_tx(&state.pool).await?;
    let res = sqlx::query(
        r#"
        INSERT INTO promotions (
            name, discount_type, discount_value, max_discount, min_order_amount,
            quota_type, quota_limit, start_date, end_date, regular_only,
            receipt_promo_text, receipt_media_type, receipt_media_value,
            is_active, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        "#,
    )
    .bind(&v.name)
    .bind(v.discount_type)
    .bind(v.discount_value)
    .bind(v.max_discount)
    .bind(v.min_order_amount)
    .bind(v.quota_type)
    .bind(v.quota_limit)
    .bind(&v.start_date)
    .bind(&v.end_date)
    .bind(v.regular_only)
    .bind(&v.receipt_promo_text)
    .bind(v.receipt_media_type)
    .bind(&v.receipt_media_value)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    let id = res.last_insert_rowid();
    let row: PromotionRow = sqlx::query_as("SELECT * FROM promotions WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;

    tracing::info!(
        actor = %auth.username,
        promo_id = id,
        discount_type = v.discount_type,
        quota_type = v.quota_type,
        media_type = v.receipt_media_type,
        "promotion created"
    );

    Ok((StatusCode::CREATED, Json(PromotionResponse::from_row(row, 0, 0))))
}

pub async fn update_promotion(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<UpdatePromotionRequest>,
) -> AppResult<Json<PromotionResponse>> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;

    let v = validate_promo_fields(
        &req.name,
        &req.discount_type,
        req.discount_value,
        req.max_discount,
        req.min_order_amount,
        &req.quota_type,
        req.quota_limit,
        req.start_date.as_deref(),
        req.end_date.as_deref(),
        req.regular_only,
        Some(&req.receipt_promo_text),
        Some(&req.receipt_media_type),
        Some(&req.receipt_media_value),
    )?;

    let now = now_iso();
    let is_active_int: i64 = if req.is_active { 1 } else { 0 };
    let mut tx = begin_write_tx(&state.pool).await?;

    let exists: Option<(i64,)> = sqlx::query_as("SELECT id FROM promotions WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!("Promo #{id} tidak ditemukan")));
    }

    sqlx::query(
        r#"
        UPDATE promotions
        SET name = ?, discount_type = ?, discount_value = ?, max_discount = ?,
            min_order_amount = ?, quota_type = ?, quota_limit = ?,
            start_date = ?, end_date = ?, regular_only = ?,
            receipt_promo_text = ?, receipt_media_type = ?, receipt_media_value = ?,
            is_active = ?, updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(&v.name)
    .bind(v.discount_type)
    .bind(v.discount_value)
    .bind(v.max_discount)
    .bind(v.min_order_amount)
    .bind(v.quota_type)
    .bind(v.quota_limit)
    .bind(&v.start_date)
    .bind(&v.end_date)
    .bind(v.regular_only)
    .bind(&v.receipt_promo_text)
    .bind(v.receipt_media_type)
    .bind(&v.receipt_media_value)
    .bind(is_active_int)
    .bind(&now)
    .bind(id)
    .execute(&mut *tx)
    .await?;

    let row: PromotionRow = sqlx::query_as("SELECT * FROM promotions WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;

    let today = today_date();
    let hydrated = hydrate_promotion_response(&state.pool, row, &today).await?;
    Ok(Json(hydrated))
}

pub async fn delete_promotion(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;
    let now = now_iso();
    let mut tx = begin_write_tx(&state.pool).await?;

    let exists: Option<(i64,)> = sqlx::query_as("SELECT id FROM promotions WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!("Promo #{id} tidak ditemukan")));
    }

    let (ref_count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM orders WHERE promo_id = ?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;

    if ref_count > 0 {
        sqlx::query("UPDATE promotions SET is_active = 0, updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(Json(json!({
            "deleted": false,
            "soft_deleted": true,
            "reason": format!("Promo sudah dipakai di {ref_count} nota sehingga diarsipkan agar riwayat tetap utuh.")
        })));
    }

    sqlx::query("DELETE FROM promotions WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({ "deleted": true, "soft_deleted": false })))
}
