import { useCallback, useEffect, useState } from 'react';
import {
  Barcode,
  Edit2,
  Percent,
  Plus,
  QrCode,
  Tag,
  Trash2,
} from 'lucide-react';
import { api } from '../api/client';
import { BottomSheet } from './BottomSheet';
import type { ToastMessage } from './ToastContainer';
import type {
  PromoDiscountType,
  PromoReceiptMediaType,
  Promotion,
} from '../types';
import {
  formatRupiah,
  formatThousandsInput,
  parseThousandsInput,
} from '../utils/format';

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
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [regularOnly, setRegularOnly] = useState(true);
  const [receiptText, setReceiptText] = useState('');
  const [mediaType, setMediaType] = useState<PromoReceiptMediaType>('NONE');
  const [mediaValue, setMediaValue] = useState('');
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
    setStartDate('');
    setEndDate('');
    setRegularOnly(true);
    setReceiptText('');
    setMediaType('NONE');
    setMediaValue('');
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
    setStartDate(p.start_date ?? '');
    setEndDate(p.end_date ?? '');
    setRegularOnly(p.regular_only);
    setReceiptText(p.receipt_promo_text);
    setMediaType(p.receipt_media_type);
    setMediaValue(p.receipt_media_value);
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
    if (mediaType !== 'NONE' && !mediaValue.trim()) {
      setError(
        mediaType === 'QR'
          ? 'Isi URL / teks untuk QR Code.'
          : 'Isi kode ASCII untuk Barcode CODE128.'
      );
      return;
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
        start_date: startDate.trim() || null,
        end_date: endDate.trim() || null,
        regular_only: regularOnly,
        receipt_promo_text: receiptText,
        receipt_media_type: mediaType,
        receipt_media_value: mediaType === 'NONE' ? '' : mediaValue.trim(),
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
          Atur diskon berbasis kuota pelanggan beserta <strong>Promo Section</strong> (teks + QR / Barcode) yang otomatis tercetak hanya saat promo dipakai.
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
            Buat promo kuota (mis. 50 pelanggan pertama) lengkap dengan QR Google Maps atau Barcode di struk.
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
                      {(p.start_date || p.end_date) &&
                        ` • ${p.start_date ?? '...'} s/d ${p.end_date ?? '...'}`}
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

                {/* Receipt Promo Section Badge */}
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-brand-amber-soft/50 pt-2 text-[11px]">
                  <span className="inline-flex items-center gap-1 rounded-full border border-brand-amber-soft bg-brand-cream px-2 py-0.5 font-bold text-brand-brown">
                    {p.receipt_media_type === 'QR' ? (
                      <>
                        <QrCode className="h-3 w-3 text-brand-orange" />
                        <span>Struk: QR Code</span>
                      </>
                    ) : p.receipt_media_type === 'BARCODE' ? (
                      <>
                        <Barcode className="h-3 w-3 text-brand-orange" />
                        <span>Struk: Barcode</span>
                      </>
                    ) : (
                      <>
                        <Tag className="h-3 w-3 text-brand-brown/60" />
                        <span>Struk: Tanpa Gambar</span>
                      </>
                    )}
                  </span>
                  {p.receipt_promo_text && (
                    <span className="truncate text-brand-brown/65">
                      “{p.receipt_promo_text}”
                    </span>
                  )}
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

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
                Mulai (Opsional)
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="h-10 w-full rounded-xl border border-brand-amber-soft px-3 text-xs font-bold text-brand-brown focus:border-brand-orange focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
                Berakhir (Opsional)
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="h-10 w-full rounded-xl border border-brand-amber-soft px-3 text-xs font-bold text-brand-brown focus:border-brand-orange focus:outline-none"
              />
            </div>
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

          {/* Receipt Promo Section Configuration */}
          <div className="space-y-3 rounded-2xl border border-brand-amber-soft bg-brand-cream/60 p-3.5">
            <div>
              <p className="text-xs font-extrabold text-brand-brown">
                Promo Section di Struk (Cetak Khusus Saat Promo Dipakai)
              </p>
              <p className="mt-0.5 text-[11px] text-brand-brown/65">
                Jika nota tidak memakai promo, struk berhenti di footer normal tanpa mencetak bagian ini.
              </p>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
                Teks Kecil Promo (Opsional)
              </label>
              <textarea
                rows={2}
                maxLength={300}
                value={receiptText}
                onChange={(e) => setReceiptText(e.target.value)}
                placeholder="cth: Suka makanan kami? Scan QR ini untuk berbagi ulasan jujur di Google Maps!"
                className="w-full rounded-xl border border-brand-amber-soft bg-white px-3 py-2 text-xs text-brand-brown focus:border-brand-orange focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold text-brand-brown/80">
                Gambar / Kode pada Promo Section (Pilih Salah Satu)
              </label>
              <div className="grid grid-cols-3 gap-1.5 rounded-xl bg-white p-1 border border-brand-amber-soft">
                {(
                  [
                    { key: 'NONE', label: 'Tanpa Gambar' },
                    { key: 'QR', label: 'QR Code' },
                    { key: 'BARCODE', label: 'Barcode' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => {
                      setMediaType(opt.key);
                      if (opt.key === 'NONE') setMediaValue('');
                    }}
                    className={`h-9 rounded-lg text-xs font-bold transition ${
                      mediaType === opt.key
                        ? 'bg-brand-orange text-white shadow-sm'
                        : 'text-brand-brown/75 hover:bg-brand-cream'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {mediaType === 'QR' && (
              <div>
                <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
                  Link / Teks QR Code (cth: link Google Maps Review)
                </label>
                <input
                  type="text"
                  maxLength={500}
                  value={mediaValue}
                  onChange={(e) => setMediaValue(e.target.value)}
                  placeholder="https://g.page/r/xxxx/review"
                  className="h-10 w-full rounded-xl border border-brand-amber-soft bg-white px-3 text-xs text-brand-brown focus:border-brand-orange focus:outline-none"
                />
              </div>
            )}

            {mediaType === 'BARCODE' && (
              <div>
                <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
                  Nilai Barcode CODE128 (ASCII, maks. 48 karakter)
                </label>
                <input
                  type="text"
                  maxLength={48}
                  value={mediaValue}
                  onChange={(e) => setMediaValue(e.target.value)}
                  placeholder="cth: PROMO-NASIUDUK22"
                  className="h-10 w-full rounded-xl border border-brand-amber-soft bg-white px-3 font-mono text-xs text-brand-brown focus:border-brand-orange focus:outline-none"
                />
              </div>
            )}
          </div>
        </form>
      </BottomSheet>
    </div>
  );
}
