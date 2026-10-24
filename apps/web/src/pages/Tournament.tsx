import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { RANKS } from '@rl/core';
import { api, downloadCsv } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsync, useLive } from '../lib/hooks';
import { AvailabilityBadge, Empty, ErrorBox, Field, MatchBadge, Spinner, StateBadge, Tabs, useToast, ConfirmButton } from '../components/ui';
import { BracketView, MatchCard, MatchList, RoundsView } from '../components/matches';
import { SixmansStandings, StandingsTable } from '../components/standings';
import { MemberPicker } from '../components/MemberPicker';
import { fmtDate, relTime } from '../lib/format';

export function useTournament(id: string | undefined) {
  return useLive<any>(id ? `/api/tournaments/${id}` : null, id ? `/api/tournaments/${id}/version` : null);
}

type Tab = 'overview' | 'bracket' | 'standings' | 'pools' | 'matches' | 'participants';

export function TournamentPage() {
  const { id } = useParams();
  const { data: d, error, loading, reload } = useTournament(id);
  const [tab, setTab] = useState<Tab>('overview');
  if (loading && !d) return <Spinner />;
  if (error && !d) {
    if (error.status === 404) return <Empty icon="🔒" title="Tournament not found">It may be private (log in with an account that was invited) or it may have been deleted.</Empty>;
    return <ErrorBox error={error} />;
  }
  if (!d) return null;
  const t = d.tournament;
  const six = t.format === 'sixmans';
  const elim = t.format === 'single_elim' || t.format === 'double_elim';
  const tabs: { id: Tab; label: string }[] = [{ id: 'overview', label: 'Overview' }];
  if (elim) tabs.push({ id: 'bracket', label: 'Bracket' });
  if (t.format === 'swiss' || t.format === 'round_robin') tabs.push({ id: 'standings', label: 'Standings' });
  if (six) tabs.push({ id: 'pools', label: 'Pools & standings' }, { id: 'bracket', label: 'Finals' });
  tabs.push({ id: 'matches', label: `Matches (${d.matches.filter((m: any) => !m.walkover && m.status !== 'void').length})` }, { id: 'participants', label: `Participants (${d.entries.filter((e: any) => e.status === 'confirmed').length})` });
  return (
    <div>
      <div className="row between" style={{ alignItems: 'flex-start', marginBottom: 14 }}>
        <div>
          <div className="row" style={{ marginBottom: 6 }}>
            <StateBadge state={t.state} />
            {t.stage && t.state === 'in_progress' && <span className="badge">{t.stage.replace(/_/g, ' ')}</span>}
            {t.visibility === 'private' && <span className="badge">🔒 Private</span>}
            <span className="muted small">{d.guild?.name}</span>
          </div>
          <h1>{t.name}</h1>
          <div className="meta">
            <span>{t.formatLabel}</span>·<span>{t.teamSize}v{t.teamSize}</span>·<span>Best of {six ? t.config.sixmans.groupBestOf : t.config.series.bestOf}</span>
            {t.startAt && <><span>·</span><span>{fmtDate(t.startAt)} ({relTime(t.startAt)})</span></>}
          </div>
        </div>
        <div className="row">
          {d.viewer.canManage && <Link className="btn primary" to={`/t/${t.id}/manage`}>Manage</Link>}
          <ExportMenu id={t.id} six={six} />
        </div>
      </div>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'overview' && <Overview d={d} reload={reload} />}
      {tab === 'bracket' && (
        (elim || six) && d.matches.some((m: any) => m.stage !== 'group') ? (
          <div className="card"><BracketView matches={d.matches.filter((m: any) => m.stage !== 'group')} myIds={d.viewer.myMatchIds} /></div>
        ) : <Empty icon="🌳" title="Bracket not generated yet">{six ? 'Finals are created when the group stage ends.' : 'The bracket appears when the tournament starts.'}</Empty>
      )}
      {tab === 'standings' && (
        d.standings?.length ? <div className="card"><StandingsTable rows={d.standings} myCompetitorIds={myCompetitors(d)} /></div> : <Empty icon="📊" title="No standings yet" />
      )}
      {tab === 'pools' && <PoolsTab d={d} />}
      {tab === 'matches' && (
        d.matches.length ? (
          <div className="card">
            {t.format === 'swiss' || t.format === 'round_robin' ? <RoundsView matches={d.matches.filter((m: any) => !m.walkover)} myIds={d.viewer.myMatchIds} /> : <MatchList matches={d.matches.filter((m: any) => !(m.walkover && !m.b) && m.status !== 'void')} myIds={d.viewer.myMatchIds} />}
          </div>
        ) : <Empty icon="🎮" title="No matches yet" />
      )}
      {tab === 'participants' && <Participants d={d} />}
    </div>
  );
}

