import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { FINALS_TEAM_FORMATION_LABELS, FINALS_TEAM_FORMATIONS, poolIssues, scheduleMatchIssues } from '@rl/core';
import { applyDrop, DragBoard, DragPill, DropZone, type DropResult } from '../components/dnd';
import { Alert, ErrorBox, useToast } from '../components/ui';
import { SixmansStandings } from '../components/standings';
import { RoundsPreview } from '../components/sixmansRounds';

/** Organizer workflow for 6mans: pools -> schedule -> start -> finals. */
export function SixmansAdmin({ d, reload }: { d: any; reload: () => void }) {
  const t = d.tournament;
  const sm = d.sixmans;
  const names = useMemo(() => new Map<string, string>([...d.entries.map((e: any) => [e.userId, e.name]), ...d.competitors.flatMap((c: any) => c.players.map((p: any) => [p.userId, p.name]))]), [d]);
  const started = !!t.startedAt;
  const step = !sm.pools ? 0 : sm.pools.status !== 'confirmed' ? 1 : !sm.schedule || sm.schedule.status !== 'confirmed' ? 2 : !started ? 3 : t.stage === 'group' ? 4 : t.stage === 'group_complete' ? 5 : 6;
  const steps = ['Make pools', 'Confirm pools', 'Schedule', 'Start', 'Group stage', 'Finals setup', 'Finals'];
  return (
    <div className="stack">
      <ol className="steps" aria-label="6mans steps" style={{ listStyle: 'none', padding: 0 }}>{steps.map((s, i) => <li key={s} className={`step ${i < step ? 'done' : i === step ? 'current' : ''}`} aria-current={i === step ? 'step' : undefined}>{s}</li>)}</ol>
      {!started && <PoolsEditor d={d} names={names} reload={reload} />}
      {!started && sm.pools?.status === 'confirmed' && <ScheduleEditor d={d} names={names} reload={reload} />}
      {started && sm.standings?.length > 0 && (
        <div className="grid cols-2">
          {sm.standings.map((p: any) => (
            <div className="card" key={p.poolId}><h3>{p.name}</h3><SixmansStandings pool={p} showSkill /></div>
          ))}
        </div>
      )}
      {t.stage === 'group_complete' && sm.finals && <FinalsEditor d={d} names={names} reload={reload} />}
      {t.stage === 'finals' && <Alert kind="ok">Finals are running. See the Finals bracket on the tournament page.</Alert>}
    </div>
  );
}

