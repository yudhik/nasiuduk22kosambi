import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Ban,
  Bluetooth,
  BluetoothConnected,
  BluetoothOff,
  Camera,
  CheckCircle2,
  Clock,
  Lock,
  Percent,
  Printer,
  RefreshCw,
  Store,
  Tag,
  Ticket,
  X,
  XCircle,
} from 'lucide-react';
import { api } from '../api/client';
import { BottomSheet } from '../components/BottomSheet';
import { VoucherScannerModal } from '../components/VoucherScannerModal';
import type { ToastMessage } from '../components/ToastContainer';
import type {
  AuthUser,
  OrderDetail,
  OrderStatus,
  Promotion,
  ReceiptSettings,
  SalesChannel,
  StoreStatusResponse,
} from '../types';
import { formatRupiah, formatTime, todayLocalDate } from '../utils/format';
import {
  connectBluetoothPrinter,
  disconnectBluetoothPrinter,
  getBluetoothPrinterState,
  getSavedPrinterMode,
  printOrderSilently,
  runThermalTestPrint,
  setSavedPrinterMode,
  subscribePrinterState,
  type BluetoothPrinterState,
  type PrinterMode,
} from '../utils/thermalPrinter';

interface CashierOrdersPageProps {
  currentUser: AuthUser;
  storeStatus: StoreStatusResponse | null;
  receiptSettings: ReceiptSettings | null;
  onRefreshStoreStatus: () => Promise<void>;
  onPrintPreview: (order: OrderDetail) => void;
  refreshSignal: number;
  onOrdersChanged: () => void;
  onToast: (title: string, description?: string, tone?: ToastMessage['tone']) => void;
}

type StatusFilter = 'UNPAID' | 'PAID' | 'VOIDED' | 'ALL';

