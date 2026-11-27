use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::{Datelike, Duration, Local, NaiveDateTime};
use rand::Rng;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Sqlite, Transaction};

use crate::{
    auth::{AuthUser, Role},
    db::{begin_write_tx, get_store_day_status_tx, now_business_and_iso, now_iso},
    error::{AppError, AppResult},
    models::{
        AppliedPromotionDetail, AppliedVoucherDetail, ApplyOrderVoucherRequest,
        CreateVoucherCampaignRequest, IssueOrderVoucherRequest, IssuedVoucherDetail, OrderDetail,
        OrderItemDetail, OrderRow, UpdateVoucherCampaignRequest, VoucherCampaignResponse,
        VoucherCampaignRow,
    },
    AppState,
};

const DYNAMIC_RANDOM_TOKENS: [&str; 3] = ["{RAND4}", "{RAND6}", "{RAND8}"];
const RAND_CHARSET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

#[derive(Debug, Deserialize)]
pub struct ListVouchersQuery {
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

fn sanitize_multiline(raw: &str) -> String {
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
    normalized
        .chars()
        .filter(|&c| !(c.is_control() && c != '\n') && !is_disallowed_unicode(c))
        .collect::<String>()
        .trim()
        .to_string()
}

fn random_code(len: usize) -> String {
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| RAND_CHARSET[rng.gen_range(0..RAND_CHARSET.len())] as char)
        .collect()
}

