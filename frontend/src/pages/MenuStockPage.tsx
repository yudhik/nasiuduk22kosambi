import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  DoorClosed,
  DoorOpen,
  Download,
  Edit2,
  Layers,
  PackagePlus,
  Percent,
  Plus,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Store,
  Tag,
  Trash2,
  Upload,
} from 'lucide-react';
import { api } from '../api/client';
import { BottomSheet } from '../components/BottomSheet';
import { PromotionsSection } from '../components/PromotionsSection';
import type { ToastMessage } from '../components/ToastContainer';
import type {
  ImportMenuCsvResponse,
  MenuItem,
  MenuStockRequirementInput,
  SalesChannel,
  StockItem,
  StoreStatusResponse,
  UserRole,
} from '../types';
import {
  formatDateTime,
  formatRupiah,
  formatThousandsInput,
  parseThousandsInput,
} from '../utils/format';

interface MenuStockPageProps {
  currentUserRole: UserRole;
  storeStatus: StoreStatusResponse | null;
  onStoreChanged: () => void;
  onToast: (title: string, description?: string, tone?: ToastMessage['tone']) => void;
}

type SectionTab = 'menus' | 'stocks' | 'channels' | 'promos';

const SELF_STOCK_ID = -1;

interface MathChallenge {
  a: number;
  b: number;
  op: '+' | '-';
  answer: number;
}

function generateMathChallenge(): MathChallenge {
  const isAdd = Math.random() >= 0.5;
  if (isAdd) {
    const a = Math.floor(Math.random() * 25) + 10;
    const b = Math.floor(Math.random() * 19) + 5;
    return { a, b, op: '+', answer: a + b };
  }
  const a = Math.floor(Math.random() * 30) + 20;
  const b = Math.floor(Math.random() * 15) + 4;
  return { a, b, op: '-', answer: a - b };
}

