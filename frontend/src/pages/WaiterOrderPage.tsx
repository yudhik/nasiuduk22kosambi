import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Minus,
  Plus,
  Printer,
  RefreshCw,
  Search,
  ShoppingBag,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../api/client';
import { BottomSheet } from '../components/BottomSheet';
import type { MenuItem, OrderDetail } from '../types';
import { formatRupiah } from '../utils/format';

interface CartEntry {
  menu: MenuItem;
  quantity: number;
  itemNote: string;
}

interface WaiterOrderPageProps {
  onPrintOrder: (order: OrderDetail) => void;
  onOrderCreated: () => void;
}

export function WaiterOrderPage({ onPrintOrder, onOrderCreated }: WaiterOrderPageProps) {
  const [menus, setMenus] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('Semua');

  const [cart, setCart] = useState<Record<number, CartEntry>>({});
  const [cartSheetOpen, setCartSheetOpen] = useState(false);
  const [customerLabel, setCustomerLabel] = useState('');
  const [waiterName, setWaiterName] = useState(
    () => localStorage.getItem('nota_waiter_name') ?? ''
  );
  const [orderNotes, setOrderNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [lastOrder, setLastOrder] = useState<OrderDetail | null>(null);

  const loadMenus = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.listMenus(true);
      setMenus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat daftar menu');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadMenus();
  }, []);

  const categories = useMemo(() => {
    const set = new Set(menus.map((m) => m.category));
    return ['Semua', ...Array.from(set)];
  }, [menus]);

  const filteredMenus = useMemo(() => {
    const q = search.trim().toLowerCase();
    return menus.filter((m) => {
      if (selectedCategory !== 'Semua' && m.category !== selectedCategory) return false;
      if (q && !m.name.toLowerCase().includes(q) && !m.category.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [menus, search, selectedCategory]);

  const cartItems = useMemo(() => Object.values(cart), [cart]);
  const totalAmount = useMemo(
    () => cartItems.reduce((sum, item) => sum + item.menu.price * item.quantity, 0),
    [cartItems]
  );
  const totalQty = useMemo(
    () => cartItems.reduce((sum, item) => sum + item.quantity, 0),
    [cartItems]
  );

  const updateQuantity = (menu: MenuItem, delta: number) => {
    setCart((prev) => {
      const current = prev[menu.id];
      const nextQty = (current?.quantity ?? 0) + delta;
      if (nextQty <= 0) {
        const clone = { ...prev };
        delete clone[menu.id];
        return clone;
      }
      if (nextQty > menu.current_stock) {
        return prev;
      }
      return {
        ...prev,
        [menu.id]: {
          menu,
          quantity: nextQty,
          itemNote: current?.itemNote ?? '',
        },
      };
    });
  };

  const updateItemNote = (menuId: number, note: string) => {
    setCart((prev) => {
      const entry = prev[menuId];
      if (!entry) return prev;
      return {
        ...prev,
        [menuId]: { ...entry, itemNote: note },
      };
    });
  };

  const handleSubmitOrder = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (cartItems.length === 0) return;

    try {
      setSubmitting(true);
      setError(null);
      if (waiterName.trim()) {
        localStorage.setItem('nota_waiter_name', waiterName.trim());
      }
      const created = await api.createOrder({
        customer_label: customerLabel.trim() || undefined,
        waiter_name: waiterName.trim() || undefined,
        notes: orderNotes.trim() || undefined,
        items: cartItems.map((entry) => ({
          menu_item_id: entry.menu.id,
          quantity: entry.quantity,
          item_note: entry.itemNote.trim() || undefined,
        })),
      });

      setLastOrder(created);
      setCart({});
      setCustomerLabel('');
      setOrderNotes('');
      setCartSheetOpen(false);
      onOrderCreated();
      await loadMenus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal membuat nota');
      await loadMenus();
    } finally {
      setSubmitting(false);
    }
  };

  const renderCartFields = () => (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1">
        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-600">
            No. Meja / Nama Konsumen (Opsional)
          </label>
          <input
            type="text"
            value={customerLabel}
            onChange={(e) => setCustomerLabel(e.target.value)}
            placeholder="cth: Meja 4 / Pak Budi"
            className="h-11 w-full rounded-xl border border-slate-200 px-3.5 text-base sm:text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-600">
            Nama Pelayan (Opsional)
          </label>
          <input
            type="text"
            value={waiterName}
            onChange={(e) => setWaiterName(e.target.value)}
            placeholder="cth: Sari"
            className="h-11 w-full rounded-xl border border-slate-200 px-3.5 text-base sm:text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
          />
        </div>
      </div>

      <div className="space-y-2.5">
        {cartItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 py-8 text-center text-slate-400">
            <ShoppingBag className="mb-2 h-8 w-8" />
            <p className="text-sm font-medium">Belum ada menu dipilih</p>
            <p className="text-xs">Ketuk tombol + pada daftar menu</p>
          </div>
        ) : (
          cartItems.map(({ menu, quantity, itemNote }) => (
            <div
              key={menu.id}
              className="rounded-xl border border-slate-200/80 bg-slate-50 p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-slate-900">{menu.name}</p>
                  <p className="text-xs text-slate-500">
                    {formatRupiah(menu.price)} × {quantity} ={' '}
                    <span className="font-bold text-emerald-700">
                      {formatRupiah(menu.price * quantity)}
                    </span>
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => updateQuantity(menu, -1)}
                    className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 active:scale-95"
                    aria-label="Kurangi"
                  >
                    <Minus className="h-4 w-4" />
                  </button>
                  <span className="w-6 text-center text-sm font-bold text-slate-900">
                    {quantity}
                  </span>
                  <button
                    type="button"
                    disabled={quantity >= menu.current_stock}
                    onClick={() => updateQuantity(menu, 1)}
                    className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-600 text-white active:scale-95 disabled:bg-slate-300"
                    aria-label="Tambah"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => updateQuantity(menu, -quantity)}
                    className="ml-0.5 flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600"
                    aria-label="Hapus item"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <input
                type="text"
                value={itemNote}
                onChange={(e) => updateItemNote(menu.id, e.target.value)}
                placeholder="Catatan item (cth: sambal pisah, tanpa es)"
                className="mt-2.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm focus:border-emerald-500 focus:outline-none"
              />
            </div>
          ))
        )}
      </div>

      {cartItems.length > 0 && (
        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-600">
            Catatan Umum Nota (Opsional)
          </label>
          <input
            type="text"
            value={orderNotes}
            onChange={(e) => setOrderNotes(e.target.value)}
            placeholder="cth: Dibungkus / Makan di tempat"
            className="h-11 w-full rounded-xl border border-slate-200 px-3.5 text-base sm:text-sm focus:border-emerald-500 focus:outline-none"
          />
        </div>
      )}
    </div>
  );

  return (
    <div className={`space-y-3.5 ${totalQty > 0 ? 'pb-24 lg:pb-0' : ''}`}>
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-slate-900 sm:text-xl">
            Catat Pesanan
          </h1>
          <p className="text-xs text-slate-500 sm:text-sm">
            Ketuk menu untuk menambah ke nota. Stok otomatis terpotong.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadMenus()}
          className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 active:scale-95 hover:bg-slate-50 sm:text-sm"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          <span className="hidden sm:inline">Segarkan Stok</span>
        </button>
      </div>

      {/* Success Banner after saving order */}
      {lastOrder && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3.5 text-emerald-900 shadow-sm">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2.5">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
              <div>
                <p className="text-sm font-bold">
                  Nota {lastOrder.order_number} tersimpan!
                </p>
                <p className="text-xs text-emerald-800 sm:text-sm">
                  {lastOrder.customer_label ? `${lastOrder.customer_label} • ` : ''}
                  Total {formatRupiah(lastOrder.total_amount)} (Belum Bayar)
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setLastOrder(null)}
              className="rounded-lg p-1 text-emerald-700 hover:bg-emerald-100"
              aria-label="Tutup"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => onPrintOrder(lastOrder)}
              className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 text-sm font-bold text-white active:scale-98 hover:bg-emerald-700 sm:flex-none"
            >
              <Printer className="h-4 w-4" />
              Cetak Nota
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left: Search, Categories & Menu List */}
        <div className="space-y-3 lg:col-span-7 xl:col-span-8">
          {/* Sticky search & horizontal category chips on mobile */}
          <div className="sticky top-[57px] z-20 -mx-3 space-y-2.5 bg-slate-50/95 px-3 py-2 backdrop-blur md:static md:mx-0 md:bg-transparent md:p-0">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Cari menu makanan atau minuman..."
                className="h-11 w-full rounded-xl border border-slate-200 bg-white pl-10 pr-9 text-base sm:text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-slate-400 hover:bg-slate-100"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            <div className="no-scrollbar flex flex-nowrap gap-2 overflow-x-auto pb-0.5">
              {categories.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setSelectedCategory(cat)}
                  className={`h-9 shrink-0 rounded-full px-4 text-xs font-bold transition active:scale-95 ${
                    selectedCategory === cat
                      ? 'bg-slate-900 text-white shadow-sm'
                      : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
              Memuat daftar menu...
            </div>
          ) : filteredMenus.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
              Tidak ada menu aktif yang cocok. Tambahkan menu di tab Menu &amp; Stok.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {filteredMenus.map((menu) => {
                const qty = cart[menu.id]?.quantity ?? 0;
                const isOut = menu.current_stock <= 0;
                const isLow = menu.current_stock > 0 && menu.current_stock <= 5;
                return (
                  <div
                    key={menu.id}
                    className={`flex items-center justify-between gap-3 rounded-2xl border p-3.5 transition sm:flex-col sm:items-stretch sm:justify-between sm:p-4 ${
                      qty > 0
                        ? 'border-emerald-500 bg-emerald-50/50 shadow-sm'
                        : isOut
                          ? 'border-slate-200 bg-slate-100/70 opacity-60'
                          : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    {/* Menu Info */}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                          {menu.category}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                            isOut
                              ? 'bg-red-100 text-red-700'
                              : isLow
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-emerald-100 text-emerald-800'
                          }`}
                        >
                          {isOut ? 'Habis' : `Stok ${menu.current_stock}`}
                        </span>
                      </div>
                      <h3 className="mt-1 truncate text-base font-bold text-slate-900">
                        {menu.name}
                      </h3>
                      <p className="text-sm font-extrabold text-emerald-700">
                        {formatRupiah(menu.price)}
                      </p>
                    </div>

                    {/* Thumb-friendly Stepper / Add Button */}
                    <div className="shrink-0 sm:mt-3 sm:w-full">
                      {qty === 0 ? (
                        <button
                          type="button"
                          disabled={isOut}
                          onClick={() => updateQuantity(menu, 1)}
                          className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-slate-900 px-4 text-sm font-bold text-white transition active:scale-95 hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300 sm:w-full"
                        >
                          <Plus className="h-4 w-4" />
                          <span>Tambah</span>
                        </button>
                      ) : (
                        <div className="flex h-11 items-center justify-between gap-1 rounded-xl bg-white p-1 ring-2 ring-emerald-500 sm:w-full">
                          <button
                            type="button"
                            onClick={() => updateQuantity(menu, -1)}
                            className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-800 active:scale-95 hover:bg-slate-200"
                            aria-label="Kurangi jumlah"
                          >
                            <Minus className="h-4 w-4" />
                          </button>
                          <span className="min-w-[28px] text-center text-base font-extrabold text-slate-900">
                            {qty}
                          </span>
                          <button
                            type="button"
                            disabled={qty >= menu.current_stock}
                            onClick={() => updateQuantity(menu, 1)}
                            className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-600 text-white active:scale-95 hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                            aria-label="Tambah jumlah"
                          >
                            <Plus className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Desktop Right Sticky Cart Panel */}
        <div className="hidden lg:col-span-5 lg:block xl:col-span-4">
          <form
            onSubmit={handleSubmitOrder}
            className="sticky top-20 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <div className="mb-4 flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <ClipboardList className="h-5 w-5 text-emerald-600" />
                <h2 className="text-base font-bold text-slate-900">Ringkasan Nota</h2>
              </div>
              <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-800">
                {totalQty} porsi
              </span>
            </div>

            <div className="max-h-[55vh] overflow-y-auto pr-1">{renderCartFields()}</div>

            <div className="mt-4 border-t border-slate-200 pt-4">
              <div className="flex items-center justify-between text-base font-bold text-slate-900">
                <span>Total Nota</span>
                <span className="text-lg text-emerald-700">{formatRupiah(totalAmount)}</span>
              </div>
              <button
                type="submit"
                disabled={cartItems.length === 0 || submitting}
                className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {submitting ? 'Menyimpan Nota...' : 'Simpan Nota & Potong Stok'}
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Mobile Floating Sticky Cart Bar (above Android Bottom Nav) */}
      {totalQty > 0 && (
        <div className="fixed inset-x-3 bottom-[72px] z-30 md:bottom-4 lg:hidden">
          <button
            type="button"
            onClick={() => setCartSheetOpen(true)}
            className="flex h-14 w-full items-center justify-between rounded-2xl bg-emerald-600 px-4 text-white shadow-lg shadow-emerald-900/25 transition active:scale-[0.99] hover:bg-emerald-700"
          >
            <div className="flex items-center gap-3">
              <span className="flex h-8 min-w-[32px] items-center justify-center rounded-xl bg-white/20 px-2 text-sm font-extrabold">
                {totalQty}
              </span>
              <div className="text-left">
                <p className="text-[11px] font-medium text-emerald-100">
                  Ringkasan Nota
                </p>
                <p className="text-base font-extrabold leading-tight">
                  {formatRupiah(totalAmount)}
                </p>
              </div>
            </div>
            <span className="inline-flex items-center gap-1 rounded-xl bg-white/15 px-3 py-1.5 text-xs font-bold">
              Tinjau &amp; Simpan
              <ChevronRight className="h-4 w-4" />
            </span>
          </button>
        </div>
      )}

      {/* Mobile Checkout Bottom Sheet */}
      <BottomSheet
        open={cartSheetOpen}
        title="Ringkasan Nota"
        subtitle={`${totalQty} porsi dipilih • Total ${formatRupiah(totalAmount)}`}
        onClose={() => setCartSheetOpen(false)}
        footer={
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-600">Total Tagihan</span>
              <span className="text-xl font-extrabold text-emerald-700">
                {formatRupiah(totalAmount)}
              </span>
            </div>
            <button
              type="button"
              disabled={cartItems.length === 0 || submitting}
              onClick={() => void handleSubmitOrder()}
              className="flex h-12 w-full items-center justify-center rounded-xl bg-emerald-600 text-sm font-bold text-white shadow-sm active:scale-[0.99] hover:bg-emerald-700 disabled:bg-slate-300"
            >
              {submitting ? 'Menyimpan Nota...' : 'Simpan Nota & Potong Stok'}
            </button>
          </div>
        }
      >
        {renderCartFields()}
      </BottomSheet>
    </div>
  );
}