function myCompetitors(d: any): number[] {
  return d.competitors.filter((c: any) => c.players.some((p: any) => p.userId === d.viewer.userId)).map((c: any) => c.id);
}

function ExportMenu({ id, six }: { id: number; six: boolean }) {
  const toast = useToast();
  const kinds = ['participants', 'teams', 'results', 'standings', 'placements', 'player_stats', ...(six ? ['pools', 'schedule'] : [])];
  return (
    <select
      aria-label="Export CSV"
      value=""
      style={{ width: 'auto' }}
      onChange={async (e) => {
        const k = e.target.value;
        if (!k) return;
        try {
          await downloadCsv(`/api/tournaments/${id}/export/${k}`);
        } catch (err: any) {
          toast(err.message, 'error');
        }
      }}
    >
      <option value="">⬇ Export CSV</option>
      {kinds.map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}
    </select>
  );
}

function Overview({ d, reload }: { d: any; reload: () => void }) {
  const t = d.tournament;
  const myMatches = d.matches.filter((m: any) => d.viewer.myMatchIds.includes(m.id) && ['ready', 'awaiting_confirmation', 'disputed'].includes(m.status));
  const live = d.matches.filter((m: any) => m.status === 'ready' && !m.walkover).slice(0, 6);
  return (
    <div className="grid overview">
      <div className="stack">
        {myMatches.length > 0 && (
          <div className="card" style={{ borderColor: 'var(--orange)' }}>
            <h2>Your match{myMatches.length > 1 ? 'es' : ''}</h2>
            <div className="grid auto">{myMatches.map((m: any) => <MatchCard key={m.id} m={m} mine showLabel />)}</div>
            <p className="muted small" style={{ marginTop: 10 }}>Open a match to report the score or confirm your opponent’s report.</p>
          </div>
        )}
        {d.placements.length > 0 && (
          <div className="card">
            <h2>🏆 Final results</h2>
            <table className="table"><tbody>
              {d.placements.slice(0, 8).map((p: any) => (
                <tr key={p.competitorId}><td style={{ width: 50, fontWeight: 800 }}>{['🥇', '🥈', '🥉'][p.placement - 1] ?? p.placement}</td><td style={{ fontWeight: 650 }}>{p.name}</td><td className="muted small">{p.players.length > 1 || p.players[0]?.name !== p.name ? p.players.map((x: any) => x.name).join(', ') : ''}</td></tr>
              ))}
            </tbody></table>
          </div>
        )}
        {live.length > 0 && (
          <div className="card">
            <h2>Live now</h2>
            <div className="grid auto">{live.map((m: any) => <MatchCard key={m.id} m={m} mine={d.viewer.myMatchIds.includes(m.id)} showLabel />)}</div>
          </div>
        )}
        <div className="card">
          <h2>About</h2>
          {t.description ? <p style={{ whiteSpace: 'pre-wrap' }}>{t.description}</p> : <p className="muted">No description.</p>}
          <dl className="kv">
            <dt>Organizer</dt><dd><Link to={`/p/${t.createdBy.id}`}>{t.createdBy.name}</Link>{t.admins.length > 0 && <span className="muted"> + {t.admins.map((a: any) => a.name).join(', ')}</span>}</dd>
            <dt>Format</dt><dd>{t.formatLabel}, {t.teamSize}v{t.teamSize}{t.format === 'double_elim' ? ` (grand-final reset ${t.config.doubleElim.grandFinalReset ? 'on' : 'off'})` : ''}</dd>
            <dt>Start</dt><dd>{t.startAt ? `${fmtDate(t.startAt)} · ${fmtDate(t.startAt, t.timezone)} ${t.timezone}` : 'Not scheduled'}</dd>
            {t.config.checkIn.enabled && <><dt>Check-in</dt><dd>Opens {t.config.checkIn.opensMinutesBefore} min before start, closes {t.config.checkIn.closesMinutesBefore} min before</dd></>}
            <dt>Results</dt><dd>{{ opponent_confirm: 'Reported by one team, confirmed by the other', single_report: 'One report completes a match', admin_only: 'Entered by organizers' }[t.config.results.confirmation as string]}</dd>
            {t.format === 'sixmans' && <><dt>6mans</dt><dd>{t.config.sixmans.poolCount} pools · {t.config.sixmans.roundsMode === 'fixed' ? `${t.config.sixmans.roundsPerPool} rounds` : 'equal games for everyone'} · win {t.config.sixmans.scoring.win} pts · no repeated trios</dd></>}
          </dl>
        </div>
      </div>
      <div className="stack">
        <RegistrationPanel d={d} reload={reload} />
      </div>
    </div>
  );
}

