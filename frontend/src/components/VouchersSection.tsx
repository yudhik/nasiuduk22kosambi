import { useCallback, useEffect, useState } from 'react';
import { Barcode, Edit2, Plus, QrCode, Ticket, Trash2, Type } from 'lucide-react';
import { api } from '../api/client';
import { BottomSheet } from './BottomSheet';
import type { ToastMessage } from './ToastContainer';
import type {
  PromoDiscountType,
  VoucherCampaign,
  VoucherCodeMode,
  VoucherDisplayFormat,
} from '../types';
import {
  formatRupiah,
  formatThousandsInput,
  parseThousandsInput,
} from '../utils/format';

const VOUCHER_TOKENS = [
  { token: '{RAND6}', hint: '6 huruf/angka acak' },
  { token: '{RAND4}', hint: '4 acak' },
  { token: '{RAND8}', hint: '8 acak' },
  { token: '{DATE}', hint: 'YYYYMMDD' },
  { token: '{SEQ4}', hint: 'Urutan 0001' },
] as const;

function previewTemplate(tmpl: string): string {
  const t = tmpl.trim().toUpperCase();
  if (!t) return '';
  return t
    .replace(/\{DATE\}/g, '20261127')
    .replace(/\{SEQ4\}/g, '0001')
    .replace(/\{RAND8\}/g, 'K7M9P2X4')
    .replace(/\{RAND6\}/g, 'K7M9P2')
    .replace(/\{RAND4\}/g, 'K7M9');
}

interface VouchersSectionProps {
  onToast: (title: string, description?: string, tone?: ToastMessage['tone']) => void;
}

