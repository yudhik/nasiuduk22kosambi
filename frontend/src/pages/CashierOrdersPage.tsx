import { useEffect, useMemo, useState } from 'react';
import {
  Ban,
  CheckCircle2,
  Clock,
  Printer,
  RefreshCw,
  X,
  XCircle,
} from 'lucide-react';
import { api } from '../api/client';
import { BottomSheet } from '../components/BottomSheet';
import type { OrderDetail, OrderStatus } from '../types';
import { formatRupiah, formatTime, todayLocalDate } from '../utils/format';

interface CashierOrdersPageProps {
  onPrintOrder: (order: OrderDetail) => void;
  refreshSignal: number;
  onOrdersChanged: () => void;
}

type FilterStatus = 'UNPAID' | 'PAID' | 'VOIDED' | 'ALL';

export function CashierOrdersPage({
  onPrintOrder,
  refreshSignal,
  onOrdersChanged,
}: CashierOrdersPageProps) {
  const [date, setDate] = useState(todayLocalDate);
  const [statusFilter, setStatusFilter] = useState<FilterStatus>('UNPAID');
  const [orders, setOrders] = useState<OrderDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionOrderId, setActionOrderId] = useState<number | null>(null);

  const [voidTarget, setVoidTarget] = useState<OrderDetail | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [notice, setNotice] = useState<{ text: string; order?: OrderDetail } | null>(null);

  const loadOrders = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.listOrders(date, 'ALL');
      setOrders(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat daftar nota');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadOrders();
  }, [date, refreshSignal]);

  const counts = useMemo(() => {
    const unpaid = orders.filter((o) => o.status === 'UNPAID');
    const paid = orders.filter((o) => o.status === 'PAID');
    const voided = orders.filter((o) => o.status === 'VOIDED');
    return {
      UNPAID: unpaid.length,
      PAID: paid.length,
      VOIDED: voided.length,
      ALL: orders.length,
      unpaidTotal: unpaid.reduce((s, o) => s + o.total_amount, 0),
      paidTotal: paid.reduce((s, o) => s + o.total_amount, 0),
    };
  }, [orders]);

  const visibleOrders = useMemo(() => {
    if (statusFilter === 'ALL') return orders;
    return orders.filter((o) => o.status === statusFilter);
  }, [orders, statusFilter]);

  const handlePay = async (order: OrderDetail) => {
    try {
      setActionOrderId(order.id);
      setError(null);
      const updated = await api.payOrder(order.id);
      setOrders((prev) => prev.map((o) => (o.id === updated.id ? updated : o)));
      setNotice({
        text: `Nota ${updated.order_number} berhasil ditandai LUNAS.`,
        order: updated,
      });
      onOrdersChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memproses pembayaran');
    } finally {
      setActionOrderId(null);
    }
  };

  const handleConfirmVoid = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!voidTarget) return;
    try {
      setActionOrderId(voidTarget.id);
      setError(null);
      const updated = await api.voidOrder(voidTarget.id, voidReason.trim() || undefined);
      setOrders((prev) => prev.map((o) => (o.id === updated.id ? updated : o)));
      setNotice({
        text: `Nota ${updated.order_number} dibatalkan dan stok dikembalikan.`,
      });
      setVoidTarget(null);
      setVoidReason('');
      onOrdersChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal membatalkan nota');
    } finally {
      setActionOrderId(null);
    }
  };

  const statusBadge = (status: OrderStatus) => {
    switch (status) {
      case 'UNPAID':
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-bold text-amber-800">
            <Clock className="h-3.5 w-3.5" />
            Belum Bayar
          </span>
        );
      case 'PAID':
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-800">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Lunas
          </span>
        );
      case 'VOIDED':
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-bold text-red-700">
            <XCircle className="h-3.5 w-3.5" />
            Dibatalkan
          </span>
        );
    }
  };

  return (
    <div className="space-y-4">
      {/* Header & Date Filter */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-lg font-bold text-slate-900 sm:text-xl">
            Kasir &amp; Daftar Nota
          </h1>
          <p className="text-xs text-slate-500 sm:text-sm">
            Proses pembayaran konsumen, cetak nota, atau batalkan nota belum bayar.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-10 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 sm:flex-none"
          />
          <button
            type="button"
            onClick={() => void loadOrders()}
            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 active:scale-95 hover:bg-slate-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Muat Ulang</span>
          </button>
        </div>
      </div>

      {/* Compact 2-column totals strip even on narrow Android screens */}
      <div className="grid grid-cols-2 gap-2.5 sm:gap-4">
        <div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-3.5 sm:p-4">
          <p className="text-[11px] font-bold uppercase tracking-wide text-amber-800">
            Belum Bayar ({counts.UNPAID})
          </p>
          <p className="mt-1 text-lg font-extrabold text-amber-900 sm:text-2xl">
            {formatRupiah(counts.unpaidTotal)}
          </p>
        </div>
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/80 p-3.5 sm:p-4">
          <p className="text-[11px] font-bold uppercase tracking-wide text-emerald-800">
            Lunas ({counts.PAID})
          </p>
          <p className="mt-1 text-lg font-extrabold text-emerald-900 sm:text-2xl">
            {formatRupiah(counts.paidTotal)}
          </p>
        </div>
      </div>

      {notice && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900">
          <span>{notice.text}</span>
          <div className="flex items-center gap-2">
            {notice.order && (
              <button
                type="button"
                onClick={() => onPrintOrder(notice.order!)}
                className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700"
              >
                <Printer className="h-3.5 w-3.5" />
                Cetak Struk
              </button>
            )}
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="rounded-lg p-1 text-emerald-700 hover:bg-emerald-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {error}
        </div>
      )}

      {/* Horizontal swipeable Status Filter Pills */}
      <div className="no-scrollbar flex flex-nowrap gap-2 overflow-x-auto pb-1">
        {(
          [
            ['UNPAID', 'Belum Bayar'],
            ['PAID', 'Lunas'],
            ['VOIDED', 'Dibatalkan'],
            ['ALL', 'Semua'],
          ] as Array<[FilterStatus, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setStatusFilter(key)}
            className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-4 text-xs font-bold transition active:scale-95 sm:text-sm ${
              statusFilter === key
                ? 'bg-slate-900 text-white shadow-sm'
                : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100'
            }`}
          >
            <span>{label}</span>
            <span
              className={`rounded-full px-1.5 py-0.5 text-[11px] ${
                statusFilter === key
                  ? 'bg-white/20 text-white'
                  : 'bg-slate-100 text-slate-700'
              }`}
            >
              {counts[key]}
            </span>
          </button>
        ))}
      </div>

      {/* Orders Grid */}
      {loading ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          Memuat daftar nota...
        </div>
      ) : visibleOrders.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          Tidak ada nota pada filter ini untuk tanggal {date}.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
          {visibleOrders.map((order) => (
            <div
              key={order.id}
              className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-extrabold text-slate-900">
                        {order.order_number}
                      </span>
                      {statusBadge(order.status)}
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {formatTime(order.created_at)}
                      {order.customer_label ? ` • ${order.customer_label}` : ''}
                      {order.waiter_name ? ` • Pelayan: ${order.waiter_name}` : ''}
                    </p>
                  </div>
                  <p className="shrink-0 text-base font-extrabold text-slate-900 sm:text-lg">
                    {formatRupiah(order.total_amount)}
                  </p>
                </div>

                <ul className="mt-3 divide-y divide-slate-100 rounded-xl bg-slate-50 px-3 py-1 text-sm">
                  {order.items.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-start justify-between gap-2 py-2"
                    >
                      <div className="min-w-0">
                        <span className="font-bold text-slate-900">{item.quantity}×</span>{' '}
                        <span className="text-slate-700">{item.menu_name_snapshot}</span>
                        {item.item_note && (
                          <p className="text-xs italic text-slate-500">
                            Catatan: {item.item_note}
                          </p>
                        )}
                      </div>
                      <span className="shrink-0 font-semibold text-slate-700">
                        {formatRupiah(item.subtotal)}
                      </span>
                    </li>
                  ))}
                </ul>

                {order.notes && (
                  <p className="mt-2.5 text-xs text-slate-600">
                    <span className="font-semibold">Catatan:</span> {order.notes}
                  </p>
                )}

                {order.void_reason && (
                  <p className="mt-2.5 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700">
                    <span className="font-bold">Alasan batal:</span> {order.void_reason}
                  </p>
                )}
              </div>

              {/* Thumb-safe Action Area: Primary CTA separated from Void */}
              <div className="mt-4 space-y-2 border-t border-slate-100 pt-3.5">
                {order.status === 'UNPAID' ? (
                  <>
                    <button
                      type="button"
                      disabled={actionOrderId === order.id}
                      onClick={() => void handlePay(order)}
                      className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 text-sm font-bold text-white shadow-sm active:scale-[0.99] hover:bg-emerald-700 disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-5 w-5" />
                      {actionOrderId === order.id
                        ? 'Memproses Pembayaran...'
                        : `Tandai Lunas • ${formatRupiah(order.total_amount)}`}
                    </button>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => onPrintOrder(order)}
                        className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white text-xs font-bold text-slate-700 active:scale-98 hover:bg-slate-50"
                      >
                        <Printer className="h-4 w-4" />
                        Cetak Nota
                      </button>
                      <button
                        type="button"
                        disabled={actionOrderId === order.id}
                        onClick={() => {
                          setVoidTarget(order);
                          setVoidReason('');
                        }}
                        className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-red-200 bg-red-50 text-xs font-bold text-red-700 active:scale-98 hover:bg-red-100 disabled:opacity-50"
                      >
                        <Ban className="h-4 w-4" />
                        Batalkan
                      </button>
                    </div>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => onPrintOrder(order)}
                    className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white text-xs font-bold text-slate-700 active:scale-98 hover:bg-slate-50"
                  >
                    <Printer className="h-4 w-4" />
                    Lihat &amp; Cetak Ulang Nota
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Void Confirmation BottomSheet */}
      <BottomSheet
        open={Boolean(voidTarget)}
        title={voidTarget ? `Batalkan ${voidTarget.order_number}?` : ''}
        subtitle="Stok seluruh item pada nota ini akan otomatis dikembalikan."
        onClose={() => setVoidTarget(null)}
        footer={
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => setVoidTarget(null)}
              className="h-11 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Kembali
            </button>
            <button
              type="button"
              disabled={!voidTarget || actionOrderId === voidTarget.id}
              onClick={() => void handleConfirmVoid()}
              className="h-11 rounded-xl bg-red-600 text-sm font-bold text-white hover:bg-red-700 disabled:opacity-50"
            >
              Ya, Batalkan Nota
            </button>
          </div>
        }
      >
        <form onSubmit={handleConfirmVoid} className="space-y-3">
          <div className="rounded-xl bg-red-50 p-3 text-xs text-red-800">
            Status nota akan berubah menjadi <strong>DIBATALKAN</strong> dan tidak akan
            dihitung dalam total pendapatan harian.
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">
              Alasan Pembatalan (Opsional)
            </label>
            <input
              type="text"
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder="cth: Salah input jumlah / konsumen batal"
              className="h-11 w-full rounded-xl border border-slate-200 px-3.5 text-base sm:text-sm focus:border-red-500 focus:outline-none"
              autoFocus
            />
          </div>
        </form>
      </BottomSheet>
    </div>
  );
}
