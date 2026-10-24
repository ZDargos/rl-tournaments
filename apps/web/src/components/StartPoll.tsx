import { useState } from 'react';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { fmtDate, localInputToIso, relTime } from '../lib/format';
import { useAuth } from '../lib/auth';
import { ConfirmButton, ErrorBox, Field, Help, useToast } from './ui';

const POLL_HELP =
  'Players vote on when the tournament starts. They can pick every time that works for them, in Discord (on a card in the registration channel) or here. When voting closes, the time with the most votes wins (a tie is picked at random), it becomes the start time, registration opens and everyone who voted for it is registered. Other voters get a DM with a Sign me up button.';

/** Organizers: set up, watch and close the start time vote (Manage → Control). */
export function StartPollAdmin({ d, reload }: { d: any; reload: () => void }) {
  const t = d.tournament;
  const p = d.startPoll;
  const tz = t.config.schedule.timezone;
  const toast = useToast();
  const { busy, error, run } = useAsync();
  const [times, setTimes] = useState<string[]>(['', '']);
  const [closes, setCloses] = useState('');
  const canCreate = ['draft', 'published'].includes(t.state) && p?.status !== 'open';
  if (!canCreate && !p) return null;

  const create = async () => {
    const options = times.map((v) => localInputToIso(v, tz)).filter(Boolean);
    const r = await run(() => api<{ warnings: string[] }>(`/api/tournaments/${t.id}/start-poll`, { body: { options, closesAt: localInputToIso(closes, tz) } }));
    if (r) {
      toast(`Vote started${r.warnings.length ? `. ${r.warnings.join(' ')}` : ''}`);
      setTimes(['', '']);
      setCloses('');
      reload();
    }
  };
  const after = async (fn: () => Promise<unknown>, msg: string) => { if (await run(fn)) { toast(msg); reload(); } };

  return (
    <div className="card">
      <h3>Start time vote<Help text={POLL_HELP} /></h3>
      {p && p.status === 'open' && (
        <>
          <p className="muted small">Voting closes {fmtDate(p.closesAt, tz)} ({relTime(p.closesAt)}). {p.voterCount} player{p.voterCount === 1 ? '' : 's'} voted.{!p.cardPosted && ' The Discord card is not posted (no channel, or the bot cannot post there), so players can only vote on the website.'}</p>
          <PollResults p={p} tz={tz} />
          {p.voters?.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary className="small">Who voted</summary>
              <ul className="small">{p.voters.map((v: any) => <li key={v.userId}><strong>{v.name}</strong>: {v.options.map((o: number) => `#${o + 1}`).join(', ')}</li>)}</ul>
            </details>
          )}
          <div className="row" style={{ marginTop: 10 }}>
            <ConfirmButton className="btn primary" label="Close now" disabled={busy} confirm="Close the vote now? The time with the most votes wins, registration opens and its voters are registered." onConfirm={() => after(() => api(`/api/tournaments/${t.id}/start-poll/close`, { body: {} }), 'Vote closed')} />
            <ConfirmButton className="btn danger" label="Cancel vote" disabled={busy} confirm="Cancel this vote? Nobody is registered and no start time is set." onConfirm={() => after(() => api(`/api/tournaments/${t.id}/start-poll`, { method: 'DELETE' }), 'Vote cancelled')} />
          </div>
        </>
      )}
      {p && p.status !== 'open' && (
        <>
          <p className="muted small">
            {p.status === 'cancelled' ? 'The last vote was cancelled.' : p.winner == null ? 'The last vote closed with no votes.' : `The last vote closed: ${fmtDate(p.options[p.winner].at, tz)} won${p.tie ? ' (a tie, picked at random)' : ''}.`}
          </p>
          <PollResults p={p} tz={tz} />
        </>
      )}
      {canCreate && (
        <div className="stack" style={{ marginTop: p ? 14 : 0 }}>
          {!p && <p className="muted small">Let players pick the start time. Set it up before registration opens: the vote opens registration when it closes.</p>}
          <div className="form-grid">
            {times.map((v, i) => (
              <Field key={i} label={`Option ${i + 1} (${tz})`}>
                <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
                  <input type="datetime-local" value={v} onChange={(e) => setTimes(times.map((x, j) => (j === i ? e.target.value : x)))} />
                  {times.length > 2 && <button className="btn small ghost" aria-label="Remove option" onClick={() => setTimes(times.filter((_, j) => j !== i))}>✕</button>}
                </div>
              </Field>
            ))}
            <Field label={`Voting closes (${tz})`} hint="Before the earliest option">
              <input type="datetime-local" value={closes} onChange={(e) => setCloses(e.target.value)} />
            </Field>
          </div>
          <div className="row">
            {times.length < 10 && <button className="btn small" onClick={() => setTimes([...times, ''])}>+ Add a time</button>}
            <button className="btn primary" disabled={busy || times.filter(Boolean).length < 2 || !closes} onClick={() => void create()}>Start the vote</button>
          </div>
        </div>
      )}
      <ErrorBox error={error} />
    </div>
  );
}

