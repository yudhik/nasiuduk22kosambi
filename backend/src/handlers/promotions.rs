use std::collections::{BTreeSet, HashMap};

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::{Datelike, NaiveDateTime, NaiveTime};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    auth::{AuthUser, Role},
    db::{begin_write_tx, now_iso},
    error::{AppError, AppResult},
    models::{
        CreatePromotionRequest, PromotionResponse, PromotionRow, PromotionSchedule,
        PromotionScheduleInput, UpdatePromotionRequest,
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

fn sanitize_single_line(raw: &str) -> String {
    raw.chars()
        .filter(|&c| !c.is_control() && !is_disallowed_unicode(c))
        .collect::<String>()
        .trim()
        .to_string()
}

fn parse_optional_datetime(raw: Option<&str>, field_label: &str) -> AppResult<Option<String>> {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => {
            let parsed = NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M")
                .or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M"))
                .or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S"))
                .or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S"))
                .map_err(|_| {
                    AppError::Validation(format!(
                        "{field_label} tidak valid (harus format YYYY-MM-DDTHH:MM)."
                    ))
                })?;
            if !(2000..=2100).contains(&parsed.year()) {
                return Err(AppError::Validation(format!(
                    "{field_label} harus berada di antara tahun 2000 hingga 2100."
                )));
            }
            Ok(Some(parsed.format("%Y-%m-%dT%H:%M").to_string()))
        }
        None => Ok(None),
    }
}

fn parse_required_hhmm(raw: &str, field_label: &str) -> AppResult<String> {
    let s = raw.trim();
    let parsed = NaiveTime::parse_from_str(s, "%H:%M")
        .or_else(|_| NaiveTime::parse_from_str(s, "%H:%M:%S"))
        .map_err(|_| {
            AppError::Validation(format!("{field_label} tidak valid (harus format HH:MM)."))
        })?;
    Ok(parsed.format("%H:%M").to_string())
}

fn validate_schedules(
    schedules: &[PromotionScheduleInput],
) -> AppResult<Vec<(i64, String, String)>> {
    if schedules.len() > 21 {
        return Err(AppError::Validation(
            "Maksimal 21 slot jadwal promo.".into(),
        ));
    }
    let mut dedup: BTreeSet<(i64, String, String)> = BTreeSet::new();
    for s in schedules {
        if !(0..=6).contains(&s.day_of_week) {
            return Err(AppError::Validation(
                "Hari jadwal tidak valid (harus 0=Senin hingga 6=Minggu).".into(),
            ));
        }
        let start = parse_required_hhmm(&s.start_time, "Jam mulai jadwal")?;
        let end = parse_required_hhmm(&s.end_time, "Jam selesai jadwal")?;
        if start >= end {
            return Err(AppError::Validation(
                "Jam mulai jadwal harus lebih awal dari jam selesai (tanpa lintas tengah malam)."
                    .into(),
            ));
        }
        dedup.insert((s.day_of_week, start, end));
    }
    Ok(dedup.into_iter().collect())
}

struct ValidatedPromo {
    name: String,
    discount_type: &'static str,
    discount_value: i64,
    max_discount: Option<i64>,
    min_order_amount: i64,
    quota_limit: i64,
    start_at: Option<String>,
    end_at: Option<String>,
    regular_only: i64,
}

#[allow(clippy::too_many_arguments)]
fn validate_promo_fields(
    name: &str,
    discount_type: &str,
    discount_value: i64,
    max_discount: Option<i64>,
    min_order_amount: i64,
    quota_limit: i64,
    start_at: Option<&str>,
    end_at: Option<&str>,
    regular_only: bool,
) -> AppResult<ValidatedPromo> {
    let cleaned_name = sanitize_single_line(name);
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

    if !(1..=1_000_000).contains(&quota_limit) {
        return Err(AppError::Validation(
            "Kuota promo wajib diisi antara 1 hingga 1.000.000 pelanggan.".into(),
        ));
    }

    let clean_start = parse_optional_datetime(start_at, "Waktu mulai")?;
    let clean_end = parse_optional_datetime(end_at, "Waktu berakhir")?;
    if let (Some(s), Some(e)) = (&clean_start, &clean_end) {
        if s > e {
            return Err(AppError::Validation(
                "Waktu mulai tidak boleh melebihi waktu berakhir.".into(),
            ));
        }
    }

    Ok(ValidatedPromo {
        name: cleaned_name,
        discount_type: dtype,
        discount_value,
        max_discount: clean_max_discount,
        min_order_amount,
        quota_limit,
        start_at: clean_start,
        end_at: clean_end,
        regular_only: if regular_only { 1 } else { 0 },
    })
}

