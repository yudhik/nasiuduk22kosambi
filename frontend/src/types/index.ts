export const STORE_NAME = 'Nasi Uduk 22 Kosambi - Mpok Indri';

export interface StockItem {
  id: number;
  name: string;
  unit: string;
  current_stock: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface MenuStockRequirementInput {
  stock_item_id: number;
  qty_per_unit: number;
}

export interface MenuStockRequirementDetail {
  stock_item_id: number;
  stock_name: string;
  stock_unit: string;
  stock_current: number;
  qty_per_unit: number;
}

export interface MenuItem {
  id: number;
  name: string;
  category: string;
  price: number;
  available_stock: number;
  is_active: number;
  created_at: string;
  updated_at: string;
  stock_requirements: MenuStockRequirementDetail[];
}

export interface CreateMenuPayload {
  name: string;
  category?: string;
  price: number;
  stock_requirements: MenuStockRequirementInput[];
  create_self_stock_qty?: number;
}

export interface UpdateMenuPayload {
  name: string;
  category: string;
  price: number;
  is_active: boolean;
  stock_requirements: MenuStockRequirementInput[];
}

export interface ImportMenuCsvResponse {
  imported_count: number;
  skipped_count: number;
  skipped_names: string[];
  created_stock_items: number;
  errors: string[];
}

export interface SalesChannel {
  id: number;
  code: string;
  name: string;
  is_auto_paid: number;
  is_active: number;
  sort_order: number;
  created_at: string;
}

export interface StoreDaySummary {
  business_date: string;
  status: 'OPEN' | 'CLOSED';
  opened_at: string;
  opened_by_user_id: number | null;
  opened_by_username: string;
  closed_at: string | null;
  closed_by_user_id: number | null;
  closed_by_username: string | null;
  total_orders: number;
  paid_orders: number;
  voided_orders: number;
  gross_revenue: number;
  total_expenses: number;
  net_profit: number;
  total_portions_sold: number;
  closing_notes: string;
}

export interface StoreStatusResponse {
  business_date: string;
  status: 'NOT_OPENED' | 'OPEN' | 'CLOSED';
  opened_at: string | null;
  opened_by_username: string | null;
  closed_at: string | null;
  closed_by_username: string | null;
  unpaid_order_count: number;
  closing_summary: StoreDaySummary | null;
}

export interface ResetStoreDayResponse {
  backup_filename: string;
  deleted_orders: number;
  deleted_snapshots: number;
  deleted_movements: number;
  store_status: StoreStatusResponse;
}

export type ReceiptHeaderFontSize = 'normal' | 'tall' | 'wide' | 'large';

export interface ReceiptSettings {
  header_text: string;
  footer_text: string;
  header_bold: boolean;
  header_font_size: ReceiptHeaderFontSize;
  updated_at: string;
  updated_by_username: string;
}

export interface DailyExpense {
  id: number;
  business_date: string;
  title: string;
  category: string;
  amount: number;
  notes: string;
  created_by_user_id: number | null;
  created_by_username: string;
  created_at: string;
}

export interface ExpenseCategory {
  id: number;
  name: string;
  is_active: number;
  sort_order: number;
  created_at: string;
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

export type PromoDiscountType = 'FIXED' | 'PERCENT';
export type PromoQuotaType = 'UNLIMITED' | 'TOTAL' | 'DAILY';
export type PromoReceiptMediaType = 'NONE' | 'QR' | 'BARCODE';

export interface Promotion {
  id: number;
  name: string;
  discount_type: PromoDiscountType;
  discount_value: number;
  max_discount: number | null;
  min_order_amount: number;
  quota_type: PromoQuotaType;
  quota_limit: number | null;
  used_total: number;
  used_today: number;
  remaining_quota: number | null;
  start_date: string | null;
  end_date: string | null;
  regular_only: boolean;
  receipt_promo_text: string;
  receipt_media_type: PromoReceiptMediaType;
  receipt_media_value: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface UpsertPromotionPayload {
  name: string;
  discount_type: PromoDiscountType;
  discount_value: number;
  max_discount?: number | null;
  min_order_amount: number;
  quota_type: PromoQuotaType;
  quota_limit?: number | null;
  start_date?: string | null;
  end_date?: string | null;
  regular_only: boolean;
  receipt_promo_text: string;
  receipt_media_type: PromoReceiptMediaType;
  receipt_media_value: string;
  is_active?: boolean;
}

export interface OrderDetail {
  id: number;
  order_number: string;
  business_date: string;
  channel_id: number | null;
  channel_name: string;
  customer_label: string;
  waiter_name: string;
  created_by_user_id: number | null;
  notes: string;
  status: OrderStatus;
  subtotal_amount: number;
  discount_amount: number;
  total_amount: number;
  promo_id: number | null;
  promo_name: string;
  promo_applied_by_username: string;
  promo_receipt_text: string;
  promo_receipt_media_type: PromoReceiptMediaType;
  promo_receipt_media_value: string;
  created_at: string;
  paid_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  items: OrderItemDetail[];
}

export interface CreateOrderPayload {
  channel_id: number;
  customer_label?: string;
  notes?: string;
  items: Array<{
    menu_item_id: number;
    quantity: number;
    item_note?: string;
  }>;
}

export interface PromoUsageSummary {
  promo_name: string;
  order_count: number;
  total_discount: number;
}

export interface RevenueSummary {
  paid_total: number;
  paid_count: number;
  unpaid_total: number;
  unpaid_count: number;
  voided_total: number;
  voided_count: number;
  total_portions_sold: number;
  total_discounts: number;
  total_expenses: number;
  net_profit: number;
}

export interface ChannelSalesSummary {
  channel_name: string;
  order_count: number;
  paid_count: number;
  unpaid_count: number;
  total_revenue: number;
  paid_revenue: number;
  unpaid_revenue: number;
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
  stock_item_id: number;
  stock_name: string;
  unit: string;
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
  store_status: 'NOT_OPENED' | 'OPEN' | 'CLOSED';
  revenue: RevenueSummary;
  sales_by_channel: ChannelSalesSummary[];
  sales_by_menu: MenuSalesSummary[];
  promo_summary: PromoUsageSummary[];
  expenses: DailyExpense[];
  stock_reconciliation: StockReconciliationRow[];
}

export interface StockMovement {
  id: number;
  business_date: string;
  stock_item_id: number;
  stock_name: string;
  order_id: number | null;
  movement_type:
    | 'SET_INITIAL'
    | 'RESTOCK'
    | 'ORDER_DEDUCT'
    | 'ORDER_VOID_RESTORE'
    | 'CLOSE_RESET';
  qty_delta: number;
  stock_after: number;
  note: string;
  created_at: string;
}

export type AnalyticsPreset = 'today' | '7d' | '30d' | 'month' | 'custom';

export interface PerformanceAnalyticsResponse {
  from_date: string;
  to_date: string;
  summary: {
    total_revenue: number;
    total_expenses: number;
    net_profit: number;
    total_orders: number;
    paid_orders: number;
    voided_orders: number;
    total_portions: number;
    avg_order_value: number;
    closed_days_count: number;
    active_days_count: number;
  };
  daily_trend: Array<{
    business_date: string;
    store_status: string;
    revenue: number;
    expenses: number;
    net_profit: number;
    order_count: number;
    portions_sold: number;
  }>;
  by_channel: Array<{
    channel_name: string;
    order_count: number;
    revenue: number;
    share_percent: number;
  }>;
  top_menus: MenuSalesSummary[];
  bottom_menus: MenuSalesSummary[];
  stock_summary: Array<{
    stock_item_id: number;
    stock_name: string;
    unit: string;
    total_supplied: number;
    total_sold: number;
    total_leftover: number;
    total_variance: number;
    opname_days: number;
  }>;
  peak_hours: Array<{
    hour: number;
    label: string;
    order_count: number;
    revenue: number;
  }>;
  by_weekday: Array<{
    weekday_index: number;
    label: string;
    order_count: number;
    revenue: number;
  }>;
  user_order_intervals: Array<{
    username: string;
    orders_created: number;
    interval_samples: number;
    avg_interval_seconds: number | null;
    min_interval_seconds: number | null;
    max_interval_seconds: number | null;
  }>;
}

export type UserRole = 'admin' | 'owner' | 'cashier' | 'waiter';

export type TabKey = 'waiter' | 'cashier' | 'menu' | 'promos' | 'expenses' | 'report' | 'users';

export interface AuthUser {
  id: number;
  username: string;
  full_name: string;
  role: UserRole;
  is_env_admin: boolean;
  allowed_tabs: TabKey[];
}

export interface AdminUser {
  id: number;
  username: string;
  full_name: string;
  role: UserRole;
  is_active: boolean;
  is_env_admin: boolean;
  failed_login_attempts: number;
  is_locked: boolean;
  locked_at: string | null;
  locked_until: string | null;
  last_login_at: string | null;
  last_logout_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateUserPayload {
  username: string;
  full_name: string;
  password: string;
  role: UserRole;
}

export interface UpdateUserPayload {
  full_name: string;
  role: UserRole;
  is_active: boolean;
}

export interface UserSessionLog {
  id: number;
  user_id: number;
  username: string;
  full_name: string;
  role: UserRole;
  login_at: string;
  logout_at: string | null;
  expires_at: string;
  status: 'ACTIVE' | 'LOGGED_OUT' | 'EXPIRED';
  ip_address: string;
  user_agent: string;
}

export interface AuthEventLog {
  id: number;
  user_id: number | null;
  username: string;
  event_type:
    | 'LOGIN_SUCCESS'
    | 'LOGOUT'
    | 'LOGIN_FAILED'
    | 'ACCOUNT_LOCKED'
    | 'ACCOUNT_UNLOCKED';
  detail: string;
  ip_address: string;
  created_at: string;
}