function PollResults({ p, tz }: { p: any; tz: string }) {
  const max = Math.max(1, ...p.options.map((o: any) => o.votes));
  return (
    <div className="stack" style={{ gap: 4 }}>
      {p.options.map((o: any, i: number) => (
        <div key={i} className="row small" style={{ gap: 8, flexWrap: 'nowrap' }}>
          <span style={{ minWidth: 190 }}>{p.winner === i ? '🏆 ' : `#${i + 1} `}{fmtDate(o.at, tz)}</span>
          <div style={{ flex: 1, height: 8, background: 'var(--line)', borderRadius: 4 }}>
            <div style={{ width: `${(o.votes / max) * 100}%`, height: '100%', background: 'var(--blue)', borderRadius: 4 }} />
          </div>
          <span style={{ minWidth: 60, textAlign: 'right' }}>{o.votes} vote{o.votes === 1 ? '' : 's'}</span>
        </div>
      ))}
    </div>
  );
}

/** Players: vote on the start time (tournament overview). */
export function StartPollVote({ d, reload }: { d: any; reload: () => void }) {
  const { me } = useAuth();
  const t = d.tournament;
  const p = d.startPoll;
  const toast = useToast();
  const { busy, error, run } = useAsync();
  if (!p || p.status !== 'open') return null;
  const picks: number[] = p.options.flatMap((o: any, i: number) => (o.mine ? [i] : []));
  const toggle = async (i: number) => {
    const next = picks.includes(i) ? picks.filter((x) => x !== i) : [...picks, i];
    if (await run(() => api(`/api/tournaments/${t.id}/start-poll/vote`, { body: { options: next } }))) {
      toast(next.length ? 'Vote saved' : 'Vote removed');
      reload();
    }
  };
  return (
    <div className="card" style={{ borderColor: 'var(--blue)' }}>
      <h2>🗳️ When should it start?</h2>
      <p className="muted small">Tick every time that works for you. Voting closes {fmtDate(p.closesAt)} ({relTime(p.closesAt)}). If a time you picked wins, you’re registered automatically.</p>
      <div className="stack" style={{ gap: 6 }}>
        {p.options.map((o: any, i: number) => (
          <label key={i} className="row" style={{ gap: 8, flexWrap: 'nowrap', cursor: me ? 'pointer' : 'default' }}>
            <input type="checkbox" checked={o.mine} disabled={!me || busy} onChange={() => void toggle(i)} />
            <span style={{ flex: 1 }}>{fmtDate(o.at)}</span>
            <span className="muted small">{o.votes} vote{o.votes === 1 ? '' : 's'}</span>
          </label>
        ))}
      </div>
      {!me && <p className="muted small" style={{ marginTop: 8 }}>Log in to vote.</p>}
      <ErrorBox error={error} />
    </div>
  );
}
