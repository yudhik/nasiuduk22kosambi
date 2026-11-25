import { AlertCircle, CheckCircle2, Info } from 'lucide-react';

export interface ToastMessage {
  id: number;
  title: string;
  description?: string;
  tone?: 'success' | 'error' | 'info';
}

interface ToastContainerProps {
  toasts: ToastMessage[];
  onDismiss: (id: number) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div
      className="no-print pointer-events-none fixed inset-x-3 top-16 z-50 flex flex-col items-center gap-2 sm:inset-x-auto sm:right-4 sm:top-20 sm:w-96 sm:items-end"
      aria-live="polite"
    >
      {toasts.map((toast) => {
        const tone = toast.tone ?? 'success';
        const styles =
          tone === 'error'
            ? 'border-rose-300 bg-rose-50/95 text-rose-900'
            : tone === 'info'
              ? 'border-brand-amber bg-brand-cream/95 text-brand-brown'
              : 'border-emerald-300 bg-emerald-50/95 text-emerald-950';

        return (
          <div
            key={toast.id}
            onClick={() => onDismiss(toast.id)}
            className={`pointer-events-auto flex w-full cursor-pointer items-start gap-2.5 rounded-2xl border px-4 py-3 shadow-lg backdrop-blur transition-all ${styles}`}
          >
            {tone === 'error' ? (
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" />
            ) : tone === 'info' ? (
              <Info className="mt-0.5 h-5 w-5 shrink-0 text-brand-orange" />
            ) : (
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold leading-snug">{toast.title}</p>
              {toast.description && (
                <p className="mt-0.5 text-xs opacity-90">{toast.description}</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