function RegistrationPanel({ d, reload }: { d: any; reload: () => void }) {
  const { me } = useAuth();
  const t = d.tournament;
  const toast = useToast();
  const { busy, error, run } = useAsync();
  const [teamName, setTeamName] = useState('');
  const [rank, setRank] = useState('');
  const myEntry = useMemo(() => d.entries.find((e: any) => e.id === d.viewer.entryId), [d]);
  const teamMode = t.config.registrationMode === 'team' && t.teamSize > 1;
  const open = t.state === 'registration_open' || (t.config.registration.lateRegistration && ['registration_closed', 'ready'].includes(t.state));
  const needsRank = t.format === 'sixmans' && t.config.sixmans.skillMethod === 'rank';
  const checkInOpen = t.config.checkIn.enabled && t.startAt && Date.now() >= Date.parse(t.startAt) - t.config.checkIn.opensMinutesBefore * 60000 && Date.now() < Date.parse(t.startAt) - t.config.checkIn.closesMinutesBefore * 60000;
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    const r = await run(fn);
    if (r !== undefined) {
      toast(msg);
      reload();
    }
  };
  return (
    <div className="card">
      <h2>Registration</h2>
      <p className="muted small">
        {d.entries.filter((e: any) => e.status === 'confirmed').length}{t.capacity ? ` / ${t.capacity}` : ''} {teamMode ? 'teams' : 'players'} confirmed
        {d.entries.some((e: any) => e.status === 'waitlisted') && ` · ${d.entries.filter((e: any) => e.status === 'waitlisted').length} on the waitlist`}
      </p>
      {!me && <Link className="btn discord" to={`/login?returnTo=/t/${t.id}`}>Log in to register</Link>}
      {me && !myEntry && open && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void act(() => api(`/api/tournaments/${t.id}/register`, { body: { teamName: teamMode ? teamName : null, rank: rank || null } }), 'Registered!'); }}>
          {teamMode && <Field label="Team name" hint="You become the captain and can invite teammates."><input required minLength={2} maxLength={40} value={teamName} onChange={(e) => setTeamName(e.target.value)} /></Field>}
          {needsRank && (
            <Field label="Your current rank (used to balance pools and teams)">
              <select value={rank} onChange={(e) => setRank(e.target.value)}>
                <option value="">Prefer not to say</option>
                {RANKS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            </Field>
          )}
          <ErrorBox error={error} />
          <button className="btn primary" disabled={busy} type="submit">{teamMode ? 'Register team' : 'Join tournament'}</button>
        </form>
      )}
      {me && !myEntry && !open && <p className="muted">{t.state === 'draft' || t.state === 'published' ? 'Registration has not opened yet.' : 'Registration is closed.'}</p>}
      {myEntry && (
        <div className="stack">
          <div className="row">
            <span className={`badge ${myEntry.status === 'confirmed' ? 'green' : myEntry.status === 'waitlisted' ? 'yellow' : 'blue'}`}>{myEntry.status}</span>
            {myEntry.checkedIn && <span className="badge green">checked in</span>}
            {myEntry.kind === 'team' && <strong>{myEntry.name}</strong>}
          </div>
          {myEntry.kind === 'team' && <TeamRoster d={d} entry={myEntry} reload={reload} />}
          {needsRank && !t.startedAt && (
            <Field label="Your rank">
              <select value={myEntry.rank ?? ''} onChange={(e) => void act(() => api(`/api/tournaments/${t.id}/my-rank`, { body: { rank: e.target.value } }), 'Rank saved')}>
                <option value="" disabled>Choose…</option>
                {RANKS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            </Field>
          )}
          {!t.startedAt && t.state !== 'cancelled' && d.viewer.availability && (
            <div className="row" style={{ gap: 8 }}>
              <span className="small">Can you make it{t.startAt ? ` on ${fmtDate(t.startAt)}` : ''}?</span>
              <AvailabilityBadge status={d.viewer.availability} />
              <button className="btn small blue" disabled={busy || d.viewer.availability === 'confirmed'} onClick={() => void act(() => api(`/api/tournaments/${t.id}/availability`, { body: { answer: 'confirmed' } }), 'Thanks, the organizers know you can make it')}>I can make it</button>
              <button className="btn small ghost" disabled={busy || d.viewer.availability === 'declined'} onClick={() => void act(() => api(`/api/tournaments/${t.id}/availability`, { body: { answer: 'declined' } }), 'The organizers know you can’t make it')}>I can’t make it</button>
            </div>
          )}
          <div className="row">
            {t.config.checkIn.enabled && !myEntry.checkedIn && myEntry.status === 'confirmed' && (
              <button className="btn primary" disabled={busy || !checkInOpen} onClick={() => void act(() => api(`/api/tournaments/${t.id}/check-in`, { body: {} }), 'Checked in')}>
                {checkInOpen ? 'Check in' : 'Check-in not open'}
              </button>
            )}
            {!t.startedAt && t.config.registration.allowWithdrawal && (
              <ConfirmButton className="btn danger" label="Withdraw" confirm={myEntry.kind === 'team' && myEntry.captainId === me?.user.id ? 'Withdraw your whole team from this tournament?' : 'Leave this tournament?'} onConfirm={() => act(() => api(`/api/tournaments/${t.id}/withdraw`, { body: {} }), 'Withdrawn')} />
            )}
          </div>
          <ErrorBox error={error} />
        </div>
      )}
      {me && (
        <div style={{ marginTop: 14 }}>
          <label className="check small">
            <input type="checkbox" checked={d.viewer.muted} onChange={(e) => void act(() => api(`/api/me/mutes/${t.id}`, { method: e.target.checked ? 'PUT' : 'DELETE', body: {} }), e.target.checked ? 'Muted' : 'Unmuted')} />
            Mute this tournament’s DMs (invitations and organizer messages still arrive)
          </label>
        </div>
      )}
    </div>
  );
}

