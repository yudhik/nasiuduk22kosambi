import { useEffect, useId, useRef } from 'react';
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
  const titleId = useId();
  const subtitleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-brand-brown-dark/55 backdrop-blur-[1px] sm:items-center sm:p-4"
      onClick={() => onCloseRef.current()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        className="flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-3xl border border-brand-amber-soft bg-white shadow-2xl sm:max-w-lg sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-brand-amber-soft/70 bg-brand-cream/60 px-5 pb-3.5 pt-4">
          <div className="min-w-0">
            <h3
              id={titleId}
              className="truncate text-base font-extrabold text-brand-brown sm:text-lg"
            >
              {title}
            </h3>
            {subtitle && (
              <p id={subtitleId} className="mt-0.5 text-xs text-brand-brown/75">
                {subtitle}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => onCloseRef.current()}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-cream-deep text-brand-brown transition hover:bg-brand-amber-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange active:scale-95"
            aria-label="Tutup"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {/* Optional Sticky Footer */}
        {footer && (
          <div className="border-t border-brand-amber-soft/70 bg-brand-cream/80 px-5 py-3.5 pb-safe">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
