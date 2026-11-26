import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  ClipboardEdit,
  LogOut,
  Package,
  Receipt,
  ShieldCheck,
} from 'lucide-react';
import { api, setUnauthorizedHandler } from './api/client';
import { ReceiptPrintView } from './components/ReceiptPrintView';
import { ToastContainer, type ToastMessage } from './components/ToastContainer';
import { AdminUsersPage, roleBadge } from './pages/AdminUsersPage';
import { CashierOrdersPage } from './pages/CashierOrdersPage';
import { DailyReportPage } from './pages/DailyReportPage';
import { LoginPage } from './pages/LoginPage';
import { MenuStockPage } from './pages/MenuStockPage';
import { WaiterOrderPage } from './pages/WaiterOrderPage';
import {
  STORE_NAME,
  type AuthUser,
  type OrderDetail,
  type StoreStatusResponse,
  type TabKey,
} from './types';
import { todayLocalDate } from './utils/format';

const ALL_NAV_ITEMS: Array<{
  key: TabKey;
  label: string;
  shortLabel: string;
  icon: typeof ClipboardEdit;
}> = [
  { key: 'waiter', label: 'Catat Nota', shortLabel: 'Catat', icon: ClipboardEdit },
  { key: 'cashier', label: 'Kasir & Nota', shortLabel: 'Kasir', icon: Receipt },
  { key: 'menu', label: 'Menu & Stok', shortLabel: 'Stok', icon: Package },
  { key: 'report', label: 'Laporan', shortLabel: 'Laporan', icon: BarChart3 },
  { key: 'users', label: 'Admin', shortLabel: 'Admin', icon: ShieldCheck },
];

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);

  const [activeTab, setActiveTab] = useState<TabKey>('waiter');
  const [printOrder, setPrintOrder] = useState<OrderDetail | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [unpaidCount, setUnpaidCount] = useState(0);
  const [storeStatus, setStoreStatus] = useState<StoreStatusResponse | null>(null);

  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toastSeq = useRef(1);

  const showToast = useCallback(
    (title: string, description?: string, tone: ToastMessage['tone'] = 'success') => {
      const id = toastSeq.current++;
      setToasts((prev) => [...prev.slice(-2), { id, title, description, tone }]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 3500);
    },
    []
  );

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const visibleNavItems = useMemo(() => {
    if (!user) return [];
    return ALL_NAV_ITEMS.filter((item) => user.allowed_tabs.includes(item.key));
  }, [user]);

  const canSeeCashier = Boolean(user?.allowed_tabs.includes('cashier'));

  const refreshStoreStatus = useCallback(async () => {
    try {
      const st = await api.getStoreStatus();
      setStoreStatus(st);
    } catch {
      // ignore silent status fetch errors
    }
  }, []);

  // Restore session on initial mount
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const me = await api.me();
        if (!active) return;
        setUser(me);
        if (me.allowed_tabs.length > 0) {
          setActiveTab(me.allowed_tabs[0]);
        }
      } catch {
        if (active) setUser(null);
      } finally {
        if (active) setAuthChecking(false);
      }
    })();

    setUnauthorizedHandler(() => {
      setUser(null);
      setPrintOrder(null);
      setUnpaidCount(0);
      setStoreStatus(null);
    });

    return () => {
      active = false;
      setUnauthorizedHandler(null);
    };
  }, []);

  useEffect(() => {
    if (user && !user.allowed_tabs.includes(activeTab) && user.allowed_tabs.length > 0) {
      setActiveTab(user.allowed_tabs[0]);
    }
  }, [user, activeTab]);

  const refreshUnpaidBadge = useCallback(async () => {
    if (!canSeeCashier) {
      setUnpaidCount(0);
      return;
    }
    try {
      const unpaid = await api.listOrders(todayLocalDate(), 'UNPAID');
      setUnpaidCount(unpaid.length);
    } catch {
      // ignore silent badge refresh failures
    }
  }, [canSeeCashier]);

  useEffect(() => {
    if (user) {
      void refreshStoreStatus();
      if (canSeeCashier) {
        void refreshUnpaidBadge();
      }
    }
  }, [user, canSeeCashier, refreshStoreStatus, refreshUnpaidBadge, refreshSignal, activeTab]);

  const handleLoginSuccess = (loggedInUser: AuthUser) => {
    setUser(loggedInUser);
    if (loggedInUser.allowed_tabs.length > 0) {
      setActiveTab(loggedInUser.allowed_tabs[0]);
    }
  };

  const handleLogout = async () => {
    try {
      setLoggingOut(true);
      await api.logout();
    } catch {
      // Clear local session even if expired
    } finally {
      setLoggingOut(false);
      setUser(null);
      setPrintOrder(null);
      setUnpaidCount(0);
      setStoreStatus(null);
    }
  };

  const handleOrderActivity = () => {
    setRefreshSignal((n) => n + 1);
    void refreshUnpaidBadge();
    void refreshStoreStatus();
  };

  const handleStoreChanged = () => {
    setRefreshSignal((n) => n + 1);
    void refreshStoreStatus();
    void refreshUnpaidBadge();
  };

  if (authChecking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-cream px-4">
        <div className="text-center">
          <div className="mx-auto mb-3 h-16 w-16 overflow-hidden rounded-2xl border-2 border-brand-amber-soft shadow-sm">
            <img src="/logo.jpeg" alt={STORE_NAME} className="h-full w-full object-cover" />
          </div>
          <p className="text-sm font-semibold text-brand-brown">Memeriksa sesi login...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginPage onLoginSuccess={handleLoginSuccess} />;
  }

  const badge = roleBadge(user.role);
  const mobileGridClass =
    visibleNavItems.length >= 5
      ? 'grid-cols-5'
      : visibleNavItems.length === 4
        ? 'grid-cols-4'
        : visibleNavItems.length === 3
          ? 'grid-cols-3'
          : 'grid-cols-2';

  const storePill =
    storeStatus?.status === 'OPEN'
      ? { label: 'Toko Buka', cls: 'bg-emerald-100 text-emerald-800 border-emerald-200' }
      : storeStatus?.status === 'CLOSED'
        ? { label: 'Toko Tutup', cls: 'bg-rose-100 text-rose-800 border-rose-200' }
        : { label: 'Belum Buka', cls: 'bg-amber-100 text-amber-900 border-amber-300' };

  return (
    <>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      <div
        className={`no-print min-h-screen bg-brand-cream ${
          visibleNavItems.length > 1 ? 'pb-24 md:pb-10' : 'pb-10'
        }`}
      >
        {/* Static Logo & Header (Non-editable, No subtitle) */}
        <header className="sticky top-0 z-30 border-b border-brand-amber-soft bg-white/95 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-2 px-3 sm:h-16 sm:px-4">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="h-10 w-10 shrink-0 overflow-hidden rounded-xl border border-brand-amber-soft bg-brand-cream shadow-sm">
                <img
                  src="/logo.jpeg"
                  alt={STORE_NAME}
                  className="h-full w-full object-cover"
                />
              </div>
              <div className="min-w-0">
                <span className="block truncate text-sm font-extrabold tracking-tight text-brand-brown sm:text-base">
                  {STORE_NAME}
                </span>
                {storeStatus && (
                  <span
                    className={`mt-0.5 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold leading-none ${storePill.cls}`}
                  >
                    {storePill.label}
                  </span>
                )}
              </div>
            </div>

            {/* Desktop Navigation */}
            {visibleNavItems.length > 1 && (
              <nav className="hidden items-center gap-1 md:flex">
                {visibleNavItems.map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setActiveTab(key)}
                    className={`relative inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition ${
                      activeTab === key
                        ? 'bg-brand-orange text-white shadow-sm'
                        : 'text-brand-brown/80 hover:bg-brand-cream-deep hover:text-brand-brown'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    <span>{label}</span>
                    {key === 'cashier' && unpaidCount > 0 && (
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-[11px] font-extrabold leading-none ${
                          activeTab === key
                            ? 'bg-white text-brand-orange'
                            : 'bg-brand-brown text-brand-cream'
                        }`}
                      >
                        {unpaidCount}
                      </span>
                    )}
                  </button>
                ))}
              </nav>
            )}

            {/* Logged-in User Info & Logout */}
            <div className="flex shrink-0 items-center gap-2">
              <div className="hidden flex-col items-end text-right sm:flex">
                <span className="max-w-[140px] truncate text-xs font-bold text-brand-brown">
                  @{user.username}
                </span>
                <span
                  className={`rounded-full border px-1.5 py-0.5 text-[10px] font-bold leading-none ${badge.cls}`}
                >
                  {badge.label}
                </span>
              </div>
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] font-bold sm:hidden ${badge.cls}`}
              >
                {badge.label}
              </span>
              <button
                type="button"
                disabled={loggingOut}
                onClick={() => void handleLogout()}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-brand-amber-soft bg-white px-2.5 text-xs font-bold text-brand-brown transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700"
                title="Keluar (Logout)"
              >
                <LogOut className="h-4 w-4" />
                <span className="hidden sm:inline">{loggingOut ? '...' : 'Keluar'}</span>
              </button>
            </div>
          </div>
        </header>

        {/* Main Content */}
        <main className="mx-auto max-w-7xl px-3 py-4 sm:px-4 sm:py-6">
          {activeTab === 'waiter' && user.allowed_tabs.includes('waiter') && (
            <WaiterOrderPage
              currentUser={user}
              storeStatus={storeStatus}
              onRefreshStoreStatus={refreshStoreStatus}
              onOrderCreated={handleOrderActivity}
              onToast={showToast}
            />
          )}
          {activeTab === 'cashier' && user.allowed_tabs.includes('cashier') && (
            <CashierOrdersPage
              currentUser={user}
              storeStatus={storeStatus}
              onRefreshStoreStatus={refreshStoreStatus}
              onPrintPreview={setPrintOrder}
              refreshSignal={refreshSignal}
              onOrdersChanged={handleOrderActivity}
              onToast={showToast}
            />
          )}
          {activeTab === 'menu' && user.allowed_tabs.includes('menu') && (
            <MenuStockPage
              storeStatus={storeStatus}
              onStoreChanged={handleStoreChanged}
              onToast={showToast}
            />
          )}
          {activeTab === 'report' && user.allowed_tabs.includes('report') && (
            <DailyReportPage
              storeStatus={storeStatus}
              onToast={showToast}
            />
          )}
          {activeTab === 'users' && user.allowed_tabs.includes('users') && (
            <AdminUsersPage currentUser={user} />
          )}
        </main>

        {/* Mobile Bottom Navigation */}
        {visibleNavItems.length > 1 && (
          <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-brand-amber-soft bg-white/95 pb-safe backdrop-blur md:hidden">
            <div className={`grid ${mobileGridClass} px-1 pt-1.5`}>
              {visibleNavItems.map(({ key, shortLabel, icon: Icon }) => {
                const active = activeTab === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setActiveTab(key)}
                    className="flex flex-col items-center justify-center gap-0.5 py-1 active:scale-95"
                  >
                    <div
                      className={`relative flex h-8 w-12 items-center justify-center rounded-full transition ${
                        active ? 'bg-brand-orange text-white' : 'text-brand-brown/60'
                      }`}
                    >
                      <Icon className="h-5 w-5" />
                      {key === 'cashier' && unpaidCount > 0 && (
                        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-brand-brown px-1 text-[10px] font-extrabold text-brand-cream">
                          {unpaidCount > 99 ? '99+' : unpaidCount}
                        </span>
                      )}
                    </div>
                    <span
                      className={`text-[11px] font-bold ${
                        active ? 'text-brand-orange' : 'text-brand-brown/60'
                      }`}
                    >
                      {shortLabel}
                    </span>
                  </button>
                );
              })}
            </div>
          </nav>
        )}
      </div>

      {/* Printable Receipt Modal (Kasir Browser Fallback Preview) */}
      <ReceiptPrintView order={printOrder} onClose={() => setPrintOrder(null)} />
    </>
  );
}
