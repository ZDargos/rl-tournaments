import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Dialog, Tabs as RTabs } from 'radix-ui';
import { Toaster, toast as sonner } from 'sonner';
import { AlertTriangle, CheckCircle2, Info, Search, X, XCircle, type LucideIcon } from 'lucide-react';
import { STATE_LABELS, type TournamentState } from '@rl/core';

/** Tailwind-friendly class joiner (shadcn's `cn`). */
export const cn = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

/** Discord's own mark (simple-icons, CC0), drawn in Discord's colour by the .discord-mark class. */
export function DiscordMark() {
  return (
    <svg className="discord-mark" viewBox="0 0 24 24" aria-hidden focusable="false" fill="currentColor">
      <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
    </svg>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="center" role="status" aria-live="polite">
      <div className="spinner" />
      {label && <div className="muted small" style={{ marginTop: 10 }}>{label}</div>}
    </div>
  );
}

const ALERT_ICON: Record<string, LucideIcon> = { error: XCircle, warn: AlertTriangle, ok: CheckCircle2, info: Info };

/** A message box. `kind` picks the color and icon. */
export function Alert({ kind = 'info', children, className, icon = true }: { kind?: 'error' | 'warn' | 'ok' | 'info'; children: ReactNode; className?: string; icon?: boolean }) {
  const Icon = ALERT_ICON[kind];
  return (
    <div className={cn('alert', kind, icon && 'with-icon', className)} role={kind === 'error' ? 'alert' : undefined}>
      {icon ? <><Icon aria-hidden /><div>{children}</div></> : children}
    </div>
  );
}

export function ErrorBox({ error, title }: { error: any; title?: string }) {
  if (!error) return null;
  const msg = typeof error === 'string' ? error : error.message ?? String(error);
  const problems: string[] | undefined = error?.details?.problems;
  return (
    <Alert kind="error">
      {title && <strong>{title} </strong>}
      {msg}
      {problems && problems.length > 0 && (
        <ul>
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
    </Alert>
  );
}

export function Empty({ icon: Icon = Search, title, children }: { icon?: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon"><Icon aria-hidden /></div>
      <div className="title">{title}</div>
      {children && <div className="small" style={{ maxWidth: 520 }}>{children}</div>}
    </div>
  );
}

const STATE_COLOR: Record<string, string> = {
  draft: '', published: 'blue', registration_open: 'green', registration_closed: 'yellow', ready: 'yellow',
  in_progress: 'orange', paused: 'yellow', completed: 'blue', cancelled: 'red',
};
export function StateBadge({ state }: { state: TournamentState | string }) {
  return (
    <span className={cn('badge', STATE_COLOR[state], state === 'in_progress' && 'live')}>
      {state === 'in_progress' && <span className="dot" />}
      {STATE_LABELS[state as TournamentState] ?? state}
    </span>
  );
}

const MATCH_COLOR: Record<string, string> = { pending: '', ready: 'orange', awaiting_confirmation: 'yellow', disputed: 'red', completed: 'green', void: '', cancelled: 'red' };
const MATCH_LABEL: Record<string, string> = { pending: 'Waiting', ready: 'Live', awaiting_confirmation: 'Awaiting confirmation', disputed: 'Disputed', completed: 'Final', void: 'Not played', cancelled: 'Cancelled' };
export function MatchBadge({ status }: { status: string }) {
  return <span className={cn('badge', MATCH_COLOR[status])}>{MATCH_LABEL[status] ?? status}</span>;
}

const AVAILABILITY: Record<string, { color: string; label: string; tip: string }> = {
  confirmed: { color: 'green', label: 'Confirmed', tip: 'Said they can make it.' },
  declined: { color: 'red', label: 'Can’t make it', tip: 'Said they can’t make it.' },
  maybe: { color: 'orange', label: 'Maybe', tip: 'Did not answer within a day of the reminder.' },
  awaiting: { color: 'yellow', label: 'Waiting', tip: 'Got the reminder, has not answered yet.' },
  not_asked: { color: '', label: 'Not asked', tip: 'No reminder with the question has reached them yet (or their DMs are off).' },
};
export const AVAILABILITY_ORDER = ['confirmed', 'declined', 'maybe', 'awaiting', 'not_asked'] as const;
export function AvailabilityBadge({ status }: { status?: string | null }) {
  if (!status) return null;
  const a = AVAILABILITY[status] ?? AVAILABILITY.not_asked;
  return <span className={cn('badge', a.color)} title={a.tip}>{a.label}</span>;
}

export function Avatar({ name, url, size }: { name: string; url?: string | null; size?: 'lg' }) {
  return <span className={cn('avatar', size)}>{url ? <img src={url} alt="" referrerPolicy="no-referrer" /> : (name || '?').slice(0, 1).toUpperCase()}</span>;
}

/**
 * An ⓘ that explains a setting on hover, keyboard focus or tap. The bubble is positioned with
 * `fixed` so scrolling tables and cards never clip it, and kept inside the screen on phones.
 */
export function Help({ text }: { text: string }) {
  const [pos, setPos] = useState<{ top: number; left: number; above: boolean } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const tipId = useId();
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(300, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8));
    const above = r.bottom + 180 > window.innerHeight && r.top > 180;
    setPos({ top: above ? r.top - 6 : r.bottom + 6, left, above });
  };
  const hide = () => setPos(null);
  useEffect(() => {
    if (!pos) return;
    window.addEventListener('scroll', hide, true);
    return () => window.removeEventListener('scroll', hide, true);
  }, [pos]);
  return (
    <span
      ref={ref}
      className="help"
      tabIndex={0}
      role="button"
      aria-label="What does this do?"
      aria-describedby={pos ? tipId : undefined}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      // Inside a <label>, a click would toggle the checkbox or focus the input: show the help instead.
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        show(); // on phones a tap focuses and clicks; tapping elsewhere (blur) closes it
      }}
    >
      <Info aria-hidden />
      {pos && (
        <span id={tipId} role="tooltip" className={cn('help-tip', pos.above && 'above')} style={{ top: pos.top, left: pos.left, width: Math.min(300, window.innerWidth - 16) }}>
          {text}
        </span>
      )}
    </span>
  );
}