pub async fn list_promotions(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(query): Query<ListPromotionsQuery>,
) -> AppResult<Json<Vec<PromotionResponse>>> {
    auth.require_roles(&[Role::Cashier, Role::Owner, Role::Admin])?;

    let active_only = auth.role == Role::Cashier || query.active_only.unwrap_or(false);
    let mut tx = state.pool.begin().await?;
    let rows: Vec<PromotionRow> = if active_only {
        sqlx::query_as("SELECT * FROM promotions WHERE is_active = 1 ORDER BY id DESC")
            .fetch_all(&mut *tx)
            .await?
    } else {
        sqlx::query_as("SELECT * FROM promotions ORDER BY is_active DESC, id DESC")
            .fetch_all(&mut *tx)
            .await?
    };

    let all_schedules: Vec<PromotionSchedule> = if active_only {
        sqlx::query_as(
            "SELECT ps.* FROM promotion_schedules ps INNER JOIN promotions p ON p.id = ps.promo_id WHERE p.is_active = 1 ORDER BY ps.promo_id ASC, ps.day_of_week ASC, ps.start_time ASC",
        )
        .fetch_all(&mut *tx)
        .await?
    } else {
        sqlx::query_as(
            "SELECT * FROM promotion_schedules ORDER BY promo_id ASC, day_of_week ASC, start_time ASC",
        )
        .fetch_all(&mut *tx)
        .await?
    };
    tx.commit().await?;

    let mut sched_map: HashMap<i64, Vec<PromotionSchedule>> = HashMap::new();
    for s in all_schedules {
        sched_map.entry(s.promo_id).or_default().push(s);
    }

    let out = rows
        .into_iter()
        .map(|row| {
            let scheds = sched_map.remove(&row.id).unwrap_or_default();
            PromotionResponse::from_parts(row, scheds)
        })
        .collect();

    Ok(Json(out))
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
        req.quota_limit,
        req.start_at.as_deref(),
        req.end_at.as_deref(),
        req.regular_only.unwrap_or(true),
    )?;
    let clean_schedules = match req.schedules.as_deref() {
        Some(list) => validate_schedules(list)?,
        None => Vec::new(),
    };

    let now = now_iso();
    let mut tx = begin_write_tx(&state.pool).await?;
    let res = sqlx::query(
        r#"
        INSERT INTO promotions (
            name, discount_type, discount_value, max_discount, min_order_amount,
            quota_limit, used_count, start_at, end_at, regular_only,
            is_active, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 1, ?, ?)
        "#,
    )
    .bind(&v.name)
    .bind(v.discount_type)
    .bind(v.discount_value)
    .bind(v.max_discount)
    .bind(v.min_order_amount)
    .bind(v.quota_limit)
    .bind(&v.start_at)
    .bind(&v.end_at)
    .bind(v.regular_only)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    let id = res.last_insert_rowid();
    for (dow, start_t, end_t) in &clean_schedules {
        sqlx::query(
            "INSERT INTO promotion_schedules (promo_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?)",
        )
        .bind(id)
        .bind(dow)
        .bind(start_t)
        .bind(end_t)
        .execute(&mut *tx)
        .await?;
    }

    let row: PromotionRow = sqlx::query_as("SELECT * FROM promotions WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let saved_schedules: Vec<PromotionSchedule> = sqlx::query_as(
        "SELECT * FROM promotion_schedules WHERE promo_id = ? ORDER BY day_of_week ASC, start_time ASC",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;

    tracing::info!(
        actor = %auth.username,
        promo_id = id,
        discount_type = v.discount_type,
        quota_limit = v.quota_limit,
        schedule_count = saved_schedules.len(),
        "promotion created"
    );

    Ok((
        StatusCode::CREATED,
        Json(PromotionResponse::from_parts(row, saved_schedules)),
    ))
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
        req.quota_limit,
        req.start_at.as_deref(),
        req.end_at.as_deref(),
        req.regular_only,
    )?;
    let clean_schedules_opt = match req.schedules.as_deref() {
        Some(list) => Some(validate_schedules(list)?),
        None => None,
    };

    let now = now_iso();
    let is_active_int: i64 = if req.is_active { 1 } else { 0 };
    let mut tx = begin_write_tx(&state.pool).await?;

    let existing: PromotionRow = sqlx::query_as("SELECT * FROM promotions WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Promo #{id} tidak ditemukan")))?;

    if v.quota_limit < existing.used_count {
        return Err(AppError::Conflict(format!(
            "Kuota ({}) tidak boleh lebih kecil dari jumlah yang sudah terpakai ({}).",
            v.quota_limit, existing.used_count
        )));
    }

    sqlx::query(
        r#"
        UPDATE promotions
        SET name = ?, discount_type = ?, discount_value = ?, max_discount = ?,
            min_order_amount = ?, quota_limit = ?,
            start_at = ?, end_at = ?, regular_only = ?,
            is_active = ?, updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(&v.name)
    .bind(v.discount_type)
    .bind(v.discount_value)
    .bind(v.max_discount)
    .bind(v.min_order_amount)
    .bind(v.quota_limit)
    .bind(&v.start_at)
    .bind(&v.end_at)
    .bind(v.regular_only)
    .bind(is_active_int)
    .bind(&now)
    .bind(id)
    .execute(&mut *tx)
    .await?;

    if let Some(clean_schedules) = clean_schedules_opt {
        sqlx::query("DELETE FROM promotion_schedules WHERE promo_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        for (dow, start_t, end_t) in &clean_schedules {
            sqlx::query(
                "INSERT INTO promotion_schedules (promo_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?)",
            )
            .bind(id)
            .bind(dow)
            .bind(start_t)
            .bind(end_t)
            .execute(&mut *tx)
            .await?;
        }
    }

    let row: PromotionRow = sqlx::query_as("SELECT * FROM promotions WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let saved_schedules: Vec<PromotionSchedule> = sqlx::query_as(
        "SELECT * FROM promotion_schedules WHERE promo_id = ? ORDER BY day_of_week ASC, start_time ASC",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;

    tracing::info!(
        actor = %auth.username,
        promo_id = id,
        quota_limit = v.quota_limit,
        is_active = req.is_active,
        schedule_count = saved_schedules.len(),
        "promotion updated"
    );

    Ok(Json(PromotionResponse::from_parts(row, saved_schedules)))
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
        sqlx::query_as("SELECT COUNT(*) FROM applied_promotions WHERE promo_id = ?")
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
        tracing::info!(actor = %auth.username, promo_id = id, ref_count, "promotion soft-archived");
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
    tracing::info!(actor = %auth.username, promo_id = id, "promotion deleted");
    Ok(Json(json!({ "deleted": true, "soft_deleted": false })))
}
