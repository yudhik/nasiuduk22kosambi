import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pencil, Plus, RefreshCw, Tags, Trash2, Wallet } from 'lucide-react';
import { api } from '../api/client';
import { BottomSheet } from '../components/BottomSheet';
import type { ToastMessage } from '../components/ToastContainer';
import type { DailyExpense, ExpenseCategory, StoreStatusResponse } from '../types';
import { formatRupiah, formatTime, todayLocalDate } from '../utils/format';

interface ExpensesPageProps {
  storeStatus: StoreStatusResponse | null;
  onToast: (title: string, description?: string, tone?: ToastMessage['tone']) => void;
}

const CATEGORY_BAR_COLORS = [
  'bg-brand-orange',
  'bg-rose-500',
  'bg-amber-500',
  'bg-brand-brown',
  'bg-emerald-600',
  'bg-sky-600',
];

export function ExpensesPage({ storeStatus, onToast }: ExpensesPageProps) {
  const [date, setDate] = useState(todayLocalDate);
  const [expenses, setExpenses] = useState<DailyExpense[]>([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Daily Expense Form (explicit date, independent of store open/close status)
  const [expDate, setExpDate] = useState(todayLocalDate);
  const [expTitle, setExpTitle] = useState('');
  const [expCategory, setExpCategory] = useState('');
  const [expAmount, setExpAmount] = useState('');
  const [expNotes, setExpNotes] = useState('');
  const [savingExp, setSavingExp] = useState(false);

  // Edit Expense sheet
  const [editing, setEditing] = useState<DailyExpense | null>(null);
  const [editDate, setEditDate] = useState(todayLocalDate);
  const [editTitle, setEditTitle] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editAmount, setEditAmount] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  // Manage Categories sheet
  const [catSheetOpen, setCatSheetOpen] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [renamingCatId, setRenamingCatId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [catError, setCatError] = useState<string | null>(null);

  const activeCategories = useMemo(
    () => categories.filter((c) => c.is_active === 1),
    [categories]
  );

  const loadExpenses = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [rows, cats] = await Promise.all([
        api.listExpenses(date),
        api.listExpenseCategories(false),
      ]);
      setExpenses(rows);
      setCategories(cats);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat data pengeluaran');
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    void loadExpenses();
  }, [loadExpenses, storeStatus?.status]);

  // Keep create-form date aligned when user switches the top date filter.
  useEffect(() => {
    setExpDate(date);
  }, [date]);

  // Keep the form's category valid when the category list changes.
  useEffect(() => {
    if (activeCategories.length === 0) return;
    if (!activeCategories.some((c) => c.name === expCategory)) {
      setExpCategory(activeCategories[0].name);
    }
  }, [activeCategories, expCategory]);

  const totalExpenses = useMemo(
    () => expenses.reduce((acc, item) => acc + item.amount, 0),
    [expenses]
  );

  const byCategory = useMemo(() => {
    const map = new Map<string, { count: number; total: number }>();
    for (const item of expenses) {
      const prev = map.get(item.category) ?? { count: 0, total: 0 };
      map.set(item.category, { count: prev.count + 1, total: prev.total + item.amount });
    }
    return Array.from(map.entries())
      .map(([category, stat]) => ({
        category,
        count: stat.count,
        total: stat.total,
        percent: totalExpenses > 0 ? (stat.total / totalExpenses) * 100 : 0,
      }))
      .sort((a, b) => b.total - a.total);
  }, [expenses, totalExpenses]);

  const handleAddExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = Number(expAmount);
    if (!expTitle.trim() || Number.isNaN(amt) || amt <= 0) {
      setError('Isi nama pengeluaran dan nominal lebih dari 0.');
      return;
    }
    const targetDate = expDate || date;
    try {
      setSavingExp(true);
      setError(null);
      await api.createExpense({
        business_date: targetDate,
        title: expTitle.trim(),
        category: expCategory,
        amount: amt,
        notes: expNotes.trim() || undefined,
      });
      const savedTitle = expTitle.trim();
      setExpTitle('');
      setExpAmount('');
      setExpNotes('');
      onToast(
        'Pengeluaran tercatat',
        `${savedTitle} • ${formatRupiah(amt)} (${targetDate})`,
        'success'
      );
      if (targetDate !== date) {
        setDate(targetDate);
      } else {
        await loadExpenses();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menambah pengeluaran');
    } finally {
      setSavingExp(false);
    }
  };

  const handleDeleteExpense = async (id: number, title: string) => {
    if (!window.confirm(`Hapus pengeluaran "${title}"?`)) return;
    try {
      setError(null);
      await api.deleteExpense(id);
      onToast(`Pengeluaran "${title}" dihapus`, undefined, 'info');
      await loadExpenses();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menghapus pengeluaran');
    }
  };

  const openEdit = (ex: DailyExpense) => {
    setEditing(ex);
    setEditDate(ex.business_date);
    setEditTitle(ex.title);
    setEditCategory(ex.category);
    setEditAmount(String(ex.amount));
    setEditNotes(ex.notes);
    setEditError(null);
  };

  const handleSaveEdit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!editing) return;
    const amt = Number(editAmount);
    if (!editTitle.trim() || Number.isNaN(amt) || amt <= 0) {
      setEditError('Isi keterangan dan nominal lebih dari 0.');
      return;
    }
    try {
      setSavingEdit(true);
      setEditError(null);
      await api.updateExpense(editing.id, {
        business_date: editDate || editing.business_date,
        title: editTitle.trim(),
        category: editCategory,
        amount: amt,
        notes: editNotes.trim() || undefined,
      });
      onToast('Pengeluaran diperbarui', `${editTitle.trim()} • ${formatRupiah(amt)}`, 'success');
      const nextDate = editDate || editing.business_date;
      setEditing(null);
      if (nextDate !== date) {
        setDate(nextDate);
      } else {
        await loadExpenses();
      }
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Gagal memperbarui pengeluaran');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleAddCategory = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const name = newCatName.trim();
    if (!name) {
      setCatError('Nama kategori tidak boleh kosong.');
      return;
    }
    try {
      setCatError(null);
      await api.createExpenseCategory(name);
      setNewCatName('');
      onToast(`Kategori "${name}" ditambahkan`, undefined, 'success');
      await loadExpenses();
    } catch (err) {
      setCatError(err instanceof Error ? err.message : 'Gagal menambah kategori');
    }
  };

  const saveCategory = async (cat: ExpenseCategory, name: string, isActive: boolean) => {
    try {
      setCatError(null);
      await api.updateExpenseCategory(cat.id, { name, is_active: isActive });
      setRenamingCatId(null);
      onToast(
        name !== cat.name
          ? `Kategori diubah menjadi "${name}"`
          : isActive
            ? `Kategori "${name}" diaktifkan`
            : `Kategori "${name}" dinonaktifkan`,
        undefined,
        'info'
      );
      await loadExpenses();
    } catch (err) {
      setCatError(err instanceof Error ? err.message : 'Gagal menyimpan kategori');
    }
  };

  return (
    <div className="space-y-4">
      {/* Header & Date Filter */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-orange/15 text-brand-orange">
            <Wallet className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-base font-extrabold text-brand-brown sm:text-lg">
              Pengeluaran Toko
            </h1>
            <p className="text-xs text-brand-brown/70">
              Catat &amp; pantau seluruh biaya terkait toko kapan saja (bebas status buka/tutup)
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setCatError(null);
              setRenamingCatId(null);
              setCatSheetOpen(true);
            }}
            className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-brand-amber-soft bg-white px-3 text-xs font-bold text-brand-brown hover:bg-brand-cream-deep"
          >
            <Tags className="h-4 w-4 text-brand-orange" />
            <span>Kelola Kategori</span>
          </button>
          <input
            type="date"
            aria-label="Filter tanggal pengeluaran"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-10 rounded-xl border border-brand-amber-soft bg-white px-3 text-xs font-bold tabular-nums text-brand-brown focus:border-brand-orange focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void loadExpenses()}
            className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-brand-amber-soft bg-white px-3 text-xs font-bold text-brand-brown hover:bg-brand-cream-deep"
            title="Muat ulang"
            aria-label="Muat ulang pengeluaran"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700"
        >
          {error}
        </div>
      )}

      {/* Summary KPI & Category Percentage Comparison Graph */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-rose-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold text-brand-brown/70">
            Total Pengeluaran ({date})
          </p>
          <p className="mt-1 text-xl font-extrabold tabular-nums text-rose-700">
            {formatRupiah(totalExpenses)}
          </p>
          <p className="mt-0.5 text-[11px] text-brand-brown/65">
            {expenses.length} catatan biaya • {byCategory.length} kategori
          </p>
        </div>

        <div className="rounded-2xl border border-brand-amber-soft bg-white p-4 shadow-sm sm:col-span-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-extrabold text-brand-brown">
              Perbandingan Persentase per Kategori
            </p>
            {byCategory.length > 0 && (
              <span className="text-[11px] font-semibold tabular-nums text-brand-brown/65">
                Total 100%
              </span>
            )}
          </div>

          {byCategory.length === 0 ? (
            <p className="mt-2 text-xs text-brand-brown/65">
              Belum ada pengeluaran tercatat pada tanggal ini.
            </p>
          ) : (
            <div className="mt-3 space-y-3 tabular-nums">
              {/* Stacked 100% Share Bar */}
              <div
                className="flex h-3 w-full overflow-hidden rounded-full bg-brand-cream-deep"
                aria-label="Komposisi persentase kategori pengeluaran"
              >
                {byCategory.map((item, idx) => (
                  <div
                    key={item.category}
                    title={`${item.category}: ${item.percent.toFixed(1)}% (${formatRupiah(item.total)})`}
                    className={`${CATEGORY_BAR_COLORS[idx % CATEGORY_BAR_COLORS.length]} h-full transition-all`}
                    style={{ width: `${item.percent}%` }}
                  />
                ))}
              </div>

              {/* Per-Category Percentage Bars */}
              <div className="space-y-2.5">
                {byCategory.map((item, idx) => {
                  const colorCls = CATEGORY_BAR_COLORS[idx % CATEGORY_BAR_COLORS.length];
                  return (
                    <div key={item.category} className="space-y-1">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="inline-flex min-w-0 items-center gap-2 font-bold text-brand-brown">
                          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${colorCls}`} />
                          <span className="truncate">{item.category}</span>
                          <span className="shrink-0 font-normal text-brand-brown/65">
                            ({item.count})
                          </span>
                        </span>
                        <span className="shrink-0 font-extrabold text-brand-brown">
                          <span className="text-rose-700">{formatRupiah(item.total)}</span>
                          <span className="ml-1.5 rounded-md bg-brand-cream-deep px-1.5 py-0.5 text-[11px] font-extrabold text-brand-brown">
                            {item.percent.toFixed(1)}%
                          </span>
                        </span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-brand-cream-deep">
                        <div
                          className={`${colorCls} h-full rounded-full transition-all`}
                          style={{ width: `${Math.max(2, item.percent)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Daily Expenses Recording & List (Always editable for Owner/Admin) */}
      <div className="rounded-2xl border border-brand-amber-soft bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-brand-orange" />
            <h2 className="text-sm font-extrabold text-brand-brown">
              Catatan Pengeluaran ({formatRupiah(totalExpenses)})
            </h2>
          </div>
        </div>

        <form
          onSubmit={handleAddExpense}
          className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-12"
        >
          <input
            type="date"
            aria-label="Tanggal pengeluaran"
            value={expDate}
            onChange={(e) => setExpDate(e.target.value)}
            className="h-10 rounded-xl border border-brand-amber-soft bg-white px-2.5 text-xs font-bold tabular-nums text-brand-brown focus:border-brand-orange focus:outline-none sm:col-span-2"
          />
          <input
            type="text"
            value={expTitle}
            onChange={(e) => setExpTitle(e.target.value)}
            placeholder="Keterangan (cth: Beli ayam 5kg / Gas 3kg)"
            className="h-10 rounded-xl border border-brand-amber-soft px-3 text-xs text-brand-brown focus:border-brand-orange focus:outline-none sm:col-span-3"
          />
          <select
            aria-label="Kategori pengeluaran"
            value={expCategory}
            onChange={(e) => setExpCategory(e.target.value)}
            className="h-10 rounded-xl border border-brand-amber-soft bg-white px-2.5 text-xs font-semibold text-brand-brown sm:col-span-2"
          >
            {activeCategories.map((c) => (
              <option key={c.id} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={1}
            value={expAmount}
            onChange={(e) => setExpAmount(e.target.value)}
            placeholder="Nominal (Rp)"
            className="h-10 rounded-xl border border-brand-amber-soft px-3 text-xs font-bold tabular-nums text-brand-brown focus:border-brand-orange focus:outline-none sm:col-span-2"
          />
          <input
            type="text"
            value={expNotes}
            onChange={(e) => setExpNotes(e.target.value)}
            placeholder="Catatan (opsional)"
            className="h-10 rounded-xl border border-brand-amber-soft px-3 text-xs text-brand-brown focus:border-brand-orange focus:outline-none sm:col-span-2"
          />
          <button
            type="submit"
            disabled={savingExp}
            className="inline-flex h-10 items-center justify-center gap-1 rounded-xl bg-brand-orange-dark px-3 text-xs font-bold text-white hover:bg-brand-brown disabled:opacity-60 sm:col-span-1"
          >
            <Plus className="h-4 w-4" />
            <span>Catat</span>
          </button>
        </form>

        {loading ? (
          <div className="mt-4 py-8 text-center text-xs text-brand-brown/65">
            Memuat catatan pengeluaran...
          </div>
        ) : expenses.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-brand-amber-soft py-8 text-center text-xs text-brand-brown/65">
            Belum ada pengeluaran yang dicatat untuk tanggal {date}.
          </div>
        ) : (
          <div className="mt-3 divide-y divide-brand-amber-soft/50 rounded-xl border border-brand-amber-soft/70">
            {expenses.map((ex) => (
              <div
                key={ex.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-xs"
              >
                <div>
                  <span className="font-bold text-brand-brown">{ex.title}</span>
                  <span className="ml-2 rounded-md bg-brand-cream-deep px-1.5 py-0.5 text-[10px] font-semibold text-brand-brown">
                    {ex.category}
                  </span>
                  {ex.notes && (
                    <p className="mt-0.5 text-[11px] text-brand-brown/70">{ex.notes}</p>
                  )}
                  <p className="mt-0.5 text-[10px] text-brand-brown/60">
                    {ex.business_date} • {formatTime(ex.created_at)} • @{ex.created_by_username}
                  </p>
                </div>
                <div className="flex items-center gap-2.5">
                  <span className="font-extrabold tabular-nums text-rose-700">
                    -{formatRupiah(ex.amount)}
                  </span>
                  <button
                    type="button"
                    onClick={() => openEdit(ex)}
                    className="rounded-lg p-1 text-brand-brown hover:bg-brand-cream-deep"
                    aria-label={`Ubah pengeluaran ${ex.title}`}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDeleteExpense(ex.id, ex.title)}
                    className="rounded-lg p-1 text-rose-600 hover:bg-rose-50"
                    aria-label="Hapus pengeluaran"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Edit Expense Sheet */}
      <BottomSheet
        open={editing !== null}
        title="Ubah Pengeluaran"
        subtitle={editing ? `dicatat @${editing.created_by_username}` : undefined}
        onClose={() => setEditing(null)}
        footer={
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="h-11 rounded-xl border border-brand-amber-soft bg-white text-sm font-semibold text-brand-brown"
            >
              Batal
            </button>
            <button
              type="button"
              disabled={savingEdit}
              onClick={() => void handleSaveEdit()}
              className="h-11 rounded-xl bg-brand-orange-dark text-sm font-bold text-white hover:bg-brand-brown disabled:opacity-60"
            >
              {savingEdit ? 'Menyimpan...' : 'Simpan Perubahan'}
            </button>
          </div>
        }
      >
        <form onSubmit={handleSaveEdit} className="space-y-3">
          {editError && (
            <div
              role="alert"
              className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700"
            >
              {editError}
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-semibold text-brand-brown/80">Tanggal</label>
            <input
              type="date"
              value={editDate}
              onChange={(e) => setEditDate(e.target.value)}
              className="h-11 w-full rounded-xl border border-brand-amber-soft bg-white px-3.5 text-sm font-bold tabular-nums text-brand-brown focus:border-brand-orange focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-brand-brown/80">Keterangan</label>
            <input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="h-11 w-full rounded-xl border border-brand-amber-soft px-3.5 text-sm text-brand-brown focus:border-brand-orange focus:outline-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-brand-brown/80">Kategori</label>
              <select
                value={editCategory}
                onChange={(e) => setEditCategory(e.target.value)}
                className="h-11 w-full rounded-xl border border-brand-amber-soft bg-white px-2.5 text-sm font-semibold text-brand-brown"
              >
                {!activeCategories.some((c) => c.name === editing?.category) && editing && (
                  <option value={editing.category}>{editing.category} (nonaktif)</option>
                )}
                {activeCategories.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-brand-brown/80">Nominal (Rp)</label>
              <input
                type="number"
                min={1}
                value={editAmount}
                onChange={(e) => setEditAmount(e.target.value)}
                className="h-11 w-full rounded-xl border border-brand-amber-soft px-3.5 text-sm font-bold tabular-nums text-brand-brown focus:border-brand-orange focus:outline-none"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-brand-brown/80">Catatan (opsional)</label>
            <input
              type="text"
              value={editNotes}
              onChange={(e) => setEditNotes(e.target.value)}
              className="h-11 w-full rounded-xl border border-brand-amber-soft px-3.5 text-sm text-brand-brown focus:border-brand-orange focus:outline-none"
            />
          </div>
        </form>
      </BottomSheet>

      {/* Manage Categories Sheet */}
      <BottomSheet
        open={catSheetOpen}
        title="Kelola Kategori Pengeluaran"
        subtitle="Ubah nama akan ikut memperbarui pengeluaran yang sudah tercatat. Kategori tidak dihapus, hanya dinonaktifkan."
        onClose={() => setCatSheetOpen(false)}
      >
        <div className="space-y-3">
          {catError && (
            <div
              role="alert"
              className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700"
            >
              {catError}
            </div>
          )}
          <form onSubmit={handleAddCategory} className="flex items-center gap-2">
            <input
              type="text"
              value={newCatName}
              onChange={(e) => setNewCatName(e.target.value)}
              placeholder="Kategori baru (cth: Transport)"
              className="h-11 flex-1 rounded-xl border border-brand-amber-soft px-3.5 text-sm text-brand-brown focus:border-brand-orange focus:outline-none"
            />
            <button
              type="submit"
              className="inline-flex h-11 items-center gap-1 rounded-xl bg-brand-orange-dark px-3.5 text-xs font-bold text-white hover:bg-brand-brown"
            >
              <Plus className="h-4 w-4" />
              <span>Tambah</span>
            </button>
          </form>

          <div className="divide-y divide-brand-amber-soft/50 rounded-xl border border-brand-amber-soft/70">
            {categories.map((cat) => (
              <div key={cat.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                {renamingCatId === cat.id ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveCategory(cat, renameValue.trim(), cat.is_active === 1);
                    }}
                    className="flex flex-1 items-center gap-2"
                  >
                    <input
                      autoFocus
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      aria-label={`Nama baru untuk kategori ${cat.name}`}
                      className="h-10 flex-1 rounded-lg border border-brand-amber bg-white px-3 text-sm text-brand-brown focus:border-brand-orange focus:outline-none"
                    />
                    <button
                      type="submit"
                      className="h-10 rounded-lg bg-brand-orange-dark px-3 text-xs font-bold text-white"
                    >
                      Simpan
                    </button>
                    <button
                      type="button"
                      onClick={() => setRenamingCatId(null)}
                      className="h-10 rounded-lg border border-brand-amber-soft px-3 text-xs font-bold text-brand-brown"
                    >
                      Batal
                    </button>
                  </form>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-sm font-bold ${
                          cat.is_active === 1 ? 'text-brand-brown' : 'text-brand-brown/55 line-through'
                        }`}
                      >
                        {cat.name}
                      </span>
                      {cat.is_active === 0 && (
                        <span className="rounded-full bg-stone-200 px-2 py-0.5 text-[10px] font-bold text-stone-600">
                          Nonaktif
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setRenamingCatId(cat.id);
                          setRenameValue(cat.name);
                          setCatError(null);
                        }}
                        className="inline-flex h-9 items-center gap-1 rounded-lg border border-brand-amber-soft px-2.5 text-xs font-bold text-brand-brown hover:bg-brand-cream-deep"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        <span>Ubah</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void saveCategory(cat, cat.name, cat.is_active !== 1)}
                        className={`inline-flex h-9 items-center rounded-lg border px-2.5 text-xs font-bold ${
                          cat.is_active === 1
                            ? 'border-rose-200 text-rose-700 hover:bg-rose-50'
                            : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'
                        }`}
                      >
                        {cat.is_active === 1 ? 'Nonaktifkan' : 'Aktifkan'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      </BottomSheet>
    </div>
  );
}