fn render_code_template(template: &str, business_date: &str, seq_num: i64) -> String {
    let clean_date = business_date.replace('-', "");
    let seq_str = format!("{:04}", seq_num.max(0));
    let mut out = template
        .replace("{DATE}", &clean_date)
        .replace("{SEQ4}", &seq_str);
    for (token, len) in [("{RAND8}", 8usize), ("{RAND6}", 6), ("{RAND4}", 4)] {
        while let Some(idx) = out.find(token) {
            let rand_str = random_code(len);
            out.replace_range(idx..idx + token.len(), &rand_str);
        }
    }
    out.to_ascii_uppercase()
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

fn validate_rendered_code(display_format: &str, code: &str, is_dynamic: bool) -> AppResult<()> {
    let prefix = if is_dynamic { "Hasil pola " } else { "" };
    if code.is_empty() {
        return Err(AppError::Validation(format!(
            "{prefix}kode voucher wajib diisi."
        )));
    }
    let max_len = if display_format == "BARCODE" { 24 } else { 48 };
    if code.len() > max_len
        || !code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    {
        return Err(AppError::Validation(format!(
            "{prefix}kode voucher hanya boleh huruf/angka/tanda '-', '_', '.' (maks. {max_len} karakter)."
        )));
    }
    Ok(())
}

pub(crate) fn compute_discount(
    subtotal: i64,
    discount_type: &str,
    discount_value: i64,
    max_discount: Option<i64>,
) -> i64 {
    let raw = if discount_type == "PERCENT" {
        let pct = ((subtotal as i128) * (discount_value as i128) / 100) as i64;
        match max_discount {
            Some(cap) => pct.min(cap),
            None => pct,
        }
    } else {
        discount_value
    };
    raw.clamp(0, subtotal.max(0))
}

struct ValidatedCampaign {
    name: String,
    code_mode: &'static str,
    static_code: Option<String>,
    code_template: Option<String>,
    display_format: &'static str,
    receipt_message: String,
    auto_issue_on_pay: i64,
    issue_min_order_amount: i64,
    issue_regular_only: i64,
    issue_quota_limit: i64,
    issue_start_at: Option<String>,
    issue_end_at: Option<String>,
    discount_type: &'static str,
    discount_value: i64,
    max_discount: Option<i64>,
    redeem_min_order_amount: i64,
    redeem_regular_only: i64,
    redeem_quota_limit: i64,
    valid_days: Option<i64>,
    redeem_start_at: Option<String>,
    redeem_end_at: Option<String>,
}

#[allow(clippy::too_many_arguments)]
fn validate_campaign_fields(
    name: &str,
    code_mode: &str,
    static_code: Option<&str>,
    code_template: Option<&str>,
    display_format: Option<&str>,
    receipt_message: Option<&str>,
    auto_issue_on_pay: bool,
    issue_min_order_amount: i64,
    issue_regular_only: bool,
    issue_quota_limit: i64,
    issue_start_at: Option<&str>,
    issue_end_at: Option<&str>,
    discount_type: &str,
    discount_value: i64,
    max_discount: Option<i64>,
    redeem_min_order_amount: i64,
    redeem_regular_only: bool,
    redeem_quota_limit: i64,
    valid_days: Option<i64>,
    redeem_start_at: Option<&str>,
    redeem_end_at: Option<&str>,
) -> AppResult<ValidatedCampaign> {
    let cleaned_name = sanitize_single_line(name);
    if cleaned_name.is_empty() || cleaned_name.chars().count() > 80 {
        return Err(AppError::Validation(
            "Nama voucher wajib diisi (maksimal 80 karakter).".into(),
        ));
    }

    let cmode: &'static str = match code_mode.trim().to_ascii_uppercase().as_str() {
        "STATIC" => "STATIC",
        "DYNAMIC" => "DYNAMIC",
        _ => {
            return Err(AppError::Validation(
                "Mode kode voucher harus STATIC atau DYNAMIC.".into(),
            ))
        }
    };

    let dformat: &'static str = match display_format
        .unwrap_or("QR")
        .trim()
        .to_ascii_uppercase()
        .as_str()
    {
        "TEXT" => "TEXT",
        "QR" | "" => "QR",
        "BARCODE" => "BARCODE",
        _ => {
            return Err(AppError::Validation(
                "Format tampilan voucher harus TEXT, QR, atau BARCODE.".into(),
            ))
        }
    };

    let (clean_static, clean_template) = if cmode == "STATIC" {
        let code = sanitize_single_line(static_code.unwrap_or("")).to_ascii_uppercase();
        validate_rendered_code(dformat, &code, false)?;
        (Some(code), None)
    } else {
        let tmpl = sanitize_single_line(code_template.unwrap_or("")).to_ascii_uppercase();
        if tmpl.is_empty() || tmpl.chars().count() > 64 {
            return Err(AppError::Validation(
                "Pola kode dinamis wajib diisi (maksimal 64 karakter).".into(),
            ));
        }
        if !DYNAMIC_RANDOM_TOKENS.iter().any(|tok| tmpl.contains(tok)) {
            return Err(AppError::Validation(
                "Pola kode dinamis harus mengandung minimal satu token acak: {RAND4}, {RAND6}, atau {RAND8}.".into(),
            ));
        }
        let sample = render_code_template(&tmpl, "2026-11-27", 9_999_999);
        validate_rendered_code(dformat, &sample, true)?;
        (None, Some(tmpl))
    };

    let clean_msg = sanitize_multiline(receipt_message.unwrap_or(""));
    if clean_msg.chars().count() > 240 || clean_msg.lines().count() > 5 {
        return Err(AppError::Validation(
            "Pesan struk voucher maksimal 240 karakter dan 5 baris.".into(),
        ));
    }

    if !(0..=100_000_000).contains(&issue_min_order_amount) {
        return Err(AppError::Validation(
            "Minimal belanja pemberian voucher harus antara Rp0 hingga Rp100.000.000.".into(),
        ));
    }
    if !(1..=1_000_000).contains(&issue_quota_limit) {
        return Err(AppError::Validation(
            "Kuota pemberian voucher wajib antara 1 hingga 1.000.000.".into(),
        ));
    }

    let clean_issue_start = parse_optional_datetime(issue_start_at, "Waktu mulai pemberian")?;
    let clean_issue_end = parse_optional_datetime(issue_end_at, "Waktu berakhir pemberian")?;
    if let (Some(s), Some(e)) = (&clean_issue_start, &clean_issue_end) {
        if s > e {
            return Err(AppError::Validation(
                "Waktu mulai pemberian tidak boleh melebihi waktu berakhir.".into(),
            ));
        }
    }

    let dtype: &'static str = match discount_type.trim().to_ascii_uppercase().as_str() {
        "FIXED" => "FIXED",
        "PERCENT" => "PERCENT",
        _ => {
            return Err(AppError::Validation(
                "Tipe diskon voucher harus FIXED atau PERCENT.".into(),
            ))
        }
    };

    if dtype == "FIXED" {
        if discount_value <= 0 || discount_value > 100_000_000 {
            return Err(AppError::Validation(
                "Nominal diskon voucher harus antara Rp1 hingga Rp100.000.000.".into(),
            ));
        }
    } else if !(1..=100).contains(&discount_value) {
        return Err(AppError::Validation(
            "Persentase diskon voucher harus antara 1% hingga 100%.".into(),
        ));
    }

    let clean_max_discount = if dtype == "PERCENT" {
        match max_discount {
            Some(v) if v <= 0 || v > 100_000_000 => {
                return Err(AppError::Validation(
                    "Maksimal diskon voucher harus antara Rp1 hingga Rp100.000.000.".into(),
                ));
            }
            other => other,
        }
    } else {
        None
    };

    if !(0..=100_000_000).contains(&redeem_min_order_amount) {
        return Err(AppError::Validation(
            "Minimal belanja penukaran voucher harus antara Rp0 hingga Rp100.000.000.".into(),
        ));
    }
    if !(1..=1_000_000).contains(&redeem_quota_limit) {
        return Err(AppError::Validation(
            "Kuota penukaran voucher wajib antara 1 hingga 1.000.000.".into(),
        ));
    }
    let clean_valid_days = if cmode == "DYNAMIC" {
        if let Some(days) = valid_days {
            if !(1..=3650).contains(&days) {
                return Err(AppError::Validation(
                    "Masa berlaku voucher harus antara 1 hingga 3650 hari.".into(),
                ));
            }
        }
        valid_days
    } else {
        None
    };

    let clean_redeem_start = parse_optional_datetime(redeem_start_at, "Waktu mulai penukaran")?;
    let clean_redeem_end = parse_optional_datetime(redeem_end_at, "Waktu berakhir penukaran")?;
    if let (Some(s), Some(e)) = (&clean_redeem_start, &clean_redeem_end) {
        if s > e {
            return Err(AppError::Validation(
                "Waktu mulai penukaran tidak boleh melebihi waktu berakhir.".into(),
            ));
        }
    }

    Ok(ValidatedCampaign {
        name: cleaned_name,
        code_mode: cmode,
        static_code: clean_static,
        code_template: clean_template,
        display_format: dformat,
        receipt_message: clean_msg,
        auto_issue_on_pay: if auto_issue_on_pay { 1 } else { 0 },
        issue_min_order_amount,
        issue_regular_only: if issue_regular_only { 1 } else { 0 },
        issue_quota_limit,
        issue_start_at: clean_issue_start,
        issue_end_at: clean_issue_end,
        discount_type: dtype,
        discount_value,
        max_discount: clean_max_discount,
        redeem_min_order_amount,
        redeem_regular_only: if redeem_regular_only { 1 } else { 0 },
        redeem_quota_limit,
        valid_days: clean_valid_days,
        redeem_start_at: clean_redeem_start,
        redeem_end_at: clean_redeem_end,
    })
}

async fn is_order_regular_tx(
    tx: &mut Transaction<'_, Sqlite>,
    order: &OrderRow,
) -> Result<bool, sqlx::Error> {
    if let Some(cid) = order.channel_id {
        let code: Option<(String,)> =
            sqlx::query_as("SELECT code FROM sales_channels WHERE id = ?")
                .bind(cid)
                .fetch_optional(&mut **tx)
                .await?;
        Ok(code
            .map(|(c,)| c.eq_ignore_ascii_case("regular"))
            .unwrap_or(false))
    } else {
        Ok(order.channel_name_snapshot.eq_ignore_ascii_case("regular"))
    }
}

