import { useState } from 'react';
import { CalendarClock, Check as CheckIcon, Send, X } from 'lucide-react';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { fmtDate, isoToLocalInput, localInputToIso, relTime } from '../lib/format';
import { Alert, ConfirmButton, ErrorBox, Field, Help, cn, useToast } from './ui';

const HELP_TEXT =
  'Propose one new date and time and say why. Every registered player gets a Discord DM with "Yes, I can make it" and "No, I can’t" buttons, and can also answer on the tournament page or on a card in the registration channel. You see every answer here. When you are ready, move the tournament to the new time (each answer then counts as that player’s “can you make it?” for it) or keep the current time. Players are told either way.';

function Tally({ c }: { c: { yes: number; no: number; waiting: number; total: number } }) {
  const pct = (n: number) => (c.total ? (n / c.total) * 100 : 0);
  return (
    <div className="stack tight">
      <div className="split-bar" aria-hidden>
        <span className="yes" style={{ width: `${pct(c.yes)}%` }} />
        <span className="no" style={{ width: `${pct(c.no)}%` }} />
      </div>
      <div className="row small" style={{ gap: 16 }}>
        <span><strong style={{ color: 'var(--green)' }}>{c.yes}</strong> can make it</span>
        <span><strong style={{ color: 'var(--red)' }}>{c.no}</strong> can’t</span>
        <span className="muted"><strong>{c.waiting}</strong> haven’t answered</span>
      </div>
    </div>
  );
}

function Proposal({ v }: { v: any }) {
  return (
    <div className="stack tight">
      <div>
        <div className="muted small">New time</div>
        <div className="display" style={{ fontSize: '1.6rem', fontWeight: 800, lineHeight: 1.1 }}>{fmtDate(v.proposedAt)}</div>
        <div className="muted small">{v.previousAt ? <>Currently <s>{fmtDate(v.previousAt)}</s></> : 'No start time was set before.'}</div>
      </div>
      <blockquote className="small" style={{ margin: 0, padding: '8px 12px', borderLeft: '3px solid var(--line)', background: 'var(--color-pitch)', borderRadius: '0 8px 8px 0', whiteSpace: 'pre-wrap' }}>{v.reason}</blockquote>
    </div>
  );
}

/** Players: answer the organizers' proposed new date (tournament overview). */
export function DateVoteAnswer({ d, reload }: { d: any; reload: () => void }) {
  const v = d.dateVote;
  const toast = useToast();
  const { busy, error, run } = useAsync();
  if (!v || v.status !== 'open' || !v.canAnswer) return null;
  const answer = async (a: 'yes' | 'no') => {
    if (await run(() => api(`/api/tournaments/${d.tournament.id}/date-vote/answer`, { body: { answer: a } }))) {
      toast(a === 'yes' ? 'Thanks, the organizers know you can make the new time' : 'The organizers know you can’t make the new time');
      reload();
    }
  };
  return (
    <div className="card accent-blue">
      <div className="todo">
        <div className="todo-icon blue"><CalendarClock aria-hidden /></div>
        <div className="todo-body stack">
          <div>
            <h3>The organizers want to move this tournament</h3>
            <p className="muted small" style={{ margin: 0 }}>Can you make the new time? You can change your answer until they decide.</p>
          </div>
          <Proposal v={v} />
          <div className="row">
            <button className={cn('btn', v.myAnswer === 'yes' ? 'success selected' : 'success')} aria-pressed={v.myAnswer === 'yes'} disabled={busy} onClick={() => void answer('yes')}><CheckIcon aria-hidden />Yes, I can make it</button>
            <button className={cn('btn', v.myAnswer === 'no' ? 'danger selected' : 'danger')} aria-pressed={v.myAnswer === 'no'} disabled={busy} onClick={() => void answer('no')}><X aria-hidden />No, I can’t</button>
          </div>
          {v.myAnswer && <p className="small muted" style={{ margin: 0 }}>You answered <strong>{v.myAnswer === 'yes' ? 'yes' : 'no'}</strong>. {v.counts.yes} of {v.counts.total} players can make it so far.</p>}
          <ErrorBox error={error} />
        </div>
      </div>
    </div>
  );
}

