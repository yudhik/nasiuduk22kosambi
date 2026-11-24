export interface MenuItem {
  id: number;
  name: string;
  category: string;
  price: number;
  current_stock: number;
  default_daily_stock: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface CreateMenuPayload {
  name: string;
  category?: string;
  price: number;
  current_stock?: number;
  default_daily_stock?: number;
}

export interface UpdateMenuPayload {
  name: string;
  category: string;
  price: number;
  default_daily_stock: number;
  is_active: boolean;
}

export interface StartDayResponse {
  business_date: string;
  initialized_count: number;
  skipped_with_sales: number;
}

export interface OrderItemDetail {
  id: number;
  order_id: number;
  menu_item_id: number;
  menu_name_snapshot: string;
  unit_price_snapshot: number;
  quantity: number;
  subtotal: number;
  item_note: string;
}

export type OrderStatus = 'UNPAID' | 'PAID' | 'VOIDED';

export interface OrderDetail {
  id: number;
  order_number: string;
  business_date: string;
  customer_label: string;
  waiter_name: string;
  notes: string;
  status: OrderStatus;
  total_amount: number;
  created_at: string;
  paid_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  items: OrderItemDetail[];
}

export interface CreateOrderPayload {
  customer_label?: string;
  waiter_name?: string;
  notes?: string;
  items: Array<{
    menu_item_id: number;
    quantity: number;
    item_note?: string;
  }>;
}

export interface RevenueSummary {
  paid_total: number;
  paid_count: number;
  unpaid_total: number;
  unpaid_count: number;
  voided_total: number;
  voided_count: number;
  total_portions_sold: number;
}

export interface MenuSalesSummary {
  menu_item_id: number;
  menu_name: string;
  quantity_sold: number;
  total_revenue: number;
  paid_revenue: number;
  unpaid_revenue: number;
}

export interface StockReconciliationRow {
  menu_item_id: number;
  menu_name: string;
  category: string;
  initial_stock: number;
  restocked_qty: number;
  sold_qty: number;
  voided_qty: number;
  system_remaining: number;
  current_stock: number;
  physical_stock: number | null;
  variance: number | null;
  notes: string;
}

export interface DailyReportResponse {
  business_date: string;
  revenue: RevenueSummary;
  sales_by_menu: MenuSalesSummary[];
  stock_reconciliation: StockReconciliationRow[];
}

export interface StockMovement {
  id: number;
  business_date: string;
  menu_item_id: number;
  menu_name: string;
  order_id: number | null;
  movement_type: 'SET_INITIAL' | 'RESTOCK' | 'ORDER_DEDUCT' | 'ORDER_VOID_RESTORE';
  qty_delta: number;
  stock_after: number;
  note: string;
  created_at: string;
}
