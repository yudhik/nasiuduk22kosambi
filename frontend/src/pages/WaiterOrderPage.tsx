import { useEffect, useMemo, useState } from 'react';
import {
  ChevronRight,
  ClipboardList,
  Lock,
  Minus,
  Plus,
  RefreshCw,
  Search,
  ShoppingBag,
  Store,
  Trash2,
  UserCheck,
  X,
} from 'lucide-react';
import { api } from '../api/client';
import { BottomSheet } from '../components/BottomSheet';
import type { ToastMessage } from '../components/ToastContainer';
import type { AuthUser, MenuItem, SalesChannel, StoreStatusResponse } from '../types';
import { formatRupiah } from '../utils/format';

interface CartEntry {
  menu: MenuItem;
  quantity: number;
  itemNote: string;
}

interface WaiterOrderPageProps {
  currentUser: AuthUser;
  storeStatus: StoreStatusResponse | null;
  onRefreshStoreStatus: () => Promise<void>;
  onOrderCreated: () => void;
  onToast: (title: string, description?: string, tone?: ToastMessage['tone']) => void;
}

export function WaiterOrderPage({
  currentUser,
  storeStatus,
  onRefreshStoreStatus,
  onOrderCreated,
  onToast,
}: WaiterOrderPageProps) {
  const [menus, setMenus] = useState<MenuItem[]>([]);
  const [channels, setChannels] = useState<SalesChannel[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('Semua');

  const [cart, setCart] = useState<Record<number, CartEntry>>({});
  const [cartSheetOpen, setCartSheetOpen] = useState(false);
  const [customerLabel, setCustomerLabel] = useState('');
  const [orderNotes, setOrderNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const [menuData, channelData] = await Promise.all([
        api.listMenus(true),
        api.listChannels(true),
      ]);
      setMenus(menuData);
      setChannels(channelData);
      if (channelData.length > 0) {
        setSelectedChannelId((prev) => {
          if (prev && channelData.some((c) => c.id === prev)) return prev;
          const regular = channelData.find((c) => c.code.toLowerCase() === 'regular');
          return regular ? regular.id : channelData[0].id;
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat daftar menu');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [storeStatus?.status]);

  const selectedChannel = useMemo(
    () => channels.find((c) => c.id === selectedChannelId) ?? null,
    [channels, selectedChannelId]
  );

  // Compute remaining stock per stock_item_id after accounting for items already in the current cart
  const cartUsedByStockId = useMemo(() => {
    const used: Record<number, number> = {};
    for (const entry of Object.values(cart)) {
      for (const req of entry.menu.stock_requirements) {
        used[req.stock_item_id] = (used[req.stock_item_id] ?? 0) + req.qty_per_unit * entry.quantity;
      }
    }
    return used;
  }, [cart]);

  const remainingForMenu = (menu: MenuItem): number => {
    if (menu.stock_requirements.length === 0) return 0;
    let minMore = Infinity;
    for (const req of menu.stock_requirements) {
      const used = cartUsedByStockId[req.stock_item_id] ?? 0;
      const left = Math.max(0, req.stock_current - used);
      const possible = Math.floor(left / req.qty_per_unit);
      if (possible < minMore) minMore = possible;
    }
    return Number.isFinite(minMore) ? minMore : 0;
  };

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
    if (delta > 0 && remainingForMenu(menu) < delta) {
      return;
    }
    setCart((prev) => {
      const current = prev[menu.id];
      const nextQty = (current?.quantity ?? 0) + delta;
      if (nextQty <= 0) {
        const clone = { ...prev };
        delete clone[menu.id];
        return clone;
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
    if (cartItems.length === 0 || !selectedChannelId) return;

    try {
      setSubmitting(true);
      setError(null);
      const created = await api.createOrder({
        channel_id: selectedChannelId,
        customer_label: customerLabel.trim() || undefined,
        notes: orderNotes.trim() || undefined,
        items: cartItems.map((entry) => ({
          menu_item_id: entry.menu.id,
          quantity: entry.quantity,
          item_note: entry.itemNote.trim() || undefined,
        })),
      });

      setCart({});
      setCustomerLabel('');
      setOrderNotes('');
      setCartSheetOpen(false);
      onOrderCreated();

      // Non-blocking growl toast — waiter can keep creating new orders immediately without clicking X
      const statusText = created.status === 'PAID' ? 'Otomatis Lunas' : 'Belum Bayar';
      onToast(
        `Nota ${created.order_number} tersimpan`,
        `${created.channel_name} • ${formatRupiah(created.total_amount)} (${statusText})`,
        'success'
      );

      await loadData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gagal membuat nota';
      setError(msg);
      onToast('Gagal membuat nota', msg, 'error');
      await loadData();
      await onRefreshStoreStatus();
    } finally {
      setSubmitting(false);
    }
  };

  // Block order creation when store is NOT_OPENED or CLOSED
  if (storeStatus && storeStatus.status !== 'OPEN') {
    const isClosed = storeStatus.status === 'CLOSED';
    return (
      <div className="mx-auto max-w-lg rounded-3xl border border-brand-amber-soft bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-cream-deep text-brand-brown">
          {isClosed ? <Lock className="h-7 w-7 text-rose-600" /> : <Store className="h-7 w-7 text-brand-orange" />}
        </div>
        <h1 className="text-lg font-extrabold text-brand-brown">
          {isClosed ? 'Toko Sudah Ditutup Hari Ini' : 'Toko Belum Dibuka'}
        </h1>
        <p className="mt-2 text-sm text-brand-brown/70">
          {isClosed
            ? 'Operasional hari ini telah selesai dan stok sudah direset. Pemesanan baru dapat dilakukan saat toko dibuka kembali besok.'
            : 'Pemilik atau Administrator perlu mengisi stok awal harian dan menekan "Buka Toko" sebelum pelayan dapat mencatat nota.'}
        </p>
        <button
          type="button"
          onClick={() => void onRefreshStoreStatus()}
          className="mt-5 inline-flex h-11 items-center gap-2 rounded-xl bg-brand-orange px-5 text-sm font-bold text-white shadow-sm hover:bg-brand-orange-dark"
        >
          <RefreshCw className="h-4 w-4" />
          <span>Periksa Status Toko</span>
        </button>
      </div>
    );
  }

  const renderCartFields = () => (
    <div className="space-y-4">
      {/* Single Channel Selector (1 channel per nota) */}
      <div>
        <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-brand-brown/75">
          Channel Penjualan (Pilih 1)
        </label>
        <div className="grid grid-cols-2 gap-2">
          {channels.map((ch) => {
            const active = selectedChannelId === ch.id;
            return (
              <button
                key={ch.id}
                type="button"
                onClick={() => setSelectedChannelId(ch.id)}
                className={`flex flex-col items-start rounded-xl border px-3 py-2 text-left transition ${
                  active
                    ? 'border-brand-orange bg-brand-orange text-white shadow-sm'
                    : 'border-brand-amber-soft bg-white text-brand-brown hover:bg-brand-cream'
                }`}
              >
                <span className="text-xs font-extrabold">{ch.name}</span>
                <span
                  className={`text-[10px] ${
                    active ? 'text-white/90' : 'text-brand-brown/60'
                  }`}
                >
                  {ch.is_auto_paid ? 'Otomatis Lunas' : 'Bayar di Kasir'}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Read-only authenticated waiter username + optional customer label */}
      <div className="grid grid-cols-1 gap-3">
        <div className="flex items-center justify-between rounded-xl border border-brand-amber-soft bg-brand-cream px-3.5 py-2.5">
          <div className="flex items-center gap-2 text-xs text-brand-brown/70">
            <UserCheck className="h-4 w-4 text-brand-orange" />
            <span>Pelayan</span>
          </div>
          <span className="font-mono text-xs font-extrabold text-brand-brown">
            @{currentUser.username}
          </span>
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
            No. Meja / Nama Konsumen / ID Order (Opsional)
          </label>
          <input
            type="text"
            value={customerLabel}
            onChange={(e) => setCustomerLabel(e.target.value)}
            placeholder="cth: Meja 4 / Pak Budi / GF-102"
            className="h-11 w-full rounded-xl border border-brand-amber-soft px-3.5 text-base text-brand-brown focus:border-brand-orange focus:outline-none focus:ring-2 focus:ring-brand-orange/20 sm:text-sm"
          />
        </div>
      </div>

      {/* Cart Items */}
      <div className="space-y-2.5">
        {cartItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-brand-amber-soft py-8 text-center text-brand-brown/50">
            <ShoppingBag className="mb-2 h-8 w-8" />
            <p className="text-sm font-medium">Belum ada menu dipilih</p>
            <p className="text-xs">Ketuk tombol + pada daftar menu</p>
          </div>
        ) : (
          cartItems.map(({ menu, quantity, itemNote }) => {
            const canAddMore = remainingForMenu(menu) > 0;
            return (
              <div
                key={menu.id}
                className="rounded-xl border border-brand-amber-soft/80 bg-brand-cream/60 p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-brand-brown">{menu.name}</p>
                    <p className="text-xs text-brand-brown/70">
                      {formatRupiah(menu.price)} × {quantity} ={' '}
                      <span className="font-bold text-brand-orange">
                        {formatRupiah(menu.price * quantity)}
                      </span>
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => updateQuantity(menu, -1)}
                      className="flex h-9 w-9 items-center justify-center rounded-lg border border-brand-amber-soft bg-white text-brand-brown active:scale-95"
                      aria-label="Kurangi"
                    >
                      <Minus className="h-4 w-4" />
                    </button>
                    <span className="w-6 text-center text-sm font-bold text-brand-brown">
                      {quantity}
                    </span>
                    <button
                      type="button"
                      disabled={!canAddMore}
                      onClick={() => updateQuantity(menu, 1)}
                      className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-orange text-white active:scale-95 disabled:bg-stone-300"
                      aria-label="Tambah"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => updateQuantity(menu, -quantity)}
                      className="ml-0.5 flex h-9 w-9 items-center justify-center rounded-lg text-brand-brown/40 hover:bg-rose-50 hover:text-rose-600"
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
                  className="mt-2.5 h-10 w-full rounded-lg border border-brand-amber-soft bg-white px-3 text-sm text-brand-brown focus:border-brand-orange focus:outline-none"
                />
              </div>
            );
          })
        )}
      </div>

      {cartItems.length > 0 && (
        <div>
          <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
            Catatan Umum Nota (Opsional)
          </label>
          <input
            type="text"
            value={orderNotes}
            onChange={(e) => setOrderNotes(e.target.value)}
            placeholder="cth: Dibungkus / Makan di tempat"
            className="h-11 w-full rounded-xl border border-brand-amber-soft px-3.5 text-base text-brand-brown focus:border-brand-orange focus:outline-none sm:text-sm"
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
          <h1 className="text-lg font-extrabold text-brand-brown sm:text-xl">Catat Pesanan</h1>
          <p className="text-xs text-brand-brown/70 sm:text-sm">
            Pelayan <span className="font-mono font-bold">@{currentUser.username}</span> • Pilih channel &amp; menu.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadData()}
          className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-brand-amber-soft bg-white px-3 text-xs font-semibold text-brand-brown active:scale-95 hover:bg-brand-cream-deep sm:text-sm"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          <span className="hidden sm:inline">Segarkan Stok</span>
        </button>
      </div>

      {/* Quick Mobile Channel Bar */}
      <div className="no-scrollbar flex flex-nowrap items-center gap-2 overflow-x-auto pb-0.5 lg:hidden">
        {channels.map((ch) => {
          const active = selectedChannelId === ch.id;
          return (
            <button
              key={ch.id}
              type="button"
              onClick={() => setSelectedChannelId(ch.id)}
              className={`h-9 shrink-0 rounded-full px-3.5 text-xs font-bold transition ${
                active
                  ? 'bg-brand-orange text-white shadow-sm'
                  : 'bg-white text-brand-brown ring-1 ring-brand-amber-soft'
              }`}
            >
              {ch.name}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left: Search, Categories & Menu List */}
        <div className="space-y-3 lg:col-span-7 xl:col-span-8">
          <div className="sticky top-[57px] z-20 -mx-3 space-y-2.5 bg-brand-cream/95 px-3 py-2 backdrop-blur md:static md:mx-0 md:bg-transparent md:p-0">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-brown/40" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Cari menu makanan atau minuman..."
                className="h-11 w-full rounded-xl border border-brand-amber-soft bg-white pl-10 pr-9 text-base text-brand-brown focus:border-brand-orange focus:outline-none focus:ring-2 focus:ring-brand-orange/20 sm:text-sm"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-brand-brown/50 hover:bg-brand-cream"
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
                      ? 'bg-brand-brown text-brand-cream shadow-sm'
                      : 'bg-white text-brand-brown/80 ring-1 ring-brand-amber-soft hover:bg-brand-cream-deep'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="rounded-2xl border border-brand-amber-soft bg-white p-10 text-center text-sm text-brand-brown/60">
              Memuat daftar menu...
            </div>
          ) : filteredMenus.length === 0 ? (
            <div className="rounded-2xl border border-brand-amber-soft bg-white p-10 text-center text-sm text-brand-brown/60">
              Tidak ada menu aktif yang cocok.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {filteredMenus.map((menu) => {
                const qty = cart[menu.id]?.quantity ?? 0;
                const rem = remainingForMenu(menu);
                const isOut = menu.available_stock <= 0;
                const isLow = menu.available_stock > 0 && menu.available_stock <= 5;
                return (
                  <div
                    key={menu.id}
                    className={`flex items-center justify-between gap-3 rounded-2xl border p-3.5 transition sm:flex-col sm:items-stretch sm:justify-between sm:p-4 ${
                      qty > 0
                        ? 'border-brand-orange bg-brand-cream-deep/60 shadow-sm'
                        : isOut
                          ? 'border-stone-200 bg-stone-100/80 opacity-60'
                          : 'border-brand-amber-soft/80 bg-white hover:border-brand-amber'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="rounded-md bg-brand-cream-deep px-2 py-0.5 text-[11px] font-semibold text-brand-brown/80">
                          {menu.category}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                            isOut
                              ? 'bg-rose-100 text-rose-700'
                              : isLow
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-emerald-100 text-emerald-700'
                          }`}
                        >
                          {isOut ? 'Habis' : `Tersedia ${menu.available_stock}`}
                        </span>
                        {menu.stock_requirements.length > 1 && (
                          <span className="rounded-full bg-brand-brown/10 px-2 py-0.5 text-[10px] font-bold text-brand-brown">
                            Paket ({menu.stock_requirements.length} stok)
                          </span>
                        )}
                      </div>
                      <h3 className="mt-1.5 truncate text-sm font-bold text-brand-brown sm:text-base">
                        {menu.name}
                      </h3>
                      <p className="mt-0.5 text-sm font-extrabold text-brand-orange">
                        {formatRupiah(menu.price)}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center justify-end gap-1.5 sm:mt-3">
                      {qty > 0 ? (
                        <div className="flex items-center gap-2 rounded-xl border border-brand-orange/40 bg-white p-1">
                          <button
                            type="button"
                            onClick={() => updateQuantity(menu, -1)}
                            className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-cream text-brand-brown active:scale-95"
                            aria-label="Kurangi"
                          >
                            <Minus className="h-4 w-4" />
                          </button>
                          <span className="min-w-[24px] text-center text-sm font-extrabold text-brand-brown">
                            {qty}
                          </span>
                          <button
                            type="button"
                            disabled={rem <= 0}
                            onClick={() => updateQuantity(menu, 1)}
                            className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-orange text-white active:scale-95 disabled:bg-stone-300"
                            aria-label="Tambah"
                          >
                            <Plus className="h-4 w-4" />
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          disabled={isOut || rem <= 0}
                          onClick={() => updateQuantity(menu, 1)}
                          className="inline-flex h-10 items-center justify-center gap-1 rounded-xl bg-brand-orange px-3.5 text-xs font-bold text-white shadow-sm active:scale-95 hover:bg-brand-orange-dark disabled:bg-stone-300 sm:w-full sm:text-sm"
                        >
                          <Plus className="h-4 w-4" />
                          <span>Tambah</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Desktop Right Cart Panel */}
        <aside className="hidden lg:col-span-5 lg:block xl:col-span-4">
          <form
            onSubmit={handleSubmitOrder}
            className="sticky top-20 rounded-2xl border border-brand-amber-soft bg-white p-5 shadow-sm"
          >
            <div className="mb-4 flex items-center justify-between border-b border-brand-amber-soft/60 pb-3">
              <div className="flex items-center gap-2">
                <ClipboardList className="h-5 w-5 text-brand-orange" />
                <h2 className="text-base font-extrabold text-brand-brown">Ringkasan Nota</h2>
              </div>
              {totalQty > 0 && (
                <span className="rounded-full bg-brand-cream-deep px-2.5 py-0.5 text-xs font-bold text-brand-brown">
                  {totalQty} porsi
                </span>
              )}
            </div>

            {renderCartFields()}

            <div className="mt-5 border-t border-brand-amber-soft/60 pt-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-semibold text-brand-brown/75">
                  Total ({selectedChannel?.name ?? 'Regular'})
                </span>
                <span className="text-xl font-extrabold text-brand-brown">
                  {formatRupiah(totalAmount)}
                </span>
              </div>
              <button
                type="submit"
                disabled={submitting || cartItems.length === 0 || !selectedChannelId}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-orange text-sm font-bold text-white shadow-sm transition hover:bg-brand-orange-dark disabled:cursor-not-allowed disabled:bg-stone-300"
              >
                {submitting
                  ? 'Menyimpan...'
                  : selectedChannel?.is_auto_paid
                    ? `Simpan Nota (${selectedChannel.name} • Lunas)`
                    : 'Simpan Nota'}
              </button>
            </div>
          </form>
        </aside>
      </div>

      {/* Mobile Floating Cart Bar */}
      {totalQty > 0 && (
        <div className="fixed inset-x-3 bottom-[72px] z-30 md:bottom-4 lg:hidden">
          <button
            type="button"
            onClick={() => setCartSheetOpen(true)}
            className="flex h-14 w-full items-center justify-between rounded-2xl bg-brand-brown px-4 text-brand-cream shadow-xl active:scale-[0.99]"
          >
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-orange text-sm font-extrabold text-white">
                {totalQty}
              </span>
              <div className="text-left">
                <p className="text-[11px] font-medium text-brand-amber-soft">
                  {selectedChannel?.name ?? 'Regular'}
                </p>
                <p className="text-sm font-extrabold">{formatRupiah(totalAmount)}</p>
              </div>
            </div>
            <div className="flex items-center gap-1 text-sm font-bold text-brand-amber">
              <span>Lihat Nota</span>
              <ChevronRight className="h-4 w-4" />
            </div>
          </button>
        </div>
      )}

      {/* Mobile Cart BottomSheet */}
      <BottomSheet
        open={cartSheetOpen}
        title="Ringkasan Nota"
        subtitle={`${totalQty} porsi • ${selectedChannel?.name ?? 'Regular'}`}
        onClose={() => setCartSheetOpen(false)}
        footer={
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-brand-brown/75">Total</span>
              <span className="text-lg font-extrabold text-brand-brown">
                {formatRupiah(totalAmount)}
              </span>
            </div>
            <button
              type="button"
              disabled={submitting || cartItems.length === 0 || !selectedChannelId}
              onClick={() => void handleSubmitOrder()}
              className="flex h-12 w-full items-center justify-center rounded-xl bg-brand-orange text-sm font-bold text-white shadow-sm hover:bg-brand-orange-dark disabled:bg-stone-300"
            >
              {submitting
                ? 'Menyimpan...'
                : selectedChannel?.is_auto_paid
                  ? `Simpan (${selectedChannel.name} • Lunas)`
                  : 'Simpan Nota Sekarang'}
            </button>
          </div>
        }
      >
        {renderCartFields()}
      </BottomSheet>
    </div>
  );
}
