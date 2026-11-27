import { useCallback, useEffect, useState } from 'react';
import { Edit2, Percent, Plus, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { BottomSheet } from './BottomSheet';
import type { ToastMessage } from './ToastContainer';
import type {
  PromoDiscountType,
  Promotion,
  PromotionSchedule,
  PromotionScheduleInput,
} from '../types';
import {
  formatRupiah,
  formatThousandsInput,
  parseThousandsInput,
} from '../utils/format';

const DAY_LABELS = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'] as const;

interface ScheduleRule {
  days: number[];
  start_time: string;
  end_time: string;
}

function groupSchedulesToRules(schedules: PromotionSchedule[]): ScheduleRule[] {
  const map = new Map<string, ScheduleRule>();
  for (const s of schedules) {
    const key = `${s.start_time}-${s.end_time}`;
    const existing = map.get(key);
    if (existing) {
      if (!existing.days.includes(s.day_of_week)) {
        existing.days.push(s.day_of_week);
        existing.days.sort((a, b) => a - b);
      }
    } else {
      map.set(key, { days: [s.day_of_week], start_time: s.start_time, end_time: s.end_time });
    }
  }
  return Array.from(map.values());
}

function formatDayGroup(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 7) return 'Setiap Hari';
  if (sorted.join(',') === '0,1,2,3,4') return 'Sen–Jum';
  if (sorted.join(',') === '5,6') return 'Sab–Min';
  return sorted.map((d) => DAY_LABELS[d] ?? String(d)).join(', ');
}

function summarizeSchedules(schedules: PromotionSchedule[]): string {
  if (!schedules || schedules.length === 0) return '';
  return groupSchedulesToRules(schedules)
    .map((r) => `${formatDayGroup(r.days)} ${r.start_time}–${r.end_time}`)
    .join('; ');
}

function formatCompactDateTime(isoLocal: string): string {
  const [datePart, timePart] = isoLocal.split('T');
  if (!datePart) return isoLocal;
  const parts = datePart.split('-');
  if (parts.length !== 3) return isoLocal.replace('T', ' ');
  return `${parts[2]}-${parts[1]}-${parts[0]}${timePart ? ` ${timePart.slice(0, 5)}` : ''}`;
}

interface PromotionsSectionProps {
  onToast: (title: string, description?: string, tone?: ToastMessage['tone']) => void;
}

