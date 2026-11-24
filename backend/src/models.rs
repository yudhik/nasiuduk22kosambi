use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct MenuItem {
    pub id: i64,
    pub name: String,
    pub category: String,
    pub price: i64,
    pub current_stock: i64,
    pub default_daily_stock: i64,
    pub is_active: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateMenuRequest {
    pub name: String,
    pub category: Option<String>,
    pub price: i64,
    pub current_stock: Option<i64>,
    pub default_daily_stock: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateMenuRequest {
    pub name: String,
    pub category: String,
    pub price: i64,
    pub default_daily_stock: i64,
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

#[derive(Debug, Serialize)]
pub struct StartDayResponse {
    pub business_date: String,
    pub initialized_count: usize,
    pub skipped_with_sales: usize,
}

#[derive(Debug, Deserialize)]
pub struct CreateOrderItemRequest {
    pub menu_item_id: i64,
    pub quantity: i64,
    pub item_note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateOrderRequest {
    pub customer_label: Option<String>,
    pub waiter_name: Option<String>,
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
    pub customer_label: String,
    pub waiter_name: String,
    pub notes: String,
    pub status: String,
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
    pub customer_label: String,
    pub waiter_name: String,
    pub notes: String,
    pub status: String,
    pub total_amount: i64,
    pub created_at: String,
    pub paid_at: Option<String>,
    pub voided_at: Option<String>,
    pub void_reason: Option<String>,
    pub items: Vec<OrderItemDetail>,
}

impl OrderDetail {
    pub fn from_parts(order: OrderRow, items: Vec<OrderItemDetail>) -> Self {
        Self {
            id: order.id,
            order_number: order.order_number,
            business_date: order.business_date,
            customer_label: order.customer_label,
            waiter_name: order.waiter_name,
            notes: order.notes,
            status: order.status,
            total_amount: order.total_amount,
            created_at: order.created_at,
            paid_at: order.paid_at,
            voided_at: order.voided_at,
            void_reason: order.void_reason,
            items,
        }
    }
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
    pub menu_item_id: i64,
    pub menu_name: String,
    pub category: String,
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
    pub revenue: RevenueSummary,
    pub sales_by_menu: Vec<MenuSalesSummary>,
    pub stock_reconciliation: Vec<StockReconciliationRow>,
}

#[derive(Debug, Deserialize)]
pub struct PhysicalStockEntry {
    pub menu_item_id: i64,
    pub physical_stock: Option<i64>,
    pub notes: Option<String>,
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
    pub menu_item_id: i64,
    pub menu_name: String,
    pub order_id: Option<i64>,
    pub movement_type: String,
    pub qty_delta: i64,
    pub stock_after: i64,
    pub note: String,
    pub created_at: String,
}
