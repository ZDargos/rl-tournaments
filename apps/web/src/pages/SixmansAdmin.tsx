import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { ErrorBox, Field, useToast } from '../components/ui';
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
      <div className="steps">{steps.map((s, i) => <span key={s} className={`step ${i < step ? 'done' : i === step ? 'current' : ''}`}>{i < step ? '✓ ' : ''}{s}</span>)}</div>
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
      {t.stage === 'finals' && <div className="alert ok">Finals are running. See the Finals bracket on the tournament page.</div>}
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
  const confirmedPlayers = d.entries.filter((e: any) => e.status === 'confirmed').length;
  const move = async (userId: string, to: number) => {
    const pools: string[][] = plan.pools.map((p: any) => p.players.map((x: any) => x.userId).filter((u: string) => u !== userId));
    pools[to].push(userId);
    if (await run(() => api(`/api/tournaments/${t.id}/sixmans/pools`, { method: 'PUT', body: { pools } }))) reload();
  };
  return (
    <div className="card">
      <div className="card-head">
        <h3>1. Pools {confirmed && <span className="badge green">confirmed</span>}</h3>
        <div className="row">
          <label className="row small muted">Pools <input type="number" min={1} max={32} value={count} onChange={(e) => setCount(Number(e.target.value))} style={{ width: 70 }} /></label>
          <button className="btn" disabled={busy} onClick={async () => { if (await run(() => api(`/api/tournaments/${t.id}/sixmans/pools`, { body: { poolCount: count } }))) { toast('Pools proposed'); reload(); } }}>{plan ? 'Re-make pools' : 'Make pools'}</button>
          {plan && !confirmed && <button className="btn primary" disabled={busy} onClick={async () => { if (await run(() => api(`/api/tournaments/${t.id}/sixmans/pools/confirm`, { body: {} }))) { toast('Pools confirmed'); reload(); } }}>Confirm pools</button>}
        </div>
      </div>
      <p className="muted small">{confirmedPlayers} confirmed players. Pools are filled by snake draft on skill ({t.config.sixmans.skillMethod === 'rank' ? 'RL rank' : 'manual seed'}), then balanced by swaps; sizes differ by at most one; minimum 6 per pool. The same input always gives the same pools. Re-making or editing pools clears any schedule.</p>
      <ErrorBox error={error} />
      {plan && (
        <>
          <p className="small">Average skill per pool: {plan.averages.map((a: number) => a.toFixed(1)).join(' · ')} (spread {plan.averageSpread.toFixed(2)})</p>
          <div className="pool-grid">
            {plan.pools.map((p: any) => (
              <div className="round" key={p.index}>
                <h4>{p.name} · {p.players.length} players</h4>
                {p.players.map((x: any) => (
                  <span key={x.userId} className="player-pill">
                    {names.get(x.userId) ?? x.userId} <span className="muted tiny">{x.skill.toFixed(0)}{x.imputed ? '*' : ''}</span>
                    {!confirmed && (
                      <select aria-label={`Move ${names.get(x.userId)}`} value={p.index} onChange={(e) => void move(x.userId, Number(e.target.value))}>
                        {plan.pools.map((q: any) => <option key={q.index} value={q.index}>{q.name.replace('Pool ', '→')}</option>)}
                      </select>
                    )}
                  </span>
                ))}
              </div>
            ))}
          </div>
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
  const [swap, setSwap] = useState<{ pool: number; round: number; a: string; b: string }>({ pool: 0, round: 1, a: '', b: '' });
  const plan = sm.schedule?.data;
  const confirmed = sm.schedule?.status === 'confirmed';
  const n = (u: string) => names.get(u) ?? u;
  return (
    <div className="card">
      <div className="card-head">
        <h3>2. Group-stage schedule {confirmed && <span className="badge green">confirmed</span>}</h3>
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
            <button className="btn primary" disabled={busy} onClick={async () => { if (await run(() => api(`/api/tournaments/${t.id}/sixmans/schedule/confirm`, { body: {} }))) { toast('Schedule confirmed'); reload(); } }}>Confirm schedule</button>
          )}
        </div>
      </div>
      {mode === 'equal_games' && poolSizes.length > 0 && !plan && (
        <RoundsPreview players={poolSizes.reduce((a, b) => a + b, 0)} poolCount={poolSizes.length} matchesPerRound={t.config.sixmans.matchesPerRound} games={games} />
      )}
      {plan?.notes?.length > 0 && <div className="alert info small">{plan.notes.map((x: string) => <div key={x}>{x}</div>)}</div>}
      <p className="muted small">One 3v3 match per round per pool. The scheduler guarantees no trio of teammates repeats in a pool, balances how often each player plays, and (optionally) balances team skill. Every schedule is re-checked by an independent validator.</p>
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
        return (
          <div key={p.poolId} style={{ marginTop: 16 }}>
            <div className="row between">
              <h4 style={{ margin: 0 }}>{poolName} · {p.playerIds.length} players · {r.rounds.length} rounds</h4>
              <span className="small muted">
                {r.balance.min === r.balance.max ? `${r.balance.min} games per player (equal)` : <>Games per player {r.balance.min}–{r.balance.max} {r.balance.ideal ? '(ideal)' : r.balance.provenBest ? '(best possible, proven)' : '(best found)'}</>} · skill diff total {r.skill.totalDiff.toFixed?.(0) ?? r.skill.totalDiff} (best found) · no repeated trios ✓
              </span>
            </div>
            <div className="grid auto" style={{ marginTop: 8 }}>
              {r.rounds.map((rd: any) => (
                <div className="round" key={rd.round}>
                  <h4>Round {rd.round}</h4>
                  {rd.matches.map((m: any) => (
                    <div key={m.index} className="vs" style={{ marginBottom: 6 }}>
                      <div className="team-a small">{m.teamA.map(n).join(', ')}<div className="tiny muted">{m.skillA?.toFixed?.(0)}</div></div>
                      <span className="label">vs</span>
                      <div className="team-b small" style={{ textAlign: 'right' }}>{m.teamB.map(n).join(', ')}<div className="tiny muted">{m.skillB?.toFixed?.(0)}</div></div>
                    </div>
                  ))}
                  {rd.sitOut.length > 0 && <div className="tiny muted">Sitting out: {rd.sitOut.map(n).join(', ')}</div>}
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {plan && !confirmed && plan.pools.some((p: any) => p.result.status === 'ok') && (
        <details style={{ marginTop: 14 }}>
          <summary>Manual adjustment: swap two players within a round</summary>
          <div className="form-grid" style={{ marginTop: 10 }}>
            <Field label="Pool"><select value={swap.pool} onChange={(e) => setSwap({ ...swap, pool: Number(e.target.value), a: '', b: '' })}>{plan.pools.map((p: any) => <option key={p.poolIndex} value={p.poolIndex}>Pool {String.fromCharCode(65 + p.poolIndex)}</option>)}</select></Field>
            <Field label="Round"><input type="number" min={1} max={plan.pools.find((p: any) => p.poolIndex === swap.pool)?.rounds ?? plan.rounds} value={swap.round} onChange={(e) => setSwap({ ...swap, round: Number(e.target.value) })} /></Field>
            {(['a', 'b'] as const).map((k) => (
              <Field key={k} label={k === 'a' ? 'Player' : 'Swap with'}>
                <select value={swap[k]} onChange={(e) => setSwap({ ...swap, [k]: e.target.value })}>
                  <option value="">Choose…</option>
                  {plan.pools.find((p: any) => p.poolIndex === swap.pool)?.playerIds.map((u: string) => <option key={u} value={u}>{n(u)}</option>)}
                </select>
              </Field>
            ))}
          </div>
          <p className="tiny muted">Swaps that would repeat a trio, put someone twice in a round, or worsen appearance balance are refused.</p>
          <button className="btn small" disabled={busy || !swap.a || !swap.b} onClick={async () => { if (await run(() => api(`/api/tournaments/${t.id}/sixmans/schedule/swap`, { body: { poolIndex: swap.pool, round: swap.round, playerA: swap.a, playerB: swap.b } }))) { toast('Swapped and re-validated'); reload(); } }}>Swap</button>
        </details>
      )}
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
  const preview = async (optionId: string | null, q?: number) => {
    if (await run(() => api(`/api/tournaments/${t.id}/sixmans/finals/preview`, { body: { optionId, qualifiersPerPool: q ?? perPool } }))) reload();
  };
  const moveTo = async (userId: string, to: number) => {
    const teams = plan.teams.map((tm: any) => ({ players: tm.players.filter((u: string) => u !== userId) }));
    teams[to].players.push(userId);
    if (await run(() => api(`/api/tournaments/${t.id}/sixmans/finals/teams`, { method: 'PUT', body: { teams } }))) reload();
  };
  const swapPlayers = async (u1: string, u2: string) => {
    const teams = plan.teams.map((tm: any) => ({ players: tm.players.map((u: string) => (u === u1 ? u2 : u === u2 ? u1 : u)) }));
    if (await run(() => api(`/api/tournaments/${t.id}/sixmans/finals/teams`, { method: 'PUT', body: { teams } }))) reload();
  };
  const [pick, setPick] = useState<string | null>(null);
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
          <button className="btn primary" disabled={busy || plan.teams.some((tm: any) => tm.players.length !== 3)} onClick={async () => { if (await run(() => api(`/api/tournaments/${t.id}/sixmans/finals/start`, { body: {} }))) { toast('Finals started!'); reload(); } }}>Start finals</button>
        </div>
      </div>
      <ErrorBox error={error} />
      <p className="small muted">Qualified ({plan.qualified.length}): {plan.qualified.map((q: any) => `${n(q.playerId)} (P${q.poolIndex + 1} #${q.poolRank})`).join(', ')}</p>
      <h4>Structure</h4>
      <div className="stack">
        {plan.optionId === 'hand_picked' && <div className="alert info">Using your hand-picked teams. Choose a structure below to go back to automatic teams.</div>}
        {plan.options.filter((o: any) => o.id !== 'hand_picked').map((o: any) => (
          <label key={o.id} className="check" style={{ alignItems: 'flex-start' }}>
            <input type="radio" name="finals-option" checked={o.id === plan.optionId} onChange={() => preview(o.id)} />
            <span><strong>{o.label}</strong> — <span className="small">{o.description}</span>{o.added.length > 0 && <span className="small team-a"> Adds: {o.added.map(n).join(', ')}.</span>}{o.removed.length > 0 && <span className="small team-b"> Drops: {o.removed.map(n).join(', ')}.</span>}</span>
          </label>
        ))}
      </div>
      <h4 style={{ marginTop: 14 }}>Teams ({plan.optionId === 'hand_picked' ? 'hand-picked' : 'balanced'}; click two players to swap them)</h4>
      <div className="pool-grid">
        {plan.teams.map((tm: any, i: number) => (
          <div className="round" key={tm.key}>
            <h4>Seed {tm.seed} · {tm.name} · skill {tm.skill.toFixed?.(0) ?? tm.skill}</h4>
            {tm.players.map((u: string) => (
              <span key={u} className={`player-pill ${pick === u ? 'me' : ''}`} style={{ cursor: 'pointer' }} onClick={() => { if (!pick) setPick(u); else { if (pick !== u) void swapPlayers(pick, u); setPick(null); } }}>
                {n(u)}
                <select aria-label={`Move ${n(u)}`} value={i} onClick={(e) => e.stopPropagation()} onChange={(e) => void moveTo(u, Number(e.target.value))}>
                  {plan.teams.map((_: any, j: number) => <option key={j} value={j}>→{j + 1}</option>)}
                </select>
              </span>
            ))}
            {tm.players.length !== 3 && <div className="tiny" style={{ color: 'var(--red)' }}>Needs exactly 3 players</div>}
          </div>
        ))}
      </div>
      <h4 style={{ marginTop: 14 }}>First round</h4>
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
  const ready = teams.every((tm) => tm.length === 3);
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
      <p className="small muted">Put exactly 3 players on each team. Any group-stage player can be picked; team 1 is the top seed.</p>
      <div className="pool-grid">
        {teams.map((tm, i) => (
          <div className="round" key={i}>
            <h4>Team {i + 1} (seed {i + 1})</h4>
            {tm.map((u) => <span key={u} className="player-pill">{n(u)}</span>)}
            {tm.length !== 3 && <div className="tiny" style={{ color: 'var(--red)' }}>{tm.length}/3 players</div>}
          </div>
        ))}
      </div>
      <div className="table-wrap" style={{ marginTop: 10 }}>
        <table className="table">
          <thead><tr><th>Player</th><th>Group result</th><th>Team</th></tr></thead>
          <tbody>
            {everyone.map((q) => (
              <tr key={q.playerId}>
                <td>{n(q.playerId)}</td>
                <td className="small">P{q.poolIndex + 1} #{q.poolRank}{qualified.has(q.playerId) ? ' · qualified' : ''}</td>
                <td>
                  <select aria-label={`Team for ${n(q.playerId)}`} value={(assign[q.playerId] ?? -1) < count ? assign[q.playerId] ?? -1 : -1} onChange={(e) => setAssign({ ...assign, [q.playerId]: Number(e.target.value) })}>
                    <option value={-1}>Not playing</option>
                    {teams.map((_, j) => <option key={j} value={j}>Team {j + 1}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