export function PromotionsSection({ onToast }: PromotionsSectionProps) {
  const [promos, setPromos] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  // Create / Edit modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Promotion | null>(null);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState('');
  const [discountType, setDiscountType] = useState<PromoDiscountType>('FIXED');
  const [discountValue, setDiscountValue] = useState('');
  const [maxDiscount, setMaxDiscount] = useState('');
  const [minOrder, setMinOrder] = useState('');
  const [quotaLimit, setQuotaLimit] = useState('50');
  const [startAt, setStartAt] = useState('');
  const [endAt, setEndAt] = useState('');
  const [useSchedule, setUseSchedule] = useState(false);
  const [scheduleRules, setScheduleRules] = useState<ScheduleRule[]>([
    { days: [0, 1, 2, 3, 4, 5, 6], start_time: '14:00', end_time: '17:00' },
  ]);
  const [regularOnly, setRegularOnly] = useState(true);
  const [isActive, setIsActive] = useState(true);

  const loadPromos = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.listPromotions(false);
      setPromos(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat daftar promo');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPromos();
  }, [loadPromos]);

  const openCreate = () => {
    setEditing(null);
    setName('');
    setDiscountType('FIXED');
    setDiscountValue('');
    setMaxDiscount('');
    setMinOrder('');
    setQuotaLimit('50');
    setStartAt('');
    setEndAt('');
    setUseSchedule(false);
    setScheduleRules([{ days: [0, 1, 2, 3, 4, 5, 6], start_time: '14:00', end_time: '17:00' }]);
    setRegularOnly(true);
    setIsActive(true);
    setError(null);
    setModalOpen(true);
  };

  const openEdit = (p: Promotion) => {
    setEditing(p);
    setName(p.name);
    setDiscountType(p.discount_type);
    setDiscountValue(
      p.discount_type === 'FIXED'
        ? formatThousandsInput(String(p.discount_value))
        : String(p.discount_value)
    );
    setMaxDiscount(p.max_discount ? formatThousandsInput(String(p.max_discount)) : '');
    setMinOrder(p.min_order_amount > 0 ? formatThousandsInput(String(p.min_order_amount)) : '');
    setQuotaLimit(String(p.quota_limit));
    setStartAt(p.start_at ?? '');
    setEndAt(p.end_at ?? '');
    const grouped = groupSchedulesToRules(p.schedules ?? []);
    setUseSchedule(grouped.length > 0);
    setScheduleRules(
      grouped.length > 0
        ? grouped
        : [{ days: [0, 1, 2, 3, 4, 5, 6], start_time: '14:00', end_time: '17:00' }]
    );
    setRegularOnly(p.regular_only);
    setIsActive(p.is_active);
    setError(null);
    setModalOpen(true);
  };

  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const parsedDisc =
      discountType === 'FIXED' ? parseThousandsInput(discountValue) : Number(discountValue);
    if (!name.trim() || Number.isNaN(parsedDisc) || parsedDisc <= 0) {
      setError('Isi nama promo dan nilai diskon yang valid.');
      return;
    }
    const parsedMax =
      discountType === 'PERCENT' && maxDiscount.trim()
        ? parseThousandsInput(maxDiscount)
        : null;
    const parsedMin = minOrder.trim() ? parseThousandsInput(minOrder) : 0;
    const parsedQuota = Number(quotaLimit);

    if (!parsedQuota || Number.isNaN(parsedQuota) || parsedQuota < 1) {
      setError('Kuota promo wajib diisi minimal 1 pelanggan.');
      return;
    }
    const flattenedSchedules: PromotionScheduleInput[] = [];
    if (useSchedule) {
      for (const rule of scheduleRules) {
        if (rule.days.length === 0) {
          setError('Pilih minimal 1 hari untuk setiap jadwal khusus.');
          return;
        }
        if (!rule.start_time || !rule.end_time || rule.start_time >= rule.end_time) {
          setError('Jam mulai jadwal harus lebih awal dari jam selesai.');
          return;
        }
        for (const day of rule.days) {
          flattenedSchedules.push({
            day_of_week: day,
            start_time: rule.start_time,
            end_time: rule.end_time,
          });
        }
      }
    }

    try {
      setSaving(true);
      setError(null);
      const payload = {
        name: name.trim(),
        discount_type: discountType,
        discount_value: parsedDisc,
        max_discount: parsedMax && !Number.isNaN(parsedMax) ? parsedMax : null,
        min_order_amount: Number.isNaN(parsedMin) ? 0 : parsedMin,
        quota_limit: parsedQuota,
        start_at: startAt.trim() || null,
        end_at: endAt.trim() || null,
        schedules: flattenedSchedules,
        regular_only: regularOnly,
        is_active: isActive,
      };
      if (editing) {
        await api.updatePromotion(editing.id, payload);
        onToast(`Promo "${name.trim()}" diperbarui`);
      } else {
        await api.createPromotion(payload);
        onToast(`Promo "${name.trim()}" dibuat`);
      }
      setModalOpen(false);
      await loadPromos();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menyimpan promo');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (p: Promotion) => {
    if (!window.confirm(`Hapus / arsipkan promo "${p.name}"?`)) return;
    try {
      setError(null);
      const res = await api.deletePromotion(p.id);
      onToast(
        res.soft_deleted ? `Promo "${p.name}" diarsipkan` : `Promo "${p.name}" dihapus`,
        res.reason,
        'info'
      );
      await loadPromos();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menghapus promo');
    }
  };

  const visiblePromos = promos.filter((p) => (showInactive ? true : p.is_active));
  const inactiveCount = promos.filter((p) => !p.is_active).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-brand-brown/75">
          Atur diskon promo berbasis kuota pelanggan, periode waktu, dan jadwal khusus (Happy Hour / Jumat Berkah) yang diterapkan Kasir sebelum pembayaran.
        </p>
        <div className="flex items-center gap-2">
          {inactiveCount > 0 && (
            <button
              type="button"
              onClick={() => setShowInactive((v) => !v)}
              className="h-9 rounded-xl border border-brand-amber-soft bg-white px-3 text-xs font-bold text-brand-brown hover:bg-brand-cream-deep"
            >
              {showInactive ? 'Sembunyikan Arsip' : `Arsip (${inactiveCount})`}
            </button>
          )}
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-brand-orange px-3.5 text-xs font-bold text-white shadow-sm hover:bg-brand-orange-dark"
          >
            <Plus className="h-4 w-4" />
            <span>Tambah Promo</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="rounded-2xl border border-brand-amber-soft bg-white p-8 text-center text-sm text-brand-brown/70">
          Memuat daftar promo...
        </div>
      ) : visiblePromos.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-brand-amber bg-white p-8 text-center">
          <Percent className="mx-auto h-8 w-8 text-brand-orange/70" />
          <p className="mt-2 text-sm font-bold text-brand-brown">Belum ada promo aktif</p>
          <p className="mt-1 text-xs text-brand-brown/65">
            Buat promo diskon berbasis kuota (mis. 50 pelanggan pertama, Happy Hour, atau Jumat Berkah).
          </p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {visiblePromos.map((p) => {
            const pct =
              p.quota_limit > 0
                ? Math.min(100, Math.round((p.used_count / p.quota_limit) * 100))
                : 0;
            return (
              <div
                key={p.id}
                className={`rounded-2xl border bg-white p-4 shadow-sm ${
                  p.is_active ? 'border-brand-amber-soft' : 'border-stone-200 opacity-70'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h3 className="text-sm font-extrabold text-brand-brown">{p.name}</h3>
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-extrabold text-emerald-800">
                        {p.discount_type === 'FIXED'
                          ? `-${formatRupiah(p.discount_value)}`
                          : `-${p.discount_value}%${p.max_discount ? ` (maks ${formatRupiah(p.max_discount)})` : ''}`}
                      </span>
                      {!p.is_active && (
                        <span className="rounded-full bg-stone-200 px-2 py-0.5 text-[10px] font-bold text-stone-600">
                          Arsip
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-brand-brown/70">
                      {p.min_order_amount > 0
                        ? `Min. belanja ${formatRupiah(p.min_order_amount)}`
                        : 'Tanpa min. belanja'}
                      {' • '}
                      {p.regular_only ? 'Khusus Regular' : 'Semua Channel'}
                      {(p.start_at || p.end_at) &&
                        ` • ${p.start_at ? formatCompactDateTime(p.start_at) : '...'} s/d ${
                          p.end_at ? formatCompactDateTime(p.end_at) : '...'
                        }`}
                      {p.schedules?.length > 0 && ` • ${summarizeSchedules(p.schedules)}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => openEdit(p)}
                      className="flex h-8 w-8 items-center justify-center rounded-lg border border-brand-amber-soft text-brand-brown hover:bg-brand-cream"
                      title="Edit promo"
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(p)}
                      className="flex h-8 w-8 items-center justify-center rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50"
                      title="Hapus / Arsipkan promo"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {/* Quota Bar */}
                <div className="mt-3 rounded-xl bg-brand-cream/70 p-2.5">
                  <div className="flex items-center justify-between text-[11px] font-bold text-brand-brown">
                    <span>
                      Kuota: {p.used_count}/{p.quota_limit} pelanggan
                    </span>
                    <span className={p.remaining_quota === 0 ? 'text-rose-600' : 'text-emerald-700'}>
                      Sisa {p.remaining_quota}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-brand-amber-soft/70">
                    <div
                      className={`h-full rounded-full ${
                        pct >= 100 ? 'bg-rose-500' : 'bg-brand-orange'
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create / Edit Promo Modal */}
      <BottomSheet
        open={modalOpen}
        title={editing ? 'Edit Promo' : 'Tambah Promo Baru'}
        subtitle="Promo hanya dapat diterapkan Kasir pada nota BELUM BAYAR sebelum Tandai Lunas."
        onClose={() => setModalOpen(false)}
        footer={
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="h-11 rounded-xl border border-brand-amber-soft bg-white text-sm font-semibold text-brand-brown"
            >
              Batal
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSave()}
              className="h-11 rounded-xl bg-brand-orange text-sm font-bold text-white hover:bg-brand-orange-dark disabled:opacity-60"
            >
              {saving ? 'Menyimpan...' : 'Simpan Promo'}
            </button>
          </div>
        }
      >
        <form onSubmit={handleSave} className="space-y-3.5">
          <div>
            <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
              Nama Promo
            </label>
            <input
              type="text"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="cth: Promo 50 Pelanggan Pertama"
              className="h-11 w-full rounded-xl border border-brand-amber-soft px-3.5 text-sm text-brand-brown focus:border-brand-orange focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
                Tipe Diskon
              </label>
              <select
                value={discountType}
                onChange={(e) => {
                  setDiscountType(e.target.value as PromoDiscountType);
                  setDiscountValue('');
                }}
                className="h-11 w-full rounded-xl border border-brand-amber-soft bg-white px-3 text-sm font-semibold text-brand-brown focus:border-brand-orange focus:outline-none"
              >
                <option value="FIXED">Nominal (Rp)</option>
                <option value="PERCENT">Persen (%)</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
                {discountType === 'FIXED' ? 'Potongan (Rp)' : 'Persentase (%)'}
              </label>
              <input
                type="text"
                inputMode="numeric"
                value={discountValue}
                onChange={(e) =>
                  setDiscountValue(
                    discountType === 'FIXED'
                      ? formatThousandsInput(e.target.value)
                      : e.target.value.replace(/\D/g, '').slice(0, 3)
                  )
                }
                placeholder={discountType === 'FIXED' ? '5.000' : '10'}
                className="h-11 w-full rounded-xl border border-brand-amber-soft px-3.5 text-sm font-semibold tabular-nums text-brand-brown focus:border-brand-orange focus:outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
                Min. Belanja (Rp, opsional)
              </label>
              <input
                type="text"
                inputMode="numeric"
                value={minOrder}
                onChange={(e) => setMinOrder(formatThousandsInput(e.target.value))}
                placeholder="0"
                className="h-11 w-full rounded-xl border border-brand-amber-soft px-3.5 text-sm font-semibold tabular-nums text-brand-brown focus:border-brand-orange focus:outline-none"
              />
            </div>
            {discountType === 'PERCENT' && (
              <div>
                <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
                  Maks. Diskon (Rp, opsional)
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={maxDiscount}
                  onChange={(e) => setMaxDiscount(formatThousandsInput(e.target.value))}
                  placeholder="10.000"
                  className="h-11 w-full rounded-xl border border-brand-amber-soft px-3.5 text-sm font-semibold tabular-nums text-brand-brown focus:border-brand-orange focus:outline-none"
                />
              </div>
            )}
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
              Kuota Pelanggan (Wajib, min. 1)
            </label>
            <input
              type="number"
              min={1}
              value={quotaLimit}
              onChange={(e) => setQuotaLimit(e.target.value)}
              placeholder="50"
              className="h-11 w-full rounded-xl border border-brand-amber-soft px-3.5 text-sm font-semibold tabular-nums text-brand-brown focus:border-brand-orange focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
                Mulai (Tanggal &amp; Jam, Opsional)
              </label>
              <input
                type="datetime-local"
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
                className="h-10 w-full rounded-xl border border-brand-amber-soft px-3 text-xs font-bold text-brand-brown focus:border-brand-orange focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
                Berakhir (Tanggal &amp; Jam, Opsional)
              </label>
              <input
                type="datetime-local"
                value={endAt}
                onChange={(e) => setEndAt(e.target.value)}
                className="h-10 w-full rounded-xl border border-brand-amber-soft px-3 text-xs font-bold text-brand-brown focus:border-brand-orange focus:outline-none"
              />
            </div>
          </div>

          <div className="rounded-xl border border-brand-amber-soft/80 bg-brand-cream/40 p-3 space-y-2.5">
            <label className="flex cursor-pointer items-center gap-2 text-xs font-bold text-brand-brown">
              <input
                type="checkbox"
                checked={useSchedule}
                onChange={(e) => setUseSchedule(e.target.checked)}
                className="h-4 w-4 accent-brand-orange"
              />
              <span>Batasi hari &amp; jam khusus (Happy Hour / Jumat Berkah)</span>
            </label>
            {!useSchedule ? (
              <p className="text-[11px] text-brand-brown/65">
                Berlaku setiap saat selama periode promo aktif.
              </p>
            ) : (
              <div className="space-y-2.5">
                {scheduleRules.map((rule, idx) => (
                  <div
                    key={idx}
                    className="space-y-2 rounded-xl border border-brand-amber-soft bg-white p-2.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-1">
                      <div className="flex flex-wrap gap-1">
                        {(
                          [
                            { label: 'Setiap Hari', days: [0, 1, 2, 3, 4, 5, 6] },
                            { label: 'Sen–Jum', days: [0, 1, 2, 3, 4] },
                            { label: 'Sab–Min', days: [5, 6] },
                            { label: 'Jumat', days: [4] },
                          ] as const
                        ).map((preset) => (
                          <button
                            key={preset.label}
                            type="button"
                            onClick={() =>
                              setScheduleRules((prev) =>
                                prev.map((r, i) =>
                                  i === idx ? { ...r, days: [...preset.days] } : r
                                )
                              )
                            }
                            className="rounded-md bg-brand-cream px-2 py-0.5 text-[10px] font-bold text-brand-brown hover:bg-brand-amber-soft/70"
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                      {scheduleRules.length > 1 && (
                        <button
                          type="button"
                          onClick={() =>
                            setScheduleRules((prev) => prev.filter((_, i) => i !== idx))
                          }
                          className="text-[10px] font-bold text-rose-600 hover:underline"
                        >
                          Hapus
                        </button>
                      )}
                    </div>

                    <div className="grid grid-cols-7 gap-1">
                      {DAY_LABELS.map((label, dayIdx) => {
                        const selected = rule.days.includes(dayIdx);
                        return (
                          <button
                            key={label}
                            type="button"
                            onClick={() =>
                              setScheduleRules((prev) =>
                                prev.map((r, i) => {
                                  if (i !== idx) return r;
                                  const nextDays = selected
                                    ? r.days.filter((d) => d !== dayIdx)
                                    : [...r.days, dayIdx].sort((a, b) => a - b);
                                  return { ...r, days: nextDays };
                                })
                              )
                            }
                            className={`h-7 rounded-lg text-[10px] font-bold transition ${
                              selected
                                ? 'bg-brand-orange text-white'
                                : 'border border-brand-amber-soft bg-white text-brand-brown/70 hover:bg-brand-cream'
                            }`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="mb-0.5 block text-[10px] font-semibold text-brand-brown/70">
                          Jam Mulai
                        </label>
                        <input
                          type="time"
                          value={rule.start_time}
                          onChange={(e) =>
                            setScheduleRules((prev) =>
                              prev.map((r, i) =>
                                i === idx ? { ...r, start_time: e.target.value } : r
                              )
                            )
                          }
                          className="h-9 w-full rounded-lg border border-brand-amber-soft px-2.5 text-xs font-bold text-brand-brown focus:border-brand-orange focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="mb-0.5 block text-[10px] font-semibold text-brand-brown/70">
                          Jam Selesai
                        </label>
                        <input
                          type="time"
                          value={rule.end_time}
                          onChange={(e) =>
                            setScheduleRules((prev) =>
                              prev.map((r, i) =>
                                i === idx ? { ...r, end_time: e.target.value } : r
                              )
                            )
                          }
                          className="h-9 w-full rounded-lg border border-brand-amber-soft px-2.5 text-xs font-bold text-brand-brown focus:border-brand-orange focus:outline-none"
                        />
                      </div>
                    </div>
                  </div>
                ))}

                {scheduleRules.length < 3 && (
                  <button
                    type="button"
                    onClick={() =>
                      setScheduleRules((prev) => [
                        ...prev,
                        { days: [0, 1, 2, 3, 4], start_time: '18:00', end_time: '21:00' },
                      ])
                    }
                    className="text-xs font-bold text-brand-orange hover:underline"
                  >
                    + Tambah Slot Jadwal (mis. Sarapan &amp; Makan Malam)
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-4">
            <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-brand-brown">
              <input
                type="checkbox"
                checked={regularOnly}
                onChange={(e) => setRegularOnly(e.target.checked)}
                className="h-4 w-4 accent-brand-orange"
              />
              <span>Khusus saluran Regular (Dine-in / Bungkus)</span>
            </label>
            {editing && (
              <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-brand-brown">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                  className="h-4 w-4 accent-brand-orange"
                />
                <span>Promo Aktif</span>
              </label>
            )}
          </div>
        </form>
      </BottomSheet>
    </div>
  );
}
