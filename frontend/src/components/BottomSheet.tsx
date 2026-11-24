import { useEffect } from 'react';
import { X } from 'lucide-react';

interface BottomSheetProps {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

export function BottomSheet({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
}: BottomSheetProps) {
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/60 backdrop-blur-[1px] sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:max-w-lg sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Mobile grab handle */}
        <div className="flex justify-center pt-2.5 sm:hidden">
          <div className="h-1.5 w-12 rounded-full bg-slate-300" />
        </div>

        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 pb-3 pt-3 sm:pt-4">
          <div className="min-w-0">
            <h3 className="truncate text-base font-bold text-slate-900 sm:text-lg">
              {title}
            </h3>
            {subtitle && (
              <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600 active:scale-95 hover:bg-slate-200"
            aria-label="Tutup"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {/* Optional Sticky Footer */}
        {footer && (
          <div className="border-t border-slate-100 bg-slate-50/90 px-5 py-3.5 pb-safe">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