function TeamRoster({ d, entry, reload }: { d: any; entry: any; reload: () => void }) {
  const { me } = useAuth();
  const toast = useToast();
  const { busy, error, run } = useAsync();
  const isCaptain = entry.captainId === me?.user.id;
  const t = d.tournament;
  const [role, setRole] = useState<'player' | 'substitute'>('player');
  return (
    <div className="stack">
      <div>
        {entry.members.map((m: any) => (
          <span key={m.userId} className={`player-pill ${m.userId === me?.user.id ? 'me' : ''}`}>
            {m.name} <span className="muted tiny">{m.role}</span>
            {isCaptain && m.role !== 'captain' && !entry.rosterLocked && (
              <button className="btn ghost small" aria-label={`Remove ${m.name}`} disabled={busy} onClick={async () => { if (await run(() => api(`/api/entries/${entry.id}/members/${m.userId}`, { method: 'DELETE', body: {} })) !== undefined) reload(); }}>✕</button>
            )}
          </span>
        ))}
      </div>
      {entry.members.filter((m: any) => m.role !== 'substitute').length < t.teamSize && <div className="alert warn small">Your roster needs {t.teamSize} players to play.</div>}
      {isCaptain && !entry.rosterLocked && d.guild && (
        <div className="stack">
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <select value={role} onChange={(e) => setRole(e.target.value as 'player')} style={{ width: 140 }} aria-label="Role">
              <option value="player">Player</option>
              {t.config.registration.maxSubstitutes > 0 && <option value="substitute">Substitute</option>}
            </select>
            <div style={{ flex: 1 }}>
              <MemberPicker guildId={d.guild.id} placeholder="Invite a teammate…" exclude={entry.members.map((m: any) => m.userId)} onPick={async (u) => {
                if (await run(() => api(`/api/entries/${entry.id}/invitations`, { body: { userId: u.id, role } })) !== undefined) toast(`Invitation sent to ${u.displayName}. They can accept on the website or in Discord.`);
              }} />
            </div>
          </div>
        </div>
      )}
      {entry.rosterLocked && <span className="muted small">🔒 Roster locked</span>}
      <ErrorBox error={error} />
    </div>
  );
}

