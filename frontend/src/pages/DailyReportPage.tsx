import { useCallback, useEffect, useState } from 'react';
import {
  BarChart3,
  Clock,
  Download,
  History,
  RefreshCw,
  Save,
  TrendingUp,
} from 'lucide-react';
import { api } from '../api/client';
import type { ToastMessage } from '../components/ToastContainer';
import type {
  AnalyticsPreset,
  DailyReportResponse,
  PerformanceAnalyticsResponse,
  StockMovement,
  StoreStatusResponse,
} from '../types';
import { formatRupiah, formatTime, todayLocalDate } from '../utils/format';

interface DailyReportPageProps {
  storeStatus: StoreStatusResponse | null;
  onToast: (title: string, description?: string, tone?: ToastMessage['tone']) => void;
}

interface PhysicalDraft {
  physical: string;
  notes: string;
}

type ReportTab = 'daily' | 'analytics';

function formatDurationSeconds(secs: number | null): string {
  if (secs === null) return '—';
  if (secs < 60) return `${secs} dtk`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  if (mins < 60) return rem > 0 ? `${mins} mnt ${rem} dtk` : `${mins} mnt`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs} jam ${remMins} mnt`;
}

export function DailyReportPage({ storeStatus, onToast }: DailyReportPageProps) {
  const [tab, setTab] = useState<ReportTab>('daily');

  // === Daily Report State ===
  const [date, setDate] = useState(todayLocalDate);
  const [report, setReport] = useState<DailyReportResponse | null>(null);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [showMovements, setShowMovements] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, PhysicalDraft>>({});
  const [dirty, setDirty] = useState(false);
  const [loadingDaily, setLoadingDaily] = useState(true);
  const [savingOpname, setSavingOpname] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // === Performance Analytics State ===
  const [preset, setPreset] = useState<AnalyticsPreset>('7d');
  const [customFrom, setCustomFrom] = useState(todayLocalDate);
  const [customTo, setCustomTo] = useState(todayLocalDate);
  const [analytics, setAnalytics] = useState<PerformanceAnalyticsResponse | null>(null);
  const [loadingAnalytics, setLoadingAnalytics] = useState(false);

  const loadDaily = useCallback(async () => {
    try {
      setLoadingDaily(true);
      setError(null);
      const [rep, movs] = await Promise.all([
        api.getDailyReport(date),
        api.listStockMovements(date),
      ]);
      setReport(rep);
      setMovements(movs);

      const initialDrafts: Record<number, PhysicalDraft> = {};
      for (const row of rep.stock_reconciliation) {
        initialDrafts[row.stock_item_id] = {
          physical: row.physical_stock === null ? '' : String(row.physical_stock),
          notes: row.notes ?? '',
        };
      }
      setDrafts(initialDrafts);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat laporan harian');
    } finally {
      setLoadingDaily(false);
    }
  }, [date]);

  const loadAnalytics = useCallback(async () => {
    try {
      setLoadingAnalytics(true);
      setError(null);
      const data = await api.getPerformanceAnalytics(
        preset,
        preset === 'custom' ? customFrom : undefined,
        preset === 'custom' ? customTo : undefined
      );
      setAnalytics(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat analitik performa');
    } finally {
      setLoadingAnalytics(false);
    }
  }, [preset, customFrom, customTo]);

  useEffect(() => {
    if (tab === 'daily') {
      void loadDaily();
    } else {
      void loadAnalytics();
    }
  }, [tab, loadDaily, loadAnalytics, storeStatus?.status]);

  const isDayClosed = report?.store_status === 'CLOSED';

  const handleSavePhysicalStock = async () => {
    if (!report) return;
    try {
      setSavingOpname(true);
      setError(null);
      const entries = report.stock_reconciliation.map((row) => {
        const draft = drafts[row.stock_item_id];
        const raw = draft?.physical.trim() ?? '';
        return {
          stock_item_id: row.stock_item_id,
          physical_stock: raw === '' ? null : Number(raw),
          notes: draft?.notes ?? '',
        };
      });
      const updated = await api.updatePhysicalStock(date, entries);
      setReport(updated);
      setDirty(false);
      onToast('Opname stok fisik disimpan', undefined, 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menyimpan opname stok');
    } finally {
      setSavingOpname(false);
    }
  };

  const movementLabel = (t: StockMovement['movement_type']) => {
    switch (t) {
      case 'SET_INITIAL':
        return 'Stok Awal';
      case 'RESTOCK':
        return 'Restock';
      case 'ORDER_DEDUCT':
        return 'Terpakai';
      case 'ORDER_VOID_RESTORE':
        return 'Batal (Void)';
      case 'CLOSE_RESET':
        return 'Reset Tutup';
    }
  };

  const maxTrendRev = Math.max(
    1,
    ...(analytics?.daily_trend.map((d) => Math.max(d.revenue, d.expenses)) ?? [1])
  );
  const maxPeakOrders = Math.max(1, ...(analytics?.peak_hours.map((p) => p.order_count) ?? [1]));
  const maxWeekdayRev = Math.max(1, ...(analytics?.by_weekday.map((w) => w.revenue) ?? [1]));

  return (
    <div className="space-y-4">
      {/* Top Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="inline-flex rounded-xl border border-brand-amber-soft bg-white p-1">
          <button
            type="button"
            onClick={() => setTab('daily')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-bold transition ${
              tab === 'daily'
                ? 'bg-brand-orange text-white'
                : 'text-brand-brown/75 hover:bg-brand-cream'
            }`}
          >
            <TrendingUp className="h-3.5 w-3.5" />
            <span>Laporan Harian</span>
          </button>
          <button
            type="button"
            onClick={() => setTab('analytics')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-bold transition ${
              tab === 'analytics'
                ? 'bg-brand-orange text-white'
                : 'text-brand-brown/75 hover:bg-brand-cream'
            }`}
          >
            <BarChart3 className="h-3.5 w-3.5" />
            <span>Analitik Performa</span>
          </button>
        </div>

        {tab === 'daily' && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="h-10 rounded-xl border border-brand-amber-soft bg-white px-3 text-xs font-bold text-brand-brown focus:border-brand-orange focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void loadDaily()}
              className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-brand-amber-soft bg-white px-3 text-xs font-bold text-brand-brown hover:bg-brand-cream-deep"
            >
              <RefreshCw className={`h-4 w-4 ${loadingDaily ? 'animate-spin' : ''}`} />
            </button>
            <a
              href={api.getCsvExportUrl(date)}
              download={`laporan-${date}.csv`}
              className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-brand-brown px-3.5 text-xs font-bold text-brand-cream hover:bg-brand-brown-dark"
            >
              <Download className="h-4 w-4" />
              <span>Export CSV</span>
            </a>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
          {error}
        </div>
      )}

      {/* ==================== TAB 1: DAILY REPORT ==================== */}
      {tab === 'daily' &&
        (loadingDaily || !report ? (
          <div className="rounded-2xl border border-brand-amber-soft bg-white p-10 text-center text-sm text-brand-brown/60">
            Memuat laporan harian...
          </div>
        ) : (
          <div className="space-y-4">
            {/* Revenue, Expenses & Net Profit KPI Cards */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <div className="rounded-2xl border border-emerald-200 bg-white p-4 shadow-sm">
                <p className="text-xs font-semibold text-brand-brown/65">Pendapatan Lunas</p>
                <p className="mt-1 text-lg font-extrabold text-emerald-700 sm:text-xl">
                  {formatRupiah(report.revenue.paid_total)}
                </p>
                <p className="mt-0.5 text-[11px] text-brand-brown/60">
                  {report.revenue.paid_count} nota • {report.revenue.total_portions_sold} porsi
                </p>
              </div>
              <div className="rounded-2xl border border-rose-200 bg-white p-4 shadow-sm">
                <p className="text-xs font-semibold text-brand-brown/65">Pengeluaran Harian</p>
                <p className="mt-1 text-lg font-extrabold text-rose-700 sm:text-xl">
                  {formatRupiah(report.revenue.total_expenses)}
                </p>
                <p className="mt-0.5 text-[11px] text-brand-brown/60">
                  {report.expenses.length} catatan biaya
                </p>
              </div>
              <div className="rounded-2xl border border-brand-orange/40 bg-brand-cream-deep/60 p-4 shadow-sm">
                <p className="text-xs font-bold text-brand-brown">Laba Bersih</p>
                <p
                  className={`mt-1 text-lg font-extrabold sm:text-xl ${
                    report.revenue.net_profit >= 0 ? 'text-brand-brown' : 'text-rose-700'
                  }`}
                >
                  {formatRupiah(report.revenue.net_profit)}
                </p>
                <p className="mt-0.5 text-[11px] text-brand-brown/65">Lunas − Pengeluaran</p>
              </div>
              <div className="rounded-2xl border border-brand-amber-soft bg-white p-4 shadow-sm">
                <p className="text-xs font-semibold text-brand-brown/65">Belum Bayar</p>
                <p className="mt-1 text-lg font-extrabold text-amber-700 sm:text-xl">
                  {formatRupiah(report.revenue.unpaid_total)}
                </p>
                <p className="mt-0.5 text-[11px] text-brand-brown/60">
                  {report.revenue.unpaid_count} nota
                </p>
              </div>
              <div className="col-span-2 rounded-2xl border border-brand-amber-soft bg-white p-4 shadow-sm lg:col-span-1">
                <p className="text-xs font-semibold text-brand-brown/65">Dibatalkan (Void)</p>
                <p className="mt-1 text-lg font-extrabold text-stone-600 sm:text-xl">
                  {formatRupiah(report.revenue.voided_total)}
                </p>
                <p className="mt-0.5 text-[11px] text-brand-brown/60">
                  {report.revenue.voided_count} nota
                </p>
              </div>
            </div>

            {/* Sales Grouped by Channel */}
            <div className="rounded-2xl border border-brand-amber-soft bg-white p-4 shadow-sm">
              <h3 className="text-sm font-extrabold text-brand-brown">
                Total Penjualan per Channel ({report.business_date})
              </h3>
              {report.sales_by_channel.length === 0 ? (
                <p className="mt-2 text-xs text-brand-brown/60">Belum ada penjualan pada tanggal ini.</p>
              ) : (
                <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
                  {report.sales_by_channel.map((ch) => (
                    <div
                      key={ch.channel_name}
                      className="rounded-xl border border-brand-amber-soft bg-brand-cream/60 p-3"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-extrabold text-brand-brown">
                          {ch.channel_name}
                        </span>
                        <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-bold text-brand-brown/80">
                          {ch.order_count} nota
                        </span>
                      </div>
                      <p className="mt-1.5 text-base font-extrabold text-brand-orange">
                        {formatRupiah(ch.total_revenue)}
                      </p>
                      <p className="text-[11px] text-brand-brown/65">
                        Lunas: {formatRupiah(ch.paid_revenue)}
                        {ch.unpaid_count > 0 ? ` • Belum: ${ch.unpaid_count}` : ''}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Stock Reconciliation per Stock Item */}
            <div className="rounded-2xl border border-brand-amber-soft bg-white p-4 shadow-sm">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-extrabold text-brand-brown">
                    Rekonsiliasi Stok Akhir Hari (Per Item Stok)
                  </h3>
                  <p className="text-xs text-brand-brown/65">
                    Stok Awal + Restock − Terpakai = Sisa Sistem
                  </p>
                </div>
                {!isDayClosed && (
                  <button
                    type="button"
                    disabled={!dirty || savingOpname}
                    onClick={() => void handleSavePhysicalStock()}
                    className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-brand-orange px-3.5 text-xs font-bold text-white hover:bg-brand-orange-dark disabled:bg-stone-300"
                  >
                    <Save className="h-3.5 w-3.5" />
                    <span>{savingOpname ? 'Menyimpan...' : 'Simpan Opname'}</span>
                  </button>
                )}
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-brand-amber-soft/60 text-left text-xs">
                  <thead className="bg-brand-cream text-[11px] font-bold uppercase text-brand-brown/75">
                    <tr>
                      <th className="px-3 py-2.5">Item Stok</th>
                      <th className="px-3 py-2.5 text-right">Awal</th>
                      <th className="px-3 py-2.5 text-right">Restock</th>
                      <th className="px-3 py-2.5 text-right">Terpakai</th>
                      <th className="px-3 py-2.5 text-right">Sisa Sistem</th>
                      <th className="px-3 py-2.5 text-right">Stok Fisik</th>
                      <th className="px-3 py-2.5 text-right">Selisih</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-brand-amber-soft/40">
                    {report.stock_reconciliation.map((row) => {
                      const d = drafts[row.stock_item_id];
                      const parsed = d && d.physical.trim() !== '' ? Number(d.physical) : null;
                      const variance = parsed === null ? null : parsed - row.system_remaining;
                      return (
                        <tr key={row.stock_item_id}>
                          <td className="px-3 py-2 font-bold text-brand-brown">
                            {row.stock_name}{' '}
                            <span className="font-normal text-brand-brown/55">({row.unit})</span>
                          </td>
                          <td className="px-3 py-2 text-right">{row.initial_stock}</td>
                          <td className="px-3 py-2 text-right">{row.restocked_qty}</td>
                          <td className="px-3 py-2 text-right font-bold">{row.sold_qty}</td>
                          <td className="px-3 py-2 text-right font-bold text-brand-brown">
                            {row.system_remaining}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <input
                              type="number"
                              min={0}
                              disabled={isDayClosed}
                              value={d?.physical ?? ''}
                              onChange={(e) => {
                                setDrafts((prev) => ({
                                  ...prev,
                                  [row.stock_item_id]: {
                                    physical: e.target.value,
                                    notes: prev[row.stock_item_id]?.notes ?? '',
                                  },
                                }));
                                setDirty(true);
                              }}
                              className="h-8 w-20 rounded-lg border border-brand-amber-soft bg-white px-2 text-right text-xs font-bold text-brand-brown disabled:bg-stone-100"
                            />
                          </td>
                          <td className="px-3 py-2 text-right font-bold">
                            {variance === null ? (
                              <span className="text-stone-400">—</span>
                            ) : variance === 0 ? (
                              <span className="text-emerald-700">Cocok (0)</span>
                            ) : variance < 0 ? (
                              <span className="text-rose-700">Kurang ({variance})</span>
                            ) : (
                              <span className="text-sky-700">Lebih (+{variance})</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Menu Sales Table */}
            {report.sales_by_menu.length > 0 && (
              <div className="rounded-2xl border border-brand-amber-soft bg-white p-4 shadow-sm">
                <h3 className="mb-3 text-sm font-extrabold text-brand-brown">
                  Rincian Penjualan per Menu
                </h3>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-brand-amber-soft/60 text-left text-xs">
                    <thead className="bg-brand-cream text-[11px] font-bold uppercase text-brand-brown/75">
                      <tr>
                        <th className="px-3 py-2">Menu</th>
                        <th className="px-3 py-2 text-right">Terjual</th>
                        <th className="px-3 py-2 text-right">Omzet Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-brand-amber-soft/40">
                      {report.sales_by_menu.map((m) => (
                        <tr key={`${m.menu_item_id}-${m.menu_name}`}>
                          <td className="px-3 py-2 font-bold text-brand-brown">{m.menu_name}</td>
                          <td className="px-3 py-2 text-right font-semibold">{m.quantity_sold}</td>
                          <td className="px-3 py-2 text-right font-extrabold text-brand-orange">
                            {formatRupiah(m.total_revenue)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Stock Movements Collapsible */}
            <div className="rounded-2xl border border-brand-amber-soft bg-white p-4 shadow-sm">
              <button
                type="button"
                onClick={() => setShowMovements((v) => !v)}
                className="flex w-full items-center justify-between text-left"
              >
                <span className="inline-flex items-center gap-2 text-sm font-extrabold text-brand-brown">
                  <History className="h-4 w-4 text-brand-orange" />
                  Log Mutasi Stok ({movements.length})
                </span>
                <span className="text-xs font-bold text-brand-orange">
                  {showMovements ? 'Sembunyikan' : 'Tampilkan'}
                </span>
              </button>
              {showMovements && (
                <div className="mt-3 max-h-72 overflow-y-auto divide-y divide-brand-amber-soft/40 text-xs">
                  {movements.map((mv) => (
                    <div key={mv.id} className="flex items-center justify-between gap-2 py-2">
                      <div>
                        <span className="font-bold text-brand-brown">{mv.stock_name}</span>
                        <span className="ml-2 rounded bg-brand-cream-deep px-1.5 py-0.5 text-[10px] font-bold">
                          {movementLabel(mv.movement_type)}
                        </span>
                        <p className="text-[11px] text-brand-brown/60">
                          {formatTime(mv.created_at)} • {mv.note}
                        </p>
                      </div>
                      <div className="text-right font-mono">
                        <span
                          className={`font-bold ${
                            mv.qty_delta >= 0 ? 'text-emerald-700' : 'text-rose-700'
                          }`}
                        >
                          {mv.qty_delta >= 0 ? `+${mv.qty_delta}` : mv.qty_delta}
                        </span>
                        <p className="text-[10px] text-brand-brown/55">Sisa: {mv.stock_after}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

      {/* ==================== TAB 2: PERFORMANCE ANALYTICS ==================== */}
      {tab === 'analytics' && (
        <div className="space-y-4">
          {/* Date Range Filter Bar (Hari Ini, 7 Hari, 30 Hari, Bulan Ini, Custom) */}
          <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-2xl border border-brand-amber-soft bg-white p-3.5 shadow-sm">
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  { key: 'today', label: 'Hari Ini' },
                  { key: '7d', label: '7 Hari' },
                  { key: '30d', label: '30 Hari' },
                  { key: 'month', label: 'Bulan Ini' },
                  { key: 'custom', label: 'Custom' },
                ] as Array<{ key: AnalyticsPreset; label: string }>
              ).map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setPreset(p.key)}
                  className={`h-9 rounded-xl px-3.5 text-xs font-bold transition ${
                    preset === p.key
                      ? 'bg-brand-orange text-white shadow-sm'
                      : 'bg-brand-cream text-brand-brown hover:bg-brand-cream-deep'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {preset === 'custom' && (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="h-9 rounded-xl border border-brand-amber-soft px-2.5 text-xs font-bold text-brand-brown"
                />
                <span className="text-xs font-bold text-brand-brown/60">s/d</span>
                <input
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="h-9 rounded-xl border border-brand-amber-soft px-2.5 text-xs font-bold text-brand-brown"
                />
              </div>
            )}
          </div>

          {loadingAnalytics || !analytics ? (
            <div className="rounded-2xl border border-brand-amber-soft bg-white p-10 text-center text-sm text-brand-brown/60">
              Menghitung analitik performa...
            </div>
          ) : (
            <div className="space-y-4">
              {/* KPI Overview */}
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
                <div className="rounded-2xl border border-emerald-200 bg-white p-3.5 shadow-sm">
                  <p className="text-[11px] font-semibold text-brand-brown/65">Total Pendapatan</p>
                  <p className="mt-1 text-base font-extrabold text-emerald-700">
                    {formatRupiah(analytics.summary.total_revenue)}
                  </p>
                </div>
                <div className="rounded-2xl border border-rose-200 bg-white p-3.5 shadow-sm">
                  <p className="text-[11px] font-semibold text-brand-brown/65">Total Pengeluaran</p>
                  <p className="mt-1 text-base font-extrabold text-rose-700">
                    {formatRupiah(analytics.summary.total_expenses)}
                  </p>
                </div>
                <div className="rounded-2xl border border-brand-orange/40 bg-brand-cream-deep/70 p-3.5 shadow-sm">
                  <p className="text-[11px] font-bold text-brand-brown">Laba Bersih</p>
                  <p className="mt-1 text-base font-extrabold text-brand-brown">
                    {formatRupiah(analytics.summary.net_profit)}
                  </p>
                </div>
                <div className="rounded-2xl border border-brand-amber-soft bg-white p-3.5 shadow-sm">
                  <p className="text-[11px] font-semibold text-brand-brown/65">Nota / Porsi</p>
                  <p className="mt-1 text-base font-extrabold text-brand-brown">
                    {analytics.summary.paid_orders} / {analytics.summary.total_portions}
                  </p>
                </div>
                <div className="rounded-2xl border border-brand-amber-soft bg-white p-3.5 shadow-sm">
                  <p className="text-[11px] font-semibold text-brand-brown/65">Rata-rata / Nota</p>
                  <p className="mt-1 text-base font-extrabold text-brand-orange">
                    {formatRupiah(analytics.summary.avg_order_value)}
                  </p>
                </div>
                <div className="rounded-2xl border border-brand-amber-soft bg-white p-3.5 shadow-sm">
                  <p className="text-[11px] font-semibold text-brand-brown/65">Hari Tutup / Aktif</p>
                  <p className="mt-1 text-base font-extrabold text-brand-brown">
                    {analytics.summary.closed_days_count} / {analytics.summary.active_days_count}
                  </p>
                </div>
              </div>

              {/* Channel Breakdown */}
              <div className="rounded-2xl border border-brand-amber-soft bg-white p-4 shadow-sm">
                <h3 className="mb-3 text-sm font-extrabold text-brand-brown">
                  Performa Penjualan per Channel ({analytics.from_date} – {analytics.to_date})
                </h3>
                {analytics.by_channel.length === 0 ? (
                  <p className="text-xs text-brand-brown/60">Belum ada data transaksi pada rentang ini.</p>
                ) : (
                  <div className="space-y-3">
                    {analytics.by_channel.map((ch) => (
                      <div key={ch.channel_name} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-bold text-brand-brown">
                            {ch.channel_name}{' '}
                            <span className="font-normal text-brand-brown/60">
                              ({ch.order_count} nota)
                            </span>
                          </span>
                          <span className="font-extrabold text-brand-orange">
                            {formatRupiah(ch.revenue)} ({ch.share_percent}%)
                          </span>
                        </div>
                        <div className="h-2.5 w-full overflow-hidden rounded-full bg-brand-cream-deep">
                          <div
                            className="h-full rounded-full bg-brand-orange"
                            style={{ width: `${Math.min(100, Math.max(2, ch.share_percent))}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Daily Trend */}
              <div className="rounded-2xl border border-brand-amber-soft bg-white p-4 shadow-sm">
                <h3 className="mb-3 text-sm font-extrabold text-brand-brown">
                  Tren Harian (Pendapatan vs Pengeluaran)
                </h3>
                {analytics.daily_trend.length === 0 ? (
                  <p className="text-xs text-brand-brown/60">Belum ada data harian.</p>
                ) : (
                  <div className="space-y-2.5">
                    {analytics.daily_trend.map((d) => (
                      <div
                        key={d.business_date}
                        className="rounded-xl border border-brand-amber-soft/60 bg-brand-cream/40 p-3 text-xs"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-bold text-brand-brown">
                              {d.business_date}
                            </span>
                            <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-brand-brown/75">
                              {d.store_status}
                            </span>
                            <span className="text-brand-brown/65">
                              {d.order_count} nota • {d.portions_sold} porsi
                            </span>
                          </div>
                          <div className="flex items-center gap-3 font-bold">
                            <span className="text-emerald-700">+{formatRupiah(d.revenue)}</span>
                            <span className="text-rose-700">-{formatRupiah(d.expenses)}</span>
                            <span className="text-brand-brown">
                              Bersih: {formatRupiah(d.net_profit)}
                            </span>
                          </div>
                        </div>
                        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white">
                          <div
                            className="h-full rounded-full bg-emerald-500"
                            style={{
                              width: `${Math.max(2, Math.round((d.revenue / maxTrendRev) * 100))}%`,
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Per-User Nota Creation Interval */}
              <div className="rounded-2xl border border-brand-amber-soft bg-white p-4 shadow-sm">
                <div className="mb-3 flex items-center gap-2">
                  <Clock className="h-4 w-4 text-brand-orange" />
                  <h3 className="text-sm font-extrabold text-brand-brown">
                    Interval Pembuatan Nota per Pengguna
                  </h3>
                </div>
                {analytics.user_order_intervals.length === 0 ? (
                  <p className="text-xs text-brand-brown/60">Belum ada data pembuatan nota.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-brand-amber-soft/60 text-left text-xs">
                      <thead className="bg-brand-cream text-[11px] font-bold uppercase text-brand-brown/75">
                        <tr>
                          <th className="px-3 py-2">Username</th>
                          <th className="px-3 py-2 text-right">Nota Dibuat</th>
                          <th className="px-3 py-2 text-right">Rata-rata Interval</th>
                          <th className="px-3 py-2 text-right">Tercepat</th>
                          <th className="px-3 py-2 text-right">Terlama</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-brand-amber-soft/40">
                        {analytics.user_order_intervals.map((u) => (
                          <tr key={u.username}>
                            <td className="px-3 py-2 font-mono font-bold text-brand-brown">
                              @{u.username}
                            </td>
                            <td className="px-3 py-2 text-right font-bold">{u.orders_created}</td>
                            <td className="px-3 py-2 text-right font-extrabold text-brand-orange">
                              {formatDurationSeconds(u.avg_interval_seconds)}
                            </td>
                            <td className="px-3 py-2 text-right text-emerald-700">
                              {formatDurationSeconds(u.min_interval_seconds)}
                            </td>
                            <td className="px-3 py-2 text-right text-brand-brown/75">
                              {formatDurationSeconds(u.max_interval_seconds)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Peak Hours & Busiest Weekdays */}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div className="rounded-2xl border border-brand-amber-soft bg-white p-4 shadow-sm">
                  <h3 className="mb-3 text-sm font-extrabold text-brand-brown">
                    Jam Ramai (Peak Hours WIB)
                  </h3>
                  {analytics.peak_hours.length === 0 ? (
                    <p className="text-xs text-brand-brown/60">Belum ada data jam ramai.</p>
                  ) : (
                    <div className="space-y-2">
                      {analytics.peak_hours.map((p) => (
                        <div key={p.hour} className="flex items-center gap-2 text-xs">
                          <span className="w-12 font-mono font-bold text-brand-brown">
                            {p.label}
                          </span>
                          <div className="h-3 flex-1 overflow-hidden rounded-full bg-brand-cream-deep">
                            <div
                              className="h-full rounded-full bg-brand-orange"
                              style={{
                                width: `${Math.max(5, Math.round((p.order_count / maxPeakOrders) * 100))}%`,
                              }}
                            />
                          </div>
                          <span className="w-24 text-right font-semibold text-brand-brown">
                            {p.order_count} nota
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="rounded-2xl border border-brand-amber-soft bg-white p-4 shadow-sm">
                  <h3 className="mb-3 text-sm font-extrabold text-brand-brown">
                    Hari Tersibuk (Senin – Minggu)
                  </h3>
                  <div className="space-y-2">
                    {analytics.by_weekday.map((w) => (
                      <div key={w.weekday_index} className="flex items-center gap-2 text-xs">
                        <span className="w-16 font-bold text-brand-brown">{w.label}</span>
                        <div className="h-3 flex-1 overflow-hidden rounded-full bg-brand-cream-deep">
                          <div
                            className="h-full rounded-full bg-brand-brown"
                            style={{
                              width: `${
                                w.revenue > 0
                                  ? Math.max(4, Math.round((w.revenue / maxWeekdayRev) * 100))
                                  : 0
                              }%`,
                            }}
                          />
                        </div>
                        <span className="w-28 text-right font-semibold text-brand-brown">
                          {formatRupiah(w.revenue)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Top & Bottom Menus */}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div className="rounded-2xl border border-brand-amber-soft bg-white p-4 shadow-sm">
                  <h3 className="mb-2.5 text-sm font-extrabold text-brand-brown">Menu Terlaris</h3>
                  {analytics.top_menus.length === 0 ? (
                    <p className="text-xs text-brand-brown/60">Belum ada penjualan.</p>
                  ) : (
                    <div className="divide-y divide-brand-amber-soft/40 text-xs">
                      {analytics.top_menus.map((m, i) => (
                        <div key={m.menu_name} className="flex items-center justify-between py-2">
                          <span className="font-bold text-brand-brown">
                            {i + 1}. {m.menu_name}
                          </span>
                          <span className="font-semibold text-brand-orange">
                            {m.quantity_sold} porsi • {formatRupiah(m.total_revenue)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="rounded-2xl border border-brand-amber-soft bg-white p-4 shadow-sm">
                  <h3 className="mb-2.5 text-sm font-extrabold text-brand-brown">
                    Menu Kurang Laris
                  </h3>
                  {analytics.bottom_menus.length === 0 ? (
                    <p className="text-xs text-brand-brown/60">Belum ada penjualan.</p>
                  ) : (
                    <div className="divide-y divide-brand-amber-soft/40 text-xs">
                      {analytics.bottom_menus.map((m) => (
                        <div key={m.menu_name} className="flex items-center justify-between py-2">
                          <span className="font-bold text-brand-brown">{m.menu_name}</span>
                          <span className="font-semibold text-brand-brown/75">
                            {m.quantity_sold} porsi • {formatRupiah(m.total_revenue)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Stock Usage & Variance History */}
              {analytics.stock_summary.length > 0 && (
                <div className="rounded-2xl border border-brand-amber-soft bg-white p-4 shadow-sm">
                  <h3 className="mb-3 text-sm font-extrabold text-brand-brown">
                    Ringkasan Pemakaian &amp; Selisih Stok
                  </h3>
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-brand-amber-soft/60 text-left text-xs">
                      <thead className="bg-brand-cream text-[11px] font-bold uppercase text-brand-brown/75">
                        <tr>
                          <th className="px-3 py-2">Item Stok</th>
                          <th className="px-3 py-2 text-right">Total Stok Masuk</th>
                          <th className="px-3 py-2 text-right">Terpakai</th>
                          <th className="px-3 py-2 text-right">Sisa Tak Terjual</th>
                          <th className="px-3 py-2 text-right">Selisih Opname</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-brand-amber-soft/40">
                        {analytics.stock_summary.map((s) => (
                          <tr key={s.stock_item_id}>
                            <td className="px-3 py-2 font-bold text-brand-brown">
                              {s.stock_name}{' '}
                              <span className="font-normal text-brand-brown/55">({s.unit})</span>
                            </td>
                            <td className="px-3 py-2 text-right">{s.total_supplied}</td>
                            <td className="px-3 py-2 text-right font-bold">{s.total_sold}</td>
                            <td className="px-3 py-2 text-right">{s.total_leftover}</td>
                            <td className="px-3 py-2 text-right font-bold">
                              {s.opname_days === 0 ? (
                                <span className="text-stone-400">Belum opname</span>
                              ) : s.total_variance === 0 ? (
                                <span className="text-emerald-700">0</span>
                              ) : s.total_variance < 0 ? (
                                <span className="text-rose-700">{s.total_variance}</span>
                              ) : (
                                <span className="text-sky-700">+{s.total_variance}</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
