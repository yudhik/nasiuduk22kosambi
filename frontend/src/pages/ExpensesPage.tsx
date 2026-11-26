import { useCallback, useEffect, useMemo, useState } from 'react';
import { Lock, Plus, RefreshCw, Trash2, Wallet } from 'lucide-react';
import { api } from '../api/client';
import type { ToastMessage } from '../components/ToastContainer';
import type { DailyExpense, StoreStatusResponse } from '../types';
import { formatRupiah, formatTime, todayLocalDate } from '../utils/format';

interface ExpensesPageProps {
  storeStatus: StoreStatusResponse | null;
  onToast: (title: string, description?: string, tone?: ToastMessage['tone']) => void;
}

const EXPENSE_CATEGORIES = ['Bahan Baku', 'Gas / Listrik', 'Kemasan', 'Operasional', 'Lainnya'];

export function ExpensesPage({ storeStatus, onToast }: ExpensesPageProps) {
  const [date, setDate] = useState(todayLocalDate);
  const [expenses, setExpenses] = useState<DailyExpense[]>([]);
  const [dayStatus, setDayStatus] = useState<'NOT_OPENED' | 'OPEN' | 'CLOSED'>('NOT_OPENED');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Daily Expense Form
  const [expTitle, setExpTitle] = useState('');
  const [expCategory, setExpCategory] = useState('Bahan Baku');
  const [expAmount, setExpAmount] = useState('');
  const [expNotes, setExpNotes] = useState('');
  const [savingExp, setSavingExp] = useState(false);

  const loadExpenses = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [rows, report] = await Promise.all([
        api.listExpenses(date),
        api.getDailyReport(date),
      ]);
      setExpenses(rows);
      setDayStatus(report.store_status);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat data pengeluaran');
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    void loadExpenses();
  }, [loadExpenses, storeStatus?.status]);

  const isDayClosed = dayStatus === 'CLOSED';

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
    return Array.from(map.entries()).sort((a, b) => b[1].total - a[1].total);
  }, [expenses]);

  const handleAddExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = Number(expAmount);
    if (!expTitle.trim() || Number.isNaN(amt) || amt <= 0) {
      setError('Isi nama pengeluaran dan nominal lebih dari 0.');
      return;
    }
    try {
      setSavingExp(true);
      setError(null);
      await api.createExpense({
        business_date: date,
        title: expTitle.trim(),
        category: expCategory,
        amount: amt,
        notes: expNotes.trim() || undefined,
      });
      const savedTitle = expTitle.trim();
      setExpTitle('');
      setExpAmount('');
      setExpNotes('');
      onToast('Pengeluaran tercatat', `${savedTitle} • ${formatRupiah(amt)}`, 'success');
      await loadExpenses();
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
              Pengeluaran Harian
            </h1>
            <p className="text-xs text-brand-brown/65">
              Catat &amp; pantau biaya operasional per tanggal
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-10 rounded-xl border border-brand-amber-soft bg-white px-3 text-xs font-bold text-brand-brown focus:border-brand-orange focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void loadExpenses()}
            className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-brand-amber-soft bg-white px-3 text-xs font-bold text-brand-brown hover:bg-brand-cream-deep"
            title="Muat ulang"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
          {error}
        </div>
      )}

      {/* Summary KPI & Category Breakdown */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-rose-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold text-brand-brown/65">
            Total Pengeluaran ({date})
          </p>
          <p className="mt-1 text-xl font-extrabold text-rose-700">
            {formatRupiah(totalExpenses)}
          </p>
          <p className="mt-0.5 text-[11px] text-brand-brown/60">
            {expenses.length} catatan biaya
          </p>
        </div>

        <div className="rounded-2xl border border-brand-amber-soft bg-white p-4 shadow-sm sm:col-span-2">
          <p className="text-xs font-semibold text-brand-brown/65">Ringkasan per Kategori</p>
          {byCategory.length === 0 ? (
            <p className="mt-2 text-xs text-brand-brown/55">
              Belum ada pengeluaran tercatat pada tanggal ini.
            </p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              {byCategory.map(([category, stat]) => (
                <div
                  key={category}
                  className="rounded-xl border border-brand-amber-soft bg-brand-cream/60 px-3 py-1.5 text-xs"
                >
                  <span className="font-bold text-brand-brown">{category}</span>
                  <span className="ml-1.5 font-extrabold text-rose-700">
                    {formatRupiah(stat.total)}
                  </span>
                  <span className="ml-1 text-[10px] text-brand-brown/60">({stat.count})</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Daily Expenses Recording & List */}
      <div className="rounded-2xl border border-brand-amber-soft bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-brand-orange" />
            <h2 className="text-sm font-extrabold text-brand-brown">
              Catatan Pengeluaran ({formatRupiah(totalExpenses)})
            </h2>
          </div>
          {isDayClosed && (
            <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2.5 py-0.5 text-[11px] font-bold text-rose-700">
              <Lock className="h-3 w-3" />
              Terkunci (Toko Sudah Tutup)
            </span>
          )}
        </div>

        {!isDayClosed && (
          <form
            onSubmit={handleAddExpense}
            className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-12"
          >
            <input
              type="text"
              value={expTitle}
              onChange={(e) => setExpTitle(e.target.value)}
              placeholder="Keterangan (cth: Beli ayam 5kg / Gas 3kg)"
              className="h-10 rounded-xl border border-brand-amber-soft px-3 text-xs text-brand-brown focus:border-brand-orange focus:outline-none sm:col-span-4"
            />
            <select
              value={expCategory}
              onChange={(e) => setExpCategory(e.target.value)}
              className="h-10 rounded-xl border border-brand-amber-soft bg-white px-2.5 text-xs font-semibold text-brand-brown sm:col-span-2"
            >
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <input
              type="number"
              min={1}
              value={expAmount}
              onChange={(e) => setExpAmount(e.target.value)}
              placeholder="Nominal (Rp)"
              className="h-10 rounded-xl border border-brand-amber-soft px-3 text-xs font-bold text-brand-brown focus:border-brand-orange focus:outline-none sm:col-span-2"
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
              className="inline-flex h-10 items-center justify-center gap-1 rounded-xl bg-brand-orange px-3 text-xs font-bold text-white hover:bg-brand-orange-dark disabled:opacity-60 sm:col-span-2"
            >
              <Plus className="h-4 w-4" />
              <span>Catat</span>
            </button>
          </form>
        )}

        {loading ? (
          <div className="mt-4 py-8 text-center text-xs text-brand-brown/60">
            Memuat catatan pengeluaran...
          </div>
        ) : expenses.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-brand-amber-soft py-8 text-center text-xs text-brand-brown/60">
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
                    <p className="mt-0.5 text-[11px] text-brand-brown/65">{ex.notes}</p>
                  )}
                  <p className="mt-0.5 text-[10px] text-brand-brown/50">
                    {formatTime(ex.created_at)} • @{ex.created_by_username}
                  </p>
                </div>
                <div className="flex items-center gap-2.5">
                  <span className="font-extrabold text-rose-700">
                    -{formatRupiah(ex.amount)}
                  </span>
                  {!isDayClosed && (
                    <button
                      type="button"
                      onClick={() => void handleDeleteExpense(ex.id, ex.title)}
                      className="rounded-lg p-1 text-rose-600 hover:bg-rose-50"
                      aria-label="Hapus pengeluaran"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