function Participants({ d }: { d: any }) {
  const groups = ['confirmed', 'pending', 'waitlisted'];
  const any = d.entries.length > 0;
  if (!any) return <Empty icon="👥" title="No one has registered yet" />;
  return (
    <div className="stack">
      {groups.map((g) => {
        const es = d.entries.filter((e: any) => e.status === g);
        if (!es.length) return null;
        return (
          <div className="card" key={g}>
            <h3 style={{ textTransform: 'capitalize' }}>{g} ({es.length})</h3>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>#</th><th>{d.tournament.teamSize > 1 && d.tournament.config.registrationMode === 'team' ? 'Team' : 'Player'}</th><th>Roster</th><th>Check-in</th>{d.viewer.canManage && !d.tournament.startedAt && <th>Can make it?</th>}</tr></thead>
                <tbody>
                  {es.map((e: any, i: number) => (
                    <tr key={e.id} className={e.id === d.viewer.entryId ? 'highlight' : ''}>
                      <td>{i + 1}</td>
                      <td style={{ fontWeight: 650 }}>{e.kind === 'player' ? <Link to={`/p/${e.userId}`}>{e.name}</Link> : e.name}</td>
                      <td className="small">{e.kind === 'team' ? e.members.map((m: any) => `${m.name}${m.role === 'substitute' ? ' (sub)' : ''}`).join(', ') : '—'}</td>
                      <td>{d.tournament.config.checkIn.enabled ? (e.checkedIn ? '✅' : '—') : 'n/a'}</td>
                      {d.viewer.canManage && !d.tournament.startedAt && (
                        <td>{e.kind === 'team' ? <div className="row" style={{ gap: 4 }}>{e.members.map((m: any) => <span key={m.userId} title={m.name}><AvailabilityBadge status={m.availability} /></span>)}</div> : <AvailabilityBadge status={e.availability} />}</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PoolsTab({ d }: { d: any }) {
  const sm = d.sixmans;
  if (!sm) return null;
  const me = d.viewer.userId;
  const names = new Map<string, string>(d.entries.map((e: any) => [e.userId, e.name]));
  if (sm.standings?.length) {
    return (
      <div className="stack">
        <p className="muted small">Top {sm.qualifiersPerPool} per pool qualify (green). Points: {d.tournament.config.sixmans.scoring.win} per win. Tie-breakers: points, goal difference, goals for, seed.</p>
        <div className="grid cols-2">
          {sm.standings.map((p: any) => (
            <div className="card" key={p.poolId}>
              <h3>{p.name}</h3>
              <SixmansStandings pool={p} me={me} />
            </div>
          ))}
        </div>
        <div className="card">
          <h3>Group matches</h3>
          {d.pools.map((p: any) => (
            <div key={p.id} style={{ marginBottom: 16 }}>
              <h4 className="muted">{p.name}</h4>
              <div className="grid auto">
                {d.matches.filter((m: any) => m.poolId === p.id).map((m: any) => <SixmansMatch key={m.id} m={m} me={me} />)}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (!sm.pools) return <Empty icon="🧩" title="Pools are not published yet">The organizer is still preparing pools and the schedule.</Empty>;
  return (
    <div className="pool-grid">
      {sm.pools.data.pools.map((p: any) => (
        <div className="card" key={p.index}>
          <h3>{p.name}</h3>
          {p.players.map((x: any) => <span key={x.userId} className={`player-pill ${x.userId === me ? 'me' : ''}`}>{names.get(x.userId) ?? 'Player'}</span>)}
        </div>
      ))}
    </div>
  );
}

export function SixmansMatch({ m, me }: { m: any; me?: string | null }) {
  const side = (s: any, cls: string) => (
    <div>
      {s?.players.map((p: any) => <div key={p.userId} className={`${cls} small`} style={{ fontWeight: p.userId === me ? 800 : 500 }}>{p.name}</div>) ?? <span className="tbd">TBD</span>}
    </div>
  );
  return (
    <Link to={`/m/${m.id}`} className="round" style={{ color: 'var(--text)', display: 'block' }}>
      <div className="row between" style={{ marginBottom: 6 }}>
        <span className="tiny muted">Round {m.round} · #{m.id}</span>
        <MatchBadge status={m.status} />
      </div>
      <div className="vs">
        {side(m.a, 'team-a')}
        <span className="label">{m.status === 'completed' ? `${m.goalsA ?? m.winsA}–${m.goalsB ?? m.winsB}` : 'vs'}</span>
        <div style={{ textAlign: 'right' }}>{side(m.b, 'team-b')}</div>
      </div>
    </Link>
  );
}