function PoolsEditor({ d, names, reload }: { d: any; names: Map<string, string>; reload: () => void }) {
  const t = d.tournament;
  const sm = d.sixmans;
  const toast = useToast();
  const { busy, error, run } = useAsync();
  const [count, setCount] = useState<number>(t.config.sixmans.poolCount);
  const plan = sm.pools?.data;
  const confirmed = sm.pools?.status === 'confirmed';
  const out = new Set(d.entries.filter((e: any) => e.status === 'confirmed' && e.availability === 'declined').map((e: any) => e.userId));
  const confirmedPlayers = d.entries.filter((e: any) => e.status === 'confirmed').length - out.size;
  // Shown right away while the move saves.
  const [local, setLocal] = useState<string[][] | null>(null);
  const saved: string[][] = plan ? plan.pools.map((p: any) => p.players.map((x: any) => x.userId)) : [];
  const pools = local ?? saved;
  const info = new Map<string, any>(plan ? plan.pools.flatMap((p: any) => p.players.map((x: any) => [x.userId, x])) : []);
  const issues = plan ? poolIssues(pools) : [];
  const legal = issues.every((x) => x.length === 0);
  const drop = async (r: DropResult) => {
    const zones = applyDrop(Object.fromEntries(pools.map((p, i) => [`pool:${i}`, p])), r);
    const next = pools.map((_, i) => zones[`pool:${i}`]);
    setLocal(next);
    if (await run(() => api(`/api/tournaments/${t.id}/sixmans/pools`, { method: 'PUT', body: { pools: next } }))) await reload();
    setLocal(null);
  };
  return (
    <div className="card">
      <div className="card-head">
        <h3 className="row" style={{ gap: 10 }}>Pools {confirmed && <span className="badge green">confirmed</span>}</h3>
        <div className="row">
          <label className="row small muted">Pools <input type="number" min={1} max={32} value={count} onChange={(e) => setCount(Number(e.target.value))} style={{ width: 70 }} /></label>
          <button className="btn" disabled={busy} onClick={async () => { if (await run(() => api(`/api/tournaments/${t.id}/sixmans/pools`, { body: { poolCount: count } }))) { toast('Pools proposed'); reload(); } }}>{plan ? 'Re-make pools' : 'Make pools'}</button>
          {plan && !confirmed && <button className="btn primary" disabled={busy || !legal} title={legal ? undefined : 'Fix the pools marked in red first'} onClick={async () => { if (await run(() => api(`/api/tournaments/${t.id}/sixmans/pools/confirm`, { body: {} }))) { toast('Pools confirmed'); reload(); } }}>Confirm pools</button>}
        </div>
      </div>
      <p className="muted small">{confirmedPlayers} confirmed players{out.size ? ` (${out.size} who can’t make it are left out)` : ''}. Pools are filled by snake draft on skill ({t.config.sixmans.skillMethod === 'rank' ? 'RL rank' : 'manual seed'}), then balanced by swaps; sizes differ by at most one; minimum 6 per pool. The same input always gives the same pools. Re-making or editing pools clears any schedule.</p>
      <ErrorBox error={error} />
      {plan && (
        <>
          <p className="small">Average skill per pool: {plan.averages.map((a: number) => a.toFixed(1)).join(' · ')} (spread {plan.averageSpread.toFixed(2)})</p>
          {!confirmed && <p className="small muted">Drag a name to another pool to move it, or onto another name to swap the two.</p>}
          <DragBoard onDrop={(r) => void drop(r)} disabled={busy || confirmed}>
            <div className="pool-grid">
              {plan.pools.map((p: any, i: number) => (
                <DropZone key={p.index} zone={`pool:${i}`} className="round" invalid={issues[i]?.length > 0} label={p.name}>
                  <h4>{p.name} · {pools[i]?.length ?? 0} players</h4>
                  {(pools[i] ?? []).map((u) => {
                    const x = info.get(u);
                    return <DragPill key={u} item={u} zone={`pool:${i}`} disabled={confirmed} label={names.get(u) ?? u} extra={x && <span className="muted tiny">{x.skill.toFixed(0)}{x.imputed ? '*' : ''}</span>} />;
                  })}
                  {issues[i]?.map((m) => <div key={m} className="issue">{m}</div>)}
                </DropZone>
              ))}
            </div>
          </DragBoard>
          {plan.pools.some((p: any) => p.players.some((x: any) => x.imputed)) && <p className="tiny muted">* no rank/seed given; treated as {t.config.sixmans.missingSkill}.</p>}
        </>
      )}
    </div>
  );
}