export function Field({ label, hint, help, children, className }: { label: string; hint?: ReactNode; help?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn('field', className)}>
      <span>{label}{help && <Help text={help} />}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function Check({ label, checked, onChange, disabled, help }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; help?: string }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}{help && <Help text={help} />}</span>
    </label>
  );
}

/** Pick one of a few options (filters). Buttons with aria-pressed, so it reads as a toggle group. */
export function Segmented<T extends string>({ options, value, onChange, label }: { options: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={value === o.id} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

export type TabDef<T extends string> = { id: T; label: ReactNode; icon?: LucideIcon; count?: number };

/** Accessible tab strip (Radix: arrow keys move between tabs). The page renders the active panel. */
export function Tabs<T extends string>({ tabs, value, onChange, orientation = 'horizontal', children, className }: { tabs: TabDef<T>[]; value: T; onChange: (v: T) => void; orientation?: 'horizontal' | 'vertical'; children?: ReactNode; className?: string }) {
  return (
    <RTabs.Root value={value} onValueChange={(v) => onChange(v as T)} orientation={orientation} className={className} activationMode="manual">
      <RTabs.List className="tabs" aria-label="Sections">
        {tabs.map((t) => (
          <RTabs.Trigger key={t.id} value={t.id}>
            {t.icon && <t.icon aria-hidden />}
            {t.label}
            {t.count != null && <span className="tab-count">{t.count}</span>}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {children && <div className="min-w-0">{children}</div>}
    </RTabs.Root>
  );
}

/** Dialog with focus trap, Escape to close and scroll lock (Radix). */
export function Modal({ title, onClose, children, description }: { title: string; onClose: () => void; children: ReactNode; description?: string }) {
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop" />
        <Dialog.Content className="card modal" aria-describedby={description ? undefined : undefined}>
          <div className="card-head">
            <Dialog.Title asChild><h3>{title}</h3></Dialog.Title>
            <Dialog.Close className="btn ghost small icon-btn" aria-label="Close"><X /></Dialog.Close>
          </div>
          {description ? <Dialog.Description className="muted small">{description}</Dialog.Description> : <Dialog.Description className="sr-only">{title}</Dialog.Description>}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type ToastKind = 'ok' | 'error' | 'info';
const push = (text: string, kind: ToastKind = 'ok') => {
  if (kind === 'error') sonner.error(text);
  else if (kind === 'info') sonner.info(text);
  else sonner.success(text);
};
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <Toaster
        theme="dark"
        position="bottom-right"
        duration={5000}
        toastOptions={{ style: { background: 'var(--color-raised)', border: '1px solid var(--color-line)', color: 'var(--color-ink)', fontFamily: 'var(--font-sans)', fontSize: '0.94rem' } }}
      />
    </>
  );
}
export const useToast = () => push;

/** Confirm-before-acting button with an optional reason prompt. */
export function ConfirmButton({ label, confirm, onConfirm, className = 'btn', reason, disabled, confirmLabel = 'Confirm' }: { label: ReactNode; confirm: string; onConfirm: (reason: string) => Promise<unknown> | void; className?: string; reason?: 'required' | 'optional'; disabled?: boolean; confirmLabel?: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} disabled={disabled}>{label}</button>
      {open && (
        <Modal title="Please confirm" onClose={() => setOpen(false)}>
          <p>{confirm}</p>
          {reason && (
            <Field label={reason === 'required' ? 'Reason (kept in the activity log)' : 'Reason (optional)'}>
              <input autoFocus value={text} onChange={(e) => setText(e.target.value)} maxLength={300} />
            </Field>
          )}
          <div className="row end" style={{ marginTop: 16 }}>
            <button type="button" className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || (reason === 'required' && text.trim().length < 3)}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm(text.trim());
                  setOpen(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {confirmLabel}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
