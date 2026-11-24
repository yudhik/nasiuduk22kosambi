import { useCallback, useEffect, useState } from 'react';
import {
  BarChart3,
  ClipboardEdit,
  Edit3,
  Package,
  Receipt,
  Store,
} from 'lucide-react';
import { api } from './api/client';
import { BottomSheet } from './components/BottomSheet';
import { ReceiptPrintView } from './components/ReceiptPrintView';
import { CashierOrdersPage } from './pages/CashierOrdersPage';
import { DailyReportPage } from './pages/DailyReportPage';
import { MenuStockPage } from './pages/MenuStockPage';
import { WaiterOrderPage } from './pages/WaiterOrderPage';
import type { OrderDetail } from './types';
import { todayLocalDate } from './utils/format';

type TabKey = 'waiter' | 'cashier' | 'menu' | 'report';

const NAV_ITEMS: Array<{
  key: TabKey;
  label: string;
  shortLabel: string;
  icon: typeof ClipboardEdit;
}> = [
  { key: 'waiter', label: 'Catat Nota', shortLabel: 'Catat', icon: ClipboardEdit },
  { key: 'cashier', label: 'Kasir & Nota', shortLabel: 'Kasir', icon: Receipt },
  { key: 'menu', label: 'Menu & Stok', shortLabel: 'Stok', icon: Package },
  { key: 'report', label: 'Laporan', shortLabel: 'Laporan', icon: BarChart3 },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('waiter');
  const [printOrder, setPrintOrder] = useState<OrderDetail | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [unpaidCount, setUnpaidCount] = useState(0);

  const [shopName, setShopName] = useState(
    () => localStorage.getItem('nota_shop_name') ?? 'Warung NotaDigital'
  );
  const [shopSheetOpen, setShopSheetOpen] = useState(false);
  const [shopDraft, setShopDraft] = useState(shopName);

  const refreshUnpaidBadge = useCallback(async () => {
    try {
      const unpaid = await api.listOrders(todayLocalDate(), 'UNPAID');
      setUnpaidCount(unpaid.length);
    } catch {
      // ignore silent badge refresh failures
    }
  }, []);

  useEffect(() => {
    void refreshUnpaidBadge();
  }, [refreshUnpaidBadge, refreshSignal, activeTab]);

  const handleOrderActivity = () => {
    setRefreshSignal((n) => n + 1);
    void refreshUnpaidBadge();
  };

  const handleSaveShopName = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleaned = shopDraft.trim() || 'Warung NotaDigital';
    setShopName(cleaned);
    localStorage.setItem('nota_shop_name', cleaned);
    setShopSheetOpen(false);
  };

  return (
    <>
      <div className="no-print min-h-screen bg-slate-50 pb-24 md:pb-10">
        {/* Compact Top Header */}
        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-3 px-3 sm:h-16 sm:px-4">
            <button
              type="button"
              onClick={() => {
                setShopDraft(shopName);
                setShopSheetOpen(true);
              }}
              className="flex min-w-0 items-center gap-2.5 text-left active:opacity-80"
              title="Ketuk untuk ubah nama warung"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm">
                <Store className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-extrabold tracking-tight text-slate-900 sm:text-base">
                    {shopName}
                  </span>
                  <Edit3 className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                </div>
                <p className="truncate text-[11px] text-slate-500">
                  Nota Digital &amp; Stok Harian
                </p>
              </div>
            </button>

            {/* Desktop Navigation */}
            <nav className="hidden items-center gap-1 md:flex">
              {NAV_ITEMS.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setActiveTab(key)}
                  className={`relative inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-semibold transition ${
                    activeTab === key
                      ? 'bg-emerald-600 text-white shadow-sm'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <span>{label}</span>
                  {key === 'cashier' && unpaidCount > 0 && (
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[11px] font-extrabold leading-none ${
                        activeTab === key
                          ? 'bg-white text-emerald-700'
                          : 'bg-amber-500 text-white'
                      }`}
                    >
                      {unpaidCount}
                    </span>
                  )}
                </button>
              ))}
            </nav>
          </div>
        </header>

        {/* Main Content */}
        <main className="mx-auto max-w-7xl px-3 py-4 sm:px-4 sm:py-6">
          {activeTab === 'waiter' && (
            <WaiterOrderPage
              onPrintOrder={setPrintOrder}
              onOrderCreated={handleOrderActivity}
            />
          )}
          {activeTab === 'cashier' && (
            <CashierOrdersPage
              onPrintOrder={setPrintOrder}
              refreshSignal={refreshSignal}
              onOrdersChanged={handleOrderActivity}
            />
          )}
          {activeTab === 'menu' && <MenuStockPage />}
          {activeTab === 'report' && <DailyReportPage />}
        </main>

        {/* Android-Style Material Bottom Navigation Bar */}
        <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur pb-safe md:hidden">
          <div className="grid grid-cols-4 px-1 pt-1.5">
            {NAV_ITEMS.map(({ key, shortLabel, icon: Icon }) => {
              const active = activeTab === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setActiveTab(key)}
                  className="flex flex-col items-center justify-center gap-0.5 py-1 active:scale-95"
                >
                  <div
                    className={`relative flex h-8 w-14 items-center justify-center rounded-full transition ${
                      active ? 'bg-emerald-100 text-emerald-700' : 'text-slate-500'
                    }`}
                  >
                    <Icon className="h-5 w-5" />
                    {key === 'cashier' && unpaidCount > 0 && (
                      <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-extrabold text-white">
                        {unpaidCount > 99 ? '99+' : unpaidCount}
                      </span>
                    )}
                  </div>
                  <span
                    className={`text-[11px] font-bold ${
                      active ? 'text-emerald-700' : 'text-slate-500'
                    }`}
                  >
                    {shortLabel}
                  </span>
                </button>
              );
            })}
          </div>
        </nav>
      </div>

      {/* Shop Name Settings BottomSheet */}
      <BottomSheet
        open={shopSheetOpen}
        title="Nama Warung / Usaha"
        subtitle="Nama ini akan ditampilkan di header dan di bagian atas struk nota cetak."
        onClose={() => setShopSheetOpen(false)}
        footer={
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => setShopSheetOpen(false)}
              className="h-11 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-700"
            >
              Batal
            </button>
            <button
              type="button"
              onClick={() => handleSaveShopName()}
              className="h-11 rounded-xl bg-emerald-600 text-sm font-bold text-white hover:bg-emerald-700"
            >
              Simpan Nama
            </button>
          </div>
        }
      >
        <form onSubmit={handleSaveShopName}>
          <label className="mb-1 block text-xs font-semibold text-slate-700">
            Nama Usaha
          </label>
          <input
            type="text"
            value={shopDraft}
            onChange={(e) => setShopDraft(e.target.value)}
            placeholder="cth: Warung Nasi Uduk 22"
            className="h-11 w-full rounded-xl border border-slate-200 px-3.5 text-base sm:text-sm focus:border-emerald-500 focus:outline-none"
            autoFocus
          />
        </form>
      </BottomSheet>

      {/* Printable Receipt Modal (renders outside .no-print) */}
      <ReceiptPrintView
        order={printOrder}
        shopName={shopName}
        onClose={() => setPrintOrder(null)}
      />
    </>
  );
}