function ScheduleEditor({ d, names, reload }: { d: any; names: Map<string, string>; reload: () => void }) {
  const t = d.tournament;
  const sm = d.sixmans;
  const toast = useToast();
  const { busy, error, run } = useAsync();
  const [rounds, setRounds] = useState<number>(t.config.sixmans.roundsPerPool);
  const [mode, setMode] = useState<'equal_games' | 'fixed'>(t.config.sixmans.roundsMode ?? 'equal_games');
  const [games, setGames] = useState<number | null>(t.config.sixmans.gamesPerPlayer ?? null);
  const poolSizes: number[] = sm.pools?.data.pools.map((p: any) => p.players.length) ?? [];
  const [balanced, setBalanced] = useState<boolean>(t.config.sixmans.skillBalancedTeams);
  const plan = sm.schedule?.data;
  const confirmed = sm.schedule?.status === 'confirmed';
  const n = (u: string) => names.get(u) ?? u;
  // Edited rounds per pool, shown right away while the move saves.
  const [local, setLocal] = useState<Record<number, any[]>>({});
  const roundsOf = (p: any): any[] => local[p.poolIndex] ?? p.result.rounds;
  const issuesOf = (p: any) => (p.result.status === 'ok' ? scheduleMatchIssues({ rounds: roundsOf(p) }) : {});
  const neverPlays = (p: any) => {
    const rounds = roundsOf(p);
    const playing = new Set(rounds.flatMap((r: any) => r.matches.flatMap((m: any) => [...m.teamA, ...m.teamB])));
    return p.playerIds.filter((u: string) => !playing.has(u));
  };
  const legal = !!plan && plan.pools.every((p: any) => p.result.status === 'ok' && Object.keys(issuesOf(p)).length === 0 && neverPlays(p).length === 0);
  const drop = async (p: any, r: DropResult) => {
    const rd = roundsOf(p).find((x: any) => r.from.startsWith(`${x.round}:`));
    if (!rd) return;
    const zones: Record<string, string[]> = { [`${rd.round}:sit`]: rd.sitOut ?? [] };
    rd.matches.forEach((m: any, i: number) => { zones[`${rd.round}:${i}:A`] = m.teamA; zones[`${rd.round}:${i}:B`] = m.teamB; });
    const z = applyDrop(zones, r);
    const changed = { ...rd, matches: rd.matches.map((m: any, i: number) => ({ ...m, teamA: z[`${rd.round}:${i}:A`], teamB: z[`${rd.round}:${i}:B`] })), sitOut: z[`${rd.round}:sit`] };
    const rounds = roundsOf(p).map((x: any) => (x.round === rd.round ? changed : x));
    setLocal((l) => ({ ...l, [p.poolIndex]: rounds }));
    const body = { poolIndex: p.poolIndex, rounds: rounds.map((x: any) => ({ round: x.round, matches: x.matches.map((m: any) => ({ teamA: m.teamA, teamB: m.teamB })) })) };
    if (await run(() => api(`/api/tournaments/${t.id}/sixmans/schedule/pool`, { method: 'PUT', body }))) await reload();
    setLocal((l) => { const { [p.poolIndex]: _, ...rest } = l; return rest; });
  };
  return (
    <div className="card">
      <div className="card-head">
        <h3 className="row" style={{ gap: 10 }}>Group-stage schedule {confirmed && <span className="badge green">confirmed</span>}</h3>
        <div className="row">
          <select aria-label="Rounds mode" value={mode} onChange={(e) => setMode(e.target.value as 'equal_games')}>
            <option value="equal_games">Equal games for everyone</option>
            <option value="fixed">Fixed rounds</option>
          </select>
          {mode === 'fixed'
            ? <label className="row small muted">Rounds <input type="number" min={1} max={60} value={rounds} onChange={(e) => setRounds(Number(e.target.value))} style={{ width: 70 }} /></label>
            : <label className="row small muted">Games each <input type="number" min={1} max={60} placeholder="Auto" value={games ?? ''} onChange={(e) => setGames(e.target.value === '' ? null : Number(e.target.value))} style={{ width: 70 }} /></label>}
          <label className="check small"><input type="checkbox" checked={balanced} onChange={(e) => setBalanced(e.target.checked)} /> Skill-balanced</label>
          <button className="btn" disabled={busy} onClick={async () => { if (await run(() => api(`/api/tournaments/${t.id}/sixmans/schedule`, { body: mode === 'fixed' ? { mode, rounds, skillBalanced: balanced } : { mode, games, skillBalanced: balanced } }))) reload(); }}>{busy ? 'Searching…' : plan ? 'Regenerate' : 'Generate schedule'}</button>
          {plan && !confirmed && plan.pools.every((p: any) => p.result.status === 'ok') && (
            <button className="btn primary" disabled={busy || !legal} title={legal ? undefined : 'Fix the matches marked in red first'} onClick={async () => { if (await run(() => api(`/api/tournaments/${t.id}/sixmans/schedule/confirm`, { body: {} }))) { toast('Schedule confirmed'); reload(); } }}>Confirm schedule</button>
          )}
        </div>
      </div>
      {mode === 'equal_games' && poolSizes.length > 0 && !plan && (
        <RoundsPreview players={poolSizes.reduce((a, b) => a + b, 0)} poolCount={poolSizes.length} matchesPerRound={t.config.sixmans.matchesPerRound} games={games} />
      )}
      {plan?.notes?.length > 0 && <div className="alert info small">{plan.notes.map((x: string) => <div key={x}>{x}</div>)}</div>}
      <p className="muted small">One 3v3 match per round per pool. The scheduler guarantees no trio of teammates repeats in a pool, balances how often each player plays, and (optionally) balances team skill. Every schedule is re-checked by an independent validator.{plan && !confirmed && ' To change a match, drag a name to the other team, another match or the sit-out row of the same round, or onto another name to swap the two. Matches that are not allowed are marked in red with the reason.'}</p>
      <ErrorBox error={error} />
      {plan?.pools.map((p: any) => {
        const r = p.result;
        const poolName = `Pool ${String.fromCharCode(65 + p.poolIndex)}`;
        if (r.status !== 'ok')
          return (
            <div key={p.poolId} className="alert error" style={{ marginTop: 10 }}>
              <strong>{poolName}: {r.status === 'infeasible' ? 'impossible' : 'no schedule found in time'}.</strong> {r.infeasibility?.reasons.join(' ')}
              {r.infeasibility?.maxFeasibleFound != null && <div>Most rounds found: {r.infeasibility.maxFeasibleFound}{r.infeasibility.maxFeasibleProven ? ' (proven maximum)' : ''}. Upper bound from trio counting: {r.infeasibility.upperBoundRounds}.</div>}
              {r.infeasibility?.alternatives?.length > 0 && <ul>{r.infeasibility.alternatives.map((a: string) => <li key={a}>{a}</li>)}</ul>}
            </div>
          );
        const issues = issuesOf(p);
        const idle = neverPlays(p);
        const edit = !confirmed;
        return (
          <div key={p.poolId} style={{ marginTop: 16 }}>
            <div className="row between">
              <h4 style={{ margin: 0 }}>{poolName} · {p.playerIds.length} players · {r.rounds.length} rounds</h4>
              <span className="small muted">
                {r.balance.min === r.balance.max ? `${r.balance.min} games per player (equal)` : <>Games per player {r.balance.min}–{r.balance.max} {r.balance.ideal ? '(ideal)' : r.balance.provenBest ? '(best possible, proven)' : '(best found)'}</>} · skill diff total {r.skill.totalDiff.toFixed?.(0) ?? r.skill.totalDiff}{Object.keys(issues).length === 0 && ' · no repeated trios ✓'}
              </span>
            </div>
            {idle.length > 0 && <div className="issue">Never plays: {idle.map(n).join(', ')}. Every player needs at least one match.</div>}
            <DragBoard onDrop={(x) => void drop(p, x)} disabled={busy || !edit}>
              <div className="grid auto" style={{ marginTop: 8 }}>
                {roundsOf(p).map((rd: any) => {
                  const group = `p${p.poolIndex}r${rd.round}`;
                  const bad = rd.matches.some((_: any, i: number) => issues[`${rd.round}:${i}`]);
                  return (
                    <div className={`round ${bad ? 'drop-invalid' : ''}`} key={rd.round}>
                      <h4>Round {rd.round}</h4>
                      {rd.matches.map((m: any, i: number) => {
                        const why = issues[`${rd.round}:${i}`];
                        return (
                          <div key={i} className={`match-box ${why ? 'drop-invalid' : ''}`}>
                            <div className="vs">
                              <DropZone zone={`${rd.round}:${i}:A`} group={group} className="team-zone a" label={`Round ${rd.round} team A`}>
                                {m.teamA.map((u: string) => <DragPill key={u} item={u} zone={`${rd.round}:${i}:A`} group={group} disabled={!edit} label={n(u)} />)}
                              </DropZone>
                              <span className="label">vs</span>
                              <DropZone zone={`${rd.round}:${i}:B`} group={group} className="team-zone b" label={`Round ${rd.round} team B`}>
                                {m.teamB.map((u: string) => <DragPill key={u} item={u} zone={`${rd.round}:${i}:B`} group={group} disabled={!edit} label={n(u)} />)}
                              </DropZone>
                            </div>
                            <div className="row between tiny muted"><span>{m.skillA?.toFixed?.(0)}</span><span>{m.skillB?.toFixed?.(0)}</span></div>
                            {why?.map((w: string) => <div key={w} className="issue">Not allowed: {w}</div>)}
                          </div>
                        );
                      })}
                      {(edit || rd.sitOut?.length > 0) && (
                        <DropZone zone={`${rd.round}:sit`} group={group} className="sit-zone" label={`Round ${rd.round} sitting out`}>
                          <span className="tiny muted">Sitting out:</span>
                          {(rd.sitOut ?? []).map((u: string) => <DragPill key={u} item={u} zone={`${rd.round}:sit`} group={group} disabled={!edit} label={n(u)} />)}
                        </DropZone>
                      )}
                    </div>
                  );
                })}
              </div>
            </DragBoard>
          </div>
        );
      })}
    </div>
  );
}

