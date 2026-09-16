/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { cn } from '../../lib/utils';

type ToastVariant = 'success' | 'error' | 'info';

interface ToastData {
  id: number;
  message: string;
  variant: ToastVariant;
  title?: string;
}

interface ToastOptions {
  title?: string;
  duration?: number;
}

interface ToastContextValue {
  success: (message: string, opts?: ToastOptions) => void;
  error: (message: string, opts?: ToastOptions) => void;
  info: (message: string, opts?: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const VARIANT_STYLES: Record<ToastVariant, { icon: typeof Info; box: string; iconColor: string }> = {
  success: { icon: CheckCircle2, box: 'border-green-500/30', iconColor: 'text-green-500' },
  error: { icon: AlertCircle, box: 'border-destructive/40', iconColor: 'text-destructive' },
  info: { icon: Info, box: 'border-primary/30', iconColor: 'text-primary' },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastData[]>([]);

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (variant: ToastVariant, message: string, opts: ToastOptions = {}) => {
      const id = Date.now() + Math.random();
      setToasts((prev) => [...prev, { id, message, variant, title: opts.title }]);
      const duration = opts.duration ?? 4000;
      if (duration > 0) {
        setTimeout(() => remove(id), duration);
      }
    },
    [remove]
  );

  const api: ToastContextValue = {
    success: useCallback((m, o) => push('success', m, o), [push]),
    error: useCallback((m, o) => push('error', m, o), [push]),
    info: useCallback((m, o) => push('info', m, o), [push]),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Toast viewport */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-3">
        {toasts.map((toast) => {
          const { icon: Icon, box, iconColor } = VARIANT_STYLES[toast.variant];
          return (
            <div
              key={toast.id}
              role="status"
              className={cn(
                'pointer-events-auto flex items-start gap-3 rounded-xl border bg-card p-4 text-sm shadow-lg',
                'ring-1 ring-foreground/10 animate-in slide-in-from-bottom-4 fade-in duration-300',
                box
              )}
            >
              <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', iconColor)} />
              <div className="min-w-0 flex-1">
                {toast.title && (
                  <p className="font-semibold text-foreground">{toast.title}</p>
                )}
                <p className="text-muted-foreground">{toast.message}</p>
              </div>
              <button
                onClick={() => remove(toast.id)}
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Dismiss notification"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}