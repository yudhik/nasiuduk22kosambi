import { useEffect, useMemo, useState } from 'react';
import {
  Edit2,
  PackagePlus,
  Plus,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../api/client';
import { BottomSheet } from '../components/BottomSheet';
import type { MenuItem } from '../types';
import { formatRupiah } from '../utils/format';

export function MenuStockPage() {
  const [menus, setMenus] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('Semua');

  // Add/Edit Menu modal state
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<MenuItem | null>(null);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('Makanan');
  const [price, setPrice] = useState('');
  const [defaultStock, setDefaultStock] = useState('30');
  const [isActive, setIsActive] = useState(true);

  // Stock action modal state
  const [stockModal, setStockModal] = useState<{
    mode: 'restock' | 'set-initial';
    menu: MenuItem;
  } | null>(null);
  const [stockValue, setStockValue] = useState('');
  const [stockNote, setStockNote] = useState('');

  const loadMenus = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.listMenus(false);
      setMenus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat menu');
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

  const openCreateForm = () => {
    setEditing(null);
    setName('');
    setCategory('Makanan');
    setPrice('');
    setDefaultStock('30');
    setIsActive(true);
    setShowForm(true);
  };

  const openEditForm = (menu: MenuItem) => {
    setEditing(menu);
    setName(menu.name);
    setCategory(menu.category);
    setPrice(String(menu.price));
    setDefaultStock(String(menu.default_daily_stock));
    setIsActive(menu.is_active === 1);
    setShowForm(true);
  };

  const handleSaveMenu = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const parsedPrice = Number(price);
    const parsedStock = Number(defaultStock);
    if (!name.trim() || Number.isNaN(parsedPrice) || parsedPrice < 0) {
      setError('Mohon isi nama menu dan harga yang valid.');
      return;
    }

    try {
      setError(null);
      if (editing) {
        await api.updateMenu(editing.id, {
          name: name.trim(),
          category: category.trim() || 'Makanan',
          price: parsedPrice,
          default_daily_stock: Math.max(0, parsedStock || 0),
          is_active: isActive,
        });
        setNotice(`Menu "${name.trim()}" berhasil diperbarui.`);
      } else {
        await api.createMenu({
          name: name.trim(),
          category: category.trim() || 'Makanan',
          price: parsedPrice,
          current_stock: Math.max(0, parsedStock || 0),
          default_daily_stock: Math.max(0, parsedStock || 0),
        });
        setNotice(`Menu baru "${name.trim()}" berhasil ditambahkan.`);
      }
      setShowForm(false);
      await loadMenus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menyimpan menu');
    }
  };

  const handleDeleteMenu = async (menu: MenuItem) => {
    if (
      !window.confirm(
        `Hapus menu "${menu.name}"? Jika sudah pernah masuk nota, menu akan dinonaktifkan agar riwayat laporan tetap aman.`
      )
    ) {
      return;
    }
    try {
      setError(null);
      const res = await api.deleteMenu(menu.id);
      setNotice(
        res.soft_deleted
          ? `Menu "${menu.name}" dinonaktifkan (sudah memiliki riwayat transaksi).`
          : `Menu "${menu.name}" dihapus permanen.`
      );
      await loadMenus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menghapus menu');
    }
  };

  const handleStartDay = async () => {
    if (
      !window.confirm(
        'Reset stok awal hari ini ke stok default untuk semua menu aktif yang belum terjual hari ini?'
      )
    ) {
      return;
    }
    try {
      setError(null);
      const res = await api.startDay();
      setNotice(
        `Hari baru (${res.business_date}) dimulai: ${res.initialized_count} menu di-reset ke stok default` +
          (res.skipped_with_sales > 0
            ? `, ${res.skipped_with_sales} menu dilewati karena sudah ada penjualan hari ini.`
            : '.')
      );
      await loadMenus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memulai hari baru');
    }
  };

  const handleStockAction = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!stockModal) return;
    const val = Number(stockValue);
    if (Number.isNaN(val)) return;

    try {
      setError(null);
      if (stockModal.mode === 'restock') {
        await api.restockMenu(stockModal.menu.id, val, stockNote.trim() || undefined);
        setNotice(`Berhasil menambah +${val} stok untuk "${stockModal.menu.name}".`);
      } else {
        await api.setInitialStock(stockModal.menu.id, val, stockNote.trim() || undefined);
        setNotice(`Stok awal harian "${stockModal.menu.name}" diatur ke ${val}.`);
      }
      setStockModal(null);
      setStockValue('');
      setStockNote('');
      await loadMenus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memperbarui stok');
    }
  };

  const stockBadgeClass = (stock: number) =>
    stock <= 0
      ? 'bg-red-100 text-red-700'
      : stock <= 5
        ? 'bg-amber-100 text-amber-800'
        : 'bg-emerald-100 text-emerald-800';

  return (
    <div className="space-y-4">
      {/* Header + Primary Actions */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-lg font-bold text-slate-900 sm:text-xl">
            Menu &amp; Stok Harian
          </h1>
          <p className="text-xs text-slate-500 sm:text-sm">
            Atur daftar makanan, reset stok pagi, dan tambah stok (restock) tengah hari.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <button
            type="button"
            onClick={() => void handleStartDay()}
            className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 text-xs font-bold text-emerald-800 active:scale-98 hover:bg-emerald-100 sm:text-sm"
          >
            <RotateCcw className="h-4 w-4 shrink-0" />
            <span>Mulai Hari Baru</span>
          </button>
          <button
            type="button"
            onClick={openCreateForm}
            className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl bg-slate-900 px-3.5 text-xs font-bold text-white active:scale-98 hover:bg-slate-800 sm:text-sm"
          >
            <Plus className="h-4 w-4 shrink-0" />
            <span>Tambah Menu</span>
          </button>
        </div>
      </div>

      {/* Search & Category Filter */}
      <div className="space-y-2.5 sm:flex sm:items-center sm:gap-3 sm:space-y-0">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari menu..."
            className="h-11 w-full rounded-xl border border-slate-200 bg-white pl-10 pr-3 text-base sm:text-sm focus:border-emerald-500 focus:outline-none"
          />
        </div>
        <div className="no-scrollbar flex flex-nowrap gap-2 overflow-x-auto pb-0.5">
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setSelectedCategory(cat)}
              className={`h-9 shrink-0 rounded-full px-3.5 text-xs font-bold transition ${
                selectedCategory === cat
                  ? 'bg-slate-900 text-white'
                  : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100'
              }`}
            >
              {cat}
            </button>
          ))}
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

      {/* Mobile Android Card List (zero horizontal scroll) */}
      <div className="space-y-2.5 md:hidden">
        {loading ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
            Memuat data menu...
          </div>
        ) : filteredMenus.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
            Tidak ada menu ditemukan.
          </div>
        ) : (
          filteredMenus.map((menu) => (
            <div
              key={menu.id}
              className={`rounded-2xl border border-slate-200 bg-white p-4 shadow-sm ${
                menu.is_active ? '' : 'opacity-65'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                      {menu.category}
                    </span>
                    <span
                      className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                        menu.is_active
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-slate-200 text-slate-600'
                      }`}
                    >
                      {menu.is_active ? 'Aktif' : 'Nonaktif'}
                    </span>
                  </div>
                  <h3 className="mt-1 truncate text-base font-bold text-slate-900">
                    {menu.name}
                  </h3>
                  <p className="text-sm font-bold text-emerald-700">
                    {formatRupiah(menu.price)}
                  </p>
                </div>

                <div className="shrink-0 text-right">
                  <span
                    className={`inline-block rounded-xl px-3 py-1 text-sm font-extrabold ${stockBadgeClass(
                      menu.current_stock
                    )}`}
                  >
                    Stok: {menu.current_stock}
                  </span>
                  <p className="mt-1 text-[11px] text-slate-500">
                    Default: {menu.default_daily_stock}/hari
                  </p>
                </div>
              </div>

              <div className="mt-3.5 flex items-center gap-2 border-t border-slate-100 pt-3">
                <button
                  type="button"
                  onClick={() => {
                    setStockModal({ mode: 'restock', menu });
                    setStockValue('10');
                    setStockNote('');
                  }}
                  className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 text-xs font-bold text-white active:scale-98"
                >
                  <PackagePlus className="h-4 w-4" />
                  Restock
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setStockModal({ mode: 'set-initial', menu });
                    setStockValue(String(menu.default_daily_stock));
                    setStockNote('');
                  }}
                  className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-slate-100 text-xs font-bold text-slate-700 active:scale-98"
                >
                  <SlidersHorizontal className="h-4 w-4" />
                  Set Awal
                </button>
                <button
                  type="button"
                  onClick={() => openEditForm(menu)}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 active:scale-95"
                  aria-label="Edit menu"
                >
                  <Edit2 className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => void handleDeleteMenu(menu)}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-red-100 bg-red-50 text-red-600 active:scale-95"
                  aria-label="Hapus menu"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Desktop Table View */}
      <div className="hidden overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm md:block">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Menu</th>
                <th className="px-4 py-3">Kategori</th>
                <th className="px-4 py-3 text-right">Harga</th>
                <th className="px-4 py-3 text-center">Stok Default</th>
                <th className="px-4 py-3 text-center">Sisa Stok</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3 text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    Memuat data menu...
                  </td>
                </tr>
              ) : filteredMenus.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    Tidak ada menu ditemukan.
                  </td>
                </tr>
              ) : (
                filteredMenus.map((menu) => (
                  <tr key={menu.id} className={menu.is_active ? '' : 'bg-slate-50 opacity-65'}>
                    <td className="px-4 py-3 font-semibold text-slate-900">{menu.name}</td>
                    <td className="px-4 py-3 text-slate-600">{menu.category}</td>
                    <td className="px-4 py-3 text-right font-medium text-slate-800">
                      {formatRupiah(menu.price)}
                    </td>
                    <td className="px-4 py-3 text-center text-slate-600">
                      {menu.default_daily_stock}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-bold ${stockBadgeClass(
                          menu.current_stock
                        )}`}
                      >
                        {menu.current_stock}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                          menu.is_active
                            ? 'bg-emerald-50 text-emerald-700'
                            : 'bg-slate-200 text-slate-600'
                        }`}
                      >
                        {menu.is_active ? 'Aktif' : 'Nonaktif'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setStockModal({ mode: 'restock', menu });
                            setStockValue('10');
                            setStockNote('');
                          }}
                          className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
                        >
                          <PackagePlus className="h-3.5 w-3.5" />
                          Restock
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setStockModal({ mode: 'set-initial', menu });
                            setStockValue(String(menu.default_daily_stock));
                            setStockNote('');
                          }}
                          className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-200"
                        >
                          <SlidersHorizontal className="h-3.5 w-3.5" />
                          Set Awal
                        </button>
                        <button
                          type="button"
                          onClick={() => openEditForm(menu)}
                          className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                          title="Edit menu"
                        >
                          <Edit2 className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteMenu(menu)}
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                          title="Hapus menu"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add / Edit Menu BottomSheet */}
      <BottomSheet
        open={showForm}
        title={editing ? `Edit Menu: ${editing.name}` : 'Tambah Menu Baru'}
        onClose={() => setShowForm(false)}
        footer={
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="h-11 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-700"
            >
              Batal
            </button>
            <button
              type="button"
              onClick={() => void handleSaveMenu()}
              className="h-11 rounded-xl bg-emerald-600 text-sm font-bold text-white hover:bg-emerald-700"
            >
              Simpan Menu
            </button>
          </div>
        }
      >
        <form onSubmit={handleSaveMenu} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">
              Nama Makanan / Minuman
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="cth: Ayam Goreng Lengkuas"
              className="h-11 w-full rounded-xl border border-slate-200 px-3.5 text-base sm:text-sm focus:border-emerald-500 focus:outline-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                Kategori
              </label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-base sm:text-sm focus:border-emerald-500 focus:outline-none"
              >
                <option value="Makanan">Makanan</option>
                <option value="Lauk">Lauk</option>
                <option value="Minuman">Minuman</option>
                <option value="Tambahan">Tambahan</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                Harga (Rp)
              </label>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                required
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="15000"
                className="h-11 w-full rounded-xl border border-slate-200 px-3.5 text-base sm:text-sm focus:border-emerald-500 focus:outline-none"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">
              {editing ? 'Stok Default Harian' : 'Stok Awal & Default Harian'}
            </label>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              required
              value={defaultStock}
              onChange={(e) => setDefaultStock(e.target.value)}
              className="h-11 w-full rounded-xl border border-slate-200 px-3.5 text-base sm:text-sm focus:border-emerald-500 focus:outline-none"
            />
          </div>
          {editing && (
            <label className="flex h-11 items-center gap-3 rounded-xl border border-slate-200 px-3.5 text-sm font-medium text-slate-700">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="h-5 w-5 rounded border-slate-300 text-emerald-600"
              />
              Menu aktif (tampil di layar pelayan)
            </label>
          )}
        </form>
      </BottomSheet>

      {/* Restock / Set Initial Stock BottomSheet */}
      <BottomSheet
        open={Boolean(stockModal)}
        title={
          stockModal?.mode === 'restock'
            ? `Restock: ${stockModal.menu.name}`
            : stockModal
              ? `Set Stok Awal: ${stockModal.menu.name}`
              : ''
        }
        subtitle={
          stockModal ? `Stok tersedia saat ini: ${stockModal.menu.current_stock} porsi` : undefined
        }
        onClose={() => setStockModal(null)}
        footer={
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => setStockModal(null)}
              className="h-11 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-700"
            >
              Batal
            </button>
            <button
              type="button"
              onClick={() => void handleStockAction()}
              className="h-11 rounded-xl bg-emerald-600 text-sm font-bold text-white hover:bg-emerald-700"
            >
              Simpan Stok
            </button>
          </div>
        }
      >
        {stockModal && (
          <form onSubmit={handleStockAction} className="space-y-4">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                {stockModal.mode === 'restock'
                  ? 'Jumlah Tambahan Porsi (+)'
                  : 'Total Stok Awal Pagi Hari'}
              </label>
              <input
                type="number"
                inputMode="numeric"
                min={stockModal.mode === 'restock' ? 1 : 0}
                required
                value={stockValue}
                onChange={(e) => setStockValue(e.target.value)}
                className="h-12 w-full rounded-xl border border-slate-200 px-4 text-lg font-bold focus:border-emerald-500 focus:outline-none"
                autoFocus
              />
              {stockModal.mode === 'restock' && (
                <div className="mt-2 flex gap-2">
                  {[5, 10, 20, 30].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setStockValue(String(preset))}
                      className="h-9 flex-1 rounded-lg bg-emerald-50 text-xs font-bold text-emerald-700 active:scale-95 hover:bg-emerald-100"
                    >
                      +{preset}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                Catatan (Opsional)
              </label>
              <input
                type="text"
                value={stockNote}
                onChange={(e) => setStockNote(e.target.value)}
                placeholder={
                  stockModal.mode === 'restock'
                    ? 'cth: Goreng batch 2'
                    : 'cth: Koreksi stok pagi'
                }
                className="h-11 w-full rounded-xl border border-slate-200 px-3.5 text-base sm:text-sm focus:border-emerald-500 focus:outline-none"
              />
            </div>
          </form>
        )}
      </BottomSheet>
    </div>
  );
}