/// Recomputes `orders.discount_amount` and `orders.total_amount` from active `applied_promotions`
/// and `applied_vouchers` so stacked discounts stay strictly consistent and non-negative.
pub(crate) async fn recalculate_order_totals_tx(
    tx: &mut Transaction<'_, Sqlite>,
    order_id: i64,
    subtotal_amount: i64,
) -> Result<(i64, i64), sqlx::Error> {
    let (promo_disc,): (i64,) = sqlx::query_as(
        "SELECT COALESCE(SUM(discount_amount), 0) FROM applied_promotions WHERE order_id = ? AND status = 'APPLIED'",
    )
    .bind(order_id)
    .fetch_one(&mut **tx)
    .await?;

    let (voucher_disc,): (i64,) = sqlx::query_as(
        "SELECT COALESCE(SUM(discount_amount), 0) FROM applied_vouchers WHERE order_id = ? AND status = 'APPLIED'",
    )
    .bind(order_id)
    .fetch_one(&mut **tx)
    .await?;

    let total_discount = promo_disc
        .saturating_add(voucher_disc)
        .clamp(0, subtotal_amount.max(0));
    let new_total = subtotal_amount.saturating_sub(total_discount).max(0);

    sqlx::query("UPDATE orders SET discount_amount = ?, total_amount = ? WHERE id = ?")
        .bind(total_discount)
        .bind(new_total)
        .bind(order_id)
        .execute(&mut **tx)
        .await?;

    Ok((total_discount, new_total))
}

pub(crate) async fn load_order_detail_tx(
    tx: &mut Transaction<'_, Sqlite>,
    order_id: i64,
) -> Result<OrderDetail, sqlx::Error> {
    let order: OrderRow = sqlx::query_as("SELECT * FROM orders WHERE id = ?")
        .bind(order_id)
        .fetch_one(&mut **tx)
        .await?;
    let items: Vec<OrderItemDetail> =
        sqlx::query_as("SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC")
            .bind(order_id)
            .fetch_all(&mut **tx)
            .await?;
    let applied_promos: Vec<AppliedPromotionDetail> = sqlx::query_as(
        "SELECT * FROM applied_promotions WHERE order_id = ? AND status = 'APPLIED' ORDER BY id ASC",
    )
    .bind(order_id)
    .fetch_all(&mut **tx)
    .await?;
    let applied_vouchers: Vec<AppliedVoucherDetail> = sqlx::query_as(
        "SELECT * FROM applied_vouchers WHERE order_id = ? AND status = 'APPLIED' ORDER BY id ASC",
    )
    .bind(order_id)
    .fetch_all(&mut **tx)
    .await?;
    let issued_vouchers: Vec<IssuedVoucherDetail> = sqlx::query_as(
        "SELECT * FROM issued_vouchers WHERE source_order_id = ? AND status != 'VOIDED' ORDER BY id ASC",
    )
    .bind(order_id)
    .fetch_all(&mut **tx)
    .await?;
    Ok(OrderDetail::from_parts(
        order,
        items,
        applied_promos,
        applied_vouchers,
        issued_vouchers,
    ))
}

async fn issue_campaign_to_order_tx(
    tx: &mut Transaction<'_, Sqlite>,
    campaign: &VoucherCampaignRow,
    order: &OrderRow,
    actor_username: &str,
    now_iso_str: &str,
    now_dt: &str,
) -> AppResult<IssuedVoucherDetail> {
    if campaign.is_active == 0 {
        return Err(AppError::Conflict("Campaign voucher sudah tidak aktif.".into()));
    }
    if let Some(ref start) = campaign.issue_start_at {
        if now_dt < start.as_str() {
            return Err(AppError::Conflict(format!(
                "Pemberian voucher baru berlaku mulai {}.",
                start.replace('T', " ")
            )));
        }
    }
    if let Some(ref end) = campaign.issue_end_at {
        if now_dt > end.as_str() {
            return Err(AppError::Conflict(format!(
                "Periode pemberian voucher sudah berakhir pada {}.",
                end.replace('T', " ")
            )));
        }
    }
    if campaign.issue_regular_only != 0 && !is_order_regular_tx(tx, order).await? {
        return Err(AppError::Conflict(
            "Voucher ini hanya diberikan untuk saluran Regular.".into(),
        ));
    }
    // User decision: check issuance min purchase against subtotal_amount (before discount)
    if order.subtotal_amount < campaign.issue_min_order_amount {
        return Err(AppError::Validation(format!(
            "Minimal belanja (subtotal) untuk mendapatkan voucher ini adalah Rp{}.",
            campaign.issue_min_order_amount
        )));
    }

    // Check if this order already received this campaign
    let already: Option<(i64,)> = sqlx::query_as(
        "SELECT id FROM issued_vouchers WHERE source_order_id = ? AND campaign_id = ? AND status != 'VOIDED'",
    )
    .bind(order.id)
    .bind(campaign.id)
    .fetch_optional(&mut **tx)
    .await?;
    if already.is_some() {
        return Err(AppError::Conflict(
            "Nota ini sudah menerima voucher dari campaign tersebut.".into(),
        ));
    }

    let claimed_seq: Option<i64> = sqlx::query_scalar(
        "UPDATE voucher_campaigns SET issued_count = issued_count + 1, seq_counter = seq_counter + 1, updated_at = ? WHERE id = ? AND is_active = 1 AND issued_count < issue_quota_limit RETURNING seq_counter",
    )
    .bind(now_iso_str)
    .bind(campaign.id)
    .fetch_optional(&mut **tx)
    .await?;

    let seq_num = match claimed_seq {
        Some(seq) => seq,
        None => {
            return Err(AppError::Conflict(format!(
                "Kuota pemberian voucher \"{}\" sudah habis ({}/{}).",
                campaign.name, campaign.issued_count, campaign.issue_quota_limit
            )));
        }
    };

    // Compute expires_at = min(now + valid_days, campaign.redeem_end_at)
    let rel_expiry = campaign.valid_days.map(|days| {
        (Local::now() + Duration::days(days))
            .format("%Y-%m-%dT%H:%M")
            .to_string()
    });
    let expires_at = match (rel_expiry, campaign.redeem_end_at.clone()) {
        (Some(a), Some(b)) => Some(if a <= b { a } else { b }),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    };

    let is_unique: i64 = if campaign.code_mode == "DYNAMIC" { 1 } else { 0 };
    let mut inserted_id: Option<i64> = None;

    for _attempt in 0..5 {
        let candidate = if campaign.code_mode == "DYNAMIC" {
            let tmpl = campaign.code_template.as_deref().unwrap_or("VCH-{RAND6}");
            let rendered = render_code_template(tmpl, &order.business_date, seq_num);
            validate_rendered_code(&campaign.display_format, &rendered, true)?;
            // Avoid shadowing an existing STATIC campaign code
            let static_clash: Option<(i64,)> =
                sqlx::query_as("SELECT id FROM voucher_campaigns WHERE static_code = ?")
                    .bind(&rendered)
                    .fetch_optional(&mut **tx)
                    .await?;
            if static_clash.is_some() {
                continue;
            }
            rendered
        } else {
            campaign.static_code.clone().unwrap_or_default()
        };

        let insert_res = sqlx::query(
            r#"
            INSERT INTO issued_vouchers (
                campaign_id, source_order_id, code, is_unique_code,
                display_format_snapshot, receipt_message_snapshot,
                status, expires_at, issued_by_username, issued_at
            )
            VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)
            "#,
        )
        .bind(campaign.id)
        .bind(order.id)
        .bind(&candidate)
        .bind(is_unique)
        .bind(&campaign.display_format)
        .bind(&campaign.receipt_message)
        .bind(&expires_at)
        .bind(actor_username)
        .bind(now_iso_str)
        .execute(&mut **tx)
        .await;

        match insert_res {
            Ok(r) => {
                inserted_id = Some(r.last_insert_rowid());
                break;
            }
            Err(sqlx::Error::Database(db_err))
                if db_err.message().contains("UNIQUE") && is_unique == 1 =>
            {
                continue;
            }
            Err(e) => return Err(e.into()),
        }
    }

    let id = inserted_id.ok_or_else(|| {
        AppError::Conflict("Gagal menghasilkan kode voucher unik. Silakan coba lagi.".into())
    })?;

    let row: IssuedVoucherDetail = sqlx::query_as("SELECT * FROM issued_vouchers WHERE id = ?")
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
    Ok(row)
}

