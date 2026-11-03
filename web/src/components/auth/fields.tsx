import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { EyeIcon, EyeOffIcon } from '../landing/icons';

const inputClass =
  'block w-full rounded-xl border border-white/10 bg-ink-900 px-3.5 py-2.5 text-[15px] text-white placeholder:text-slate-600 transition focus:border-pulse-400/60 focus:outline-none focus:ring-4 focus:ring-pulse-400/10 aria-[invalid=true]:border-rose-400/60 disabled:opacity-60';

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  trailing?: ReactNode;
}

export function TextField({ label, hint, error, trailing, className = '', ...props }: FieldProps) {
  const id = useId();
  const describedBy =
    [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-200">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`${inputClass} ${trailing ? 'pr-11' : ''} ${className}`}
          {...props}
        />
        {trailing && (
          <div className="absolute inset-y-0 right-1.5 flex items-center">{trailing}</div>
        )}
      </div>
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-slate-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1.5 text-xs text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}

/** Masked by default; the toggle is a real button with an accessible name and pressed state. */
export function SecretField(props: Omit<FieldProps, 'type' | 'trailing'>) {
  const [visible, setVisible] = useState(false);
  return (
    <TextField
      {...props}
      type={visible ? 'text' : 'password'}
      spellCheck={false}
      autoCapitalize="off"
      trailing={
        <button
          type="button"
          onClick={() => setVisible((value) => !value)}
          aria-label={
            visible ? `Hide ${props.label.toLowerCase()}` : `Show ${props.label.toLowerCase()}`
          }
          aria-pressed={visible}
          className="rounded-lg p-2 text-slate-500 transition hover:text-slate-200 focus-visible:outline-2 focus-visible:outline-pulse-400"
        >
          {visible ? (
            <EyeOffIcon className="h-[18px] w-[18px]" />
          ) : (
            <EyeIcon className="h-[18px] w-[18px]" />
          )}
        </button>
      }
    />
  );
}

export function SubmitButton({
  busy,
  busyLabel,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy: boolean; busyLabel: string }) {
  return (
    <button
      type="submit"
      {...props}
      disabled={busy || props.disabled}
      aria-busy={busy}
      className="flex w-full items-center justify-center gap-2 rounded-xl bg-pulse-400 px-4 py-3 text-sm font-semibold text-ink-950 transition hover:bg-pulse-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pulse-300 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy && (
        <span
          aria-hidden="true"
          className="h-4 w-4 animate-spin rounded-full border-2 border-ink-950/30 border-t-ink-950"
        />
      )}
      {busy ? busyLabel : children}
    </button>
  );
}

export function Alert({
  tone,
  children,
}: {
  tone: 'error' | 'success' | 'info';
  children: ReactNode;
}) {
  const styles = {
    error: 'border-rose-400/25 bg-rose-400/[0.07] text-rose-200',
    success: 'border-emerald-400/25 bg-emerald-400/[0.07] text-emerald-200',
    info: 'border-pulse-400/20 bg-pulse-400/[0.06] text-slate-300',
  }[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-xl border px-3.5 py-3 text-sm leading-relaxed ${styles}`}
    >
      {children}
    </div>
  );
}
