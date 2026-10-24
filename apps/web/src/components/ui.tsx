import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { STATE_LABELS, type TournamentState } from '@rl/core';

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="center" role="status" aria-live="polite">
      <div className="spinner" />
      {label && <div className="muted small" style={{ marginTop: 8 }}>{label}</div>}
    </div>
  );
}

export function ErrorBox({ error, title }: { error: any; title?: string }) {
  if (!error) return null;
  const msg = typeof error === 'string' ? error : error.message ?? String(error);
  const problems: string[] | undefined = error?.details?.problems;
  return (
    <div className="alert error" role="alert">
      {title && <strong>{title} </strong>}
      {msg}
      {problems && problems.length > 0 && (
        <ul>
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
    </div>
  );
}

export function Empty({ icon = '🏟️', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="big">{icon}</div>
      <div style={{ fontWeight: 700, color: 'var(--text)' }}>{title}</div>
      {children && <div className="small" style={{ marginTop: 6 }}>{children}</div>}
    </div>
  );
}

const STATE_COLOR: Record<string, string> = {
  draft: '', published: 'blue', registration_open: 'green', registration_closed: 'yellow', ready: 'yellow',
  in_progress: 'orange', paused: 'yellow', completed: 'blue', cancelled: 'red',
};
export function StateBadge({ state }: { state: TournamentState | string }) {
  return (
    <span className={`badge ${STATE_COLOR[state] ?? ''} ${state === 'in_progress' ? 'live' : ''}`}>
      {state === 'in_progress' && <span className="dot" />}
      {STATE_LABELS[state as TournamentState] ?? state}
    </span>
  );
}

const MATCH_COLOR: Record<string, string> = { pending: '', ready: 'orange', awaiting_confirmation: 'yellow', disputed: 'red', completed: 'green', void: '', cancelled: 'red' };
const MATCH_LABEL: Record<string, string> = { pending: 'Waiting', ready: 'Live', awaiting_confirmation: 'Awaiting confirmation', disputed: 'Disputed', completed: 'Final', void: 'Not played', cancelled: 'Cancelled' };
export function MatchBadge({ status }: { status: string }) {
  return <span className={`badge ${MATCH_COLOR[status] ?? ''}`}>{MATCH_LABEL[status] ?? status}</span>;
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
  return <span className={`badge ${a.color}`} title={a.tip}>{a.label}</span>;
}

export function Avatar({ name, url }: { name: string; url?: string | null }) {
  return <span className="avatar">{url ? <img src={url} alt="" referrerPolicy="no-referrer" /> : (name || '?').slice(0, 1).toUpperCase()}</span>;
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
      ⓘ
      {pos && (
        <span id={tipId} role="tooltip" className={`help-tip${pos.above ? ' above' : ''}`} style={{ top: pos.top, left: pos.left, width: Math.min(300, window.innerWidth - 16) }}>
          {text}
        </span>
      )}
    </span>
  );
}

export function Field({ label, hint, help, children }: { label: string; hint?: ReactNode; help?: string; children: ReactNode }) {
  return (
    <label className="field">
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

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? 'active' : ''} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={title}>
      <div className="card modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <h3>{title}</h3>
          <button className="btn ghost small" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

type Toast = { id: number; text: string; kind: 'ok' | 'error' | 'info' };
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** Confirm-before-acting button with an optional reason prompt. */
export function ConfirmButton({ label, confirm, onConfirm, className = 'btn', reason, disabled }: { label: ReactNode; confirm: string; onConfirm: (reason: string) => Promise<unknown> | void; className?: string; reason?: 'required' | 'optional'; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button className={className} onClick={() => setOpen(true)} disabled={disabled}>{label}</button>
      {open && (
        <Modal title="Please confirm" onClose={() => setOpen(false)}>
          <p>{confirm}</p>
          {reason && (
            <Field label={reason === 'required' ? 'Reason (kept in the audit log)' : 'Reason (optional)'}>
              <input autoFocus value={text} onChange={(e) => setText(e.target.value)} maxLength={300} />
            </Field>
          )}
          <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button
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
              Confirm
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