/// Automatically issues at most 1 eligible `auto_issue_on_pay = 1` voucher campaign when an order becomes `PAID`.
pub(crate) async fn auto_issue_voucher_for_paid_order_tx(
    tx: &mut Transaction<'_, Sqlite>,
    order: &OrderRow,
    actor_username: &str,
    now_iso_str: &str,
) -> AppResult<Option<IssuedVoucherDetail>> {
    let now_dt = Local::now().format("%Y-%m-%dT%H:%M").to_string();
    let is_regular = is_order_regular_tx(tx, order).await?;

    let candidates: Vec<VoucherCampaignRow> = sqlx::query_as(
        r#"
        SELECT * FROM voucher_campaigns
        WHERE is_active = 1
          AND auto_issue_on_pay = 1
          AND issued_count < issue_quota_limit
          AND issue_min_order_amount <= ?
        ORDER BY id DESC
        "#,
    )
    .bind(order.subtotal_amount)
    .fetch_all(&mut **tx)
    .await?;

    for campaign in candidates {
        if campaign.issue_regular_only != 0 && !is_regular {
            continue;
        }
        if let Some(ref s) = campaign.issue_start_at {
            if now_dt.as_str() < s.as_str() {
                continue;
            }
        }
        if let Some(ref e) = campaign.issue_end_at {
            if now_dt.as_str() > e.as_str() {
                continue;
            }
        }
        sqlx::query("SAVEPOINT auto_issue_sp").execute(&mut **tx).await?;
        match issue_campaign_to_order_tx(tx, &campaign, order, actor_username, now_iso_str, &now_dt)
            .await
        {
            Ok(issued) => {
                sqlx::query("RELEASE SAVEPOINT auto_issue_sp")
                    .execute(&mut **tx)
                    .await?;
                return Ok(Some(issued));
            }
            Err(err) => {
                sqlx::query("ROLLBACK TO SAVEPOINT auto_issue_sp")
                    .execute(&mut **tx)
                    .await?;
                sqlx::query("RELEASE SAVEPOINT auto_issue_sp")
                    .execute(&mut **tx)
                    .await?;
                tracing::warn!(
                    order_id = order.id,
                    campaign_id = campaign.id,
                    error = %err,
                    "auto-issue voucher skipped so checkout is never blocked"
                );
                continue;
            }
        }
    }

    Ok(None)
}

/// Releases a previously redeemed dynamic `issued_voucher`.
/// If its source order was already `VOIDED`, voids the voucher and decrements `issued_count`
/// instead of resurrecting it back to `'ACTIVE'`.
async fn release_issued_voucher_tx(
    tx: &mut Transaction<'_, Sqlite>,
    iv_id: i64,
    now_iso_str: &str,
) -> Result<(), sqlx::Error> {
    let row: Option<(i64, Option<i64>)> = sqlx::query_as(
        "SELECT campaign_id, source_order_id FROM issued_vouchers WHERE id = ? AND status = 'REDEEMED'",
    )
    .bind(iv_id)
    .fetch_optional(&mut **tx)
    .await?;

    let Some((campaign_id, source_order_id)) = row else {
        return Ok(());
    };

    let source_voided = if let Some(src_oid) = source_order_id {
        let st: Option<(String,)> = sqlx::query_as("SELECT status FROM orders WHERE id = ?")
            .bind(src_oid)
            .fetch_optional(&mut **tx)
            .await?;
        match st {
            Some((s,)) => s == "VOIDED",
            None => true,
        }
    } else {
        false
    };

    if source_voided {
        sqlx::query("UPDATE issued_vouchers SET status = 'VOIDED' WHERE id = ?")
            .bind(iv_id)
            .execute(&mut **tx)
            .await?;
        sqlx::query(
            "UPDATE voucher_campaigns SET issued_count = MAX(0, issued_count - 1), updated_at = ? WHERE id = ?",
        )
        .bind(now_iso_str)
        .bind(campaign_id)
        .execute(&mut **tx)
        .await?;
    } else {
        sqlx::query("UPDATE issued_vouchers SET status = 'ACTIVE' WHERE id = ?")
            .bind(iv_id)
            .execute(&mut **tx)
            .await?;
    }

    Ok(())
}

