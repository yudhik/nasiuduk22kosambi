use serde::{Deserialize, Serialize};
use sqlx::FromRow;

// ===== Stock Items & Multi-Stock Menu Models =====

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct StockItem {
    pub id: i64,
    pub name: String,
    pub unit: String,
    pub current_stock: i64,
    pub is_active: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateStockItemRequest {
    pub name: String,
    pub unit: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateStockItemRequest {
    pub name: String,
    pub unit: String,
    pub is_active: bool,
}

#[derive(Debug, Deserialize)]
pub struct SetInitialStockRequest {
    pub initial_stock: i64,
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RestockRequest {
    pub quantity: i64,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MenuStockRequirementInput {
    pub stock_item_id: i64,
    pub qty_per_unit: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct MenuStockRequirementDetail {
    pub stock_item_id: i64,
    pub stock_name: String,
    pub stock_unit: String,
    pub stock_current: i64,
    pub qty_per_unit: i64,
}

#[derive(Debug, Clone, FromRow)]
pub struct MenuItemRow {
    pub id: i64,
    pub name: String,
    pub category: String,
    pub price: i64,
    pub is_active: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MenuItem {
    pub id: i64,
    pub name: String,
    pub category: String,
    pub price: i64,
    pub available_stock: i64,
    pub is_active: i64,
    pub created_at: String,
    pub updated_at: String,
    pub stock_requirements: Vec<MenuStockRequirementDetail>,
}

#[derive(Debug, Deserialize)]
pub struct CreateMenuRequest {
    pub name: String,
    pub category: Option<String>,
    pub price: i64,
    #[serde(default)]
    pub stock_requirements: Vec<MenuStockRequirementInput>,
    #[serde(default)]
    pub create_self_stock_qty: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateMenuRequest {
    pub name: String,
    pub category: String,
    pub price: i64,
    pub is_active: bool,
    pub stock_requirements: Vec<MenuStockRequirementInput>,
}

#[derive(Debug, Deserialize)]
pub struct ImportMenuCsvRequest {
    pub csv_content: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportMenuCsvResponse {
    pub imported_count: usize,
    pub skipped_count: usize,
    pub skipped_names: Vec<String>,
    pub created_stock_items: usize,
    pub errors: Vec<String>,
}

// ===== Sales Channels =====

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct SalesChannel {
    pub id: i64,
    pub code: String,
    pub name: String,
    pub is_auto_paid: i64,
    pub is_active: i64,
    pub sort_order: i64,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateChannelRequest {
    pub name: String,
    pub is_auto_paid: Option<bool>,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateChannelRequest {
    pub name: String,
    pub is_auto_paid: bool,
    pub is_active: bool,
    pub sort_order: i64,
}

// ===== Store Open / Close Lifecycle =====

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct StoreDayRow {
    pub business_date: String,
    pub status: String,
    pub opened_at: String,
    pub opened_by_user_id: Option<i64>,
    pub opened_by_username: String,
    pub closed_at: Option<String>,
    pub closed_by_user_id: Option<i64>,
    pub closed_by_username: Option<String>,
    pub total_orders: i64,
    pub paid_orders: i64,
    pub voided_orders: i64,
    pub gross_revenue: i64,
    pub total_expenses: i64,
    pub net_profit: i64,
    pub total_portions_sold: i64,
    pub closing_notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoreStatusResponse {
    pub business_date: String,
    pub status: String, // "NOT_OPENED" | "OPEN" | "CLOSED"
    pub opened_at: Option<String>,
    pub opened_by_username: Option<String>,
    pub closed_at: Option<String>,
    pub closed_by_username: Option<String>,
    pub unpaid_order_count: i64,
    pub pending_prior_date: Option<String>,
    pub pending_prior_unpaid_count: i64,
    pub closing_summary: Option<StoreDayRow>,
}

#[derive(Debug, Deserialize)]
pub struct OpenStoreStockEntry {
    pub stock_item_id: i64,
    pub initial_stock: i64,
}

#[derive(Debug, Deserialize)]
pub struct OpenStoreRequest {
    pub stocks: Vec<OpenStoreStockEntry>,
}

#[derive(Debug, Deserialize)]
pub struct PhysicalStockEntry {
    pub stock_item_id: i64,
    pub physical_stock: Option<i64>,
    pub notes: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CloseStoreRequest {
    pub physical_stocks: Option<Vec<PhysicalStockEntry>>,
    pub closing_notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResetStoreDayResponse {
    pub backup_filename: String,
    pub deleted_orders: i64,
    pub deleted_snapshots: i64,
    pub deleted_movements: i64,
    pub store_status: StoreStatusResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ReceiptSettings {
    pub header_text: String,
    pub footer_text: String,
    pub header_bold: bool,
    pub header_font_size: String,
    pub review_enabled: bool,
    pub review_text: String,
    pub review_url: String,
    pub updated_at: String,
    pub updated_by_username: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateReceiptSettingsRequest {
    pub header_text: String,
    pub footer_text: String,
    #[serde(default = "default_header_bold")]
    pub header_bold: bool,
    #[serde(default = "default_header_font_size")]
    pub header_font_size: String,
    #[serde(default)]
    pub review_enabled: bool,
    #[serde(default)]
    pub review_text: String,
    #[serde(default)]
    pub review_url: String,
}

fn default_header_bold() -> bool {
    true
}

fn default_header_font_size() -> String {
    "tall".to_string()
}

// ===== Daily Expenses =====

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct DailyExpense {
    pub id: i64,
    pub business_date: String,
    pub title: String,
    pub category: String,
    pub amount: i64,
    pub notes: String,
    pub created_by_user_id: Option<i64>,
    pub created_by_username: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateExpenseRequest {
    pub business_date: Option<String>,
    pub title: String,
    pub category: Option<String>,
    pub amount: i64,
    pub notes: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateExpenseRequest {
    pub business_date: Option<String>,
    pub title: String,
    pub category: String,
    pub amount: i64,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ExpenseCategory {
    pub id: i64,
    pub name: String,
    pub is_active: i64,
    pub sort_order: i64,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateExpenseCategoryRequest {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateExpenseCategoryRequest {
    pub name: String,
    pub is_active: bool,
}

// ===== Promotions =====

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct PromotionSchedule {
    pub id: i64,
    pub promo_id: i64,
    pub day_of_week: i64,
    pub start_time: String,
    pub end_time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromotionScheduleInput {
    pub day_of_week: i64,
    pub start_time: String,
    pub end_time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct PromotionRow {
    pub id: i64,
    pub name: String,
    pub discount_type: String,
    pub discount_value: i64,
    pub max_discount: Option<i64>,
    pub min_order_amount: i64,
    pub quota_limit: i64,
    pub used_count: i64,
    pub start_at: Option<String>,
    pub end_at: Option<String>,
    pub regular_only: i64,
    pub is_active: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromotionResponse {
    pub id: i64,
    pub name: String,
    pub discount_type: String,
    pub discount_value: i64,
    pub max_discount: Option<i64>,
    pub min_order_amount: i64,
    pub quota_limit: i64,
    pub used_count: i64,
    pub remaining_quota: i64,
    pub start_at: Option<String>,
    pub end_at: Option<String>,
    pub schedules: Vec<PromotionSchedule>,
    pub regular_only: bool,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl PromotionResponse {
    pub fn from_parts(row: PromotionRow, schedules: Vec<PromotionSchedule>) -> Self {
        let remaining_quota = row.quota_limit.saturating_sub(row.used_count);
        Self {
            id: row.id,
            name: row.name,
            discount_type: row.discount_type,
            discount_value: row.discount_value,
            max_discount: row.max_discount,
            min_order_amount: row.min_order_amount,
            quota_limit: row.quota_limit,
            used_count: row.used_count,
            remaining_quota,
            start_at: row.start_at,
            end_at: row.end_at,
            schedules,
            regular_only: row.regular_only != 0,
            is_active: row.is_active != 0,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct CreatePromotionRequest {
    pub name: String,
    pub discount_type: String,
    pub discount_value: i64,
    pub max_discount: Option<i64>,
    pub min_order_amount: Option<i64>,
    pub quota_limit: i64,
    pub start_at: Option<String>,
    pub end_at: Option<String>,
    pub schedules: Option<Vec<PromotionScheduleInput>>,
    pub regular_only: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct UpdatePromotionRequest {
    pub name: String,
    pub discount_type: String,
    pub discount_value: i64,
    pub max_discount: Option<i64>,
    pub min_order_amount: i64,
    pub quota_limit: i64,
    pub start_at: Option<String>,
    pub end_at: Option<String>,
    pub schedules: Option<Vec<PromotionScheduleInput>>,
    pub regular_only: bool,
    pub is_active: bool,
}

#[derive(Debug, Deserialize)]
pub struct ApplyOrderPromoRequest {
    pub promo_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct AppliedPromotionDetail {
    pub id: i64,
    pub order_id: i64,
    pub promo_id: i64,
    pub promo_name_snapshot: String,
    pub discount_amount: i64,
    pub applied_by_username: String,
    pub status: String,
    pub created_at: String,
}

// ===== Vouchers =====

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct VoucherCampaignRow {
    pub id: i64,
    pub name: String,
    pub code_mode: String,
    pub static_code: Option<String>,
    pub code_template: Option<String>,
    pub display_format: String,
    pub receipt_message: String,
    pub auto_issue_on_pay: i64,
    pub issue_min_order_amount: i64,
    pub issue_regular_only: i64,
    pub issue_quota_limit: i64,
    pub issued_count: i64,
    pub seq_counter: i64,
    pub issue_start_at: Option<String>,
    pub issue_end_at: Option<String>,
    pub discount_type: String,
    pub discount_value: i64,
    pub max_discount: Option<i64>,
    pub redeem_min_order_amount: i64,
    pub redeem_regular_only: i64,
    pub redeem_quota_limit: i64,
    pub redeemed_count: i64,
    pub valid_days: Option<i64>,
    pub redeem_start_at: Option<String>,
    pub redeem_end_at: Option<String>,
    pub is_active: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoucherCampaignResponse {
    pub id: i64,
    pub name: String,
    pub code_mode: String,
    pub static_code: Option<String>,
    pub code_template: Option<String>,
    pub display_format: String,
    pub receipt_message: String,
    pub auto_issue_on_pay: bool,
    pub issue_min_order_amount: i64,
    pub issue_regular_only: bool,
    pub issue_quota_limit: i64,
    pub issued_count: i64,
    pub remaining_issue_quota: i64,
    pub issue_start_at: Option<String>,
    pub issue_end_at: Option<String>,
    pub discount_type: String,
    pub discount_value: i64,
    pub max_discount: Option<i64>,
    pub redeem_min_order_amount: i64,
    pub redeem_regular_only: bool,
    pub redeem_quota_limit: i64,
    pub redeemed_count: i64,
    pub remaining_redeem_quota: i64,
    pub valid_days: Option<i64>,
    pub redeem_start_at: Option<String>,
    pub redeem_end_at: Option<String>,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl From<VoucherCampaignRow> for VoucherCampaignResponse {
    fn from(r: VoucherCampaignRow) -> Self {
        Self {
            id: r.id,
            name: r.name,
            code_mode: r.code_mode,
            static_code: r.static_code,
            code_template: r.code_template,
            display_format: r.display_format,
            receipt_message: r.receipt_message,
            auto_issue_on_pay: r.auto_issue_on_pay != 0,
            issue_min_order_amount: r.issue_min_order_amount,
            issue_regular_only: r.issue_regular_only != 0,
            issue_quota_limit: r.issue_quota_limit,
            issued_count: r.issued_count,
            remaining_issue_quota: r.issue_quota_limit.saturating_sub(r.issued_count),
            issue_start_at: r.issue_start_at,
            issue_end_at: r.issue_end_at,
            discount_type: r.discount_type,
            discount_value: r.discount_value,
            max_discount: r.max_discount,
            redeem_min_order_amount: r.redeem_min_order_amount,
            redeem_regular_only: r.redeem_regular_only != 0,
            redeem_quota_limit: r.redeem_quota_limit,
            redeemed_count: r.redeemed_count,
            remaining_redeem_quota: r.redeem_quota_limit.saturating_sub(r.redeemed_count),
            valid_days: r.valid_days,
            redeem_start_at: r.redeem_start_at,
            redeem_end_at: r.redeem_end_at,
            is_active: r.is_active != 0,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct CreateVoucherCampaignRequest {
    pub name: String,
    pub code_mode: String,
    pub static_code: Option<String>,
    pub code_template: Option<String>,
    pub display_format: Option<String>,
    pub receipt_message: Option<String>,
    pub auto_issue_on_pay: Option<bool>,
    pub issue_min_order_amount: Option<i64>,
    pub issue_regular_only: Option<bool>,
    pub issue_quota_limit: i64,
    pub issue_start_at: Option<String>,
    pub issue_end_at: Option<String>,
    pub discount_type: String,
    pub discount_value: i64,
    pub max_discount: Option<i64>,
    pub redeem_min_order_amount: Option<i64>,
    pub redeem_regular_only: Option<bool>,
    pub redeem_quota_limit: i64,
    pub valid_days: Option<i64>,
    pub redeem_start_at: Option<String>,
    pub redeem_end_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateVoucherCampaignRequest {
    pub name: String,
    pub code_mode: String,
    pub static_code: Option<String>,
    pub code_template: Option<String>,
    pub display_format: String,
    pub receipt_message: String,
    pub auto_issue_on_pay: bool,
    pub issue_min_order_amount: i64,
    pub issue_regular_only: bool,
    pub issue_quota_limit: i64,
    pub issue_start_at: Option<String>,
    pub issue_end_at: Option<String>,
    pub discount_type: String,
    pub discount_value: i64,
    pub max_discount: Option<i64>,
    pub redeem_min_order_amount: i64,
    pub redeem_regular_only: bool,
    pub redeem_quota_limit: i64,
    pub valid_days: Option<i64>,
    pub redeem_start_at: Option<String>,
    pub redeem_end_at: Option<String>,
    pub is_active: bool,
}

#[derive(Debug, Deserialize)]
pub struct ApplyOrderVoucherRequest {
    pub code: String,
}

#[derive(Debug, Deserialize)]
pub struct IssueOrderVoucherRequest {
    pub campaign_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct IssuedVoucherDetail {
    pub id: i64,
    pub campaign_id: i64,
    pub source_order_id: Option<i64>,
    pub code: String,
    pub is_unique_code: i64,
    pub display_format_snapshot: String,
    pub receipt_message_snapshot: String,
    pub status: String,
    pub expires_at: Option<String>,
    pub issued_by_username: String,
    pub issued_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct AppliedVoucherDetail {
    pub id: i64,
    pub order_id: i64,
    pub campaign_id: i64,
    pub issued_voucher_id: Option<i64>,
    pub code_snapshot: String,
    pub campaign_name_snapshot: String,
    pub discount_amount: i64,
    pub applied_by_username: String,
    pub status: String,
    pub created_at: String,
}

// ===== Orders (Nota Digital) =====

#[derive(Debug, Deserialize)]
pub struct CreateOrderItemRequest {
    pub menu_item_id: i64,
    pub quantity: i64,
    pub item_note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateOrderRequest {
    pub channel_id: Option<i64>,
    pub customer_label: Option<String>,
    pub notes: Option<String>,
    pub items: Vec<CreateOrderItemRequest>,
}

#[derive(Debug, Deserialize)]
pub struct VoidOrderRequest {
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct OrderItemDetail {
    pub id: i64,
    pub order_id: i64,
    pub menu_item_id: i64,
    pub menu_name_snapshot: String,
    pub unit_price_snapshot: i64,
    pub quantity: i64,
    pub subtotal: i64,
    pub item_note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct OrderRow {
    pub id: i64,
    pub order_number: String,
    pub business_date: String,
    pub channel_id: Option<i64>,
    pub channel_name_snapshot: String,
    pub customer_label: String,
    pub waiter_name: String,
    pub created_by_user_id: Option<i64>,
    pub notes: String,
    pub status: String,
    pub subtotal_amount: i64,
    pub discount_amount: i64,
    pub total_amount: i64,
    pub created_at: String,
    pub paid_at: Option<String>,
    pub voided_at: Option<String>,
    pub void_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderDetail {
    pub id: i64,
    pub order_number: String,
    pub business_date: String,
    pub channel_id: Option<i64>,
    pub channel_name: String,
    pub customer_label: String,
    pub waiter_name: String,
    pub created_by_user_id: Option<i64>,
    pub notes: String,
    pub status: String,
    pub subtotal_amount: i64,
    pub discount_amount: i64,
    pub total_amount: i64,
    pub applied_promotions: Vec<AppliedPromotionDetail>,
    pub applied_vouchers: Vec<AppliedVoucherDetail>,
    pub issued_vouchers: Vec<IssuedVoucherDetail>,
    pub created_at: String,
    pub paid_at: Option<String>,
    pub voided_at: Option<String>,
    pub void_reason: Option<String>,
    pub items: Vec<OrderItemDetail>,
}

impl OrderDetail {
    pub fn from_parts(
        order: OrderRow,
        items: Vec<OrderItemDetail>,
        applied_promotions: Vec<AppliedPromotionDetail>,
        applied_vouchers: Vec<AppliedVoucherDetail>,
        issued_vouchers: Vec<IssuedVoucherDetail>,
    ) -> Self {
        Self {
            id: order.id,
            order_number: order.order_number,
            business_date: order.business_date,
            channel_id: order.channel_id,
            channel_name: order.channel_name_snapshot,
            customer_label: order.customer_label,
            waiter_name: order.waiter_name,
            created_by_user_id: order.created_by_user_id,
            notes: order.notes,
            status: order.status,
            subtotal_amount: order.subtotal_amount,
            discount_amount: order.discount_amount,
            total_amount: order.total_amount,
            applied_promotions,
            applied_vouchers,
            issued_vouchers,
            created_at: order.created_at,
            paid_at: order.paid_at,
            voided_at: order.voided_at,
            void_reason: order.void_reason,
            items,
        }
    }
}

// ===== Daily Report & Performance Analytics =====

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct PromoUsageSummary {
    pub promo_name: String,
    pub order_count: i64,
    pub total_discount: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RevenueSummary {
    pub paid_total: i64,
    pub paid_count: i64,
    pub unpaid_total: i64,
    pub unpaid_count: i64,
    pub voided_total: i64,
    pub voided_count: i64,
    pub total_portions_sold: i64,
    pub total_discounts: i64,
    pub total_expenses: i64,
    pub net_profit: i64,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct ChannelSalesSummary {
    pub channel_name: String,
    pub order_count: i64,
    pub paid_count: i64,
    pub unpaid_count: i64,
    pub total_revenue: i64,
    pub paid_revenue: i64,
    pub unpaid_revenue: i64,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct MenuSalesSummary {
    pub menu_item_id: i64,
    pub menu_name: String,
    pub quantity_sold: i64,
    pub total_revenue: i64,
    pub paid_revenue: i64,
    pub unpaid_revenue: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StockReconciliationRow {
    pub stock_item_id: i64,
    pub stock_name: String,
    pub unit: String,
    pub initial_stock: i64,
    pub restocked_qty: i64,
    pub sold_qty: i64,
    pub voided_qty: i64,
    pub system_remaining: i64,
    pub current_stock: i64,
    pub physical_stock: Option<i64>,
    pub variance: Option<i64>,
    pub notes: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DailyReportResponse {
    pub business_date: String,
    pub store_status: String,
    pub revenue: RevenueSummary,
    pub sales_by_channel: Vec<ChannelSalesSummary>,
    pub sales_by_menu: Vec<MenuSalesSummary>,
    pub promo_summary: Vec<PromoUsageSummary>,
    pub expenses: Vec<DailyExpense>,
    pub stock_reconciliation: Vec<StockReconciliationRow>,
}

#[derive(Debug, Deserialize)]
pub struct UpdatePhysicalStockRequest {
    pub business_date: Option<String>,
    pub entries: Vec<PhysicalStockEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct StockMovement {
    pub id: i64,
    pub business_date: String,
    pub stock_item_id: i64,
    pub stock_name: String,
    pub order_id: Option<i64>,
    pub movement_type: String,
    pub qty_delta: i64,
    pub stock_after: i64,
    pub note: String,
    pub created_at: String,
}

// ===== Performance Analytics =====

#[derive(Debug, Serialize, Deserialize)]
pub struct AnalyticsSummary {
    pub total_revenue: i64,
    pub total_expenses: i64,
    pub net_profit: i64,
    pub total_orders: i64,
    pub paid_orders: i64,
    pub voided_orders: i64,
    pub total_portions: i64,
    pub avg_order_value: i64,
    pub closed_days_count: i64,
    pub active_days_count: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DailyPerformancePoint {
    pub business_date: String,
    pub store_status: String,
    pub revenue: i64,
    pub expenses: i64,
    pub net_profit: i64,
    pub order_count: i64,
    pub portions_sold: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChannelPerformanceStat {
    pub channel_name: String,
    pub order_count: i64,
    pub revenue: i64,
    pub share_percent: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PeakHourStat {
    pub hour: i64,
    pub label: String,
    pub order_count: i64,
    pub revenue: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WeekdayStat {
    pub weekday_index: u32,
    pub label: String,
    pub order_count: i64,
    pub revenue: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StockVarianceSummary {
    pub stock_item_id: i64,
    pub stock_name: String,
    pub unit: String,
    pub total_supplied: i64,
    pub total_sold: i64,
    pub total_leftover: i64,
    pub total_variance: i64,
    pub opname_days: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UserOrderIntervalStat {
    pub username: String,
    pub orders_created: i64,
    pub interval_samples: i64,
    pub avg_interval_seconds: Option<i64>,
    pub min_interval_seconds: Option<i64>,
    pub max_interval_seconds: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PerformanceAnalyticsResponse {
    pub from_date: String,
    pub to_date: String,
    pub summary: AnalyticsSummary,
    pub daily_trend: Vec<DailyPerformancePoint>,
    pub by_channel: Vec<ChannelPerformanceStat>,
    pub top_menus: Vec<MenuSalesSummary>,
    pub bottom_menus: Vec<MenuSalesSummary>,
    pub stock_summary: Vec<StockVarianceSummary>,
    pub peak_hours: Vec<PeakHourStat>,
    pub by_weekday: Vec<WeekdayStat>,
    pub user_order_intervals: Vec<UserOrderIntervalStat>,
}

// ===== Auth & User Management Models =====

#[derive(Debug, Clone, FromRow)]
pub struct UserRow {
    pub id: i64,
    pub username: String,
    pub full_name: String,
    pub password_hash: String,
    pub role: String,
    pub is_active: i64,
    pub is_env_admin: i64,
    pub failed_login_attempts: i64,
    pub is_locked: i64,
    pub locked_at: Option<String>,
    pub locked_until: Option<String>,
    pub last_login_at: Option<String>,
    pub last_logout_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthUserResponse {
    pub id: i64,
    pub username: String,
    pub full_name: String,
    pub role: String,
    pub is_env_admin: bool,
    pub allowed_tabs: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminUserSummary {
    pub id: i64,
    pub username: String,
    pub full_name: String,
    pub role: String,
    pub is_active: bool,
    pub is_env_admin: bool,
    pub failed_login_attempts: i64,
    pub is_locked: bool,
    pub locked_at: Option<String>,
    pub locked_until: Option<String>,
    pub last_login_at: Option<String>,
    pub last_logout_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateUserRequest {
    pub username: String,
    pub full_name: String,
    pub password: String,
    pub role: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateUserRequest {
    pub full_name: String,
    pub role: String,
    pub is_active: bool,
}

#[derive(Debug, Deserialize)]
pub struct ResetPasswordRequest {
    pub new_password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSessionLog {
    pub id: i64,
    pub user_id: i64,
    pub username: String,
    pub full_name: String,
    pub role: String,
    pub login_at: String,
    pub logout_at: Option<String>,
    pub expires_at: String,
    pub status: String,
    pub ip_address: String,
    pub user_agent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct AuthEventLog {
    pub id: i64,
    pub user_id: Option<i64>,
    pub username: String,
    pub event_type: String,
    pub detail: String,
    pub ip_address: String,
    pub created_at: String,
}
