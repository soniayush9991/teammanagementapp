import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import type { TaskPriority, UtilizationBand } from '@teamspace/shared';

/* ---------------------------------------------------------------------------
   Primitives shared by every screen. They are deliberately small and
   unopinionated about layout — pages compose them.
   --------------------------------------------------------------------------- */

export function Card({
  title,
  actions,
  children,
  flush,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}): JSX.Element {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card__header">
          {typeof title === 'string' ? <h2 className="card__title">{title}</h2> : title}
          {actions}
        </header>
      )}
      <div className={flush ? 'card__body card__body--flush' : 'card__body'}>{children}</div>
    </section>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'sm';
  block?: boolean;
};

export function Button({
  variant = 'primary',
  size = 'md',
  block,
  className = '',
  type = 'button',
  ...rest
}: ButtonProps): JSX.Element {
  const classes = [
    'btn',
    variant !== 'primary' ? `btn--${variant}` : '',
    size === 'sm' ? 'btn--sm' : '',
    block ? 'btn--block' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  // eslint-disable-next-line react/button-has-type -- type is constrained above
  return <button type={type} className={classes} {...rest} />;
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  htmlFor: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && !error && (
        <span className="field__hint" id={`${htmlFor}-hint`}>
          {hint}
        </span>
      )}
      {error && (
        <span className="field__error" id={`${htmlFor}-error`} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return <input className="input" {...props} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>): JSX.Element {
  return <select className="select" {...props} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
  return <textarea className="textarea" {...props} />;
}

export function Badge({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: UtilizationBand | 'accent';
}): JSX.Element {
  return <span className={`badge${tone ? ` badge--${tone}` : ''}`}>{children}</span>;
}

export function Avatar({
  name,
  src,
  size = 'md',
}: {
  name: string;
  src?: string | null;
  size?: 'sm' | 'md' | 'lg';
}): JSX.Element {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();

  return (
    <span className={`avatar${size === 'md' ? '' : ` avatar--${size}`}`} title={name}>
      {src ? <img src={src} alt="" /> : <span aria-hidden="true">{initials}</span>}
      <span className="sr-only">{name}</span>
    </span>
  );
}

export function AvatarStack({
  people,
  max = 3,
}: {
  people: { displayName: string; avatarUrl?: string | null }[];
  max?: number;
}): JSX.Element {
  const shown = people.slice(0, max);
  const overflow = people.length - shown.length;
  return (
    <span className="avatar-stack">
      {shown.map((person) => (
        <Avatar key={person.displayName} name={person.displayName} src={person.avatarUrl} size="sm" />
      ))}
      {overflow > 0 && (
        <span className="avatar avatar--sm" title={`${overflow} more`}>
          +{overflow}
        </span>
      )}
    </span>
  );
}

export function EmptyState({
  icon = '—',
  title,
  description,
  action,
}: {
  icon?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="empty-state">
      <span className="empty-state__icon" aria-hidden="true">
        {icon}
      </span>
      <p className="empty-state__title">{title}</p>
      {description && <p className="muted">{description}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ height = 16, width = '100%' }: { height?: number; width?: string }): JSX.Element {
  return <div className="skeleton" style={{ height, width }} aria-hidden="true" />;
}

export function LoadingBlock({ rows = 3, label }: { rows?: number; label: string }): JSX.Element {
  return (
    <div className="stack" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={index === 0 ? 24 : 16} />
      ))}
    </div>
  );
}

export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry?: () => void }): JSX.Element {
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <EmptyState
      icon="!"
      title="That did not load"
      description={message}
      action={onRetry ? <Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button> : undefined}
    />
  );
}

export function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: UtilizationBand;
}): JSX.Element {
  return (
    <Card>
      <p className="metric__label">{label}</p>
      <p className="metric__value" style={tone ? { color: `var(--band-${tone.replace('_', '-')})` } : undefined}>
        {value}
      </p>
      {hint && <p className="metric__hint">{hint}</p>}
    </Card>
  );
}

/**
 * Utilization is shown three ways at once — bar length, colour and a printed
 * percentage — because colour alone fails for colour-blind users and in
 * greyscale print-outs.
 */
export function UtilizationMeter({
  utilization,
  band,
  label,
}: {
  utilization: number;
  band: UtilizationBand;
  label?: string;
}): JSX.Element {
  const finite = Number.isFinite(utilization);
  const percent = finite ? Math.round(utilization * 100) : 999;
  // The bar is scaled so 100% sits at two thirds, leaving room to show
  // over-allocation rather than clipping it at the end of the track.
  const width = Math.min(100, (percent / 150) * 100);

  return (
    <div
      role="meter"
      aria-valuenow={finite ? percent : 150}
      aria-valuemin={0}
      aria-valuemax={150}
      aria-label={label ?? `Utilization ${percent}%`}
      title={`${percent}% of available capacity`}
    >
      <div className="meter">
        <div className={`meter__fill meter__fill--${band}`} style={{ width: `${width}%` }} />
        <div className="meter__limit" style={{ left: `${(100 / 150) * 100}%` }} />
      </div>
    </div>
  );
}

export function BandBadge({ band }: { band: UtilizationBand }): JSX.Element {
  // A glyph accompanies the colour so the state survives greyscale.
  const copy: Record<UtilizationBand, { icon: string; text: string }> = {
    healthy: { icon: '●', text: 'Healthy' },
    near_capacity: { icon: '◐', text: 'Near capacity' },
    overloaded: { icon: '▲', text: 'Overloaded' },
    underutilized: { icon: '○', text: 'Has bandwidth' },
  };
  const { icon, text } = copy[band];
  return (
    <Badge tone={band}>
      <span aria-hidden="true">{icon}</span>
      {text}
    </Badge>
  );
}

export function PriorityDot({ priority }: { priority: TaskPriority }): JSX.Element {
  return (
    <span className="row" style={{ gap: 4 }}>
      <span className={`priority-dot priority-dot--${priority}`} aria-hidden="true" />
      <span className="tiny" style={{ textTransform: 'capitalize' }}>
        {priority}
      </span>
    </span>
  );
}

export function DueDate({ date, done }: { date: string | null; done?: boolean }): JSX.Element | null {
  if (!date) return null;
  const due = new Date(`${date}T00:00:00Z`);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const overdue = !done && due < today;
  const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);

  const label =
    days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : days < 0 ? `${Math.abs(days)}d overdue` : `Due in ${days}d`;

  return (
    <span className={overdue ? 'due due--overdue' : 'due'}>
      {overdue && <span aria-hidden="true">! </span>}
      {label}
    </span>
  );
}

/**
 * A modal that traps focus, restores it on close and responds to Escape —
 * the three things a dialog must do to be usable from a keyboard.
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}): JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const focusable = dialogRef.current?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused.current?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={dialogRef}>
        <header className="card__header">
          <h2 className="card__title">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close dialog">
            ✕
          </Button>
        </header>
        <div className="card__body">{children}</div>
        {footer && <div className="card__header" style={{ borderTop: '1px solid var(--border-subtle)', borderBottom: 'none', justifyContent: 'flex-end' }}>{footer}</div>}
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="page-header__subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function formatHours(hours: number): string {
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}

export function formatPercent(value: number): string {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '>150%';
}

export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