/// Handles voucher rollbacks inside `void_order`:
/// 1. Restores any voucher redeemed on this voided order (`applied_vouchers` → `VOIDED`, `redeemed_count - 1`, `issued_vouchers` → `ACTIVE`).
/// 2. Voids any unredeemed `ACTIVE` voucher issued by this voided `PAID` order (`issued_vouchers` → `VOIDED`, `issued_count - 1`).
pub(crate) async fn void_order_vouchers_tx(
    tx: &mut Transaction<'_, Sqlite>,
    order_id: i64,
    now_iso_str: &str,
) -> Result<(), sqlx::Error> {
    let applied_rows: Vec<(i64, i64, Option<i64>)> = sqlx::query_as(
        "SELECT id, campaign_id, issued_voucher_id FROM applied_vouchers WHERE order_id = ? AND status = 'APPLIED'",
    )
    .bind(order_id)
    .fetch_all(&mut **tx)
    .await?;

    if !applied_rows.is_empty() {
        sqlx::query(
            "UPDATE applied_vouchers SET status = 'VOIDED' WHERE order_id = ? AND status = 'APPLIED'",
        )
        .bind(order_id)
        .execute(&mut **tx)
        .await?;
        for (_id, cid, iv_id) in applied_rows {
            sqlx::query(
                "UPDATE voucher_campaigns SET redeemed_count = MAX(0, redeemed_count - 1), updated_at = ? WHERE id = ?",
            )
            .bind(now_iso_str)
            .bind(cid)
            .execute(&mut **tx)
            .await?;
            if let Some(iv) = iv_id {
                release_issued_voucher_tx(tx, iv, now_iso_str).await?;
            }
        }
    }

    let issued_rows: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT id, campaign_id FROM issued_vouchers WHERE source_order_id = ? AND status = 'ACTIVE'",
    )
    .bind(order_id)
    .fetch_all(&mut **tx)
    .await?;

    if !issued_rows.is_empty() {
        sqlx::query(
            "UPDATE issued_vouchers SET status = 'VOIDED' WHERE source_order_id = ? AND status = 'ACTIVE'",
        )
        .bind(order_id)
        .execute(&mut **tx)
        .await?;
        for (_id, cid) in issued_rows {
            sqlx::query(
                "UPDATE voucher_campaigns SET issued_count = MAX(0, issued_count - 1), updated_at = ? WHERE id = ?",
            )
            .bind(now_iso_str)
            .bind(cid)
            .execute(&mut **tx)
            .await?;
        }
    }

    Ok(())
}

// ===== HTTP Handlers =====

pub async fn list_voucher_campaigns(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(query): Query<ListVouchersQuery>,
) -> AppResult<Json<Vec<VoucherCampaignResponse>>> {
    auth.require_roles(&[Role::Cashier, Role::Owner, Role::Admin])?;
    let active_only = auth.role == Role::Cashier || query.active_only.unwrap_or(false);
    let rows: Vec<VoucherCampaignRow> = if active_only {
        sqlx::query_as("SELECT * FROM voucher_campaigns WHERE is_active = 1 ORDER BY id DESC")
            .fetch_all(&state.pool)
            .await?
    } else {
        sqlx::query_as("SELECT * FROM voucher_campaigns ORDER BY is_active DESC, id DESC")
            .fetch_all(&state.pool)
            .await?
    };
    Ok(Json(rows.into_iter().map(VoucherCampaignResponse::from).collect()))
}

pub async fn create_voucher_campaign(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(req): Json<CreateVoucherCampaignRequest>,
) -> AppResult<(StatusCode, Json<VoucherCampaignResponse>)> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;

    let v = validate_campaign_fields(
        &req.name,
        &req.code_mode,
        req.static_code.as_deref(),
        req.code_template.as_deref(),
        req.display_format.as_deref(),
        req.receipt_message.as_deref(),
        req.auto_issue_on_pay.unwrap_or(true),
        req.issue_min_order_amount.unwrap_or(0),
        req.issue_regular_only.unwrap_or(true),
        req.issue_quota_limit,
        req.issue_start_at.as_deref(),
        req.issue_end_at.as_deref(),
        &req.discount_type,
        req.discount_value,
        req.max_discount,
        req.redeem_min_order_amount.unwrap_or(0),
        req.redeem_regular_only.unwrap_or(true),
        req.redeem_quota_limit,
        req.valid_days,
        req.redeem_start_at.as_deref(),
        req.redeem_end_at.as_deref(),
    )?;

    let now = now_iso();
    let mut tx = begin_write_tx(&state.pool).await?;

    if let Some(ref sc) = v.static_code {
        let dup: Option<(i64,)> =
            sqlx::query_as("SELECT id FROM voucher_campaigns WHERE static_code = ?")
                .bind(sc)
                .fetch_optional(&mut *tx)
                .await?;
        let dyn_dup: Option<(i64,)> = sqlx::query_as(
            "SELECT id FROM issued_vouchers WHERE code = ? AND is_unique_code = 1 LIMIT 1",
        )
        .bind(sc)
        .fetch_optional(&mut *tx)
        .await?;
        if dup.is_some() || dyn_dup.is_some() {
            return Err(AppError::Conflict(format!(
                "Kode voucher statis \"{sc}\" sudah digunakan."
            )));
        }
    }

    let res = sqlx::query(
        r#"
        INSERT INTO voucher_campaigns (
            name, code_mode, static_code, code_template, display_format, receipt_message,
            auto_issue_on_pay, issue_min_order_amount, issue_regular_only, issue_quota_limit,
            issued_count, seq_counter, issue_start_at, issue_end_at,
            discount_type, discount_value, max_discount, redeem_min_order_amount,
            redeem_regular_only, redeem_quota_limit, redeemed_count, valid_days,
            redeem_start_at, redeem_end_at, is_active, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 1, ?, ?)
        "#,
    )
    .bind(&v.name)
    .bind(v.code_mode)
    .bind(&v.static_code)
    .bind(&v.code_template)
    .bind(v.display_format)
    .bind(&v.receipt_message)
    .bind(v.auto_issue_on_pay)
    .bind(v.issue_min_order_amount)
    .bind(v.issue_regular_only)
    .bind(v.issue_quota_limit)
    .bind(&v.issue_start_at)
    .bind(&v.issue_end_at)
    .bind(v.discount_type)
    .bind(v.discount_value)
    .bind(v.max_discount)
    .bind(v.redeem_min_order_amount)
    .bind(v.redeem_regular_only)
    .bind(v.redeem_quota_limit)
    .bind(v.valid_days)
    .bind(&v.redeem_start_at)
    .bind(&v.redeem_end_at)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    let id = res.last_insert_rowid();
    let row: VoucherCampaignRow = sqlx::query_as("SELECT * FROM voucher_campaigns WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;

    tracing::info!(
        actor = %auth.username,
        campaign_id = id,
        code_mode = v.code_mode,
        display_format = v.display_format,
        "voucher campaign created"
    );

    Ok((StatusCode::CREATED, Json(VoucherCampaignResponse::from(row))))
}

