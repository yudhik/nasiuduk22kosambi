import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Download,
  History,
  RefreshCw,
  Save,
  TrendingUp,
  X,
} from 'lucide-react';
import { api } from '../api/client';
import type { DailyReportResponse, StockMovement } from '../types';
import { formatRupiah, formatTime, todayLocalDate } from '../utils/format';

interface PhysicalDraft {
  physical: string;
  notes: string;
}

export function DailyReportPage() {
  const [date, setDate] = useState(todayLocalDate);
  const [report, setReport] = useState<DailyReportResponse | null>(null);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [showMovements, setShowMovements] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, PhysicalDraft>>({});
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadReport = async () => {
    try {
      setLoading(true);
      setError(null);
      const [rep, movs] = await Promise.all([
        api.getDailyReport(date),
        api.listStockMovements(date),
      ]);
      setReport(rep);
      setMovements(movs);

      const initialDrafts: Record<number, PhysicalDraft> = {};
      for (const row of rep.stock_reconciliation) {
        initialDrafts[row.menu_item_id] = {
          physical: row.physical_stock === null ? '' : String(row.physical_stock),
          notes: row.notes ?? '',
        };
      }
      setDrafts(initialDrafts);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat laporan harian');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadReport();
  }, [date]);

  const updateDraft = (menuId: number, patch: Partial<PhysicalDraft>) => {
    setDrafts((prev) => ({
      ...prev,
      [menuId]: {
        physical: prev[menuId]?.physical ?? '',
        notes: prev[menuId]?.notes ?? '',
        ...patch,
      },
    }));
    setDirty(true);
  };

  const handleSavePhysicalStock = async () => {
    if (!report) return;
    try {
      setSaving(true);
      setError(null);
      const entries = report.stock_reconciliation.map((row) => {
        const draft = drafts[row.menu_item_id];
        const raw = draft?.physical.trim() ?? '';
        return {
          menu_item_id: row.menu_item_id,
          physical_stock: raw === '' ? null : Number(raw),
          notes: draft?.notes ?? '',
        };
      });

      const updated = await api.updatePhysicalStock(date, entries);
      setReport(updated);
      setDirty(false);
      setNotice('Hasil hitung stok fisik (opname akhir hari) berhasil disimpan.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menyimpan opname stok');
    } finally {
      setSaving(false);
    }
  };

  const movementLabel = (t: StockMovement['movement_type']) => {
    switch (t) {
      case 'SET_INITIAL':
        return 'Stok Awal';
      case 'RESTOCK':
        return 'Restock';
      case 'ORDER_DEDUCT':
        return 'Terjual';
      case 'ORDER_VOID_RESTORE':
        return 'Batal (Void)';
    }
  };

  const renderVarianceBadge = (liveVariance: number | null) => {
    if (liveVariance === null) {
      return (
        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-semibold text-slate-500">
          Belum diisi
        </span>
      );
    }
    if (liveVariance === 0) {
      return (
        <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-800">
          Cocok (0)
        </span>
      );
    }
    if (liveVariance < 0) {
      return (
        <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-bold text-red-700">
          Kurang ({liveVariance})
        </span>
      );
    }
    return (
      <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-bold text-blue-700">
        Lebih (+{liveVariance})
      </span>
    );
  };

  return (
    <div className={`space-y-5 ${dirty ? 'pb-20 md:pb-0' : ''}`}>
      {/* Header & Controls */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-lg font-bold text-slate-900 sm:text-xl">
            Laporan &amp; Rekonsiliasi Stok
          </h1>
          <p className="text-xs text-slate-500 sm:text-sm">
            Total pendapatan semua nota dan pencocokan stok akhir hari secara otomatis.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-10 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 sm:flex-none"
          />
          <button
            type="button"
            onClick={() => void loadReport()}
            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 active:scale-95 hover:bg-slate-50"
            aria-label="Muat Ulang"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Muat Ulang</span>
          </button>
          <a
            href={api.getCsvExportUrl(date)}
            download
            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl bg-slate-900 px-3.5 text-xs font-bold text-white active:scale-95 hover:bg-slate-800 sm:text-sm"
          >
            <Download className="h-4 w-4" />
            <span>CSV</span>
          </a>
        </div>
      </div>

      {notice && (
        <div className="flex items-center justify-between gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="rounded-lg p-1 text-emerald-700 hover:bg-emerald-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {error}
        </div>
      )}

      {loading || !report ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          Memuat laporan harian...
        </div>
      ) : (
        <>
          {/* Warning if unpaid orders remain */}
          {report.revenue.unpaid_count > 0 && (
            <div className="flex items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-3.5 text-amber-900">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
              <div className="text-xs sm:text-sm">
                <p className="font-bold">
                  Masih ada {report.revenue.unpaid_count} nota BELUM BAYAR (
                  {formatRupiah(report.revenue.unpaid_total)}).
                </p>
                <p className="mt-0.5 text-amber-800">
                  Selesaikan pembayaran di tab Kasir sebelum tutup hari.
                </p>
              </div>
            </div>
          )}

          {/* Compact 2x2 KPI Cards on Android, 4-col on Desktop */}
          <div className="grid grid-cols-2 gap-2.5 sm:gap-4 lg:grid-cols-4">
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50/75 p-3.5 sm:p-5">
              <p className="text-[11px] font-bold uppercase tracking-wide text-emerald-800">
                Pendapatan Lunas
              </p>
              <p className="mt-1.5 text-lg font-extrabold text-emerald-900 sm:text-2xl">
                {formatRupiah(report.revenue.paid_total)}
              </p>
              <p className="mt-0.5 text-[11px] text-emerald-700 sm:text-xs">
                {report.revenue.paid_count} nota lunas
              </p>
            </div>

            <div className="rounded-2xl border border-amber-200 bg-amber-50/75 p-3.5 sm:p-5">
              <p className="text-[11px] font-bold uppercase tracking-wide text-amber-800">
                Belum Dibayar
              </p>
              <p className="mt-1.5 text-lg font-extrabold text-amber-900 sm:text-2xl">
                {formatRupiah(report.revenue.unpaid_total)}
              </p>
              <p className="mt-0.5 text-[11px] text-amber-700 sm:text-xs">
                {report.revenue.unpaid_count} nota gantung
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-3.5 sm:p-5">
              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                Porsi Terjual
              </p>
              <p className="mt-1.5 text-lg font-extrabold text-slate-900 sm:text-2xl">
                {report.revenue.total_portions_sold}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500 sm:text-xs">
                Total nota aktif
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-3.5 sm:p-5">
              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                Nota Batal (Void)
              </p>
              <p className="mt-1.5 text-lg font-extrabold text-slate-900 sm:text-2xl">
                {report.revenue.voided_count} nota
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500 sm:text-xs">
                {formatRupiah(report.revenue.voided_total)}
              </p>
            </div>
          </div>

          {/* End-of-day Stock Reconciliation Section */}
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div>
                <h2 className="text-base font-bold text-slate-900">
                  Rekonsiliasi Stok Akhir Hari ({report.business_date})
                </h2>
                <p className="text-xs text-slate-500">
                  Sisa Sistem = Awal + Restock − Terjual. Ketuk <strong>= Sisa</strong> jika
                  stok fisik di dapur cocok.
                </p>
              </div>
              <button
                type="button"
                disabled={saving}
                onClick={() => void handleSavePhysicalStock()}
                className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-4 text-sm font-bold text-white shadow-sm active:scale-98 hover:bg-emerald-700 disabled:opacity-50"
              >
                <Save className="h-4 w-4" />
                {saving ? 'Menyimpan...' : 'Simpan Opname Fisik'}
              </button>
            </div>

            {/* Mobile Android Stock Opname Cards (zero horizontal scroll!) */}
            <div className="divide-y divide-slate-100 md:hidden">
              {report.stock_reconciliation.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  Belum ada data stok pada tanggal {date}.
                </div>
              ) : (
                report.stock_reconciliation.map((row) => {
                  const draft = drafts[row.menu_item_id] ?? { physical: '', notes: '' };
                  const parsedPhysical =
                    draft.physical.trim() === '' ? null : Number(draft.physical);
                  const liveVariance =
                    parsedPhysical !== null && !Number.isNaN(parsedPhysical)
                      ? parsedPhysical - row.system_remaining
                      : null;

                  return (
                    <div key={row.menu_item_id} className="space-y-3 p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <h3 className="truncate text-sm font-bold text-slate-900">
                            {row.menu_name}
                          </h3>
                          <p className="text-[11px] text-slate-500">{row.category}</p>
                        </div>
                        {renderVarianceBadge(liveVariance)}
                      </div>

                      {/* 4-cell Stock Breakdown Strip */}
                      <div className="grid grid-cols-4 gap-1.5 rounded-xl bg-slate-50 p-2 text-center">
                        <div>
                          <p className="text-[10px] font-semibold uppercase text-slate-500">
                            Awal
                          </p>
                          <p className="text-sm font-bold text-slate-800">
                            {row.initial_stock}
                          </p>
                        </div>
                        <div>
                          <p className="text-[10px] font-semibold uppercase text-slate-500">
                            Restock
                          </p>
                          <p className="text-sm font-bold text-emerald-700">
                            +{row.restocked_qty}
                          </p>
                        </div>
                        <div>
                          <p className="text-[10px] font-semibold uppercase text-slate-500">
                            Terjual
                          </p>
                          <p className="text-sm font-bold text-slate-900">{row.sold_qty}</p>
                        </div>
                        <div className="rounded-lg bg-slate-200/70 py-0.5">
                          <p className="text-[10px] font-bold uppercase text-slate-600">
                            Sisa
                          </p>
                          <p className="text-sm font-extrabold text-slate-900">
                            {row.system_remaining}
                          </p>
                        </div>
                      </div>

                      {/* Physical Count Input + 1-Tap Quick Match Button */}
                      <div className="flex items-center gap-2">
                        <div className="flex-1">
                          <label className="mb-1 block text-[11px] font-semibold text-slate-600">
                            Stok Fisik Dapur
                          </label>
                          <input
                            type="number"
                            inputMode="numeric"
                            min={0}
                            value={draft.physical}
                            onChange={(e) =>
                              updateDraft(row.menu_item_id, { physical: e.target.value })
                            }
                            placeholder="Isi angka..."
                            className="h-11 w-full rounded-xl border border-slate-200 px-3 text-center text-base font-bold text-slate-900 focus:border-emerald-500 focus:outline-none"
                          />
                        </div>
                        <div className="pt-5">
                          <button
                            type="button"
                            onClick={() =>
                              updateDraft(row.menu_item_id, {
                                physical: String(row.system_remaining),
                              })
                            }
                            className="inline-flex h-11 items-center gap-1 rounded-xl border border-emerald-200 bg-emerald-50 px-3 text-xs font-bold text-emerald-800 active:scale-95 hover:bg-emerald-100"
                          >
                            <Check className="h-4 w-4" />
                            = Sisa ({row.system_remaining})
                          </button>
                        </div>
                      </div>

                      <input
                        type="text"
                        value={draft.notes}
                        onChange={(e) =>
                          updateDraft(row.menu_item_id, { notes: e.target.value })
                        }
                        placeholder="Catatan selisih (opsional)..."
                        className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm focus:border-emerald-500 focus:outline-none"
                      />
                    </div>
                  );
                })
              )}
            </div>

            {/* Desktop Full Reconciliation Table */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Menu</th>
                    <th className="px-3 py-3 text-center">Stok Awal</th>
                    <th className="px-3 py-3 text-center">Restock</th>
                    <th className="px-3 py-3 text-center">Terjual</th>
                    <th className="px-3 py-3 text-center">Batal</th>
                    <th className="px-3 py-3 text-center">Sisa Sistem</th>
                    <th className="px-3 py-3 text-center">Stok Fisik</th>
                    <th className="px-3 py-3 text-center">Selisih</th>
                    <th className="px-4 py-3">Catatan Selisih</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {report.stock_reconciliation.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-4 py-8 text-center text-slate-500">
                        Belum ada data stok pada tanggal {date}.
                      </td>
                    </tr>
                  ) : (
                    report.stock_reconciliation.map((row) => {
                      const draft = drafts[row.menu_item_id] ?? { physical: '', notes: '' };
                      const parsedPhysical =
                        draft.physical.trim() === '' ? null : Number(draft.physical);
                      const liveVariance =
                        parsedPhysical !== null && !Number.isNaN(parsedPhysical)
                          ? parsedPhysical - row.system_remaining
                          : null;

                      return (
                        <tr key={row.menu_item_id}>
                          <td className="px-4 py-3">
                            <p className="font-semibold text-slate-900">{row.menu_name}</p>
                            <p className="text-xs text-slate-500">{row.category}</p>
                          </td>
                          <td className="px-3 py-3 text-center font-medium text-slate-700">
                            {row.initial_stock}
                          </td>
                          <td className="px-3 py-3 text-center text-emerald-700">
                            {row.restocked_qty > 0 ? `+${row.restocked_qty}` : '0'}
                          </td>
                          <td className="px-3 py-3 text-center font-bold text-slate-900">
                            {row.sold_qty}
                          </td>
                          <td className="px-3 py-3 text-center text-slate-500">
                            {row.voided_qty}
                          </td>
                          <td className="px-3 py-3 text-center">
                            <span className="inline-block rounded-lg bg-slate-100 px-2.5 py-1 font-bold text-slate-900">
                              {row.system_remaining}
                            </span>
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex items-center justify-center gap-1.5">
                              <input
                                type="number"
                                min={0}
                                value={draft.physical}
                                onChange={(e) =>
                                  updateDraft(row.menu_item_id, { physical: e.target.value })
                                }
                                placeholder="—"
                                className="w-20 rounded-lg border border-slate-200 px-2 py-1.5 text-center text-sm font-semibold focus:border-emerald-500 focus:outline-none"
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  updateDraft(row.menu_item_id, {
                                    physical: String(row.system_remaining),
                                  })
                                }
                                title="Isi sama dengan sisa sistem"
                                className="rounded-lg bg-emerald-50 px-2 py-1.5 text-[11px] font-bold text-emerald-700 hover:bg-emerald-100"
                              >
                                =Sisa
                              </button>
                            </div>
                          </td>
                          <td className="px-3 py-3 text-center">
                            {renderVarianceBadge(liveVariance)}
                          </td>
                          <td className="px-4 py-3">
                            <input
                              type="text"
                              value={draft.notes}
                              onChange={(e) =>
                                updateDraft(row.menu_item_id, { notes: e.target.value })
                              }
                              placeholder="cth: 1 porsi rusak/bonus"
                              className="w-full min-w-[160px] rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs focus:border-emerald-500 focus:outline-none"
                            />
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Sales breakdown by menu */}
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3.5 sm:px-5">
              <TrendingUp className="h-5 w-5 text-emerald-600" />
              <h2 className="text-base font-bold text-slate-900">
                Rincian Penjualan per Menu
              </h2>
            </div>

            {/* Mobile Sales List */}
            <div className="divide-y divide-slate-100 md:hidden">
              {report.sales_by_menu.length === 0 ? (
                <div className="p-6 text-center text-sm text-slate-500">
                  Belum ada transaksi penjualan pada tanggal {date}.
                </div>
              ) : (
                report.sales_by_menu.map((item) => (
                  <div
                    key={`${item.menu_item_id}-${item.menu_name}`}
                    className="flex items-center justify-between gap-2 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-slate-900">
                        {item.menu_name}
                      </p>
                      <p className="text-xs text-slate-500">
                        Terjual <strong>{item.quantity_sold} porsi</strong>
                        {item.unpaid_revenue > 0 && (
                          <span className="ml-1.5 text-amber-700">
                            • Belum bayar {formatRupiah(item.unpaid_revenue)}
                          </span>
                        )}
                      </p>
                    </div>
                    <p className="shrink-0 text-sm font-extrabold text-emerald-700">
                      {formatRupiah(item.total_revenue)}
                    </p>
                  </div>
                ))
              )}
            </div>

            {/* Desktop Sales Table */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Menu</th>
                    <th className="px-4 py-3 text-center">Jumlah Terjual</th>
                    <th className="px-4 py-3 text-right">Omzet Lunas</th>
                    <th className="px-4 py-3 text-right">Belum Bayar</th>
                    <th className="px-4 py-3 text-right">Total Nilai</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {report.sales_by_menu.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                        Belum ada transaksi penjualan pada tanggal {date}.
                      </td>
                    </tr>
                  ) : (
                    report.sales_by_menu.map((item) => (
                      <tr key={`${item.menu_item_id}-${item.menu_name}`}>
                        <td className="px-4 py-3 font-semibold text-slate-900">
                          {item.menu_name}
                        </td>
                        <td className="px-4 py-3 text-center font-bold text-slate-800">
                          {item.quantity_sold} porsi
                        </td>
                        <td className="px-4 py-3 text-right text-emerald-700">
                          {formatRupiah(item.paid_revenue)}
                        </td>
                        <td className="px-4 py-3 text-right text-amber-700">
                          {formatRupiah(item.unpaid_revenue)}
                        </td>
                        <td className="px-4 py-3 text-right font-bold text-slate-900">
                          {formatRupiah(item.total_revenue)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Audit log: stock movements */}
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <button
              type="button"
              onClick={() => setShowMovements((v) => !v)}
              className="flex h-12 w-full items-center justify-between px-4 text-left hover:bg-slate-50 sm:px-5"
            >
              <div className="flex items-center gap-2">
                <History className="h-5 w-5 text-slate-500" />
                <span className="text-sm font-bold text-slate-900">
                  Riwayat Mutasi Stok ({movements.length})
                </span>
              </div>
              <span className="text-xs font-bold text-emerald-700">
                {showMovements ? 'Sembunyikan' : 'Tampilkan'}
              </span>
            </button>
            {showMovements && (
              <>
                {/* Mobile Movement Cards */}
                <div className="divide-y divide-slate-100 border-t border-slate-200 md:hidden">
                  {movements.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-start justify-between gap-2 px-4 py-3 text-xs"
                    >
                      <div className="min-w-0">
                        <p className="font-bold text-slate-900">{m.menu_name}</p>
                        <p className="text-slate-500">
                          {formatTime(m.created_at)} • {movementLabel(m.movement_type)}
                        </p>
                        {m.note && <p className="mt-0.5 text-slate-600">{m.note}</p>}
                      </div>
                      <div className="shrink-0 text-right">
                        <p
                          className={`text-sm font-extrabold ${
                            m.qty_delta >= 0 ? 'text-emerald-700' : 'text-red-600'
                          }`}
                        >
                          {m.qty_delta > 0 ? `+${m.qty_delta}` : m.qty_delta}
                        </p>
                        <p className="text-[11px] text-slate-500">Sisa: {m.stock_after}</p>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Desktop Movement Table */}
                <div className="hidden overflow-x-auto border-t border-slate-200 md:block">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 uppercase text-slate-500">
                      <tr>
                        <th className="px-4 py-2.5">Waktu</th>
                        <th className="px-4 py-2.5">Menu</th>
                        <th className="px-4 py-2.5">Aktivitas</th>
                        <th className="px-4 py-2.5 text-center">Perubahan</th>
                        <th className="px-4 py-2.5 text-center">Sisa Setelahnya</th>
                        <th className="px-4 py-2.5">Keterangan</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {movements.map((m) => (
                        <tr key={m.id}>
                          <td className="px-4 py-2 font-mono text-slate-600">
                            {formatTime(m.created_at)}
                          </td>
                          <td className="px-4 py-2 font-semibold text-slate-900">
                            {m.menu_name}
                          </td>
                          <td className="px-4 py-2">{movementLabel(m.movement_type)}</td>
                          <td
                            className={`px-4 py-2 text-center font-bold ${
                              m.qty_delta >= 0 ? 'text-emerald-700' : 'text-red-600'
                            }`}
                          >
                            {m.qty_delta > 0 ? `+${m.qty_delta}` : m.qty_delta}
                          </td>
                          <td className="px-4 py-2 text-center font-medium text-slate-800">
                            {m.stock_after}
                          </td>
                          <td className="px-4 py-2 text-slate-600">{m.note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/* Mobile Floating Save Bar when physical stock inputs are modified */}
      {dirty && (
        <div className="fixed inset-x-3 bottom-[72px] z-30 md:hidden">
          <button
            type="button"
            disabled={saving}
            onClick={() => void handleSavePhysicalStock()}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-emerald-600 text-sm font-bold text-white shadow-lg shadow-emerald-900/25 active:scale-[0.99] disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {saving ? 'Menyimpan Opname...' : 'Simpan Perubahan Opname Fisik'}
          </button>
        </div>
      )}
    </div>
  );
}