export function VouchersSection({ onToast }: VouchersSectionProps) {
  const [campaigns, setCampaigns] = useState<VoucherCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<VoucherCampaign | null>(null);
  const [saving, setSaving] = useState(false);

  // Identity & format
  const [name, setName] = useState('');
  const [codeMode, setCodeMode] = useState<VoucherCodeMode>('DYNAMIC');
  const [staticCode, setStaticCode] = useState('');
  const [codeTemplate, setCodeTemplate] = useState('NU22-{RAND6}');
  const [displayFormat, setDisplayFormat] = useState<VoucherDisplayFormat>('QR');
  const [receiptMessage, setReceiptMessage] = useState(
    'Tunjukkan voucher ini pada kunjungan berikutnya!'
  );

  // Issuance rules (when customer pays)
  const [autoIssueOnPay, setAutoIssueOnPay] = useState(true);
  const [issueMinOrder, setIssueMinOrder] = useState('');
  const [issueRegularOnly, setIssueRegularOnly] = useState(true);
  const [issueQuotaLimit, setIssueQuotaLimit] = useState('50');
  const [issueStartAt, setIssueStartAt] = useState('');
  const [issueEndAt, setIssueEndAt] = useState('');

  // Redemption rules (on future transaction)
  const [discountType, setDiscountType] = useState<PromoDiscountType>('FIXED');
  const [discountValue, setDiscountValue] = useState('');
  const [maxDiscount, setMaxDiscount] = useState('');
  const [redeemMinOrder, setRedeemMinOrder] = useState('');
  const [redeemRegularOnly, setRedeemRegularOnly] = useState(true);
  const [redeemQuotaLimit, setRedeemQuotaLimit] = useState('50');
  const [validDays, setValidDays] = useState('14');
  const [redeemStartAt, setRedeemStartAt] = useState('');
  const [redeemEndAt, setRedeemEndAt] = useState('');
  const [isActive, setIsActive] = useState(true);

  const loadCampaigns = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.listVouchers(false);
      setCampaigns(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat daftar voucher');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCampaigns();
  }, [loadCampaigns]);

  const openCreate = () => {
    setEditing(null);
    setName('');
    setCodeMode('DYNAMIC');
    setStaticCode('');
    setCodeTemplate('NU22-{RAND6}');
    setDisplayFormat('QR');
    setReceiptMessage('Tunjukkan voucher ini pada kunjungan berikutnya!');
    setAutoIssueOnPay(true);
    setIssueMinOrder('');
    setIssueRegularOnly(true);
    setIssueQuotaLimit('50');
    setIssueStartAt('');
    setIssueEndAt('');
    setDiscountType('FIXED');
    setDiscountValue('');
    setMaxDiscount('');
    setRedeemMinOrder('');
    setRedeemRegularOnly(true);
    setRedeemQuotaLimit('50');
    setValidDays('14');
    setRedeemStartAt('');
    setRedeemEndAt('');
    setIsActive(true);
    setError(null);
    setModalOpen(true);
  };

  const openEdit = (v: VoucherCampaign) => {
    setEditing(v);
    setName(v.name);
    setCodeMode(v.code_mode);
    setStaticCode(v.static_code ?? '');
    setCodeTemplate(v.code_template ?? 'NU22-{RAND6}');
    setDisplayFormat(v.display_format);
    setReceiptMessage(v.receipt_message);
    setAutoIssueOnPay(v.auto_issue_on_pay);
    setIssueMinOrder(
      v.issue_min_order_amount > 0 ? formatThousandsInput(String(v.issue_min_order_amount)) : ''
    );
    setIssueRegularOnly(v.issue_regular_only);
    setIssueQuotaLimit(String(v.issue_quota_limit));
    setIssueStartAt(v.issue_start_at ?? '');
    setIssueEndAt(v.issue_end_at ?? '');
    setDiscountType(v.discount_type);
    setDiscountValue(
      v.discount_type === 'FIXED'
        ? formatThousandsInput(String(v.discount_value))
        : String(v.discount_value)
    );
    setMaxDiscount(v.max_discount ? formatThousandsInput(String(v.max_discount)) : '');
    setRedeemMinOrder(
      v.redeem_min_order_amount > 0 ? formatThousandsInput(String(v.redeem_min_order_amount)) : ''
    );
    setRedeemRegularOnly(v.redeem_regular_only);
    setRedeemQuotaLimit(String(v.redeem_quota_limit));
    setValidDays(v.valid_days ? String(v.valid_days) : '');
    setRedeemStartAt(v.redeem_start_at ?? '');
    setRedeemEndAt(v.redeem_end_at ?? '');
    setIsActive(v.is_active);
    setError(null);
    setModalOpen(true);
  };

  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const parsedDisc =
      discountType === 'FIXED' ? parseThousandsInput(discountValue) : Number(discountValue);
    if (!name.trim() || Number.isNaN(parsedDisc) || parsedDisc <= 0) {
      setError('Isi nama voucher dan nilai diskon penukaran yang valid.');
      return;
    }
    const parsedIssueQuota = Number(issueQuotaLimit);
    const parsedRedeemQuota = Number(redeemQuotaLimit);
    if (!parsedIssueQuota || parsedIssueQuota < 1 || !parsedRedeemQuota || parsedRedeemQuota < 1) {
      setError('Kuota pemberian dan kuota penukaran wajib minimal 1.');
      return;
    }
    if (codeMode === 'STATIC' && !staticCode.trim()) {
      setError('Isi kode statis voucher (mis. NU22-HEMAT5K).');
      return;
    }
    if (codeMode === 'DYNAMIC' && !codeTemplate.trim()) {
      setError('Isi pola kode dinamis voucher (mis. NU22-{RAND6}).');
      return;
    }

    const parsedMax =
      discountType === 'PERCENT' && maxDiscount.trim()
        ? parseThousandsInput(maxDiscount)
        : null;
    const parsedIssueMin = issueMinOrder.trim() ? parseThousandsInput(issueMinOrder) : 0;
    const parsedRedeemMin = redeemMinOrder.trim() ? parseThousandsInput(redeemMinOrder) : 0;
    const parsedValidDays = validDays.trim() ? Number(validDays) : null;

    try {
      setSaving(true);
      setError(null);
      const payload = {
        name: name.trim(),
        code_mode: codeMode,
        static_code: codeMode === 'STATIC' ? staticCode.trim().toUpperCase() : null,
        code_template: codeMode === 'DYNAMIC' ? codeTemplate.trim().toUpperCase() : null,
        display_format: displayFormat,
        receipt_message: receiptMessage,
        auto_issue_on_pay: autoIssueOnPay,
        issue_min_order_amount: Number.isNaN(parsedIssueMin) ? 0 : parsedIssueMin,
        issue_regular_only: issueRegularOnly,
        issue_quota_limit: parsedIssueQuota,
        issue_start_at: issueStartAt.trim() || null,
        issue_end_at: issueEndAt.trim() || null,
        discount_type: discountType,
        discount_value: parsedDisc,
        max_discount: parsedMax && !Number.isNaN(parsedMax) ? parsedMax : null,
        redeem_min_order_amount: Number.isNaN(parsedRedeemMin) ? 0 : parsedRedeemMin,
        redeem_regular_only: redeemRegularOnly,
        redeem_quota_limit: parsedRedeemQuota,
        valid_days: parsedValidDays && !Number.isNaN(parsedValidDays) ? parsedValidDays : null,
        redeem_start_at: redeemStartAt.trim() || null,
        redeem_end_at: redeemEndAt.trim() || null,
        is_active: isActive,
      };
      if (editing) {
        await api.updateVoucher(editing.id, payload);
        onToast(`Voucher "${name.trim()}" diperbarui`);
      } else {
        await api.createVoucher(payload);
        onToast(`Voucher "${name.trim()}" dibuat`);
      }
      setModalOpen(false);
      await loadCampaigns();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menyimpan voucher');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (v: VoucherCampaign) => {
    if (!window.confirm(`Hapus / arsipkan voucher "${v.name}"?`)) return;
    try {
      setError(null);
      const res = await api.deleteVoucher(v.id);
      onToast(
        res.soft_deleted ? `Voucher "${v.name}" diarsipkan` : `Voucher "${v.name}" dihapus`,
        res.reason,
        'info'
      );
      await loadCampaigns();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menghapus voucher');
    }
  };

  const visible = campaigns.filter((c) => (showInactive ? true : c.is_active));
  const inactiveCount = campaigns.filter((c) => !c.is_active).length;
  const codeModeLocked = Boolean(editing && (editing.issued_count > 0 || editing.redeemed_count > 0));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-brand-brown/75">
          Voucher <strong>diberikan di bawah footer struk</strong> saat pelanggan bayar (tanpa memotong nota hari ini), lalu <strong>discan &amp; ditukar</strong> sebagai potongan pada transaksi berikutnya.
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
            <span>Tambah Voucher</span>
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
          Memuat daftar voucher...
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-brand-amber bg-white p-8 text-center">
          <Ticket className="mx-auto h-8 w-8 text-brand-orange/70" />
          <p className="mt-2 text-sm font-bold text-brand-brown">Belum ada campaign voucher aktif</p>
          <p className="mt-1 text-xs text-brand-brown/65">
            Buat voucher QR / Barcode / Teks Biasa untuk diberikan otomatis saat pelanggan bayar.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {visible.map((v) => {
            const issuePct = Math.min(100, Math.round((v.issued_count / v.issue_quota_limit) * 100));
            const redeemPct = Math.min(
              100,
              Math.round((v.redeemed_count / v.redeem_quota_limit) * 100)
            );
            return (
              <div
                key={v.id}
                className={`rounded-2xl border bg-white p-4 shadow-sm ${
                  v.is_active ? 'border-brand-amber-soft' : 'border-stone-200 opacity-70'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h3 className="text-sm font-extrabold text-brand-brown">{v.name}</h3>
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-extrabold text-emerald-800">
                        {v.discount_type === 'FIXED'
                          ? `-${formatRupiah(v.discount_value)}`
                          : `-${v.discount_value}%${v.max_discount ? ` (maks ${formatRupiah(v.max_discount)})` : ''}`}
                      </span>
                      {v.auto_issue_on_pay && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">
                          Auto-Beri
                        </span>
                      )}
                      {!v.is_active && (
                        <span className="rounded-full bg-stone-200 px-2 py-0.5 text-[10px] font-bold text-stone-600">
                          Arsip
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[11px] text-brand-brown/70">
                      Beri: min. subtotal {formatRupiah(v.issue_min_order_amount)} • Tukar: min.{' '}
                      {formatRupiah(v.redeem_min_order_amount)}
                      {v.valid_days ? ` • Berlaku ${v.valid_days} hari` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => openEdit(v)}
                      className="flex h-8 w-8 items-center justify-center rounded-lg border border-brand-amber-soft text-brand-brown hover:bg-brand-cream"
                      title="Edit voucher"
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(v)}
                      className="flex h-8 w-8 items-center justify-center rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50"
                      title="Hapus / Arsipkan voucher"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {/* Quotas */}
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div className="rounded-xl bg-brand-cream/70 p-2">
                    <div className="flex items-center justify-between text-[10px] font-bold text-brand-brown">
                      <span>Diberikan</span>
                      <span>
                        {v.issued_count}/{v.issue_quota_limit}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-brand-amber-soft/70">
                      <div
                        className={`h-full rounded-full ${issuePct >= 100 ? 'bg-rose-500' : 'bg-brand-orange'}`}
                        style={{ width: `${issuePct}%` }}
                      />
                    </div>
                  </div>
                  <div className="rounded-xl bg-emerald-50/80 p-2">
                    <div className="flex items-center justify-between text-[10px] font-bold text-emerald-900">
                      <span>Ditukar</span>
                      <span>
                        {v.redeemed_count}/{v.redeem_quota_limit}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-emerald-200">
                      <div
                        className={`h-full rounded-full ${redeemPct >= 100 ? 'bg-rose-500' : 'bg-emerald-600'}`}
                        style={{ width: `${redeemPct}%` }}
                      />
                    </div>
                  </div>
                </div>

                {/* Format & Code Badge */}
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-brand-amber-soft/50 pt-2 text-[11px]">
                  <span className="inline-flex items-center gap-1 rounded-full border border-brand-amber-soft bg-brand-cream px-2 py-0.5 font-bold text-brand-brown">
                    {v.display_format === 'QR' ? (
                      <>
                        <QrCode className="h-3 w-3 text-brand-orange" />
                        <span>QR Code</span>
                      </>
                    ) : v.display_format === 'BARCODE' ? (
                      <>
                        <Barcode className="h-3 w-3 text-brand-orange" />
                        <span>Barcode</span>
                      </>
                    ) : (
                      <>
                        <Type className="h-3 w-3 text-brand-orange" />
                        <span>Teks Biasa</span>
                      </>
                    )}
                  </span>
                  <span className="rounded-full bg-brand-amber-soft/60 px-2 py-0.5 font-mono text-[10px] font-bold text-brand-brown">
                    {v.code_mode === 'DYNAMIC' ? `Dinamis: ${v.code_template}` : `Statis: ${v.static_code}`}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create / Edit Voucher Modal */}
      <BottomSheet
        open={modalOpen}
        title={editing ? 'Edit Campaign Voucher' : 'Tambah Campaign Voucher'}
        subtitle="Voucher dicetak di bawah footer struk saat bayar, dan ditukar pada transaksi berikutnya."
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
              {saving ? 'Menyimpan...' : 'Simpan Voucher'}
            </button>
          </div>
        }
      >
        <form onSubmit={handleSave} className="space-y-3.5">
          <div>
            <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
              Nama Campaign Voucher
            </label>
            <input
              type="text"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="cth: Voucher Kunjungan Berikutnya Rp5.000"
              className="h-11 w-full rounded-xl border border-brand-amber-soft px-3.5 text-sm text-brand-brown focus:border-brand-orange focus:outline-none"
            />
          </div>

          {/* Code Mode & Display Format */}
          <div className="space-y-2.5 rounded-2xl border border-brand-amber-soft bg-brand-cream/50 p-3">
            <p className="text-xs font-extrabold text-brand-brown">Kode &amp; Tampilan di Struk</p>
            <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-brand-amber-soft bg-white p-1">
              {(
                [
                  { key: 'DYNAMIC', label: 'Dynamic (Unik/Nota)' },
                  { key: 'STATIC', label: 'Static (Kode Tetap)' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  disabled={codeModeLocked}
                  onClick={() => setCodeMode(opt.key)}
                  className={`h-9 rounded-lg text-xs font-bold transition disabled:opacity-50 ${
                    codeMode === opt.key
                      ? 'bg-brand-orange text-white shadow-sm'
                      : 'text-brand-brown/75 hover:bg-brand-cream'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-3 gap-1.5 rounded-xl border border-brand-amber-soft bg-white p-1">
              {(
                [
                  { key: 'TEXT', label: 'Teks Biasa' },
                  { key: 'QR', label: 'QR Code' },
                  { key: 'BARCODE', label: 'Barcode' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setDisplayFormat(opt.key)}
                  className={`h-9 rounded-lg text-xs font-bold transition ${
                    displayFormat === opt.key
                      ? 'bg-brand-orange text-white shadow-sm'
                      : 'text-brand-brown/75 hover:bg-brand-cream'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {codeMode === 'STATIC' ? (
              <div>
                <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
                  Kode Voucher Statis (Huruf/Angka/Tanda `-`)
                </label>
                <input
                  type="text"
                  maxLength={displayFormat === 'BARCODE' ? 24 : 48}
                  value={staticCode}
                  onChange={(e) => setStaticCode(e.target.value.toUpperCase())}
                  placeholder="cth: NU22-HEMAT5K"
                  className="h-10 w-full rounded-xl border border-brand-amber-soft bg-white px-3 font-mono text-xs font-bold uppercase text-brand-brown focus:border-brand-orange focus:outline-none"
                />
              </div>
            ) : (
              <div>
                <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
                  Pola Kode Dinamis (1x pakai per struk)
                </label>
                <input
                  type="text"
                  maxLength={64}
                  value={codeTemplate}
                  onChange={(e) => setCodeTemplate(e.target.value.toUpperCase())}
                  placeholder="cth: NU22-{RAND6}"
                  className="h-10 w-full rounded-xl border border-brand-amber-soft bg-white px-3 font-mono text-xs font-bold uppercase text-brand-brown focus:border-brand-orange focus:outline-none"
                />
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {VOUCHER_TOKENS.map((t) => (
                    <button
                      key={t.token}
                      type="button"
                      onClick={() => setCodeTemplate((prev) => `${prev}${t.token}`)}
                      title={t.hint}
                      className="rounded-lg border border-brand-amber-soft bg-white px-2 py-0.5 font-mono text-[10px] font-bold text-brand-brown hover:bg-brand-amber-soft/50"
                    >
                      +{t.token}
                    </button>
                  ))}
                </div>
                {codeTemplate.trim() && (
                  <p className="mt-1 text-[11px] text-brand-brown/75">
                    Contoh:{' '}
                    <span className="font-mono font-bold text-brand-brown">
                      {previewTemplate(codeTemplate)}
                    </span>
                  </p>
                )}
              </div>
            )}

            <div>
              <label className="mb-1 block text-xs font-semibold text-brand-brown/80">
                Pesan di Struk (di bawah footer, opsional)
              </label>
              <textarea
                rows={2}
                maxLength={240}
                value={receiptMessage}
                onChange={(e) => setReceiptMessage(e.target.value)}
                placeholder="cth: Scan QR ini di kunjungan berikutnya untuk diskon Rp5.000!"
                className="w-full rounded-xl border border-brand-amber-soft bg-white px-3 py-2 text-xs text-brand-brown focus:border-brand-orange focus:outline-none"
              />
            </div>
          </div>

          {/* Issuance Rules */}
          <div className="space-y-2.5 rounded-2xl border border-brand-amber-soft bg-white p-3">
            <p className="text-xs font-extrabold text-brand-brown">
              1. Syarat Pemberian Voucher (Saat Bayar — Tanpa Potongan Hari Ini)
            </p>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="mb-1 block text-[11px] font-semibold text-brand-brown/80">
                  Min. Subtotal Nota (Rp)
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={issueMinOrder}
                  onChange={(e) => setIssueMinOrder(formatThousandsInput(e.target.value))}
                  placeholder="0"
                  className="h-10 w-full rounded-xl border border-brand-amber-soft px-3 text-xs font-bold tabular-nums text-brand-brown focus:border-brand-orange focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-semibold text-brand-brown/80">
                  Kuota Diberikan (Wajib)
                </label>
                <input
                  type="number"
                  min={1}
                  value={issueQuotaLimit}
                  onChange={(e) => setIssueQuotaLimit(e.target.value)}
                  className="h-10 w-full rounded-xl border border-brand-amber-soft px-3 text-xs font-bold tabular-nums text-brand-brown focus:border-brand-orange focus:outline-none"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-[11px] font-semibold text-brand-brown/80">
                  Mulai Pemberian (Opsional)
                </label>
                <input
                  type="datetime-local"
                  value={issueStartAt}
                  onChange={(e) => setIssueStartAt(e.target.value)}
                  className="h-9 w-full rounded-xl border border-brand-amber-soft px-2.5 text-xs font-bold text-brand-brown"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-semibold text-brand-brown/80">
                  Akhir Pemberian (Opsional)
                </label>
                <input
                  type="datetime-local"
                  value={issueEndAt}
                  onChange={(e) => setIssueEndAt(e.target.value)}
                  className="h-9 w-full rounded-xl border border-brand-amber-soft px-2.5 text-xs font-bold text-brand-brown"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-brand-brown">
                <input
                  type="checkbox"
                  checked={autoIssueOnPay}
                  onChange={(e) => setAutoIssueOnPay(e.target.checked)}
                  className="h-4 w-4 accent-brand-orange"
                />
                <span>Otomatis berikan saat Tandai Lunas</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-brand-brown">
                <input
                  type="checkbox"
                  checked={issueRegularOnly}
                  onChange={(e) => setIssueRegularOnly(e.target.checked)}
                  className="h-4 w-4 accent-brand-orange"
                />
                <span>Khusus saluran Regular</span>
              </label>
            </div>
          </div>

          {/* Redemption Rules */}
          <div className="space-y-2.5 rounded-2xl border border-emerald-200 bg-emerald-50/40 p-3">
            <p className="text-xs font-extrabold text-emerald-900">
              2. Nilai &amp; Syarat Penukaran (Transaksi Berikutnya)
            </p>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="mb-1 block text-[11px] font-semibold text-brand-brown/80">
                  Tipe Diskon
                </label>
                <select
                  value={discountType}
                  onChange={(e) => {
                    setDiscountType(e.target.value as PromoDiscountType);
                    setDiscountValue('');
                  }}
                  className="h-10 w-full rounded-xl border border-brand-amber-soft bg-white px-2.5 text-xs font-bold text-brand-brown"
                >
                  <option value="FIXED">Nominal (Rp)</option>
                  <option value="PERCENT">Persen (%)</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-semibold text-brand-brown/80">
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
                  className="h-10 w-full rounded-xl border border-brand-amber-soft bg-white px-3 text-xs font-bold tabular-nums text-brand-brown"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="mb-1 block text-[11px] font-semibold text-brand-brown/80">
                  Min. Belanja Tukar (Rp)
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={redeemMinOrder}
                  onChange={(e) => setRedeemMinOrder(formatThousandsInput(e.target.value))}
                  placeholder="0"
                  className="h-10 w-full rounded-xl border border-brand-amber-soft bg-white px-3 text-xs font-bold tabular-nums text-brand-brown"
                />
              </div>
              {discountType === 'PERCENT' ? (
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-brand-brown/80">
                    Maks. Diskon (Rp)
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={maxDiscount}
                    onChange={(e) => setMaxDiscount(formatThousandsInput(e.target.value))}
                    placeholder="10.000"
                    className="h-10 w-full rounded-xl border border-brand-amber-soft bg-white px-3 text-xs font-bold tabular-nums text-brand-brown"
                  />
                </div>
              ) : (
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-brand-brown/80">
                    Masa Berlaku (Hari, opsional)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    value={validDays}
                    onChange={(e) => setValidDays(e.target.value)}
                    placeholder="14"
                    className="h-10 w-full rounded-xl border border-brand-amber-soft bg-white px-3 text-xs font-bold tabular-nums text-brand-brown"
                  />
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="mb-1 block text-[11px] font-semibold text-brand-brown/80">
                  Kuota Penukaran (Wajib)
                </label>
                <input
                  type="number"
                  min={1}
                  value={redeemQuotaLimit}
                  onChange={(e) => setRedeemQuotaLimit(e.target.value)}
                  className="h-10 w-full rounded-xl border border-brand-amber-soft bg-white px-3 text-xs font-bold tabular-nums text-brand-brown"
                />
              </div>
              {discountType === 'PERCENT' && (
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-brand-brown/80">
                    Masa Berlaku (Hari, opsional)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    value={validDays}
                    onChange={(e) => setValidDays(e.target.value)}
                    placeholder="14"
                    className="h-10 w-full rounded-xl border border-brand-amber-soft bg-white px-3 text-xs font-bold tabular-nums text-brand-brown"
                  />
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-[11px] font-semibold text-brand-brown/80">
                  Mulai Penukaran (Opsional)
                </label>
                <input
                  type="datetime-local"
                  value={redeemStartAt}
                  onChange={(e) => setRedeemStartAt(e.target.value)}
                  className="h-9 w-full rounded-xl border border-brand-amber-soft bg-white px-2.5 text-xs font-bold text-brand-brown"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-semibold text-brand-brown/80">
                  Akhir Penukaran (Opsional)
                </label>
                <input
                  type="datetime-local"
                  value={redeemEndAt}
                  onChange={(e) => setRedeemEndAt(e.target.value)}
                  className="h-9 w-full rounded-xl border border-brand-amber-soft bg-white px-2.5 text-xs font-bold text-brand-brown"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-brand-brown">
                <input
                  type="checkbox"
                  checked={redeemRegularOnly}
                  onChange={(e) => setRedeemRegularOnly(e.target.checked)}
                  className="h-4 w-4 accent-brand-orange"
                />
                <span>Penukaran khusus saluran Regular</span>
              </label>
              {editing && (
                <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-brand-brown">
                  <input
                    type="checkbox"
                    checked={isActive}
                    onChange={(e) => setIsActive(e.target.checked)}
                    className="h-4 w-4 accent-brand-orange"
                  />
                  <span>Voucher Aktif</span>
                </label>
              )}
            </div>
          </div>
        </form>
      </BottomSheet>
    </div>
  );
}