export function CashierOrdersPage({
  currentUser,
  storeStatus,
  receiptSettings,
  onRefreshStoreStatus,
  onPrintPreview,
  refreshSignal,
  onOrdersChanged,
  onToast,
}: CashierOrdersPageProps) {
  const [date, setDate] = useState(todayLocalDate);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('UNPAID');
  const [channelFilter, setChannelFilter] = useState<number | 'ALL'>('ALL');
  const [channels, setChannels] = useState<SalesChannel[]>([]);
  const [orders, setOrders] = useState<OrderDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  // Post-payment print-or-skip prompt
  const [printPromptOrder, setPrintPromptOrder] = useState<OrderDetail | null>(null);

  // Void modal
  const [voidTarget, setVoidTarget] = useState<OrderDetail | null>(null);
  const [voidReason, setVoidReason] = useState('');

  // Promo picker modal
  const [activePromos, setActivePromos] = useState<Promotion[]>([]);
  const [promoTarget, setPromoTarget] = useState<OrderDetail | null>(null);

  // Voucher redeem + camera scanner modal
  const [voucherTarget, setVoucherTarget] = useState<OrderDetail | null>(null);
  const [voucherCodeInput, setVoucherCodeInput] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);

  // Thermal Bluetooth printer state
  const [printerMode, setPrinterMode] = useState<PrinterMode>(getSavedPrinterMode);
  const [btState, setBtState] = useState<BluetoothPrinterState>(getBluetoothPrinterState);
  const [connectingBt, setConnectingBt] = useState(false);
  const [printingId, setPrintingId] = useState<number | null>(null);

  const canVoidPaid = currentUser.role === 'owner' || currentUser.role === 'admin';
  const isTodayClosed = date === todayLocalDate() && storeStatus?.status === 'CLOSED';

  useEffect(() => {
    return subscribePrinterState(() => setBtState(getBluetoothPrinterState()));
  }, []);

  const loadOrders = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [orderData, channelData, promoData] = await Promise.all([
        api.listOrders(date, 'ALL'),
        api.listChannels(false),
        api.listPromotions(true).catch(() => [] as Promotion[]),
      ]);
      setOrders(orderData);
      setChannels(channelData);
      setActivePromos(promoData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat daftar nota');
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders, refreshSignal]);

  const handleApplyVoucher = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!voucherTarget) return;
    const code = voucherCodeInput.trim().toUpperCase();
    if (!code) {
      setError('Masukkan atau scan kode voucher terlebih dahulu.');
      return;
    }
    try {
      setBusyId(voucherTarget.id);
      setError(null);
      const updated = await api.applyOrderVoucher(voucherTarget.id, code);
      setOrders((prev) => prev.map((o) => (o.id === updated.id ? updated : o)));
      setVoucherTarget(null);
      setVoucherCodeInput('');
      onToast(
        `Voucher ${code} diterapkan`,
        `Total bayar menjadi ${formatRupiah(updated.total_amount)}`
      );
      onOrdersChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menukar voucher');
    } finally {
      setBusyId(null);
    }
  };

  const handleRemoveVoucher = async (order: OrderDetail) => {
    try {
      setBusyId(order.id);
      setError(null);
      const updated = await api.removeOrderVoucher(order.id);
      setOrders((prev) => prev.map((o) => (o.id === updated.id ? updated : o)));
      onToast(`Voucher dihapus dari ${order.order_number}`, undefined, 'info');
      onOrdersChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menghapus voucher');
    } finally {
      setBusyId(null);
    }
  };

  const counts = useMemo(() => {
    let unpaid = 0;
    let paid = 0;
    let voided = 0;
    for (const o of orders) {
      if (o.status === 'UNPAID') unpaid += 1;
      else if (o.status === 'PAID') paid += 1;
      else if (o.status === 'VOIDED') voided += 1;
    }
    return { unpaid, paid, voided, all: orders.length };
  }, [orders]);

  const visibleOrders = useMemo(() => {
    return orders.filter((o) => {
      if (statusFilter !== 'ALL' && o.status !== statusFilter) return false;
      if (channelFilter !== 'ALL' && o.channel_id !== channelFilter) return false;
      return true;
    });
  }, [orders, statusFilter, channelFilter]);

  const handleModeChange = (mode: PrinterMode) => {
    setPrinterMode(mode);
    setSavedPrinterMode(mode);
  };

  const handleConnectPrinter = async () => {
    try {
      setConnectingBt(true);
      const state = await connectBluetoothPrinter();
      setBtState(state);
      onToast(
        'Printer Bluetooth terhubung',
        `${state.deviceName ?? 'Iware X583'} siap cetak otomatis`,
        'success'
      );
    } catch (err) {
      onToast(
        'Gagal menghubungkan printer',
        err instanceof Error ? err.message : 'Periksa Bluetooth & daya printer',
        'error'
      );
    } finally {
      setConnectingBt(false);
    }
  };

  const handleTestPrint = async () => {
    try {
      await runThermalTestPrint(printerMode, receiptSettings);
      onToast('Test print terkirim ke printer 58mm', undefined, 'success');
    } catch (err) {
      onToast(
        'Test print gagal',
        err instanceof Error ? err.message : 'Pastikan printer terhubung',
        'error'
      );
    }
  };

  const handlePrintOrder = async (order: OrderDetail) => {
    try {
      setPrintingId(order.id);
      const result = await printOrderSilently(order, printerMode, receiptSettings);
      if (result === 'fallback_browser') {
        onPrintPreview(order);
      } else {
        onToast(`Struk ${order.order_number} dicetak`, 'Printer thermal 58mm', 'success');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gagal mengirim ke printer Bluetooth';
      onToast('Gagal cetak Bluetooth', `${msg} — membuka preview.`, 'error');
      onPrintPreview(order);
    } finally {
      setPrintingId(null);
    }
  };

  const handleApplyPromo = async (order: OrderDetail, promo: Promotion) => {
    try {
      setBusyId(order.id);
      setError(null);
      const updated = await api.applyOrderPromo(order.id, promo.id);
      setPromoTarget(null);
      onOrdersChanged();
      await loadOrders();
      onToast(
        `Promo "${promo.name}" diterapkan`,
        `Diskon -${formatRupiah(updated.discount_amount)} • Total ${formatRupiah(updated.total_amount)}`,
        'success'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gagal menerapkan promo';
      setError(msg);
      onToast('Gagal menerapkan promo', msg, 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleRemovePromo = async (order: OrderDetail) => {
    try {
      setBusyId(order.id);
      setError(null);
      await api.removeOrderPromo(order.id);
      onOrdersChanged();
      await loadOrders();
      onToast('Promo dihapus dari nota', undefined, 'info');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gagal menghapus promo';
      setError(msg);
      onToast('Gagal menghapus promo', msg, 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handlePay = async (order: OrderDetail) => {
    try {
      setBusyId(order.id);
      setError(null);
      const paid = await api.payOrder(order.id);
      onOrdersChanged();
      await loadOrders();
      // Offer print-or-skip choice right after payment
      setPrintPromptOrder(paid);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menandai lunas');
    } finally {
      setBusyId(null);
    }
  };

  const handleVoid = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!voidTarget) return;
    try {
      setBusyId(voidTarget.id);
      setError(null);
      await api.voidOrder(voidTarget.id, voidReason.trim() || undefined);
      const num = voidTarget.order_number;
      setVoidTarget(null);
      setVoidReason('');
      onOrdersChanged();
      await loadOrders();
      onToast(`Nota ${num} dibatalkan`, 'Stok telah dikembalikan otomatis', 'info');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal membatalkan nota');
    } finally {
      setBusyId(null);
    }
  };

  const statusBadge = (status: OrderStatus) => {
    if (status === 'PAID') {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-bold text-emerald-700">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Lunas
        </span>
      );
    }
    if (status === 'VOIDED') {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2.5 py-0.5 text-[11px] font-bold text-rose-700">
          <XCircle className="h-3.5 w-3.5" />
          Dibatalkan
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-bold text-amber-800">
        <Clock className="h-3.5 w-3.5" />
        Belum Bayar
      </span>
    );
  };

  // Block cashier when today has not been opened yet (only on today's date),
  // while still letting cashiers switch to a prior date to settle leftover UNPAID orders.
  if (date === todayLocalDate() && storeStatus?.status === 'NOT_OPENED') {
    const priorDate = storeStatus.pending_prior_date;
    const priorCount = storeStatus.pending_prior_unpaid_count ?? 0;
    return (
      <div className="mx-auto max-w-lg rounded-3xl border border-brand-amber-soft bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-cream-deep text-brand-orange">
          <Store className="h-7 w-7" />
        </div>
        <h1 className="text-lg font-extrabold text-brand-brown">Toko Belum Dibuka</h1>
        <p className="mt-2 text-sm text-brand-brown/70">
          Pemilik atau Administrator perlu mengisi stok awal harian dan menekan &ldquo;Buka Toko&rdquo; terlebih dahulu.
        </p>

        {priorDate && priorCount > 0 && (
          <div className="mt-5 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-left">
            <p className="text-xs font-extrabold text-amber-900">
              Ada {priorCount} nota BELUM BAYAR dari tanggal {priorDate}
            </p>
            <p className="mt-1 text-xs text-amber-800">
              Selesaikan (lunasi atau batalkan) nota tersebut terlebih dahulu agar toko hari ini dapat dibuka.
            </p>
            <button
              type="button"
              onClick={() => {
                setDate(priorDate);
                setStatusFilter('UNPAID');
              }}
              className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-amber-600 px-4 text-xs font-extrabold text-white shadow-sm hover:bg-amber-700"
            >
              <Clock className="h-4 w-4" />
              <span>
                Buka {priorCount} Nota Belum Bayar ({priorDate})
              </span>
            </button>
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => void onRefreshStoreStatus()}
            className="inline-flex h-11 items-center gap-2 rounded-xl bg-brand-orange px-5 text-sm font-bold text-white shadow-sm hover:bg-brand-orange-dark"
          >
            <RefreshCw className="h-4 w-4" />
            <span>Periksa Status Toko</span>
          </button>
          <input
            type="date"
            aria-label="Lihat nota tanggal lain"
            value={date}
            onChange={(e) => {
              if (e.target.value) setDate(e.target.value);
            }}
            className="h-11 rounded-xl border border-brand-amber-soft bg-brand-cream/40 px-3 text-xs font-bold text-brand-brown focus:border-brand-orange focus:outline-none"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header & Date */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div>
          <h1 className="text-lg font-extrabold text-brand-brown sm:text-xl">Kasir &amp; Daftar Nota</h1>
          <p className="text-xs text-brand-brown/70 sm:text-sm">
            Proses pembayaran, batalkan nota, dan cetak struk 58mm Bluetooth.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-10 rounded-xl border border-brand-amber-soft bg-white px-3 text-xs font-bold text-brand-brown focus:border-brand-orange focus:outline-none sm:text-sm"
          />
          <button
            type="button"
            onClick={() => void loadOrders()}
            className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-brand-amber-soft bg-white px-3 text-xs font-bold text-brand-brown hover:bg-brand-cream-deep"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Segarkan</span>
          </button>
        </div>
      </div>

      {isTodayClosed && (
        <div className="flex items-center gap-2.5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-semibold text-rose-800 sm:text-sm">
          <Lock className="h-4 w-4 shrink-0 text-rose-600" />
          <span>
            Toko hari ini sudah ditutup. Daftar nota hanya dapat dilihat dan dicetak (pembayaran &amp; pembatalan terkunci).
          </span>
        </div>
      )}

      {/* 58mm Thermal Bluetooth Printer Bar (Iware X583) */}
      <div className="rounded-2xl border border-brand-amber-soft bg-white p-3.5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div
              className={`flex h-9 w-9 items-center justify-center rounded-xl ${
                printerMode === 'ble' && btState.connected
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'bg-brand-cream-deep text-brand-orange'
              }`}
            >
              {printerMode === 'ble' && btState.connected ? (
                <BluetoothConnected className="h-5 w-5" />
              ) : (
                <Bluetooth className="h-5 w-5" />
              )}
            </div>
            <div>
              <p className="text-xs font-extrabold text-brand-brown sm:text-sm">
                Printer Thermal 58mm (Iware X583)
              </p>
              <p className="text-[11px] text-brand-brown/65">
                {printerMode === 'ble'
                  ? btState.connected
                    ? `Terhubung: ${btState.deviceName} • Cetak 1-klik otomatis`
                    : 'Hubungkan sekali di awal shift untuk cetak langsung tanpa popup'
                  : printerMode === 'rawbt'
                    ? 'Mode RawBT Android • Cetak otomatis via aplikasi RawBT'
                    : 'Mode Preview Browser • Membuka dialog print biasa'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={printerMode}
              onChange={(e) => handleModeChange(e.target.value as PrinterMode)}
              className="h-9 rounded-xl border border-brand-amber-soft bg-brand-cream px-2.5 text-xs font-bold text-brand-brown focus:border-brand-orange focus:outline-none"
            >
              <option value="ble">BLE Langsung (58mm)</option>
              <option value="rawbt">RawBT Android (58mm)</option>
              <option value="browser">Preview Browser</option>
            </select>

            {printerMode === 'ble' &&
              (btState.connected ? (
                <button
                  type="button"
                  onClick={disconnectBluetoothPrinter}
                  className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-rose-200 bg-rose-50 px-3 text-xs font-bold text-rose-700 hover:bg-rose-100"
                >
                  <BluetoothOff className="h-3.5 w-3.5" />
                  <span>Putuskan</span>
                </button>
              ) : (
                <button
                  type="button"
                  disabled={connectingBt}
                  onClick={() => void handleConnectPrinter()}
                  className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-brand-orange px-3 text-xs font-bold text-white shadow-sm hover:bg-brand-orange-dark disabled:opacity-60"
                >
                  <Bluetooth className="h-3.5 w-3.5" />
                  <span>{connectingBt ? 'Menghubungkan...' : 'Hubungkan Printer'}</span>
                </button>
              ))}

            {(printerMode === 'rawbt' || (printerMode === 'ble' && btState.connected)) && (
              <button
                type="button"
                onClick={() => void handleTestPrint()}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-brand-amber-soft bg-white px-3 text-xs font-bold text-brand-brown hover:bg-brand-cream-deep"
              >
                <Printer className="h-3.5 w-3.5" />
                <span>Test Print</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Status & Channel Filter Pills */}
      <div className="space-y-2">
        <div className="no-scrollbar flex flex-nowrap gap-2 overflow-x-auto pb-0.5">
          {(
            [
              { key: 'UNPAID', label: `Belum Bayar (${counts.unpaid})` },
              { key: 'PAID', label: `Lunas (${counts.paid})` },
              { key: 'VOIDED', label: `Batal (${counts.voided})` },
              { key: 'ALL', label: `Semua (${counts.all})` },
            ] as Array<{ key: StatusFilter; label: string }>
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setStatusFilter(tab.key)}
              className={`h-9 shrink-0 rounded-full px-4 text-xs font-bold transition ${
                statusFilter === tab.key
                  ? 'bg-brand-orange text-white shadow-sm'
                  : 'bg-white text-brand-brown ring-1 ring-brand-amber-soft hover:bg-brand-cream-deep'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="no-scrollbar flex flex-nowrap gap-1.5 overflow-x-auto pb-0.5">
          <button
            type="button"
            onClick={() => setChannelFilter('ALL')}
            className={`h-8 shrink-0 rounded-full px-3 text-[11px] font-bold transition ${
              channelFilter === 'ALL'
                ? 'bg-brand-brown text-brand-cream'
                : 'bg-white text-brand-brown/80 ring-1 ring-brand-amber-soft'
            }`}
          >
            Semua Channel
          </button>
          {channels.map((ch) => (
            <button
              key={ch.id}
              type="button"
              onClick={() => setChannelFilter(ch.id)}
              className={`h-8 shrink-0 rounded-full px-3 text-[11px] font-bold transition ${
                channelFilter === ch.id
                  ? 'bg-brand-brown text-brand-cream'
                  : 'bg-white text-brand-brown/80 ring-1 ring-brand-amber-soft'
              }`}
            >
              {ch.name}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
          {error}
        </div>
      )}

      {/* Orders List */}
      {loading ? (
        <div className="rounded-2xl border border-brand-amber-soft bg-white p-10 text-center text-sm text-brand-brown/60">
          Memuat daftar nota...
        </div>
      ) : visibleOrders.length === 0 ? (
        <div className="rounded-2xl border border-brand-amber-soft bg-white p-10 text-center text-sm text-brand-brown/60">
          Tidak ada nota untuk filter yang dipilih.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {visibleOrders.map((order) => {
            const allowVoidThisOrder =
              !isTodayClosed &&
              (order.status === 'UNPAID' || (order.status === 'PAID' && canVoidPaid));

            return (
              <div
                key={order.id}
                className="flex flex-col justify-between rounded-2xl border border-brand-amber-soft bg-white p-4 shadow-sm"
              >
                <div>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-sm font-extrabold text-brand-brown">
                          {order.order_number}
                        </span>
                        <span className="rounded-full bg-brand-cream-deep px-2 py-0.5 text-[11px] font-bold text-brand-brown">
                          {order.channel_name}
                        </span>
                        {statusBadge(order.status)}
                      </div>
                      <p className="mt-1 text-xs text-brand-brown/65">
                        {formatTime(order.created_at)}
                        {order.customer_label ? ` • ${order.customer_label}` : ''}
                        {order.waiter_name ? ` • @${order.waiter_name}` : ''}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-base font-extrabold text-brand-orange">
                        {formatRupiah(order.total_amount)}
                      </p>
                    </div>
                  </div>

                  {/* Items */}
                  <div className="mt-3 space-y-1.5 border-t border-brand-amber-soft/50 pt-2.5 text-xs">
                    {order.items.map((item) => (
                      <div key={item.id} className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <span className="font-semibold text-brand-brown">
                            {item.quantity}× {item.menu_name_snapshot}
                          </span>
                          {item.item_note && (
                            <p className="text-[11px] italic text-brand-brown/60">
                              Catatan: {item.item_note}
                            </p>
                          )}
                        </div>
                        <span className="shrink-0 font-semibold text-brand-brown/80">
                          {formatRupiah(item.subtotal)}
                        </span>
                      </div>
                    ))}
                  </div>

                  {order.notes && (
                    <p className="mt-2 rounded-lg bg-brand-cream px-2.5 py-1.5 text-[11px] text-brand-brown/80">
                      <strong>Catatan:</strong> {order.notes}
                    </p>
                  )}

                  {order.applied_promotions.length > 0 && (
                    <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[11px] text-emerald-800">
                      <div className="min-w-0">
                        <span className="font-bold">
                          Promo:{' '}
                          {order.applied_promotions.map((ap) => ap.promo_name_snapshot).join(', ')}
                        </span>
                        <span className="ml-1.5 font-extrabold">
                          (-{formatRupiah(order.discount_amount)})
                        </span>
                        <span className="block text-[10px] text-emerald-700/80">
                          Subtotal {formatRupiah(order.subtotal_amount)} → Bayar{' '}
                          {formatRupiah(order.total_amount)}
                        </span>
                      </div>
                      {order.status === 'UNPAID' && !isTodayClosed && (
                        <button
                          type="button"
                          disabled={busyId === order.id}
                          onClick={() => void handleRemovePromo(order)}
                          className="inline-flex h-7 items-center gap-1 rounded-lg border border-emerald-300 bg-white px-2 text-[10px] font-bold text-rose-700 hover:bg-rose-50"
                          title="Hapus promo"
                        >
                          <X className="h-3 w-3" />
                          <span>Hapus</span>
                        </button>
                      )}
                    </div>
                  )}

                  {(order.applied_vouchers ?? []).length > 0 && (
                    <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
                      <div className="min-w-0">
                        <span className="font-bold">
                          Voucher:{' '}
                          {order.applied_vouchers
                            .map((av) => `${av.code_snapshot} (-${formatRupiah(av.discount_amount)})`)
                            .join(', ')}
                        </span>
                        <span className="block text-[10px] text-amber-800/80">
                          Subtotal {formatRupiah(order.subtotal_amount)} → Bayar{' '}
                          {formatRupiah(order.total_amount)}
                        </span>
                      </div>
                      {order.status === 'UNPAID' && !isTodayClosed && (
                        <button
                          type="button"
                          disabled={busyId === order.id}
                          onClick={() => void handleRemoveVoucher(order)}
                          className="inline-flex h-7 items-center gap-1 rounded-lg border border-amber-300 bg-white px-2 text-[10px] font-bold text-rose-700 hover:bg-rose-50"
                          title="Hapus voucher"
                        >
                          <X className="h-3 w-3" />
                          <span>Hapus</span>
                        </button>
                      )}
                    </div>
                  )}

                  {(order.issued_vouchers ?? []).length > 0 && (
                    <div className="mt-2 rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-1.5 text-[11px] text-sky-900">
                      <span className="font-bold">Voucher Diberikan di Struk: </span>
                      <span className="font-mono font-extrabold">
                        {order.issued_vouchers.map((iv) => iv.code).join(', ')}
                      </span>
                    </div>
                  )}

                  {order.void_reason && (
                    <p className="mt-2 rounded-lg bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700">
                      <strong>Alasan Batal:</strong> {order.void_reason}
                    </p>
                  )}
                </div>

                {/* Action Footer */}
                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-brand-amber-soft/50 pt-3">
                  {order.status === 'UNPAID' && !isTodayClosed && activePromos.length > 0 && (
                    <button
                      type="button"
                      disabled={busyId === order.id}
                      onClick={() => setPromoTarget(order)}
                      className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-brand-amber bg-brand-cream px-3 text-xs font-bold text-brand-brown hover:bg-brand-cream-deep disabled:opacity-60"
                    >
                      <Percent className="h-3.5 w-3.5 text-brand-orange" />
                      <span>{order.applied_promotions.length > 0 ? 'Ganti Promo' : 'Promo'}</span>
                    </button>
                  )}
                  {order.status === 'UNPAID' && !isTodayClosed && (
                    <button
                      type="button"
                      disabled={busyId === order.id}
                      onClick={() => {
                        setVoucherTarget(order);
                        setVoucherCodeInput('');
                      }}
                      className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-amber-300 bg-amber-50 px-3 text-xs font-bold text-amber-900 hover:bg-amber-100 disabled:opacity-60"
                    >
                      <Ticket className="h-3.5 w-3.5 text-brand-orange" />
                      <span>
                        {(order.applied_vouchers ?? []).length > 0 ? 'Ganti Voucher' : 'Voucher'}
                      </span>
                    </button>
                  )}
                  {order.status === 'UNPAID' && !isTodayClosed && (
                    <button
                      type="button"
                      disabled={busyId === order.id}
                      onClick={() => void handlePay(order)}
                      className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 text-xs font-bold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-60"
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      <span>{busyId === order.id ? 'Memproses...' : 'Tandai Lunas'}</span>
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={printingId === order.id}
                    onClick={() => void handlePrintOrder(order)}
                    className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl bg-brand-orange px-3.5 text-xs font-bold text-white shadow-sm hover:bg-brand-orange-dark disabled:opacity-60"
                  >
                    <Printer className="h-4 w-4" />
                    <span>{printingId === order.id ? 'Mencetak...' : 'Cetak'}</span>
                  </button>

                  {allowVoidThisOrder && (
                    <button
                      type="button"
                      disabled={busyId === order.id}
                      onClick={() => {
                        setVoidTarget(order);
                        setVoidReason('');
                      }}
                      className="inline-flex h-10 items-center justify-center gap-1 rounded-xl border border-rose-200 bg-rose-50 px-3 text-xs font-bold text-rose-700 hover:bg-rose-100"
                    >
                      <Ban className="h-3.5 w-3.5" />
                      <span>Batal</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Promo Picker Modal */}
      <BottomSheet
        open={Boolean(promoTarget)}
        title="Terapkan Promo pada Nota"
        subtitle={
          promoTarget
            ? `${promoTarget.order_number} • Subtotal ${formatRupiah(promoTarget.subtotal_amount)}`
            : ''
        }
        onClose={() => setPromoTarget(null)}
        footer={
          <button
            type="button"
            onClick={() => setPromoTarget(null)}
            className="h-11 w-full rounded-xl border border-brand-amber-soft bg-white text-sm font-semibold text-brand-brown"
          >
            Tutup
          </button>
        }
      >
        <div className="space-y-2.5">
          {activePromos.length === 0 ? (
            <p className="py-4 text-center text-sm text-brand-brown/70">
              Belum ada promo aktif.
            </p>
          ) : (
            activePromos.map((p) => {
              const subtotal = promoTarget?.subtotal_amount ?? 0;
              const isApplied = Boolean(
                promoTarget?.applied_promotions.some((ap) => ap.promo_id === p.id)
              );
              const exhausted = p.remaining_quota <= 0 && !isApplied;
              const belowMin = subtotal < p.min_order_amount;
              const wrongChannel =
                p.regular_only &&
                promoTarget !== null &&
                promoTarget.channel_name.toLowerCase() !== 'regular';
              const disabled = exhausted || belowMin || wrongChannel || busyId === promoTarget?.id;

              const estDiscount =
                p.discount_type === 'PERCENT'
                  ? Math.min(
                      subtotal,
                      p.max_discount ?? subtotal,
                      Math.floor((subtotal * p.discount_value) / 100)
                    )
                  : Math.min(subtotal, p.discount_value);

              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => promoTarget && void handleApplyPromo(promoTarget, p)}
                  className={`flex w-full items-center justify-between gap-3 rounded-xl border p-3 text-left transition ${
                    isApplied
                      ? 'border-emerald-400 bg-emerald-50'
                      : disabled
                        ? 'cursor-not-allowed border-stone-200 bg-stone-50 opacity-60'
                        : 'border-brand-amber-soft bg-white hover:border-brand-orange hover:bg-brand-cream/40'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Tag className="h-3.5 w-3.5 text-brand-orange" />
                      <span className="text-sm font-bold text-brand-brown">{p.name}</span>
                      <span className="rounded-full bg-brand-cream-deep px-2 py-0.5 text-[10px] font-bold text-brand-brown">
                        Sisa {p.remaining_quota}/{p.quota_limit}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-brand-brown/70">
                      {exhausted
                        ? 'Kuota promo sudah habis'
                        : wrongChannel
                          ? 'Khusus saluran Regular'
                          : belowMin
                            ? `Minimal belanja ${formatRupiah(p.min_order_amount)}`
                            : `Potongan -${formatRupiah(estDiscount)} → Total ${formatRupiah(subtotal - estDiscount)}`}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-lg bg-emerald-100 px-2.5 py-1 text-xs font-extrabold text-emerald-800">
                    {p.discount_type === 'FIXED'
                      ? `-${formatRupiah(p.discount_value)}`
                      : `-${p.discount_value}%`}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </BottomSheet>

      {/* Post-Payment Print-or-Skip Prompt */}
      <BottomSheet
        open={Boolean(printPromptOrder)}
        title="Pembayaran Berhasil (LUNAS)"
        subtitle={
          printPromptOrder
            ? `${printPromptOrder.order_number} • ${formatRupiah(printPromptOrder.total_amount)}`
            : ''
        }
        onClose={() => setPrintPromptOrder(null)}
        footer={
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => setPrintPromptOrder(null)}
              className="h-12 rounded-xl border border-brand-amber-soft bg-white text-sm font-bold text-brand-brown"
            >
              Tidak, Lewati
            </button>
            <button
              type="button"
              onClick={() => {
                const target = printPromptOrder;
                setPrintPromptOrder(null);
                if (target) void handlePrintOrder(target);
              }}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-brand-orange text-sm font-bold text-white shadow-sm hover:bg-brand-orange-dark"
            >
              <Printer className="h-4 w-4" />
              <span>Cetak Struk</span>
            </button>
          </div>
        }
      >
        <p className="text-sm text-brand-brown/80">
          Apakah Anda ingin mencetak struk nota ini sekarang?
          {printerMode === 'ble' && btState.connected && (
            <span className="mt-1 block text-xs font-semibold text-emerald-700">
              Akan langsung tercetak otomatis ke {btState.deviceName} tanpa popup tambahan.
            </span>
          )}
        </p>
      </BottomSheet>

      {/* Voucher Redeem BottomSheet */}
      <BottomSheet
        open={Boolean(voucherTarget)}
        title="Tukar Voucher Pelanggan"
        subtitle={
          voucherTarget
            ? `${voucherTarget.order_number} • Subtotal ${formatRupiah(voucherTarget.subtotal_amount)}`
            : ''
        }
        onClose={() => setVoucherTarget(null)}
        footer={
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => setVoucherTarget(null)}
              className="h-11 rounded-xl border border-brand-amber-soft bg-white text-sm font-semibold text-brand-brown"
            >
              Batal
            </button>
            <button
              type="button"
              disabled={busyId !== null || !voucherCodeInput.trim()}
              onClick={() => void handleApplyVoucher()}
              className="h-11 rounded-xl bg-brand-orange text-sm font-bold text-white hover:bg-brand-orange-dark disabled:opacity-60"
            >
              {busyId !== null ? 'Memproses...' : 'Terapkan Voucher'}
            </button>
          </div>
        }
      >
        <form onSubmit={handleApplyVoucher} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
              Kode Voucher (Scan QR/Barcode atau Ketik Manual)
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={voucherCodeInput}
                onChange={(e) => setVoucherCodeInput(e.target.value.toUpperCase())}
                placeholder="cth: NU22-K7M9P2"
                className="h-11 flex-1 rounded-xl border border-brand-amber-soft px-3.5 font-mono text-sm font-bold uppercase text-brand-brown focus:border-brand-orange focus:outline-none"
                autoFocus
              />
              <button
                type="button"
                onClick={() => setScannerOpen(true)}
                className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl border border-brand-amber bg-brand-cream px-3.5 text-xs font-bold text-brand-brown hover:bg-brand-cream-deep"
              >
                <Camera className="h-4 w-4 text-brand-orange" />
                <span>Scan</span>
              </button>
            </div>
          </div>
          <p className="text-[11px] text-brand-brown/65">
            Voucher dapat digabung (stack) dengan Promo Diskon pada nota yang sama.
          </p>
        </form>
      </BottomSheet>

      <VoucherScannerModal
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDetected={(code) => {
          setVoucherCodeInput(code);
          onToast(`Kode terdeteksi: ${code}`, 'Tekan "Terapkan Voucher" untuk memakai', 'info');
        }}
      />

      {/* Void Confirmation BottomSheet */}
      <BottomSheet
        open={Boolean(voidTarget)}
        title={`Batalkan Nota ${voidTarget?.order_number ?? ''}`}
        subtitle={
          voidTarget?.status === 'PAID'
            ? 'Nota ini sudah LUNAS. Pembatalan oleh Pemilik/Admin akan mengembalikan semua stok terkait.'
            : 'Stok yang sudah terpotong akan otomatis dikembalikan.'
        }
        onClose={() => setVoidTarget(null)}
        footer={
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => setVoidTarget(null)}
              className="h-11 rounded-xl border border-brand-amber-soft bg-white text-sm font-semibold text-brand-brown"
            >
              Kembali
            </button>
            <button
              type="button"
              disabled={busyId !== null}
              onClick={() => void handleVoid()}
              className="h-11 rounded-xl bg-rose-600 text-sm font-bold text-white hover:bg-rose-700 disabled:opacity-60"
            >
              Konfirmasi Batal
            </button>
          </div>
        }
      >
        <form onSubmit={handleVoid}>
          <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
            Alasan Pembatalan (Opsional)
          </label>
          <input
            type="text"
            value={voidReason}
            onChange={(e) => setVoidReason(e.target.value)}
            placeholder="cth: Salah input / Pelanggan batal"
            className="h-11 w-full rounded-xl border border-brand-amber-soft px-3.5 text-sm text-brand-brown focus:border-brand-orange focus:outline-none"
            autoFocus
          />
        </form>
      </BottomSheet>
    </div>
  );
}
