import { useState } from 'react';
import { Printer, X } from 'lucide-react';
import type { OrderDetail } from '../types';
import { formatDateTime, formatRupiah } from '../utils/format';

interface ReceiptPrintViewProps {
  order: OrderDetail | null;
  shopName: string;
  onClose: () => void;
}

type PaperSize = '58' | '80' | 'a4';

export function ReceiptPrintView({ order, shopName, onClose }: ReceiptPrintViewProps) {
  const [paperSize, setPaperSize] = useState<PaperSize>('80');

  if (!order) return null;

  const statusLabel =
    order.status === 'PAID'
      ? 'LUNAS'
      : order.status === 'VOIDED'
        ? 'DIBATALKAN'
        : 'BELUM BAYAR';

  const paperClass =
    paperSize === '58'
      ? 'receipt-paper-58 max-w-[240px]'
      : paperSize === '80'
        ? 'receipt-paper-80 max-w-[320px]'
        : 'receipt-paper-a4 max-w-[560px]';

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/60 sm:items-center sm:p-4 print:static print:block print:bg-white print:p-0"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:max-w-xl sm:rounded-2xl print:max-h-none print:max-w-none print:rounded-none print:shadow-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Mobile grab handle */}
        <div className="no-print flex justify-center pt-2.5 sm:hidden">
          <div className="h-1.5 w-12 rounded-full bg-slate-300" />
        </div>

        {/* Modal header & paper switcher - hidden during print */}
        <div className="no-print space-y-2.5 border-b border-slate-200 bg-slate-50 px-4 py-3 sm:px-5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-slate-900 sm:text-base">
              Preview Nota {order.order_number}
            </h3>
            <button
              type="button"
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-200/70 text-slate-600 hover:bg-slate-200"
              aria-label="Tutup preview"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-1.5 rounded-xl bg-slate-200/70 p-1">
            {(['58', '80', 'a4'] as PaperSize[]).map((size) => (
              <button
                key={size}
                type="button"
                onClick={() => setPaperSize(size)}
                className={`h-9 rounded-lg text-xs font-bold transition ${
                  paperSize === size
                    ? 'bg-white text-emerald-700 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {size === 'a4' ? 'Standar A4' : `Thermal ${size}mm`}
              </button>
            ))}
          </div>
        </div>

        {/* Printable Receipt Body */}
        <div className="flex-1 overflow-y-auto bg-slate-100 p-4 sm:p-6 print:overflow-visible print:bg-white print:p-0">
          <div
            className={`print-only-container mx-auto rounded-xl border border-slate-200 bg-white p-5 font-mono text-xs text-slate-900 shadow-sm ${paperClass}`}
          >
            <div className="border-b border-dashed border-slate-400 pb-3 text-center">
              <h2 className="text-base font-bold uppercase tracking-wide">{shopName}</h2>
              <p className="mt-0.5 text-[11px] text-slate-600">Nota Pesanan Digital</p>
            </div>

            <div className="space-y-1 border-b border-dashed border-slate-400 py-2.5 text-[11px]">
              <div className="flex justify-between gap-2">
                <span className="text-slate-600">No. Nota</span>
                <span className="font-bold">{order.order_number}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-600">Waktu</span>
                <span>{formatDateTime(order.created_at)}</span>
              </div>
              {order.customer_label && (
                <div className="flex justify-between gap-2">
                  <span className="text-slate-600">Pelanggan</span>
                  <span className="font-semibold">{order.customer_label}</span>
                </div>
              )}
              {order.waiter_name && (
                <div className="flex justify-between gap-2">
                  <span className="text-slate-600">Pelayan</span>
                  <span>{order.waiter_name}</span>
                </div>
              )}
              <div className="flex justify-between gap-2">
                <span className="text-slate-600">Status</span>
                <span className="font-bold">{statusLabel}</span>
              </div>
            </div>

            <div className="space-y-2 border-b border-dashed border-slate-400 py-3">
              {order.items.map((item) => (
                <div key={item.id}>
                  <div className="flex justify-between gap-2 font-semibold">
                    <span>{item.menu_name_snapshot}</span>
                    <span>{formatRupiah(item.subtotal)}</span>
                  </div>
                  <div className="flex justify-between text-[11px] text-slate-600">
                    <span>
                      {item.quantity} x {formatRupiah(item.unit_price_snapshot)}
                    </span>
                  </div>
                  {item.item_note && (
                    <div className="text-[10px] italic text-slate-500">
                      Catatan: {item.item_note}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {order.notes && (
              <div className="border-b border-dashed border-slate-400 py-2 text-[11px]">
                <span className="font-semibold">Catatan Nota: </span>
                <span>{order.notes}</span>
              </div>
            )}

            <div className="flex items-center justify-between pt-3 text-sm font-bold">
              <span>TOTAL</span>
              <span>{formatRupiah(order.total_amount)}</span>
            </div>

            {order.paid_at && (
              <div className="mt-1 flex justify-between text-[10px] text-slate-600">
                <span>Dibayar pada</span>
                <span>{formatDateTime(order.paid_at)}</span>
              </div>
            )}

            {order.void_reason && (
              <div className="mt-2 rounded border border-red-300 bg-red-50 p-1.5 text-[10px] text-red-700">
                Alasan Batal: {order.void_reason}
              </div>
            )}

            <div className="mt-4 border-t border-dashed border-slate-400 pt-2.5 text-center text-[11px] text-slate-600">
              Terima kasih atas kunjungan Anda!
            </div>
          </div>
        </div>

        {/* Sticky Print CTA Footer - hidden during print */}
        <div className="no-print border-t border-slate-200 bg-white px-4 py-3 pb-safe sm:px-5">
          <button
            type="button"
            onClick={() => window.print()}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 text-sm font-bold text-white shadow-sm active:scale-[0.99] hover:bg-emerald-700"
          >
            <Printer className="h-5 w-5" />
            Cetak Nota Sekarang
          </button>
        </div>
      </div>
    </div>
  );
}
