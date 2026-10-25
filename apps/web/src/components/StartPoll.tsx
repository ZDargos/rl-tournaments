import { useState } from 'react';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { fmtDate, relTime } from '../lib/format';
import { useAuth } from '../lib/auth';
import { ConfirmButton, ErrorBox, Help, useToast } from './ui';

const POLL_HELP =
  'Players vote on when the tournament starts. They can pick every time that works for them, in Discord (on a card in the registration channel) or here. When voting closes, the time with the most votes wins (a tie is picked at random), it becomes the start time, registration opens and everyone who voted for it is registered. Other voters get a DM with a Sign me up button. Set the times up in Settings with "Vote on date first".';

/** Organizers: watch and close the start time vote (Manage → Control). It is set up in Settings. */
export function StartPollAdmin({ d, reload, openSettings }: { d: any; reload: () => void; openSettings: () => void }) {
  const t = d.tournament;
  const p = d.startPoll;
  const tz = t.config.schedule.timezone;
  const vote = t.config.schedule.startVote;
  const toast = useToast();
  const { busy, error, run } = useAsync();
  const preRegistration = ['draft', 'published'].includes(t.state);
  if (!preRegistration && !p) return null;
  const after = async (fn: () => Promise<unknown>, msg: string) => { if (await run(fn)) { toast(msg); reload(); } };
  const setupLink = <button className="btn small" onClick={openSettings}>{vote?.enabled ? 'Edit the vote in Settings' : 'Set up in Settings'}</button>;

  return (
    <div className="card">
      <h3>Start time vote<Help text={POLL_HELP} /></h3>
      {p && p.status === 'open' && (
        <>
          <p className="muted small">Voting closes {fmtDate(p.closesAt, tz)} ({relTime(p.closesAt)}). {p.voterCount} player{p.voterCount === 1 ? '' : 's'} voted.{!p.cardPosted && ' The Discord card is not posted (no channel, or the bot cannot post there), so players can only vote on the website.'}</p>
          <PollResults p={p} tz={tz} />
          <VoterList p={p} tz={tz} />
          <div className="row" style={{ marginTop: 10 }}>
            <ConfirmButton className="btn primary" label="Close now" disabled={busy} confirm="Close the vote now? The time with the most votes wins, registration opens and its voters are registered." onConfirm={() => after(() => api(`/api/tournaments/${t.id}/start-poll/close`, { body: {} }), 'Vote closed')} />
            <ConfirmButton className="btn danger" label="Cancel vote" disabled={busy} confirm="Cancel this vote? Nobody is registered and no start time is set." onConfirm={() => after(() => api(`/api/tournaments/${t.id}/start-poll`, { method: 'DELETE' }), 'Vote cancelled')} />
            {setupLink}
          </div>
        </>
      )}
      {p && p.status !== 'open' && (
        <>
          <p className="muted small">
            {p.status === 'cancelled' ? 'The last vote was cancelled.' : p.winner == null ? 'The last vote closed with no votes.' : `The last vote closed: ${fmtDate(p.options.find((o: any) => o.index === p.winner)?.at, tz)} won${p.tie ? ' (a tie, picked at random)' : ''}.`}
          </p>
          <PollResults p={p} tz={tz} />
          <VoterList p={p} tz={tz} />
        </>
      )}
      {preRegistration && p?.status !== 'open' && (
        <div className="stack" style={{ marginTop: p ? 14 : 0 }}>
          {vote?.enabled ? (
            <p className="muted small">A vote on {vote.options.length} time{vote.options.length === 1 ? '' : 's'} is set up{vote.closesAt ? `, closing ${fmtDate(vote.closesAt, tz)}` : ''}. It is posted in the registration channel when you publish the tournament.</p>
          ) : (
            <p className="muted small">Let players pick the start time: turn on "Vote on date first" next to the start time in Settings and add the times. The vote opens registration when it closes.</p>
          )}
          <div className="row">{setupLink}</div>
        </div>
      )}
      <ErrorBox error={error} />
    </div>
  );
}

/** Voter names per option index (organizers only get `voters`). */
function votersByOption(p: any): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const v of p.voters ?? []) for (const o of v.options) out.set(o, [...(out.get(o) ?? []), v.name]);
  return out;
}

/** Results bars. For organizers each time can be clicked to list who voted for it. */
function PollResults({ p, tz }: { p: any; tz: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const max = Math.max(1, ...p.options.map((o: any) => o.votes));
  const names = votersByOption(p);
  const canSee = !!p.voters;
  return (
    <div className="stack" style={{ gap: 4 }}>
      {p.options.map((o: any, n: number) => {
        const row = (
          <>
            <span style={{ minWidth: 190, textAlign: 'left' }}>{canSee && <span aria-hidden className="muted">{open === o.index ? '▾ ' : '▸ '}</span>}{p.winner === o.index ? '🏆 ' : `#${n + 1} `}{fmtDate(o.at, tz)}</span>
            <div style={{ flex: 1, height: 8, background: 'var(--line)', borderRadius: 4 }}>
              <div style={{ width: `${(o.votes / max) * 100}%`, height: '100%', background: 'var(--blue)', borderRadius: 4 }} />
            </div>
            <span style={{ minWidth: 60, textAlign: 'right' }}>{o.votes} vote{o.votes === 1 ? '' : 's'}</span>
          </>
        );
        return (
          <div key={o.index}>
            {canSee ? (
              <button type="button" className="row small" aria-expanded={open === o.index} title="Show who voted for this time" onClick={() => setOpen(open === o.index ? null : o.index)}
                style={{ gap: 8, flexWrap: 'nowrap', width: '100%', background: 'none', border: 0, padding: '2px 0', color: 'inherit', cursor: 'pointer', font: 'inherit' }}>
                {row}
              </button>
            ) : (
              <div className="row small" style={{ gap: 8, flexWrap: 'nowrap' }}>{row}</div>
            )}
            {canSee && open === o.index && (
              <div className="small" style={{ margin: '2px 0 6px 18px' }}>
                {names.get(o.index)?.length ? names.get(o.index)!.join(', ') : <span className="muted">No votes yet.</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function VoterList({ p, tz }: { p: any; tz: string }) {
  if (!p.voters?.length) return null;
  const when = new Map<number, string>(p.options.map((o: any) => [o.index, fmtDate(o.at, tz)]));
  return (
    <details style={{ marginTop: 8 }}>
      <summary className="small">Who voted ({p.voters.length})</summary>
      <ul className="small">{p.voters.map((v: any) => <li key={v.userId}><strong>{v.name}</strong>: {v.options.map((o: number) => when.get(o)).join(', ')}</li>)}</ul>
    </details>
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
  const picks: number[] = p.options.filter((o: any) => o.mine).map((o: any) => o.index);
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
        {p.options.map((o: any) => (
          <label key={o.index} className="row" style={{ gap: 8, flexWrap: 'nowrap', cursor: me ? 'pointer' : 'default' }}>
            <input type="checkbox" checked={o.mine} disabled={!me || busy} onChange={() => void toggle(o.index)} />
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