function FinalsEditor({ d, names, reload }: { d: any; names: Map<string, string>; reload: () => void }) {
  const t = d.tournament;
  const plan = d.sixmans.finals.data;
  const toast = useToast();
  const { busy, error, run } = useAsync();
  const [perPool, setPerPool] = useState<number>(plan.qualifiersPerPool);
  const n = (u: string) => names.get(u) ?? u;
  const preview = async (optionId: string | null, q?: number, extra: Record<string, unknown> = {}) => {
    if (await run(() => api(`/api/tournaments/${t.id}/sixmans/finals/preview`, { body: { optionId, qualifiersPerPool: q ?? perPool, ...extra } }))) reload();
  };
  // Older proposals (made before these choices existed) fall back to the settings.
  const sm = t.config.sixmans;
  const bracketFormat: string = plan.bracketFormat ?? 'single_elim';
  const formation: string = plan.formation ?? sm.finalsTeamFormation;
  const keepOption = plan.optionId === 'hand_picked' ? null : plan.optionId;
  // Bracket changes keep the teams as they are (including swaps and hand-picked teams).
  const reshape = async (body: Record<string, unknown>) => {
    if (await run(() => api(`/api/tournaments/${t.id}/sixmans/finals/preview`, { body }))) reload();
  };
  // Teams as dragged, shown right away while the move saves.
  const [local, setLocal] = useState<string[][] | null>(null);
  const teamPlayers: string[][] = local ?? plan.teams.map((tm: any) => tm.players);
  const drop = async (r: DropResult) => {
    const z = applyDrop(Object.fromEntries(teamPlayers.map((p, i) => [`team:${i}`, p])), r);
    const next = teamPlayers.map((_, i) => z[`team:${i}`]);
    setLocal(next);
    if (await run(() => api(`/api/tournaments/${t.id}/sixmans/finals/teams`, { method: 'PUT', body: { teams: next.map((players) => ({ players })) } }))) await reload();
    setLocal(null);
  };
  const legal = teamPlayers.every((tm) => tm.length === 3);
  const [handPick, setHandPick] = useState(false);
  return (
    <>
    {handPick && <HandPickTeams plan={plan} t={t} n={n} reload={reload} close={() => setHandPick(false)} />}
    <div className="card">
      <div className="card-head">
        <h3>Finals setup</h3>
        <div className="row">
          <label className="row small muted">Qualifiers per pool <input type="number" min={1} value={perPool} onChange={(e) => setPerPool(Number(e.target.value))} style={{ width: 70 }} /></label>
          <button className="btn small" onClick={() => preview(null, perPool)} disabled={busy}>Recalculate</button>
          <button className="btn small" onClick={() => setHandPick(true)} disabled={busy || handPick}>Hand-pick teams</button>
          <button className="btn primary" disabled={busy || !legal} title={legal ? undefined : 'Every team needs exactly 3 players'} onClick={async () => { if (await run(() => api(`/api/tournaments/${t.id}/sixmans/finals/start`, { body: {} }))) { toast('Finals started!'); reload(); } }}>Start finals</button>
        </div>
      </div>
      <ErrorBox error={error} />
      <p className="small muted">Qualified ({plan.qualified.length}): {plan.qualified.map((q: any) => `${n(q.playerId)} (P${q.poolIndex + 1} #${q.poolRank})`).join(', ')}</p>
      <h4>Bracket</h4>
      <div className="row" style={{ gap: 16 }}>
        <label className="row small">Format
          <select value={bracketFormat} disabled={busy} onChange={(e) => void reshape({ bracketFormat: e.target.value })}>
            <option value="single_elim">Single elimination</option><option value="double_elim">Double elimination</option>
          </select>
        </label>
        {bracketFormat === 'single_elim' && <label className="check small"><input type="checkbox" checked={!!plan.thirdPlace} disabled={busy} onChange={(e) => void reshape({ thirdPlace: e.target.checked })} /> Third-place match</label>}
        {bracketFormat === 'double_elim' && <label className="check small"><input type="checkbox" checked={!!plan.grandFinalReset} disabled={busy} onChange={(e) => void reshape({ grandFinalReset: e.target.checked })} /> Grand-final reset</label>}
        <label className="row small">Teams
          <select value={plan.optionId === 'hand_picked' ? 'hand_picked' : formation} disabled={busy} onChange={(e) => (e.target.value === 'hand_picked' ? setHandPick(true) : void preview(keepOption, undefined, { formation: e.target.value }))}>
            {FINALS_TEAM_FORMATIONS.map((f) => <option key={f} value={f}>{FINALS_TEAM_FORMATION_LABELS[f]}</option>)}
            <option value="hand_picked">Hand-picked</option>
          </select>
        </label>
      </div>
      {plan.mixedPoolTeams > 0 && plan.optionId !== 'hand_picked' && <div className="alert info small" style={{ marginTop: 8 }}>Some pools do not have a multiple of 3 finals players, so {plan.mixedPoolTeams} team{plan.mixedPoolTeams === 1 ? ' mixes' : 's mix'} players from different pools.</div>}
      <h4 style={{ marginTop: 14 }}>Structure</h4>
      <div className="stack">
        {plan.optionId === 'hand_picked' && <div className="alert info">Using your hand-picked teams. Choose a structure below to go back to automatic teams.</div>}
        {plan.options.filter((o: any) => o.id !== 'hand_picked').map((o: any) => (
          <label key={o.id} className="check" style={{ alignItems: 'flex-start' }}>
            <input type="radio" name="finals-option" checked={o.id === plan.optionId} onChange={() => preview(o.id)} />
            <span><strong>{o.label}</strong> — <span className="small">{o.description}</span>{o.added.length > 0 && <span className="small team-a"> Adds: {o.added.map(n).join(', ')}.</span>}{o.removed.length > 0 && <span className="small team-b"> Drops: {o.removed.map(n).join(', ')}.</span>}</span>
          </label>
        ))}
      </div>
      <h4 style={{ marginTop: 14 }}>Teams ({plan.optionId === 'hand_picked' ? 'hand-picked' : FINALS_TEAM_FORMATION_LABELS[formation as 'balanced']?.toLowerCase() ?? formation}; drag a name to another team to move it, or onto another name to swap)</h4>
      <DragBoard onDrop={(r) => void drop(r)} disabled={busy}>
        <div className="pool-grid">
          {plan.teams.map((tm: any, i: number) => (
            <DropZone key={tm.key} zone={`team:${i}`} className="round" invalid={teamPlayers[i].length !== 3} label={`Seed ${tm.seed}`}>
              <h4>Seed {tm.seed} · {tm.name} · skill {tm.skill.toFixed?.(0) ?? tm.skill}</h4>
              {teamPlayers[i].map((u: string) => <DragPill key={u} item={u} zone={`team:${i}`} label={n(u)} />)}
              {teamPlayers[i].length !== 3 && <div className="issue">Not allowed: has {teamPlayers[i].length} players; finals teams need exactly 3.</div>}
            </DropZone>
          ))}
        </div>
      </DragBoard>
      <h4 style={{ marginTop: 14 }}>First round{bracketFormat === 'double_elim' ? ' (winners bracket)' : ''}</h4>
      <div className="small">{plan.bracket.filter((b: any) => b.round === 1).map((b: any, i: number) => {
        const tn = (k: string | null) => (k ? plan.teams.find((x: any) => x.key === k)?.name ?? k : 'bye');
        return <div key={i}>{tn(b.a)} vs {tn(b.b)}</div>;
      })}</div>
    </div>
    </>
  );
}