/** Organizers: propose a new date and watch the answers (Manage → Overview). */
export function DateVoteAdmin({ d, reload }: { d: any; reload: () => void }) {
  const t = d.tournament;
  const v = d.dateVote;
  const tz = t.config.schedule.timezone;
  const toast = useToast();
  const { busy, error, run } = useAsync();
  const [when, setWhen] = useState('');
  const [reason, setReason] = useState('');
  const preStart = !t.startedAt && t.state !== 'cancelled' && t.state !== 'completed';
  const players = new Set(d.entries.filter((e: any) => ['pending', 'confirmed', 'waitlisted'].includes(e.status)).flatMap((e: any) => (e.kind === 'team' ? e.members.map((m: any) => m.userId) : [e.userId]))).size;
  const open = v?.status === 'open';
  if (!preStart && !open) return null;
  const close = async (decision: 'move' | 'keep') => {
    if (await run(() => api(`/api/tournaments/${t.id}/date-vote/close`, { body: { decision } }))) {
      toast(decision === 'move' ? 'Moved to the new date. Players were told.' : 'Kept the current date. Players were told.');
      reload();
    }
  };
  const groups = open && v.players ? (['yes', 'no', null] as const).map((a) => ({ a, people: v.players.filter((p: any) => p.answer === a) })) : [];
  return (
    <div className="card">
      <div className="card-head">
        <h3 className="section-title"><CalendarClock aria-hidden />Change the date<Help text={HELP_TEXT} /></h3>
        {open && <span className="badge blue live"><span className="dot" />Players are answering</span>}
      </div>
      {open ? (
        <div className="stack">
          <Proposal v={v} />
          <Tally c={v.counts} />
          <div className="grid cols-3" style={{ gap: 12 }}>
            {groups.map(({ a, people }) => (
              <div key={String(a)} className="round">
                <h4>{a === 'yes' ? 'Can make it' : a === 'no' ? 'Can’t make it' : 'No answer yet'} ({people.length})</h4>
                {people.length === 0 ? <span className="faint small">Nobody</span> : (
                  <ul className="small stack tight" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                    {people.map((p: any) => <li key={p.userId}>{p.name}{!p.stillRegistered && <span className="faint"> (left)</span>}</li>)}
                  </ul>
                )}
              </div>
            ))}
          </div>
          <p className="muted small" style={{ margin: 0 }}>Proposed {relTime(v.createdAt)}.{!v.cardPosted && ' There is no card in Discord (no registration or announcement channel), so players answer by DM or on the website.'}</p>
          <div className="row">
            <ConfirmButton className="btn primary" label="Move to the new date" disabled={busy} confirm={`Move the start to ${fmtDate(v.proposedAt)}? Every registered player gets a DM, and reminders are rescheduled.`} onConfirm={() => close('move')} />
            <ConfirmButton className="btn" label="Keep the current date" disabled={busy} confirm="End the vote and keep the current start time? Players get a DM saying the date is staying." onConfirm={() => close('keep')} />
          </div>
        </div>
      ) : d.startPoll?.status === 'open' ? (
        <p className="muted small">Players are voting on the start time right now. Once that vote closes you can propose a different date here.</p>
      ) : (
        <form className="stack" onSubmit={async (e) => {
          e.preventDefault();
          const proposedAt = localInputToIso(when, tz);
          if (await run(() => api<{ recipients: number }>(`/api/tournaments/${t.id}/date-vote`, { body: { proposedAt, reason } }))) {
            toast(`Sent to ${players} player${players === 1 ? '' : 's'}`);
            setWhen('');
            setReason('');
            reload();
          }
        }}>
          <p className="muted small" style={{ margin: 0 }}>Ask every registered player whether a new date works before you move it.{t.startAt ? ` It starts ${fmtDate(t.startAt)} now.` : ''}</p>
          <div className="form-grid">
            <Field label={`New date and time (${tz})`}><input type="datetime-local" required value={when} min={isoToLocalInput(new Date().toISOString(), tz)} onChange={(e) => setWhen(e.target.value)} /></Field>
          </div>
          <Field label="Why do you want to change it?" hint="Players see this in the DM and on the tournament page.">
            <textarea required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. RLCS finals are on that evening, so a lot of you would miss it." />
          </Field>
          {players === 0 && <Alert kind="info">Nobody has registered yet, so there is no one to ask. Change the start time in Settings instead.</Alert>}
          <ErrorBox error={error} />
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy || players === 0 || !when || reason.trim().length < 3}><Send aria-hidden />Send to {players} player{players === 1 ? '' : 's'}</button>
          </div>
          {v && v.status !== 'open' && (
            <p className="faint small" style={{ margin: 0 }}>
              Last proposal ({fmtDate(v.proposedAt)}): {v.status === 'applied' ? 'the tournament moved' : v.status === 'kept' ? 'the date stayed' : 'ended'}, {v.counts.yes} could make it, {v.counts.no} couldn’t.
            </p>
          )}
        </form>
      )}
      {open && <ErrorBox error={error} />}
    </div>
  );
}
