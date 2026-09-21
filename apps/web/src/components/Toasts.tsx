import { useToast } from '../state/ToastContext';
import { Button } from './ui';

/** Live region for transient feedback. Errors are assertive, the rest polite. */
export function Toasts(): JSX.Element {
  const { toasts, dismiss } = useToast();

  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast--${toast.tone}`}
          role={toast.tone === 'error' ? 'alert' : 'status'}
          aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
        >
          <span>{toast.message}</span>
          <Button variant="ghost" size="sm" onClick={() => dismiss(toast.id)} aria-label="Dismiss">
            ✕
          </Button>
        </div>
      ))}
    </div>
  );
}