/** Build the finals teams by hand from any group-stage players (qualified or not). */
function HandPickTeams({ plan, t, n, reload, close }: { plan: any; t: any; n: (u: string) => string; reload: () => void; close: () => void }) {
  const { busy, error, run } = useAsync();
  const toast = useToast();
  const everyone: any[] = [...plan.qualified, ...plan.others];
  const qualified = new Set(plan.qualified.map((q: any) => q.playerId));
  const [count, setCount] = useState<number>(Math.max(2, plan.teams.length));
  const [assign, setAssign] = useState<Record<string, number>>(() => Object.fromEntries(plan.teams.flatMap((tm: any, i: number) => tm.players.map((u: string) => [u, i]))));
  const teams = Array.from({ length: count }, (_, i) => everyone.map((q) => q.playerId).filter((u) => assign[u] === i));
  const bench = everyone.map((q) => q.playerId).filter((u) => !((assign[u] ?? -1) >= 0 && assign[u] < count));
  const ready = teams.every((tm) => tm.length === 3);
  const info = new Map(everyone.map((q) => [q.playerId, q]));
  const drop = (r: DropResult) => {
    const zones: Record<string, string[]> = { bench, ...Object.fromEntries(teams.map((tm, i) => [`team:${i}`, tm])) };
    const z = applyDrop(zones, r);
    const next: Record<string, number> = {};
    teams.forEach((_, i) => z[`team:${i}`].forEach((u) => { next[u] = i; }));
    setAssign(next);
  };
  const pill = (u: string, zone: string) => {
    const q = info.get(u);
    return <DragPill key={u} item={u} zone={zone} label={n(u)} extra={q && <span className="muted tiny">P{q.poolIndex + 1} #{q.poolRank}{qualified.has(u) ? ' ✓' : ''}</span>} />;
  };
  const save = async () => {
    if (await run(() => api(`/api/tournaments/${t.id}/sixmans/finals/teams`, { method: 'PUT', body: { teams: teams.map((players) => ({ players })), handPicked: true } }))) {
      toast('Finals teams saved');
      close();
      reload();
    }
  };
  return (
    <div className="card">
      <div className="card-head">
        <h3>Hand-pick finals teams</h3>
        <div className="row">
          <label className="row small muted">Teams <input type="number" min={2} max={Math.floor(everyone.length / 3)} value={count} onChange={(e) => setCount(Math.max(2, Number(e.target.value) || 2))} style={{ width: 60 }} /></label>
          <button className="btn small" onClick={close} disabled={busy}>Cancel</button>
          <button className="btn primary small" onClick={save} disabled={busy || !ready}>Use these teams</button>
        </div>
      </div>
      <ErrorBox error={error} />
      <p className="small muted">Drag exactly 3 players onto each team. Any group-stage player can be picked; team 1 is the top seed. ✓ marks players who qualified.</p>
      <DragBoard onDrop={drop} disabled={busy}>
        <div className="pool-grid">
          {teams.map((tm, i) => (
            <DropZone key={i} zone={`team:${i}`} className="round" invalid={tm.length !== 3} label={`Team ${i + 1}`}>
              <h4>Team {i + 1} (seed {i + 1})</h4>
              {tm.map((u) => pill(u, `team:${i}`))}
              {tm.length !== 3 && <div className="issue">{tm.length}/3 players</div>}
            </DropZone>
          ))}
        </div>
        <DropZone zone="bench" className="round bench-zone" label="Not playing">
          <h4>Not playing ({bench.length})</h4>
          {bench.map((u) => pill(u, 'bench'))}
        </DropZone>
      </DragBoard>
    </div>
  );
}
