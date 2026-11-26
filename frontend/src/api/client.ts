import type {
  AdminUser,
  AnalyticsPreset,
  AuthEventLog,
  AuthUser,
  CreateMenuPayload,
  CreateOrderPayload,
  CreateUserPayload,
  DailyExpense,
  DailyReportResponse,
  ExpenseCategory,
  ImportMenuCsvResponse,
  MenuItem,
  OrderDetail,
  PerformanceAnalyticsResponse,
  SalesChannel,
  StockItem,
  StockMovement,
  StoreStatusResponse,
  UpdateMenuPayload,
  UpdateUserPayload,
  UserSessionLog,
} from '../types';

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}

async function request<T>(
  path: string,
  init?: RequestInit,
  options?: { suppressUnauthorizedCallback?: boolean }
): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  let data: Record<string, unknown> | null = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    if (res.status === 401 && !options?.suppressUnauthorizedCallback && unauthorizedHandler) {
      unauthorizedHandler();
    }
    throw new ApiError(
      (typeof data?.error === 'string' && data.error) || `Permintaan gagal (${res.status})`,
      res.status,
      typeof data?.code === 'string' ? data.code : undefined
    );
  }

  return data as T;
}

export const api = {
  // Authentication
  login: (username: string, password: string) =>
    request<AuthUser>(
      '/api/auth/login',
      {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      },
      { suppressUnauthorizedCallback: true }
    ),

  logout: () =>
    request<{ ok: boolean }>(
      '/api/auth/logout',
      { method: 'POST' },
      { suppressUnauthorizedCallback: true }
    ),

  me: () =>
    request<AuthUser>('/api/auth/me', undefined, {
      suppressUnauthorizedCallback: true,
    }),

  // Admin: User Management & Login/Logout Audit
  adminListUsers: () => request<AdminUser[]>('/api/admin/users'),

  adminCreateUser: (payload: CreateUserPayload) =>
    request<AdminUser>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  adminUpdateUser: (id: number, payload: UpdateUserPayload) =>
    request<AdminUser>(`/api/admin/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  adminResetPassword: (id: number, new_password: string) =>
    request<AdminUser>(`/api/admin/users/${id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ new_password }),
    }),

  adminUnlockUser: (id: number) =>
    request<AdminUser>(`/api/admin/users/${id}/unlock`, {
      method: 'POST',
    }),

  adminListSessions: (userId?: number, limit = 150) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (userId) params.set('user_id', String(userId));
    return request<UserSessionLog[]>(`/api/admin/sessions?${params.toString()}`);
  },

  adminListAuthEvents: (userId?: number, limit = 150) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (userId) params.set('user_id', String(userId));
    return request<AuthEventLog[]>(`/api/admin/auth-events?${params.toString()}`);
  },

  // Daily Store Open / Close Lifecycle
  getStoreStatus: () => request<StoreStatusResponse>('/api/store/status'),

  openStore: (stocks: Array<{ stock_item_id: number; initial_stock: number }>) =>
    request<StoreStatusResponse>('/api/store/open', {
      method: 'POST',
      body: JSON.stringify({ stocks }),
    }),

  closeStore: (payload?: {
    physical_stocks?: Array<{
      stock_item_id: number;
      physical_stock: number | null;
      notes?: string;
    }>;
    closing_notes?: string;
  }) =>
    request<StoreStatusResponse>('/api/store/close', {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
    }),

  // Stock Items
  listStocks: (activeOnly = false) =>
    request<StockItem[]>(`/api/stocks?active_only=${activeOnly}`),

  createStock: (name: string, unit?: string) =>
    request<StockItem>('/api/stocks', {
      method: 'POST',
      body: JSON.stringify({ name, unit }),
    }),

  updateStock: (id: number, payload: { name: string; unit: string; is_active: boolean }) =>
    request<StockItem>(`/api/stocks/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  deleteStock: (id: number) =>
    request<{ deleted: boolean; soft_deleted: boolean; reason?: string }>(`/api/stocks/${id}`, {
      method: 'DELETE',
    }),

  restockItem: (id: number, quantity: number, note?: string) =>
    request<StockItem>(`/api/stocks/${id}/restock`, {
      method: 'POST',
      body: JSON.stringify({ quantity, note }),
    }),

  setInitialStockItem: (id: number, initial_stock: number, note?: string) =>
    request<StockItem>(`/api/stocks/${id}/set-initial`, {
      method: 'POST',
      body: JSON.stringify({ initial_stock, note }),
    }),

  // Menus & CSV Import
  listMenus: (activeOnly = false) =>
    request<MenuItem[]>(`/api/menus?active_only=${activeOnly}`),

  createMenu: (payload: CreateMenuPayload) =>
    request<MenuItem>('/api/menus', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateMenu: (id: number, payload: UpdateMenuPayload) =>
    request<MenuItem>(`/api/menus/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  deleteMenu: (id: number) =>
    request<{ deleted: boolean; soft_deleted: boolean; reason?: string }>(`/api/menus/${id}`, {
      method: 'DELETE',
    }),

  importMenusCsv: (csv_content: string) =>
    request<ImportMenuCsvResponse>('/api/menus/import-csv', {
      method: 'POST',
      body: JSON.stringify({ csv_content }),
    }),

  getMenuCsvTemplateUrl: () => '/api/menus/template.csv',

  // Sales Channels
  listChannels: (activeOnly = false) =>
    request<SalesChannel[]>(`/api/channels?active_only=${activeOnly}`),

  createChannel: (payload: { name: string; is_auto_paid?: boolean; sort_order?: number }) =>
    request<SalesChannel>('/api/channels', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateChannel: (
    id: number,
    payload: { name: string; is_auto_paid: boolean; is_active: boolean; sort_order: number }
  ) =>
    request<SalesChannel>(`/api/channels/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  // Daily Expenses
  listExpenses: (date: string) =>
    request<DailyExpense[]>(`/api/expenses?date=${encodeURIComponent(date)}`),

  createExpense: (payload: {
    business_date?: string;
    title: string;
    category?: string;
    amount: number;
    notes?: string;
  }) =>
    request<DailyExpense>('/api/expenses', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  deleteExpense: (id: number) =>
    request<{ deleted: boolean }>(`/api/expenses/${id}`, {
      method: 'DELETE',
    }),

  updateExpense: (
    id: number,
    payload: {
      business_date?: string;
      title: string;
      category: string;
      amount: number;
      notes?: string;
    }
  ) =>
    request<DailyExpense>(`/api/expenses/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  // Expense Categories
  listExpenseCategories: (activeOnly = false) =>
    request<ExpenseCategory[]>(`/api/expense-categories?active_only=${activeOnly}`),

  createExpenseCategory: (name: string) =>
    request<ExpenseCategory>('/api/expense-categories', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  updateExpenseCategory: (id: number, payload: { name: string; is_active: boolean }) =>
    request<ExpenseCategory>(`/api/expense-categories/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  // Orders (Nota Digital)
  listOrders: (date: string, status?: string, channelId?: number) => {
    const params = new URLSearchParams({ date });
    if (status && status !== 'ALL') params.set('status', status);
    if (channelId) params.set('channel_id', String(channelId));
    return request<OrderDetail[]>(`/api/orders?${params.toString()}`);
  },

  getOrder: (id: number) => request<OrderDetail>(`/api/orders/${id}`),

  createOrder: (payload: CreateOrderPayload) =>
    request<OrderDetail>('/api/orders', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  payOrder: (id: number) =>
    request<OrderDetail>(`/api/orders/${id}/pay`, {
      method: 'POST',
    }),

  voidOrder: (id: number, reason?: string) =>
    request<OrderDetail>(`/api/orders/${id}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  // Reports & Performance Analytics
  getDailyReport: (date: string) =>
    request<DailyReportResponse>(`/api/reports/daily?date=${encodeURIComponent(date)}`),

  updatePhysicalStock: (
    business_date: string,
    entries: Array<{
      stock_item_id: number;
      physical_stock: number | null;
      notes?: string;
    }>
  ) =>
    request<DailyReportResponse>('/api/reports/daily/physical-stock', {
      method: 'PUT',
      body: JSON.stringify({ business_date, entries }),
    }),

  listStockMovements: (date: string) =>
    request<StockMovement[]>(`/api/reports/movements?date=${encodeURIComponent(date)}`),

  getCsvExportUrl: (date: string) =>
    `/api/reports/daily/export.csv?date=${encodeURIComponent(date)}`,

  getPerformanceAnalytics: (preset: AnalyticsPreset, from?: string, to?: string) => {
    const params = new URLSearchParams({ preset });
    if (preset === 'custom' && from && to) {
      params.set('from', from);
      params.set('to', to);
    }
    return request<PerformanceAnalyticsResponse>(
      `/api/analytics/performance?${params.toString()}`
    );
  },
};