export function MenuStockPage({
  currentUserRole,
  storeStatus,
  onStoreChanged,
  onToast,
}: MenuStockPageProps) {
  const [section, setSection] = useState<SectionTab>('menus');
  const [menus, setMenus] = useState<MenuItem[]>([]);
  const [stocks, setStocks] = useState<StockItem[]>([]);
  const [channels, setChannels] = useState<SalesChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('Semua');
  const [showInactiveMenus, setShowInactiveMenus] = useState(false);
  const [showInactiveStocks, setShowInactiveStocks] = useState(false);

  // Open Store modal
  const [openStoreModal, setOpenStoreModal] = useState(false);
  const [openDrafts, setOpenDrafts] = useState<Record<number, string>>({});
  const [submittingStore, setSubmittingStore] = useState(false);

  // Close Store modal (with +/- math guard + optional opname)
  const [closeStoreModal, setCloseStoreModal] = useState(false);
  const [closeOpnameDrafts, setCloseOpnameDrafts] = useState<Record<number, string>>({});
  const [closingNotes, setClosingNotes] = useState('');
  const [mathChallenge, setMathChallenge] = useState<MathChallenge>(generateMathChallenge);
  const [mathAnswerInput, setMathAnswerInput] = useState('');

  // Admin-only Reset & Rollback Day modal
  const [resetDayModal, setResetDayModal] = useState(false);
  const [resetMathChallenge, setResetMathChallenge] = useState<MathChallenge>(generateMathChallenge);
  const [resetMathInput, setResetMathInput] = useState('');
  const isAdmin = currentUserRole === 'admin';

  // Add/Edit Menu modal (with multi-stock picker)
  const [showMenuForm, setShowMenuForm] = useState(false);
  const [editingMenu, setEditingMenu] = useState<MenuItem | null>(null);
  const [menuName, setMenuName] = useState('');
  const [menuCategory, setMenuCategory] = useState('Makanan');
  const [menuPrice, setMenuPrice] = useState('');
  const [menuActive, setMenuActive] = useState(true);
  const [menuReqs, setMenuReqs] = useState<MenuStockRequirementInput[]>([]);

  // CSV Upload modal
  const [csvModalOpen, setCsvModalOpen] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [csvResult, setCsvResult] = useState<ImportMenuCsvResponse | null>(null);
  const [importingCsv, setImportingCsv] = useState(false);

  // Add/Edit Stock Item modal
  const [stockFormOpen, setStockFormOpen] = useState(false);
  const [editingStock, setEditingStock] = useState<StockItem | null>(null);
  const [stockName, setStockName] = useState('');
  const [stockUnit, setStockUnit] = useState('porsi');
  const [stockActive, setStockActive] = useState(true);

  // Restock / Adjust Initial Stock modal
  const [stockAdjustModal, setStockAdjustModal] = useState<{
    mode: 'restock' | 'set-initial';
    stock: StockItem;
  } | null>(null);
  const [stockAdjustVal, setStockAdjustVal] = useState('');
  const [stockAdjustNote, setStockAdjustNote] = useState('');

  // Add/Edit Channel modal
  const [channelFormOpen, setChannelFormOpen] = useState(false);
  const [editingChannel, setEditingChannel] = useState<SalesChannel | null>(null);
  const [channelName, setChannelName] = useState('');
  const [channelAutoPaid, setChannelAutoPaid] = useState(true);
  const [channelActive, setChannelActive] = useState(true);
  const [channelSortOrder, setChannelSortOrder] = useState('5');

  const isStoreOpen = storeStatus?.status === 'OPEN';
  const isStoreClosed = storeStatus?.status === 'CLOSED';

  const loadAll = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [mList, sList, cList] = await Promise.all([
        api.listMenus(false),
        api.listStocks(false),
        api.listChannels(false),
      ]);
      setMenus(mList);
      setStocks(sList);
      setChannels(cList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat data menu & stok');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const activeStocks = useMemo(() => stocks.filter((s) => s.is_active === 1), [stocks]);
  const inactiveStocksCount = useMemo(
    () => stocks.filter((s) => s.is_active === 0).length,
    [stocks]
  );
  const visibleStocks = useMemo(
    () => (showInactiveStocks ? stocks : activeStocks),
    [stocks, activeStocks, showInactiveStocks]
  );

  const activeMenusCount = useMemo(() => menus.filter((m) => m.is_active === 1).length, [menus]);
  const inactiveMenusCount = useMemo(
    () => menus.filter((m) => m.is_active === 0).length,
    [menus]
  );

  const categories = useMemo(() => {
    const source = showInactiveMenus ? menus : menus.filter((m) => m.is_active === 1);
    const set = new Set(source.map((m) => m.category));
    return ['Semua', ...Array.from(set)];
  }, [menus, showInactiveMenus]);

  const filteredMenus = useMemo(() => {
    const q = search.trim().toLowerCase();
    return menus.filter((m) => {
      if (!showInactiveMenus && m.is_active === 0) return false;
      if (selectedCategory !== 'Semua' && m.category !== selectedCategory) return false;
      if (q && !m.name.toLowerCase().includes(q) && !m.category.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [menus, search, selectedCategory, showInactiveMenus]);

  // === OPEN / CLOSE STORE ===
  const triggerOpenStoreSheet = () => {
    const drafts: Record<number, string> = {};
    for (const s of activeStocks) {
      drafts[s.id] = '0';
    }
    setOpenDrafts(drafts);
    setError(null);
    setOpenStoreModal(true);
  };

  const handleOpenStore = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    try {
      setSubmittingStore(true);
      setError(null);
      const payload = activeStocks.map((s) => ({
        stock_item_id: s.id,
        initial_stock: Math.max(0, Number(openDrafts[s.id] || 0) || 0),
      }));
      await api.openStore(payload);
      setOpenStoreModal(false);
      onStoreChanged();
      await loadAll();
      onToast('Toko berhasil dibuka!', 'Pelayan dan kasir kini dapat mulai bertransaksi.', 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal membuka toko');
    } finally {
      setSubmittingStore(false);
    }
  };

  const triggerCloseStoreSheet = () => {
    const drafts: Record<number, string> = {};
    for (const s of activeStocks) {
      drafts[s.id] = '';
    }
    setCloseOpnameDrafts(drafts);
    setClosingNotes('');
    setMathChallenge(generateMathChallenge());
    setMathAnswerInput('');
    setError(null);
    setCloseStoreModal(true);
  };

  const mathAnswerMatches = Number(mathAnswerInput.trim()) === mathChallenge.answer && mathAnswerInput.trim() !== '';

  const handleCloseStore = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!mathAnswerMatches) return;

    try {
      setSubmittingStore(true);
      setError(null);
      const physical_stocks = activeStocks
        .filter((s) => (closeOpnameDrafts[s.id] ?? '').trim() !== '')
        .map((s) => ({
          stock_item_id: s.id,
          physical_stock: Number(closeOpnameDrafts[s.id]),
        }));

      await api.closeStore({
        physical_stocks: physical_stocks.length > 0 ? physical_stocks : undefined,
        closing_notes: closingNotes.trim() || undefined,
      });
      setCloseStoreModal(false);
      onStoreChanged();
      await loadAll();
      onToast(
        'Toko berhasil ditutup',
        'Semua stok direset ke 0 dan rekap performa hari ini telah disimpan.',
        'info'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menutup toko');
    } finally {
      setSubmittingStore(false);
    }
  };

  const triggerResetDaySheet = () => {
    setResetMathChallenge(generateMathChallenge());
    setResetMathInput('');
    setError(null);
    setResetDayModal(true);
  };

  const resetMathMatches =
    Number(resetMathInput.trim()) === resetMathChallenge.answer && resetMathInput.trim() !== '';

  const handleResetStoreDay = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!resetMathMatches) return;

    try {
      setSubmittingStore(true);
      setError(null);
      const res = await api.resetStoreDay();
      setResetDayModal(false);
      onStoreChanged();
      await loadAll();
      onToast(
        'Data operasional hari ini direset',
        `Backup tersimpan di server: ${res.backup_filename} (${res.deleted_orders} nota di-rollback).`,
        'info'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal mereset data hari ini');
    } finally {
      setSubmittingStore(false);
    }
  };

  // === MENU CRUD & MULTI-STOCK ===
  const openCreateMenu = () => {
    setEditingMenu(null);
    setMenuName('');
    setMenuCategory('Makanan');
    setMenuPrice('');
    setMenuActive(true);
    setMenuReqs([{ stock_item_id: SELF_STOCK_ID, qty_per_unit: 1 }]);
    setError(null);
    setShowMenuForm(true);
  };

  const openEditMenu = (m: MenuItem) => {
    setEditingMenu(m);
    setMenuName(m.name);
    setMenuCategory(m.category);
    setMenuPrice(formatThousandsInput(String(m.price)));
    setMenuActive(m.is_active === 1);
    setMenuReqs(
      m.stock_requirements.map((r) => ({
        stock_item_id: r.stock_item_id,
        qty_per_unit: r.qty_per_unit,
      }))
    );
    setError(null);
    setShowMenuForm(true);
  };

  const addStockReqRow = () => {
    const usedIds = new Set(menuReqs.map((r) => r.stock_item_id));
    if (!editingMenu && !usedIds.has(SELF_STOCK_ID)) {
      setMenuReqs((prev) => [...prev, { stock_item_id: SELF_STOCK_ID, qty_per_unit: 1 }]);
      return;
    }
    const nextStock = activeStocks.find((s) => !usedIds.has(s.id));
    if (!nextStock) return;
    setMenuReqs((prev) => [...prev, { stock_item_id: nextStock.id, qty_per_unit: 1 }]);
  };

  const handleSaveMenu = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const parsedPrice = parseThousandsInput(menuPrice);
    if (!menuName.trim() || Number.isNaN(parsedPrice) || parsedPrice < 0) {
      setError('Isi nama menu dan harga yang valid.');
      return;
    }
    if (menuReqs.length === 0) {
      setError('Setiap menu wajib terhubung minimal 1 item stok.');
      return;
    }
    try {
      setError(null);
      if (editingMenu) {
        await api.updateMenu(editingMenu.id, {
          name: menuName.trim(),
          category: menuCategory.trim() || 'Makanan',
          price: parsedPrice,
          is_active: menuActive,
          stock_requirements: menuReqs.filter((r) => r.stock_item_id !== SELF_STOCK_ID),
        });
        onToast(`Menu "${menuName.trim()}" diperbarui`);
      } else {
        const selfReq = menuReqs.find((r) => r.stock_item_id === SELF_STOCK_ID);
        const existingReqs = menuReqs.filter((r) => r.stock_item_id !== SELF_STOCK_ID);
        await api.createMenu({
          name: menuName.trim(),
          category: menuCategory.trim() || 'Makanan',
          price: parsedPrice,
          stock_requirements: existingReqs,
          create_self_stock_qty: selfReq?.qty_per_unit,
        });
        onToast(
          `Menu "${menuName.trim()}" ditambahkan`,
          selfReq ? `Item stok "${menuName.trim()}" otomatis dibuat & dihubungkan.` : undefined
        );
      }
      setShowMenuForm(false);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menyimpan menu');
    }
  };

  const handleDeleteMenu = async (menu: MenuItem) => {
    if (!window.confirm(`Hapus menu "${menu.name}"?`)) return;
    try {
      setError(null);
      const res = await api.deleteMenu(menu.id);
      onToast(
        res.soft_deleted ? `Menu "${menu.name}" diarsipkan` : `Menu "${menu.name}" dihapus`,
        res.reason,
        'info'
      );
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menghapus menu');
    }
  };

  const handleReactivateMenu = async (menu: MenuItem) => {
    try {
      setError(null);
      await api.updateMenu(menu.id, {
        name: menu.name,
        category: menu.category,
        price: menu.price,
        is_active: true,
        stock_requirements: menu.stock_requirements.map((r) => ({
          stock_item_id: r.stock_item_id,
          qty_per_unit: r.qty_per_unit,
        })),
      });
      onToast(`Menu "${menu.name}" diaktifkan kembali`, undefined, 'success');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal mengaktifkan menu');
    }
  };

  // === CSV UPLOAD ===
  const handleCsvFileSelect = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setCsvText(String(reader.result ?? ''));
    };
    reader.readAsText(file);
  };

  const handleImportCsv = async () => {
    if (!csvText.trim()) {
      setError('Pilih file CSV atau tempel isi CSV terlebih dahulu.');
      return;
    }
    try {
      setImportingCsv(true);
      setError(null);
      const res = await api.importMenusCsv(csvText);
      setCsvResult(res);
      await loadAll();
      onToast(
        `Import CSV selesai: ${res.imported_count} ditambahkan`,
        res.skipped_count > 0 ? `${res.skipped_count} duplikat dilewati` : undefined,
        'success'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal mengimpor CSV');
    } finally {
      setImportingCsv(false);
    }
  };

  // === STOCK ITEMS CRUD ===
  const handleSaveStock = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!stockName.trim()) {
      setError('Nama item stok tidak boleh kosong.');
      return;
    }
    try {
      setError(null);
      if (editingStock) {
        await api.updateStock(editingStock.id, {
          name: stockName.trim(),
          unit: stockUnit.trim() || 'porsi',
          is_active: stockActive,
        });
        onToast(`Stok "${stockName.trim()}" diperbarui`);
      } else {
        await api.createStock(stockName.trim(), stockUnit.trim() || 'porsi');
        onToast(`Stok "${stockName.trim()}" ditambahkan`);
      }
      setStockFormOpen(false);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menyimpan item stok');
    }
  };

  const handleDeleteStock = async (stock: StockItem) => {
    if (!window.confirm(`Hapus item stok "${stock.name}"?`)) return;
    try {
      setError(null);
      const res = await api.deleteStock(stock.id);
      onToast(
        res.soft_deleted ? `Stok "${stock.name}" diarsipkan` : `Stok "${stock.name}" dihapus`,
        res.reason,
        'info'
      );
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menghapus item stok');
    }
  };

  const handleReactivateStock = async (stock: StockItem) => {
    try {
      setError(null);
      await api.updateStock(stock.id, {
        name: stock.name,
        unit: stock.unit,
        is_active: true,
      });
      onToast(`Stok "${stock.name}" diaktifkan kembali`, undefined, 'success');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal mengaktifkan item stok');
    }
  };

  const handleStockAdjust = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!stockAdjustModal) return;
    const val = Number(stockAdjustVal);
    if (Number.isNaN(val)) return;
    try {
      setError(null);
      if (stockAdjustModal.mode === 'restock') {
        await api.restockItem(stockAdjustModal.stock.id, val, stockAdjustNote.trim() || undefined);
        onToast(`Restock +${val} ${stockAdjustModal.stock.unit} untuk ${stockAdjustModal.stock.name}`);
      } else {
        await api.setInitialStockItem(
          stockAdjustModal.stock.id,
          val,
          stockAdjustNote.trim() || undefined
        );
        onToast(`Stok awal ${stockAdjustModal.stock.name} diubah ke ${val}`);
      }
      setStockAdjustModal(null);
      setStockAdjustVal('');
      setStockAdjustNote('');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memperbarui stok');
    }
  };

  // === CHANNELS CRUD ===
  const handleSaveChannel = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!channelName.trim()) {
      setError('Nama channel tidak boleh kosong.');
      return;
    }
    try {
      setError(null);
      const sort = Number(channelSortOrder) || 5;
      if (editingChannel) {
        await api.updateChannel(editingChannel.id, {
          name: channelName.trim(),
          is_auto_paid: channelAutoPaid,
          is_active: channelActive,
          sort_order: sort,
        });
        onToast(`Channel "${channelName.trim()}" diperbarui`);
      } else {
        await api.createChannel({
          name: channelName.trim(),
          is_auto_paid: channelAutoPaid,
          sort_order: sort,
        });
        onToast(`Channel "${channelName.trim()}" ditambahkan`);
      }
      setChannelFormOpen(false);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menyimpan channel');
    }
  };

  return (
    <div className="space-y-4">
      {/* Daily Store Open / Close Control Banner */}
      <div
        className={`rounded-2xl border p-4 shadow-sm ${
          isStoreOpen
            ? 'border-emerald-200 bg-emerald-50/70'
            : isStoreClosed
              ? 'border-rose-200 bg-rose-50/70'
              : 'border-brand-amber bg-brand-cream-deep/80'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
                isStoreOpen
                  ? 'bg-emerald-600 text-white'
                  : isStoreClosed
                    ? 'bg-rose-600 text-white'
                    : 'bg-brand-orange text-white'
              }`}
            >
              {isStoreOpen ? (
                <DoorOpen className="h-5 w-5" />
              ) : isStoreClosed ? (
                <DoorClosed className="h-5 w-5" />
              ) : (
                <Store className="h-5 w-5" />
              )}
            </div>
            <div>
              <h2 className="text-sm font-extrabold text-brand-brown sm:text-base">
                {isStoreOpen
                  ? `Toko BUKA (${storeStatus?.business_date})`
                  : isStoreClosed
                    ? `Toko SUDAH TUTUP (${storeStatus?.business_date})`
                    : `Toko BELUM DIBUKA (${storeStatus?.business_date ?? 'Hari Ini'})`}
              </h2>
              <p className="mt-0.5 text-xs text-brand-brown/75">
                {isStoreOpen && storeStatus?.opened_at
                  ? `Dibuka pukul ${formatDateTime(storeStatus.opened_at)} oleh @${storeStatus.opened_by_username} • ${
                      storeStatus.unpaid_order_count > 0
                        ? `${storeStatus.unpaid_order_count} nota belum bayar`
                        : 'Semua nota sudah lunas'
                    }`
                  : isStoreClosed && storeStatus?.closing_summary
                    ? `Ditutup oleh @${storeStatus.closed_by_username} • Omzet ${formatRupiah(
                        storeStatus.closing_summary.gross_revenue
                      )} • Laba Bersih ${formatRupiah(storeStatus.closing_summary.net_profit)}`
                    : 'Masukkan stok harian setiap item terlebih dahulu lalu buka toko agar pelayan & kasir bisa beroperasi.'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {!isStoreOpen && !isStoreClosed && (
              <button
                type="button"
                onClick={triggerOpenStoreSheet}
                className="inline-flex h-11 items-center gap-2 rounded-xl bg-brand-orange px-4 text-xs font-extrabold text-white shadow-sm hover:bg-brand-orange-dark sm:text-sm"
              >
                <DoorOpen className="h-4 w-4" />
                <span>Buka Toko &amp; Isi Stok</span>
              </button>
            )}
            {isStoreOpen && (
              <button
                type="button"
                onClick={triggerCloseStoreSheet}
                className="inline-flex h-11 items-center gap-2 rounded-xl bg-rose-600 px-4 text-xs font-extrabold text-white shadow-sm hover:bg-rose-700 sm:text-sm"
              >
                <DoorClosed className="h-4 w-4" />
                <span>Tutup Toko Hari Ini</span>
              </button>
            )}
            {isAdmin && (isStoreOpen || isStoreClosed) && (
              <button
                type="button"
                onClick={triggerResetDaySheet}
                className="inline-flex h-11 items-center gap-2 rounded-xl border border-rose-300 bg-white px-3.5 text-xs font-extrabold text-rose-700 shadow-sm transition hover:bg-rose-50 sm:text-sm"
              >
                <RotateCcw className="h-4 w-4" />
                <span>Reset Hari Ini</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
          {error}
        </div>
      )}

      {/* Sub-Section Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="inline-flex rounded-xl border border-brand-amber-soft bg-white p-1">
          <button
            type="button"
            onClick={() => setSection('menus')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition ${
              section === 'menus'
                ? 'bg-brand-orange text-white'
                : 'text-brand-brown/75 hover:bg-brand-cream'
            }`}
          >
            <Layers className="h-3.5 w-3.5" />
            <span>Menu ({activeMenusCount})</span>
          </button>
          <button
            type="button"
            onClick={() => setSection('stocks')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition ${
              section === 'stocks'
                ? 'bg-brand-orange text-white'
                : 'text-brand-brown/75 hover:bg-brand-cream'
            }`}
          >
            <Boxes className="h-3.5 w-3.5" />
            <span>Stok Harian ({activeStocks.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setSection('channels')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition ${
              section === 'channels'
                ? 'bg-brand-orange text-white'
                : 'text-brand-brown/75 hover:bg-brand-cream'
            }`}
          >
            <Tag className="h-3.5 w-3.5" />
            <span>Channel ({channels.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setSection('promos')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition ${
              section === 'promos'
                ? 'bg-brand-orange text-white'
                : 'text-brand-brown/75 hover:bg-brand-cream'
            }`}
          >
            <Percent className="h-3.5 w-3.5" />
            <span>Promo</span>
          </button>
        </div>

        {/* Contextual CTA */}
        <div className="flex flex-wrap items-center gap-2">
          {section === 'menus' && (
            <>
              <button
                type="button"
                onClick={() => {
                  setCsvText('');
                  setCsvResult(null);
                  setError(null);
                  setCsvModalOpen(true);
                }}
                className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-brand-amber-soft bg-white px-3 text-xs font-bold text-brand-brown hover:bg-brand-cream-deep"
              >
                <Upload className="h-4 w-4 text-brand-orange" />
                <span>Upload CSV</span>
              </button>
              <button
                type="button"
                onClick={openCreateMenu}
                className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-brand-orange px-3.5 text-xs font-bold text-white shadow-sm hover:bg-brand-orange-dark"
              >
                <Plus className="h-4 w-4" />
                <span>Tambah Menu</span>
              </button>
            </>
          )}
          {section === 'stocks' && (
            <button
              type="button"
              onClick={() => {
                setEditingStock(null);
                setStockName('');
                setStockUnit('porsi');
                setStockActive(true);
                setError(null);
                setStockFormOpen(true);
              }}
              className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-brand-orange px-3.5 text-xs font-bold text-white shadow-sm hover:bg-brand-orange-dark"
            >
              <Plus className="h-4 w-4" />
              <span>Tambah Item Stok</span>
            </button>
          )}
          {section === 'channels' && (
            <button
              type="button"
              onClick={() => {
                setEditingChannel(null);
                setChannelName('');
                setChannelAutoPaid(true);
                setChannelActive(true);
                setChannelSortOrder(String(channels.length + 1));
                setError(null);
                setChannelFormOpen(true);
              }}
              className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-brand-orange px-3.5 text-xs font-bold text-white shadow-sm hover:bg-brand-orange-dark"
            >
              <Plus className="h-4 w-4" />
              <span>Tambah Channel</span>
            </button>
          )}
        </div>
      </div>

      {/* SECTION 1: MENUS */}
      {section === 'menus' && (
        <div className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-brown/40" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Cari menu..."
                className="h-10 w-full rounded-xl border border-brand-amber-soft bg-white pl-10 pr-3 text-sm text-brand-brown focus:border-brand-orange focus:outline-none"
              />
            </div>
            <div className="no-scrollbar flex flex-nowrap items-center gap-1.5 overflow-x-auto">
              {categories.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setSelectedCategory(cat)}
                  className={`h-10 shrink-0 rounded-xl px-3.5 text-xs font-bold ${
                    selectedCategory === cat
                      ? 'bg-brand-brown text-brand-cream'
                      : 'bg-white text-brand-brown/80 ring-1 ring-brand-amber-soft'
                  }`}
                >
                  {cat}
                </button>
              ))}
              {inactiveMenusCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowInactiveMenus((v) => !v)}
                  className={`h-10 shrink-0 rounded-xl px-3 text-xs font-bold ${
                    showInactiveMenus
                      ? 'bg-stone-700 text-white'
                      : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                  }`}
                >
                  {showInactiveMenus
                    ? `Sembunyikan Arsip (${inactiveMenusCount})`
                    : `Arsip (${inactiveMenusCount})`}
                </button>
              )}
            </div>
          </div>

          {loading ? (
            <div className="rounded-2xl border border-brand-amber-soft bg-white p-8 text-center text-sm text-brand-brown/60">
              Memuat menu...
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {filteredMenus.map((menu) => (
                <div
                  key={menu.id}
                  className={`rounded-2xl border bg-white p-4 shadow-sm ${
                    menu.is_active === 0 ? 'border-stone-200 opacity-60' : 'border-brand-amber-soft'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="rounded-md bg-brand-cream-deep px-2 py-0.5 text-[11px] font-bold text-brand-brown">
                          {menu.category}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                            menu.available_stock > 0
                              ? 'bg-emerald-100 text-emerald-700'
                              : 'bg-rose-100 text-rose-700'
                          }`}
                        >
                          Tersedia: {menu.available_stock}
                        </span>
                        {menu.is_active === 0 && (
                          <span className="rounded-full bg-stone-200 px-2 py-0.5 text-[11px] font-bold text-stone-600">
                            Nonaktif
                          </span>
                        )}
                      </div>
                      <h3 className="mt-1.5 text-sm font-extrabold text-brand-brown">
                        {menu.name}
                      </h3>
                      <p className="text-sm font-extrabold text-brand-orange">
                        {formatRupiah(menu.price)}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => openEditMenu(menu)}
                        className="flex h-9 w-9 items-center justify-center rounded-xl border border-brand-amber-soft text-brand-brown hover:bg-brand-cream-deep"
                        aria-label="Edit menu"
                      >
                        <Edit2 className="h-4 w-4" />
                      </button>
                      {menu.is_active === 1 ? (
                        <button
                          type="button"
                          onClick={() => void handleDeleteMenu(menu)}
                          className="flex h-9 w-9 items-center justify-center rounded-xl border border-rose-200 text-rose-600 hover:bg-rose-50"
                          aria-label="Hapus menu"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void handleReactivateMenu(menu)}
                          className="inline-flex h-9 items-center gap-1 rounded-xl border border-emerald-200 bg-emerald-50 px-2.5 text-xs font-bold text-emerald-700 hover:bg-emerald-100"
                          aria-label="Aktifkan kembali menu"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          <span>Aktifkan</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Linked Stock Requirements */}
                  <div className="mt-3 flex flex-wrap gap-1.5 border-t border-brand-amber-soft/50 pt-2.5">
                    {menu.stock_requirements.map((req) => (
                      <span
                        key={req.stock_item_id}
                        className={`rounded-lg border px-2 py-0.5 text-[11px] font-semibold ${
                          req.stock_current < req.qty_per_unit
                            ? 'border-rose-200 bg-rose-50 text-rose-700'
                            : 'border-brand-amber-soft bg-brand-cream text-brand-brown'
                        }`}
                      >
                        {req.qty_per_unit}× {req.stock_name} (sisa {req.stock_current})
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* SECTION 2: STOCK ITEMS */}
      {section === 'stocks' && (
        <div className="space-y-3">
          {inactiveStocksCount > 0 && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setShowInactiveStocks((v) => !v)}
                className={`h-9 rounded-xl px-3 text-xs font-bold ${
                  showInactiveStocks
                    ? 'bg-stone-700 text-white'
                    : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                }`}
              >
                {showInactiveStocks
                  ? `Sembunyikan Stok Arsip (${inactiveStocksCount})`
                  : `Tampilkan Stok Arsip (${inactiveStocksCount})`}
              </button>
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {visibleStocks.map((stock) => (
              <div
                key={stock.id}
                className={`rounded-2xl border bg-white p-4 shadow-sm ${
                  stock.is_active === 0 ? 'border-stone-200 opacity-60' : 'border-brand-amber-soft'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-extrabold text-brand-brown">{stock.name}</h3>
                      <span className="rounded-md bg-brand-cream-deep px-2 py-0.5 text-[11px] font-semibold text-brand-brown/80">
                        {stock.unit}
                      </span>
                      {stock.is_active === 0 && (
                        <span className="rounded-full bg-stone-200 px-2 py-0.5 text-[10px] font-bold text-stone-600">
                          Arsip
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xl font-extrabold text-brand-orange">
                      {stock.current_stock}{' '}
                      <span className="text-xs font-semibold text-brand-brown/60">{stock.unit}</span>
                    </p>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingStock(stock);
                        setStockName(stock.name);
                        setStockUnit(stock.unit);
                        setStockActive(stock.is_active === 1);
                        setError(null);
                        setStockFormOpen(true);
                      }}
                      className="flex h-9 w-9 items-center justify-center rounded-xl border border-brand-amber-soft text-brand-brown hover:bg-brand-cream-deep"
                    >
                      <Edit2 className="h-4 w-4" />
                    </button>
                    {stock.is_active === 1 ? (
                      <button
                        type="button"
                        onClick={() => void handleDeleteStock(stock)}
                        className="flex h-9 w-9 items-center justify-center rounded-xl border border-rose-200 text-rose-600 hover:bg-rose-50"
                        aria-label="Hapus item stok"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleReactivateStock(stock)}
                        className="inline-flex h-9 items-center gap-1 rounded-xl border border-emerald-200 bg-emerald-50 px-2.5 text-xs font-bold text-emerald-700 hover:bg-emerald-100"
                        aria-label="Aktifkan kembali stok"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        <span>Aktifkan</span>
                      </button>
                    )}
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2 border-t border-brand-amber-soft/50 pt-3">
                  <button
                    type="button"
                    disabled={!isStoreOpen || stock.is_active === 0}
                    onClick={() => {
                      setStockAdjustModal({ mode: 'restock', stock });
                      setStockAdjustVal('');
                      setStockAdjustNote('');
                    }}
                    className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl bg-brand-orange px-3 text-xs font-bold text-white hover:bg-brand-orange-dark disabled:bg-stone-300"
                  >
                    <PackagePlus className="h-3.5 w-3.5" />
                    <span>Restock</span>
                  </button>
                  <button
                    type="button"
                    disabled={!isStoreOpen || stock.is_active === 0}
                    onClick={() => {
                      setStockAdjustModal({ mode: 'set-initial', stock });
                      setStockAdjustVal(String(stock.current_stock));
                      setStockAdjustNote('');
                    }}
                    className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl border border-brand-amber-soft bg-white px-3 text-xs font-bold text-brand-brown hover:bg-brand-cream-deep disabled:opacity-50"
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    <span>Koreksi Awal</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* SECTION 3: CHANNELS */}
      {section === 'channels' && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {channels.map((ch) => (
            <div
              key={ch.id}
              className={`flex items-center justify-between gap-3 rounded-2xl border bg-white p-4 shadow-sm ${
                ch.is_active === 0 ? 'border-stone-200 opacity-60' : 'border-brand-amber-soft'
              }`}
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-extrabold text-brand-brown">{ch.name}</span>
                  <span className="font-mono text-[11px] text-brand-brown/50">({ch.code})</span>
                </div>
                <p className="mt-1 text-xs text-brand-brown/70">
                  {ch.is_auto_paid ? 'Otomatis Lunas saat nota dibuat' : 'Masuk Belum Bayar (bayar di Kasir)'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setEditingChannel(ch);
                  setChannelName(ch.name);
                  setChannelAutoPaid(ch.is_auto_paid === 1);
                  setChannelActive(ch.is_active === 1);
                  setChannelSortOrder(String(ch.sort_order));
                  setError(null);
                  setChannelFormOpen(true);
                }}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-brand-amber-soft bg-white px-3 text-xs font-bold text-brand-brown hover:bg-brand-cream-deep"
              >
                <Edit2 className="h-3.5 w-3.5" />
                <span>Edit</span>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* SECTION 4: PROMOTIONS */}
      {section === 'promos' && <PromotionsSection onToast={onToast} />}

      {/* MODAL: OPEN STORE & ENTER INITIAL STOCK */}
      <BottomSheet
        open={openStoreModal}
        title="Buka Toko & Isi Stok Awal Harian"
        subtitle="Masukkan stok yang tersedia hari ini (isi 0 jika tidak dijual hari ini). Tidak ada akumulasi stok dari kemarin."
        onClose={() => setOpenStoreModal(false)}
        footer={
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => setOpenStoreModal(false)}
              className="h-11 rounded-xl border border-brand-amber-soft bg-white text-sm font-semibold text-brand-brown"
            >
              Batal
            </button>
            <button
              type="button"
              disabled={submittingStore || activeStocks.length === 0}
              onClick={() => void handleOpenStore()}
              className="h-11 rounded-xl bg-brand-orange text-sm font-bold text-white hover:bg-brand-orange-dark disabled:opacity-60"
            >
              {submittingStore ? 'Membuka Toko...' : 'Buka Toko Sekarang'}
            </button>
          </div>
        }
      >
        <form onSubmit={handleOpenStore} className="space-y-2.5">
          {activeStocks.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-brand-amber-soft/70 bg-brand-cream/50 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-brand-brown">{s.name}</p>
                <p className="text-[11px] text-brand-brown/60">Satuan: {s.unit}</p>
              </div>
              <input
                type="number"
                min={0}
                value={openDrafts[s.id] ?? '0'}
                onChange={(e) =>
                  setOpenDrafts((prev) => ({ ...prev, [s.id]: e.target.value }))
                }
                className="h-10 w-24 rounded-xl border border-brand-amber-soft bg-white px-3 text-right text-sm font-extrabold text-brand-brown focus:border-brand-orange focus:outline-none"
              />
            </div>
          ))}
        </form>
      </BottomSheet>

      {/* MODAL: ADMIN FORCE RESET & ROLLBACK TODAY */}
      <BottomSheet
        open={resetDayModal}
        title="Reset & Rollback Operasional Hari Ini"
        subtitle="Khusus Administrator. Server akan membuat file backup SQL terlebih dahulu sebelum menghapus data operasional hari ini."
        onClose={() => setResetDayModal(false)}
        footer={
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => setResetDayModal(false)}
              className="h-11 rounded-xl border border-brand-amber-soft bg-white text-sm font-semibold text-brand-brown"
            >
              Batal
            </button>
            <button
              type="button"
              disabled={submittingStore || !resetMathMatches}
              onClick={() => void handleResetStoreDay()}
              className="h-11 rounded-xl bg-rose-600 text-sm font-bold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-stone-300"
            >
              {submittingStore ? 'Memproses Backup & Reset...' : 'Backup & Reset Hari Ini'}
            </button>
          </div>
        }
      >
        <form onSubmit={handleResetStoreDay} className="space-y-4">
          <div className="space-y-2 rounded-xl border border-rose-200 bg-rose-50/70 p-3.5 text-xs text-rose-900">
            <div className="flex items-start gap-2 font-bold">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
              <span>Yang akan dilakukan untuk tanggal {storeStatus?.business_date}:</span>
            </div>
            <ul className="list-disc space-y-1 pl-6 text-rose-800">
              <li>
                Membuat file backup otomatis di server:{' '}
                <code className="rounded bg-white/80 px-1 py-0.5 font-mono text-[11px]">
                  force-backup-{'{timestamp}'}.sql
                </code>
              </li>
              <li>
                Menghapus seluruh nota, pergerakan stok, snapshot stok, dan status buka/tutup toko hari ini (kembali ke <strong>BELUM DIBUKA</strong>).
              </li>
              <li>
                Data <strong>Pengeluaran</strong> hari ini, menu, stok master, dan riwayat hari sebelumnya <strong>tetap aman</strong>.
              </li>
            </ul>
          </div>

          <div className="rounded-2xl border-2 border-rose-200 bg-rose-50/70 p-3.5">
            <p className="text-xs font-extrabold text-rose-900">
              Verifikasi Keamanan (Cegah Reset Tidak Sengaja)
            </p>
            <p className="mt-1 text-xs text-rose-800">
              Jawab hitungan berikut untuk mengaktifkan tombol Reset Hari Ini:
            </p>
            <div className="mt-2.5 flex items-center gap-3">
              <span className="rounded-xl bg-white px-4 py-2 font-mono text-base font-extrabold text-brand-brown shadow-sm">
                {resetMathChallenge.a} {resetMathChallenge.op} {resetMathChallenge.b} =
              </span>
              <input
                type="number"
                inputMode="numeric"
                value={resetMathInput}
                onChange={(e) => setResetMathInput(e.target.value)}
                placeholder="Jawaban"
                className="h-10 w-28 rounded-xl border border-rose-300 bg-white px-3 text-center text-base font-extrabold text-brand-brown focus:border-rose-500 focus:outline-none"
              />
            </div>
          </div>
        </form>
      </BottomSheet>

      {/* MODAL: CLOSE STORE (WITH +/- MATH GUARD & OPTIONAL OPNAME) */}
      <BottomSheet
        open={closeStoreModal}
        title="Tutup Toko Permanen Hari Ini"
        subtitle="Setelah ditutup, toko hari ini TIDAK dapat dibuka kembali dan semua stok otomatis direset ke 0."
        onClose={() => setCloseStoreModal(false)}
        footer={
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => setCloseStoreModal(false)}
              className="h-11 rounded-xl border border-brand-amber-soft bg-white text-sm font-semibold text-brand-brown"
            >
              Batal
            </button>
            <button
              type="button"
              disabled={
                submittingStore ||
                !mathAnswerMatches ||
                (storeStatus?.unpaid_order_count ?? 0) > 0
              }
              onClick={() => void handleCloseStore()}
              className="h-11 rounded-xl bg-rose-600 text-sm font-bold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-stone-300"
            >
              {submittingStore ? 'Menutup...' : 'Konfirmasi Tutup Toko'}
            </button>
          </div>
        }
      >
        <form onSubmit={handleCloseStore} className="space-y-4">
          {(storeStatus?.unpaid_order_count ?? 0) > 0 && (
            <div className="flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 p-3 text-xs font-semibold text-rose-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
              <span>
                Masih ada <strong>{storeStatus?.unpaid_order_count} nota BELUM BAYAR</strong>. Selesaikan atau batalkan di tab Kasir sebelum menutup toko.
              </span>
            </div>
          )}

          {/* Optional Stock Opname */}
          <div>
            <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-brand-brown/75">
              Stok Fisik Akhir Hari (Opsional)
            </p>
            <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
              {activeStocks.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between gap-2 rounded-xl border border-brand-amber-soft/70 bg-brand-cream/40 px-3 py-2 text-xs"
                >
                  <div>
                    <p className="font-bold text-brand-brown">{s.name}</p>
                    <p className="text-[11px] text-brand-brown/60">
                      Sisa sistem: {s.current_stock} {s.unit}
                    </p>
                  </div>
                  <input
                    type="number"
                    min={0}
                    placeholder="Kosongkan"
                    value={closeOpnameDrafts[s.id] ?? ''}
                    onChange={(e) =>
                      setCloseOpnameDrafts((prev) => ({ ...prev, [s.id]: e.target.value }))
                    }
                    className="h-9 w-24 rounded-lg border border-brand-amber-soft bg-white px-2.5 text-right text-xs font-bold text-brand-brown focus:border-brand-orange focus:outline-none"
                  />
                </div>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
              Catatan Penutupan (Opsional)
            </label>
            <input
              type="text"
              value={closingNotes}
              onChange={(e) => setClosingNotes(e.target.value)}
              placeholder="cth: Hari ramai, ayam habis jam 10 pagi"
              className="h-10 w-full rounded-xl border border-brand-amber-soft px-3 text-sm text-brand-brown focus:border-brand-orange focus:outline-none"
            />
          </div>

          {/* Accidental-Close Math Challenge Guard */}
          <div className="rounded-2xl border-2 border-rose-200 bg-rose-50/70 p-3.5">
            <p className="text-xs font-extrabold text-rose-900">
              Verifikasi Keamanan (Cegah Tutup Tidak Sengaja)
            </p>
            <p className="mt-1 text-xs text-rose-800">
              Jawab hitungan berikut untuk mengaktifkan tombol Tutup Toko:
            </p>
            <div className="mt-2.5 flex items-center gap-3">
              <span className="rounded-xl bg-white px-4 py-2 font-mono text-base font-extrabold text-brand-brown shadow-sm">
                {mathChallenge.a} {mathChallenge.op} {mathChallenge.b} =
              </span>
              <input
                type="number"
                value={mathAnswerInput}
                onChange={(e) => setMathAnswerInput(e.target.value)}
                placeholder="Jawaban"
                className="h-11 flex-1 rounded-xl border border-rose-300 bg-white px-3 text-base font-extrabold text-brand-brown focus:border-rose-500 focus:outline-none"
              />
            </div>
            {mathAnswerMatches && (
              <p className="mt-2 flex items-center gap-1 text-xs font-bold text-emerald-700">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Jawaban benar — tombol Tutup Toko aktif.
              </p>
            )}
          </div>
        </form>
      </BottomSheet>

      {/* MODAL: ADD / EDIT MENU WITH MULTI-STOCK */}
      <BottomSheet
        open={showMenuForm}
        title={editingMenu ? `Edit Menu: ${editingMenu.name}` : 'Tambah Menu Baru'}
        subtitle="Setiap menu wajib terhubung minimal 1 item stok (bisa lebih dari 1 untuk menu paket)."
        onClose={() => setShowMenuForm(false)}
        footer={
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => setShowMenuForm(false)}
              className="h-11 rounded-xl border border-brand-amber-soft bg-white text-sm font-semibold text-brand-brown"
            >
              Batal
            </button>
            <button
              type="button"
              onClick={() => void handleSaveMenu()}
              className="h-11 rounded-xl bg-brand-orange text-sm font-bold text-white hover:bg-brand-orange-dark"
            >
              Simpan Menu
            </button>
          </div>
        }
      >
        <form onSubmit={handleSaveMenu} className="space-y-3.5">
          <div>
            <label className="mb-1 block text-xs font-semibold text-brand-brown/80">Nama Menu</label>
            <input
              type="text"
              value={menuName}
              onChange={(e) => setMenuName(e.target.value)}
              placeholder="cth: Paket Nasi Uduk Ayam Goreng"
              className="h-11 w-full rounded-xl border border-brand-amber-soft px-3.5 text-sm text-brand-brown focus:border-brand-orange focus:outline-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-brand-brown/80">Kategori</label>
              <input
                type="text"
                value={menuCategory}
                onChange={(e) => setMenuCategory(e.target.value)}
                placeholder="Makanan / Paket / Lauk"
                className="h-11 w-full rounded-xl border border-brand-amber-soft px-3.5 text-sm text-brand-brown focus:border-brand-orange focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-brand-brown/80">Harga (Rp)</label>
              <input
                type="text"
                inputMode="numeric"
                value={menuPrice}
                onChange={(e) => setMenuPrice(formatThousandsInput(e.target.value))}
                placeholder="25.000"
                className="h-11 w-full rounded-xl border border-brand-amber-soft px-3.5 text-sm font-semibold tabular-nums text-brand-brown focus:border-brand-orange focus:outline-none"
              />
            </div>
          </div>

          {/* Multi-Stock Requirements Picker */}
          <div className="rounded-2xl border border-brand-amber-soft bg-brand-cream/60 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-bold text-brand-brown">
                Stok yang Dikurangi per 1 Porsi (Minimal 1)
              </span>
              <button
                type="button"
                disabled={
                  activeStocks.every((s) => menuReqs.some((r) => r.stock_item_id === s.id)) &&
                  (Boolean(editingMenu) || menuReqs.some((r) => r.stock_item_id === SELF_STOCK_ID))
                }
                onClick={addStockReqRow}
                className="inline-flex items-center gap-1 rounded-lg bg-brand-brown px-2.5 py-1 text-[11px] font-bold text-brand-cream disabled:opacity-40"
              >
                <Plus className="h-3 w-3" />
                <span>Tambah Stok</span>
              </button>
            </div>
            <div className="space-y-2">
              {menuReqs.map((req, idx) => {
                const selfUsedElsewhere = menuReqs.some(
                  (r, i) => i !== idx && r.stock_item_id === SELF_STOCK_ID
                );
                return (
                  <div key={idx} className="flex items-center gap-2">
                    <select
                      value={req.stock_item_id}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setMenuReqs((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, stock_item_id: val } : r))
                        );
                      }}
                      className="h-10 flex-1 rounded-xl border border-brand-amber-soft bg-white px-2.5 text-xs font-semibold text-brand-brown"
                    >
                      {!editingMenu && !selfUsedElsewhere && (
                        <option value={SELF_STOCK_ID}>
                          {menuName.trim()
                            ? `✦ Stok baru: "${menuName.trim()}" (kurangi diri sendiri)`
                            : '✦ Buat stok baru sesuai nama menu (kurangi diri sendiri)'}
                        </option>
                      )}
                      {activeStocks.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({s.unit})
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min={1}
                      value={req.qty_per_unit}
                      onChange={(e) => {
                        const val = Math.max(1, Number(e.target.value) || 1);
                        setMenuReqs((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, qty_per_unit: val } : r))
                        );
                      }}
                      className="h-10 w-16 rounded-xl border border-brand-amber-soft bg-white px-2 text-center text-xs font-bold text-brand-brown"
                    />
                    {menuReqs.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setMenuReqs((prev) => prev.filter((_, i) => i !== idx))}
                        className="flex h-9 w-9 items-center justify-center rounded-lg text-rose-600 hover:bg-rose-50"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {editingMenu && (
            <label className="flex items-center gap-2 rounded-xl border border-brand-amber-soft p-3 text-xs font-semibold text-brand-brown">
              <input
                type="checkbox"
                checked={menuActive}
                onChange={(e) => setMenuActive(e.target.checked)}
                className="h-4 w-4 accent-brand-orange"
              />
              <span>Menu aktif (tampil di halaman Pelayan)</span>
            </label>
          )}
        </form>
      </BottomSheet>

      {/* MODAL: CSV MENU UPLOAD */}
      <BottomSheet
        open={csvModalOpen}
        title="Upload Menu & Harga dari CSV"
        subtitle="Format kolom: name,category,price,stock_items (opsional, pisahkan multi-stok dengan | misal Nasi Uduk:1|Ayam:1). Menu yang sudah ada akan otomatis dilewati."
        onClose={() => setCsvModalOpen(false)}
        footer={
          <div className="grid grid-cols-2 gap-2.5">
            <a
              href={api.getMenuCsvTemplateUrl()}
              download="template-menu.csv"
              className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl border border-brand-amber-soft bg-white text-xs font-bold text-brand-brown hover:bg-brand-cream-deep"
            >
              <Download className="h-4 w-4 text-brand-orange" />
              <span>Template CSV</span>
            </a>
            <button
              type="button"
              disabled={importingCsv || !csvText.trim()}
              onClick={() => void handleImportCsv()}
              className="h-11 rounded-xl bg-brand-orange text-xs font-bold text-white hover:bg-brand-orange-dark disabled:opacity-50"
            >
              {importingCsv ? 'Mengimpor...' : 'Import Sekarang'}
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => handleCsvFileSelect(e.target.files?.[0])}
            className="block w-full rounded-xl border border-brand-amber-soft bg-brand-cream p-2.5 text-xs text-brand-brown file:mr-3 file:rounded-lg file:border-0 file:bg-brand-orange file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-white"
          />
          <textarea
            rows={6}
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            placeholder={`name,category,price,stock_items\nNasi Uduk Spesial,Makanan,12000,Nasi Uduk:1\nPaket Komplit,Paket,30000,Nasi Uduk:1|Ayam Goreng:1|Es Teh Manis:1`}
            className="w-full rounded-xl border border-brand-amber-soft p-3 font-mono text-xs text-brand-brown focus:border-brand-orange focus:outline-none"
          />
          {csvResult && (
            <div className="space-y-1 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
              <p className="font-bold">
                Berhasil impor: {csvResult.imported_count} menu • Dilewati (duplikat):{' '}
                {csvResult.skipped_count} • Item stok baru: {csvResult.created_stock_items}
              </p>
              {csvResult.skipped_names.length > 0 && (
                <p className="text-[11px]">
                  Dilewati: {csvResult.skipped_names.join(', ')}
                </p>
              )}
              {csvResult.errors.length > 0 && (
                <ul className="list-disc pl-4 text-[11px] text-rose-700">
                  {csvResult.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </BottomSheet>

      {/* MODAL: ADD / EDIT STOCK ITEM */}
      <BottomSheet
        open={stockFormOpen}
        title={editingStock ? `Edit Stok: ${editingStock.name}` : 'Tambah Item Stok'}
        subtitle="Stok harian direset setiap hari dan diisi saat Buka Toko."
        onClose={() => setStockFormOpen(false)}
        footer={
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => setStockFormOpen(false)}
              className="h-11 rounded-xl border border-brand-amber-soft bg-white text-sm font-semibold text-brand-brown"
            >
              Batal
            </button>
            <button
              type="button"
              onClick={() => void handleSaveStock()}
              className="h-11 rounded-xl bg-brand-orange text-sm font-bold text-white hover:bg-brand-orange-dark"
            >
              Simpan
            </button>
          </div>
        }
      >
        <form onSubmit={handleSaveStock} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
              Nama Item Stok
            </label>
            <input
              type="text"
              value={stockName}
              onChange={(e) => setStockName(e.target.value)}
              placeholder="cth: Ayam Goreng / Nasi Uduk / Telur"
              className="h-11 w-full rounded-xl border border-brand-amber-soft px-3.5 text-sm text-brand-brown focus:border-brand-orange focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-brand-brown/80">Satuan</label>
            <input
              type="text"
              value={stockUnit}
              onChange={(e) => setStockUnit(e.target.value)}
              placeholder="porsi / potong / butir / gelas"
              className="h-11 w-full rounded-xl border border-brand-amber-soft px-3.5 text-sm text-brand-brown focus:border-brand-orange focus:outline-none"
            />
          </div>
          {editingStock && (
            <label className="flex items-center gap-2 rounded-xl border border-brand-amber-soft p-3 text-xs font-semibold text-brand-brown">
              <input
                type="checkbox"
                checked={stockActive}
                onChange={(e) => setStockActive(e.target.checked)}
                className="h-4 w-4 accent-brand-orange"
              />
              <span>Aktif</span>
            </label>
          )}
        </form>
      </BottomSheet>

      {/* MODAL: RESTOCK / SET INITIAL STOCK */}
      <BottomSheet
        open={Boolean(stockAdjustModal)}
        title={
          stockAdjustModal?.mode === 'restock'
            ? `Restock: ${stockAdjustModal.stock.name}`
            : `Koreksi Stok Awal: ${stockAdjustModal?.stock.name ?? ''}`
        }
        onClose={() => setStockAdjustModal(null)}
        footer={
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => setStockAdjustModal(null)}
              className="h-11 rounded-xl border border-brand-amber-soft bg-white text-sm font-semibold text-brand-brown"
            >
              Batal
            </button>
            <button
              type="button"
              onClick={() => void handleStockAdjust()}
              className="h-11 rounded-xl bg-brand-orange text-sm font-bold text-white hover:bg-brand-orange-dark"
            >
              Simpan
            </button>
          </div>
        }
      >
        <form onSubmit={handleStockAdjust} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
              {stockAdjustModal?.mode === 'restock'
                ? `Jumlah Tambahan (${stockAdjustModal.stock.unit})`
                : `Stok Awal Hari Ini (${stockAdjustModal?.stock.unit ?? ''})`}
            </label>
            <input
              type="number"
              min={stockAdjustModal?.mode === 'restock' ? 1 : 0}
              value={stockAdjustVal}
              onChange={(e) => setStockAdjustVal(e.target.value)}
              className="h-11 w-full rounded-xl border border-brand-amber-soft px-3.5 text-sm font-bold text-brand-brown focus:border-brand-orange focus:outline-none"
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
              Catatan (Opsional)
            </label>
            <input
              type="text"
              value={stockAdjustNote}
              onChange={(e) => setStockAdjustNote(e.target.value)}
              placeholder="cth: Masak batch 2"
              className="h-11 w-full rounded-xl border border-brand-amber-soft px-3.5 text-sm text-brand-brown focus:border-brand-orange focus:outline-none"
            />
          </div>
        </form>
      </BottomSheet>

      {/* MODAL: ADD / EDIT CHANNEL */}
      <BottomSheet
        open={channelFormOpen}
        title={editingChannel ? `Edit Channel: ${editingChannel.name}` : 'Tambah Channel Penjualan'}
        subtitle="Channel selain Regular otomatis berstatus LUNAS saat nota dibuat."
        onClose={() => setChannelFormOpen(false)}
        footer={
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => setChannelFormOpen(false)}
              className="h-11 rounded-xl border border-brand-amber-soft bg-white text-sm font-semibold text-brand-brown"
            >
              Batal
            </button>
            <button
              type="button"
              onClick={() => void handleSaveChannel()}
              className="h-11 rounded-xl bg-brand-orange text-sm font-bold text-white hover:bg-brand-orange-dark"
            >
              Simpan Channel
            </button>
          </div>
        }
      >
        <form onSubmit={handleSaveChannel} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
              Nama Channel
            </label>
            <input
              type="text"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
              placeholder="cth: TikTok Shop / WhatsApp Delivery"
              className="h-11 w-full rounded-xl border border-brand-amber-soft px-3.5 text-sm text-brand-brown focus:border-brand-orange focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
              Urutan Tampil
            </label>
            <input
              type="number"
              value={channelSortOrder}
              onChange={(e) => setChannelSortOrder(e.target.value)}
              className="h-11 w-full rounded-xl border border-brand-amber-soft px-3.5 text-sm text-brand-brown focus:border-brand-orange focus:outline-none"
            />
          </div>
          <label className="flex items-center gap-2 rounded-xl border border-brand-amber-soft p-3 text-xs font-semibold text-brand-brown">
            <input
              type="checkbox"
              checked={channelAutoPaid}
              disabled={editingChannel?.code.toLowerCase() === 'regular'}
              onChange={(e) => setChannelAutoPaid(e.target.checked)}
              className="h-4 w-4 accent-brand-orange"
            />
            <span>Otomatis LUNAS saat nota dibuat</span>
          </label>
          {editingChannel && (
            <label className="flex items-center gap-2 rounded-xl border border-brand-amber-soft p-3 text-xs font-semibold text-brand-brown">
              <input
                type="checkbox"
                checked={channelActive}
                disabled={editingChannel.code.toLowerCase() === 'regular'}
                onChange={(e) => setChannelActive(e.target.checked)}
                className="h-4 w-4 accent-brand-orange"
              />
              <span>Channel aktif</span>
            </label>
          )}
        </form>
      </BottomSheet>
    </div>
  );
}
