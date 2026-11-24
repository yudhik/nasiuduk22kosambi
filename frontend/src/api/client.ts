import type {
  CreateMenuPayload,
  CreateOrderPayload,
  DailyReportResponse,
  MenuItem,
  OrderDetail,
  StartDayResponse,
  StockMovement,
  UpdateMenuPayload,
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    throw new ApiError(
      data?.error ?? `Permintaan gagal (${res.status})`,
      res.status,
      data?.code
    );
  }

  return data as T;
}

export const api = {
  // Menus & Stock
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
    request<{ deleted: boolean; soft_deleted: boolean }>(`/api/menus/${id}`, {
      method: 'DELETE',
    }),

  setInitialStock: (id: number, initial_stock: number, note?: string) =>
    request<MenuItem>(`/api/menus/${id}/stock/set-initial`, {
      method: 'POST',
      body: JSON.stringify({ initial_stock, note }),
    }),

  restockMenu: (id: number, quantity: number, note?: string) =>
    request<MenuItem>(`/api/menus/${id}/stock/restock`, {
      method: 'POST',
      body: JSON.stringify({ quantity, note }),
    }),

  startDay: () =>
    request<StartDayResponse>('/api/stock/start-day', {
      method: 'POST',
    }),

  // Orders (Nota Digital)
  listOrders: (date: string, status?: string) => {
    const params = new URLSearchParams({ date });
    if (status && status !== 'ALL') params.set('status', status);
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

  // Reports
  getDailyReport: (date: string) =>
    request<DailyReportResponse>(
      `/api/reports/daily?date=${encodeURIComponent(date)}`
    ),

  updatePhysicalStock: (
    business_date: string,
    entries: Array<{
      menu_item_id: number;
      physical_stock: number | null;
      notes?: string;
    }>
  ) =>
    request<DailyReportResponse>('/api/reports/daily/physical-stock', {
      method: 'PUT',
      body: JSON.stringify({ business_date, entries }),
    }),

  listStockMovements: (date: string) =>
    request<StockMovement[]>(
      `/api/reports/movements?date=${encodeURIComponent(date)}`
    ),

  getCsvExportUrl: (date: string) =>
    `/api/reports/daily/export.csv?date=${encodeURIComponent(date)}`,
};