pub async fn update_voucher_campaign(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateVoucherCampaignRequest>,
) -> AppResult<Json<VoucherCampaignResponse>> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;

    let v = validate_campaign_fields(
        &req.name,
        &req.code_mode,
        req.static_code.as_deref(),
        req.code_template.as_deref(),
        Some(&req.display_format),
        Some(&req.receipt_message),
        req.auto_issue_on_pay,
        req.issue_min_order_amount,
        req.issue_regular_only,
        req.issue_quota_limit,
        req.issue_start_at.as_deref(),
        req.issue_end_at.as_deref(),
        &req.discount_type,
        req.discount_value,
        req.max_discount,
        req.redeem_min_order_amount,
        req.redeem_regular_only,
        req.redeem_quota_limit,
        req.valid_days,
        req.redeem_start_at.as_deref(),
        req.redeem_end_at.as_deref(),
    )?;

    let now = now_iso();
    let is_active_int: i64 = if req.is_active { 1 } else { 0 };
    let mut tx = begin_write_tx(&state.pool).await?;

    let existing: VoucherCampaignRow =
        sqlx::query_as("SELECT * FROM voucher_campaigns WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Voucher #{id} tidak ditemukan")))?;

    let (hist_count,): (i64,) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM issued_vouchers WHERE campaign_id = ?) + (SELECT COUNT(*) FROM applied_vouchers WHERE campaign_id = ?)",
    )
    .bind(id)
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;

    if (existing.seq_counter > 0 || hist_count > 0) && existing.code_mode != v.code_mode {
        return Err(AppError::Conflict(
            "Mode kode (STATIC/DYNAMIC) tidak dapat diubah setelah voucher memiliki riwayat penerbitan atau pemakaian."
                .into(),
        ));
    }
    if v.issue_quota_limit < existing.issued_count {
        return Err(AppError::Conflict(format!(
            "Kuota pemberian ({}) tidak boleh lebih kecil dari jumlah yang sudah diberikan ({}).",
            v.issue_quota_limit, existing.issued_count
        )));
    }
    if v.redeem_quota_limit < existing.redeemed_count {
        return Err(AppError::Conflict(format!(
            "Kuota penukaran ({}) tidak boleh lebih kecil dari jumlah yang sudah ditukar ({}).",
            v.redeem_quota_limit, existing.redeemed_count
        )));
    }

    if let Some(ref sc) = v.static_code {
        let dup: Option<(i64,)> =
            sqlx::query_as("SELECT id FROM voucher_campaigns WHERE static_code = ? AND id != ?")
                .bind(sc)
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?;
        if dup.is_some() {
            return Err(AppError::Conflict(format!(
                "Kode voucher statis \"{sc}\" sudah digunakan oleh campaign lain."
            )));
        }
    }

    sqlx::query(
        r#"
        UPDATE voucher_campaigns
        SET name = ?, code_mode = ?, static_code = ?, code_template = ?,
            display_format = ?, receipt_message = ?,
            auto_issue_on_pay = ?, issue_min_order_amount = ?, issue_regular_only = ?,
            issue_quota_limit = ?, issue_start_at = ?, issue_end_at = ?,
            discount_type = ?, discount_value = ?, max_discount = ?,
            redeem_min_order_amount = ?, redeem_regular_only = ?, redeem_quota_limit = ?,
            valid_days = ?, redeem_start_at = ?, redeem_end_at = ?,
            is_active = ?, updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(&v.name)
    .bind(v.code_mode)
    .bind(&v.static_code)
    .bind(&v.code_template)
    .bind(v.display_format)
    .bind(&v.receipt_message)
    .bind(v.auto_issue_on_pay)
    .bind(v.issue_min_order_amount)
    .bind(v.issue_regular_only)
    .bind(v.issue_quota_limit)
    .bind(&v.issue_start_at)
    .bind(&v.issue_end_at)
    .bind(v.discount_type)
    .bind(v.discount_value)
    .bind(v.max_discount)
    .bind(v.redeem_min_order_amount)
    .bind(v.redeem_regular_only)
    .bind(v.redeem_quota_limit)
    .bind(v.valid_days)
    .bind(&v.redeem_start_at)
    .bind(&v.redeem_end_at)
    .bind(is_active_int)
    .bind(&now)
    .bind(id)
    .execute(&mut *tx)
    .await?;

    let row: VoucherCampaignRow = sqlx::query_as("SELECT * FROM voucher_campaigns WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;

    tracing::info!(
        actor = %auth.username,
        campaign_id = id,
        is_active = req.is_active,
        "voucher campaign updated"
    );

    Ok(Json(VoucherCampaignResponse::from(row)))
}

pub async fn delete_voucher_campaign(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    auth.require_roles(&[Role::Owner, Role::Admin])?;
    let now = now_iso();
    let mut tx = begin_write_tx(&state.pool).await?;

    let exists: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM voucher_campaigns WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!("Voucher #{id} tidak ditemukan")));
    }

    let (issued_refs,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM issued_vouchers WHERE campaign_id = ?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    let (applied_refs,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM applied_vouchers WHERE campaign_id = ?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;

    let total_refs = issued_refs + applied_refs;
    if total_refs > 0 {
        sqlx::query("UPDATE voucher_campaigns SET is_active = 0, updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        tracing::info!(actor = %auth.username, campaign_id = id, total_refs, "voucher campaign soft-archived");
        return Ok(Json(json!({
            "deleted": false,
            "soft_deleted": true,
            "reason": format!("Voucher sudah memiliki {total_refs} riwayat sehingga diarsipkan agar audit tetap utuh.")
        })));
    }

    sqlx::query("DELETE FROM voucher_campaigns WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    tracing::info!(actor = %auth.username, campaign_id = id, "voucher campaign deleted");
    Ok(Json(json!({ "deleted": true, "soft_deleted": false })))
}

pub async fn issue_order_voucher(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(order_id): Path<i64>,
    Json(req): Json<IssueOrderVoucherRequest>,
) -> AppResult<Json<OrderDetail>> {
    auth.require_roles(&[Role::Cashier, Role::Owner, Role::Admin])?;
    let (_today, now) = now_business_and_iso();
    let now_dt = Local::now().format("%Y-%m-%dT%H:%M").to_string();
    let mut tx = begin_write_tx(&state.pool).await?;

    let order: OrderRow = sqlx::query_as("SELECT * FROM orders WHERE id = ?")
        .bind(order_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Nota #{order_id} tidak ditemukan")))?;

    if get_store_day_status_tx(&mut tx, &order.business_date).await? == "CLOSED" {
        return Err(AppError::Conflict(
            "Toko untuk tanggal nota ini sudah ditutup.".into(),
        ));
    }
    if order.status != "PAID" {
        return Err(AppError::Conflict(
            "Voucher hanya dapat diberikan pada nota yang sudah LUNAS.".into(),
        ));
    }

    let campaign: VoucherCampaignRow =
        sqlx::query_as("SELECT * FROM voucher_campaigns WHERE id = ?")
            .bind(req.campaign_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| {
                AppError::NotFound(format!("Voucher #{} tidak ditemukan", req.campaign_id))
            })?;

    let issued =
        issue_campaign_to_order_tx(&mut tx, &campaign, &order, &auth.username, &now, &now_dt)
            .await?;

    let detail = load_order_detail_tx(&mut tx, order.id).await?;
    tx.commit().await?;

    tracing::info!(
        actor = %auth.username,
        order_id = order.id,
        campaign_id = campaign.id,
        issued_voucher_id = issued.id,
        "voucher manually issued to paid order"
    );

    Ok(Json(detail))
}

pub async fn apply_order_voucher(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(order_id): Path<i64>,
    Json(req): Json<ApplyOrderVoucherRequest>,
) -> AppResult<Json<OrderDetail>> {
    auth.require_roles(&[Role::Cashier, Role::Owner, Role::Admin])?;
    let code = sanitize_single_line(&req.code).to_ascii_uppercase();
    if code.is_empty() || code.len() > 64 {
        return Err(AppError::Validation("Kode voucher wajib diisi.".into()));
    }

    let (_today, now) = now_business_and_iso();
    let now_dt = Local::now().format("%Y-%m-%dT%H:%M").to_string();
    let mut tx = begin_write_tx(&state.pool).await?;

    let order: OrderRow = sqlx::query_as("SELECT * FROM orders WHERE id = ?")
        .bind(order_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Nota #{order_id} tidak ditemukan")))?;

    if get_store_day_status_tx(&mut tx, &order.business_date).await? == "CLOSED" {
        return Err(AppError::Conflict(
            "Toko untuk tanggal nota ini sudah ditutup.".into(),
        ));
    }
    if order.status != "UNPAID" {
        return Err(AppError::Conflict(
            "Voucher hanya dapat ditukar pada nota yang BELUM BAYAR.".into(),
        ));
    }

    // Release any previously applied voucher on this UNPAID order first (transactional — rolled back if new voucher fails)
    let prev_vouchers: Vec<(i64, Option<i64>)> = sqlx::query_as(
        "SELECT campaign_id, issued_voucher_id FROM applied_vouchers WHERE order_id = ? AND status = 'APPLIED'",
    )
    .bind(order.id)
    .fetch_all(&mut *tx)
    .await?;
    if !prev_vouchers.is_empty() {
        sqlx::query(
            "UPDATE applied_vouchers SET status = 'VOIDED' WHERE order_id = ? AND status = 'APPLIED'",
        )
        .bind(order.id)
        .execute(&mut *tx)
        .await?;
        for (old_cid, old_iv) in prev_vouchers {
            sqlx::query(
                "UPDATE voucher_campaigns SET redeemed_count = MAX(0, redeemed_count - 1), updated_at = ? WHERE id = ?",
            )
            .bind(&now)
            .bind(old_cid)
            .execute(&mut *tx)
            .await?;
            if let Some(iv_id) = old_iv {
                release_issued_voucher_tx(&mut tx, iv_id, &now).await?;
            }
        }
    }

    // Lookup: first check unique DYNAMIC issued_voucher, then fallback to STATIC campaign code
    let dynamic_iv: Option<IssuedVoucherDetail> = sqlx::query_as(
        "SELECT * FROM issued_vouchers WHERE code = ? AND is_unique_code = 1 LIMIT 1",
    )
    .bind(&code)
    .fetch_optional(&mut *tx)
    .await?;

    let (campaign, issued_voucher_opt): (VoucherCampaignRow, Option<IssuedVoucherDetail>) =
        if let Some(iv) = dynamic_iv {
            if iv.status == "REDEEMED" {
                return Err(AppError::Conflict(format!(
                    "Kode voucher \"{code}\" sudah pernah digunakan."
                )));
            }
            if iv.status != "ACTIVE" {
                return Err(AppError::Conflict(format!(
                    "Kode voucher \"{code}\" sudah tidak berlaku (status: {}).",
                    iv.status
                )));
            }
            if iv.source_order_id == Some(order.id) {
                return Err(AppError::Conflict(
                    "Voucher tidak dapat ditukar pada nota yang sama saat diterbitkan.".into(),
                ));
            }
            if let Some(ref exp) = iv.expires_at {
                if now_dt.as_str() > exp.as_str() {
                    return Err(AppError::Conflict(format!(
                        "Voucher \"{code}\" sudah kedaluwarsa pada {}.",
                        exp.replace('T', " ")
                    )));
                }
            }
            let camp: VoucherCampaignRow =
                sqlx::query_as("SELECT * FROM voucher_campaigns WHERE id = ?")
                    .bind(iv.campaign_id)
                    .fetch_one(&mut *tx)
                    .await?;
            (camp, Some(iv))
        } else {
            let camp: VoucherCampaignRow = sqlx::query_as(
                "SELECT * FROM voucher_campaigns WHERE code_mode = 'STATIC' AND static_code = ?",
            )
            .bind(&code)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| {
                AppError::NotFound(format!("Kode voucher \"{code}\" tidak ditemukan."))
            })?;
            (camp, None)
        };

    if campaign.is_active == 0 {
        return Err(AppError::Conflict("Voucher ini sudah tidak aktif.".into()));
    }
    if let Some(ref start) = campaign.redeem_start_at {
        if now_dt.as_str() < start.as_str() {
            return Err(AppError::Conflict(format!(
                "Voucher ini baru dapat ditukar mulai {}.",
                start.replace('T', " ")
            )));
        }
    }
    if let Some(ref end) = campaign.redeem_end_at {
        if now_dt.as_str() > end.as_str() {
            return Err(AppError::Conflict(format!(
                "Masa penukaran voucher ini sudah berakhir pada {}.",
                end.replace('T', " ")
            )));
        }
    }
    if campaign.redeem_regular_only != 0 && !is_order_regular_tx(&mut tx, &order).await? {
        return Err(AppError::Conflict(
            "Voucher ini hanya dapat ditukar pada saluran Regular (makan di tempat / bungkus)."
                .into(),
        ));
    }
    if order.subtotal_amount < campaign.redeem_min_order_amount {
        return Err(AppError::Validation(format!(
            "Minimal belanja untuk menukar voucher ini adalah Rp{}.",
            campaign.redeem_min_order_amount
        )));
    }

    // Atomic claims
    if let Some(ref iv) = issued_voucher_opt {
        let iv_claim = sqlx::query(
            "UPDATE issued_vouchers SET status = 'REDEEMED' WHERE id = ? AND status = 'ACTIVE'",
        )
        .bind(iv.id)
        .execute(&mut *tx)
        .await?;
        if iv_claim.rows_affected() == 0 {
            return Err(AppError::Conflict(format!(
                "Kode voucher \"{code}\" sudah digunakan."
            )));
        }
    }

    let camp_claim = sqlx::query(
        "UPDATE voucher_campaigns SET redeemed_count = redeemed_count + 1, updated_at = ? WHERE id = ? AND is_active = 1 AND redeemed_count < redeem_quota_limit",
    )
    .bind(&now)
    .bind(campaign.id)
    .execute(&mut *tx)
    .await?;
    if camp_claim.rows_affected() == 0 {
        return Err(AppError::Conflict(format!(
            "Kuota penukaran voucher \"{}\" sudah habis ({}/{}).",
            campaign.name, campaign.redeemed_count, campaign.redeem_quota_limit
        )));
    }

    let discount_amount = compute_discount(
        order.subtotal_amount,
        &campaign.discount_type,
        campaign.discount_value,
        campaign.max_discount,
    );

    sqlx::query(
        r#"
        INSERT INTO applied_vouchers (
            order_id, campaign_id, issued_voucher_id, code_snapshot,
            campaign_name_snapshot, discount_amount, applied_by_username,
            status, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'APPLIED', ?)
        "#,
    )
    .bind(order.id)
    .bind(campaign.id)
    .bind(issued_voucher_opt.as_ref().map(|iv| iv.id))
    .bind(&code)
    .bind(&campaign.name)
    .bind(discount_amount)
    .bind(&auth.username)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    recalculate_order_totals_tx(&mut tx, order.id, order.subtotal_amount).await?;
    let detail = load_order_detail_tx(&mut tx, order.id).await?;
    tx.commit().await?;

    tracing::info!(
        actor = %auth.username,
        order_id = order.id,
        campaign_id = campaign.id,
        code = %code,
        discount_amount,
        "voucher redeemed on order"
    );

    Ok(Json(detail))
}

pub async fn remove_order_voucher(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(order_id): Path<i64>,
) -> AppResult<Json<OrderDetail>> {
    auth.require_roles(&[Role::Cashier, Role::Owner, Role::Admin])?;
    let (_today, now) = now_business_and_iso();
    let mut tx = begin_write_tx(&state.pool).await?;

    let order: OrderRow = sqlx::query_as("SELECT * FROM orders WHERE id = ?")
        .bind(order_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Nota #{order_id} tidak ditemukan")))?;

    if get_store_day_status_tx(&mut tx, &order.business_date).await? == "CLOSED" {
        return Err(AppError::Conflict(
            "Toko untuk tanggal nota ini sudah ditutup.".into(),
        ));
    }
    if order.status != "UNPAID" {
        return Err(AppError::Conflict(
            "Voucher hanya dapat dihapus pada nota yang BELUM BAYAR.".into(),
        ));
    }

    let prev_vouchers: Vec<(i64, Option<i64>)> = sqlx::query_as(
        "SELECT campaign_id, issued_voucher_id FROM applied_vouchers WHERE order_id = ? AND status = 'APPLIED'",
    )
    .bind(order.id)
    .fetch_all(&mut *tx)
    .await?;

    sqlx::query(
        "UPDATE applied_vouchers SET status = 'VOIDED' WHERE order_id = ? AND status = 'APPLIED'",
    )
    .bind(order.id)
    .execute(&mut *tx)
    .await?;

    for (cid, iv_id) in prev_vouchers {
        sqlx::query(
            "UPDATE voucher_campaigns SET redeemed_count = MAX(0, redeemed_count - 1), updated_at = ? WHERE id = ?",
        )
        .bind(&now)
        .bind(cid)
        .execute(&mut *tx)
        .await?;
        if let Some(iv) = iv_id {
            release_issued_voucher_tx(&mut tx, iv, &now).await?;
        }
    }

    recalculate_order_totals_tx(&mut tx, order.id, order.subtotal_amount).await?;
    let detail = load_order_detail_tx(&mut tx, order.id).await?;
    tx.commit().await?;

    tracing::info!(actor = %auth.username, order_id = order.id, "voucher removed from order");
    Ok(Json(detail))
}
