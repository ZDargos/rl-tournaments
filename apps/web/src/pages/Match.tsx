import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { winsNeeded } from '@rl/core';
import { api } from '../lib/api';
import { useAsync, useLive } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { ConfirmButton, Empty, ErrorBox, Field, MatchBadge, Modal, Spinner, useToast } from '../components/ui';
import { fmtDate } from '../lib/format';

type Game = { a: number | ''; b: number | '' };

function GamesEditor({ bestOf, games, setGames, nameA, nameB }: { bestOf: number; games: Game[]; setGames: (g: Game[]) => void; nameA: string; nameB: string }) {
  const need = winsNeeded(bestOf);
  const winsA = games.filter((g) => g.a !== '' && g.b !== '' && g.a > g.b).length;
  const winsB = games.filter((g) => g.a !== '' && g.b !== '' && g.b > g.a).length;
  const decided = winsA >= need || winsB >= need;
  return (
    <div className="games">
      <div className="game-row tiny muted"><span /><span className="team-a">{nameA}</span><span /><span className="team-b">{nameB}</span><span /></div>
      {games.map((g, i) => (
        <div className="game-row" key={i}>
          <span className="muted small">Game {i + 1}</span>
          <input type="number" min={0} max={99} inputMode="numeric" aria-label={`Game ${i + 1} ${nameA} goals`} value={g.a} onChange={(e) => setGames(games.map((x, j) => (j === i ? { ...x, a: e.target.value === '' ? '' : Number(e.target.value) } : x)))} />
          <span className="muted">–</span>
          <input type="number" min={0} max={99} inputMode="numeric" aria-label={`Game ${i + 1} ${nameB} goals`} value={g.b} onChange={(e) => setGames(games.map((x, j) => (j === i ? { ...x, b: e.target.value === '' ? '' : Number(e.target.value) } : x)))} />
          {games.length > 1 ? <button className="btn ghost small" aria-label="Remove game" onClick={() => setGames(games.filter((_, j) => j !== i))}>✕</button> : <span />}
        </div>
      ))}
      <div className="row between">
        <span className="small muted">Series: <strong className="team-a">{winsA}</strong> – <strong className="team-b">{winsB}</strong> {decided ? '· decided' : `· first to ${need}`}</span>
        {!decided && games.length < bestOf && <button className="btn ghost small" onClick={() => setGames([...games, { a: '', b: '' }])}>+ Add game</button>}
      </div>
    </div>
  );
}

const clean = (games: Game[]) => games.filter((g) => g.a !== '' && g.b !== '').map((g) => ({ a: Number(g.a), b: Number(g.b) }));

export function MatchPage() {
  const { id } = useParams();
  const { me } = useAuth();
  const toast = useToast();
  const { data: d, error, loading, reload } = useLive<any>(id ? `/api/matches/${id}` : null, id ? `/api/matches/${id}` : null, 6000);
  const [games, setGames] = useState<Game[]>([{ a: '', b: '' }]);
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [disputeReason, setDisputeReason] = useState('');
  const [adminOpen, setAdminOpen] = useState(false);
  const [impact, setImpact] = useState<any[] | null>(null);
  const [reason, setReason] = useState('');
  const [forfeit, setForfeit] = useState<'' | 'a' | 'b'>('');
  const { busy, error: actErr, setError, run } = useAsync();
  if (loading && !d) return <Spinner />;
  if (error && !d) return error.status === 404 ? <Empty icon="🔒" title="Match not found" /> : <ErrorBox error={error} />;
  if (!d) return null;
  const m = d.match;
  const t = d.tournament;
  const mySide: 'a' | 'b' | null = d.viewer.side;
  const open = ['ready', 'awaiting_confirmation', 'disputed'].includes(m.status) && t.state === 'in_progress';
  const current = (r: any) => !r.superseded && r.resultVersion === m.resultVersion;
  const myReport = d.reports.find((r: any) => r.userId === me?.user.id && r.kind === 'report' && current(r));
  const opposingReport = d.reports.find((r: any) => r.kind === 'report' && current(r) && r.side && r.side !== mySide);
  const canReport = !!mySide && open && m.status !== 'disputed' && d.config.confirmation !== 'admin_only';
  const canConfirm = !!mySide && m.status === 'awaiting_confirmation' && !!opposingReport;
  const nameA = m.a?.name ?? 'Team A';
  const nameB = m.b?.name ?? 'Team B';

  const submit = async () => {
    const r = await run(() => api(`/api/matches/${m.id}/report`, { body: { games: clean(games) } }));
    if (r) {
      toast(r.outcome === 'completed' ? 'Result recorded.' : r.outcome === 'disputed' ? 'Reports disagree; organizers were notified.' : 'Reported. Waiting for the other team to confirm.');
      reload();
    }
  };
  const resolve = async (confirmDownstream = false) => {
    setError(null);
    try {
      await api(`/api/matches/${m.id}/resolve`, { body: { games: forfeit ? null : clean(games), forfeitWinner: forfeit || null, reason: reason || null, confirmDownstream } });
      toast('Result saved.');
      setAdminOpen(false);
      setImpact(null);
      reload();
    } catch (e: any) {
      if (e.code === 'downstream_impact') setImpact(e.details.matches);
      else setError(e.message);
    }
  };

  return (
    <div className="stack" style={{ maxWidth: 900, margin: '0 auto' }}>
      <div className="row between">
        <Link to={`/t/${t.id}`}>← {t.name}</Link>
        <MatchBadge status={m.status} />
      </div>
      <div className="card">
        <div className="muted small">{m.label} · Match #{m.id} · Best of {m.bestOf}</div>
        <div className="vs" style={{ marginTop: 14 }}>
          <div>
            <div className="team-a" style={{ fontSize: '1.3rem', fontWeight: 800 }}>{nameA} {m.winner === 'a' && '🏆'}</div>
            <div className="small muted">{m.a?.players.map((p: any) => p.name).join(', ')}</div>
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 900, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
            {m.status === 'completed' ? (m.forfeit ? 'FF' : `${m.winsA}–${m.winsB}`) : m.liveGames.length ? <span className="muted" title="Unofficial live score">{m.liveGames.filter((g: any) => g.a > g.b).length}–{m.liveGames.filter((g: any) => g.b > g.a).length}</span> : 'vs'}
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="team-b" style={{ fontSize: '1.3rem', fontWeight: 800 }}>{m.winner === 'b' && '🏆'} {nameB}</div>
            <div className="small muted">{m.b?.players.map((p: any) => p.name).join(', ')}</div>
          </div>
        </div>
        {m.games.length > 0 && (
          <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
            {m.games.map((g: any, i: number) => <span key={i} className="badge">G{i + 1}: {g.a}–{g.b}</span>)}
          </div>
        )}
        {m.status === 'ready' && m.liveGames.length > 0 && <p className="muted small" style={{ textAlign: 'center', marginTop: 8 }}>Live score is unofficial until the result is reported and confirmed.</p>}
        {d.voice.length > 0 && (
          <div className="alert info" style={{ marginTop: 12 }}>
            🎧 Voice: {d.voice.filter((v: any) => v.status === 'active').map((v: any) => <span key={v.id} style={{ marginRight: 10 }}>{v.slot === 'a' ? nameA : nameB}: <span className="mono">#{v.name}</span></span>)}
            {d.voice.some((v: any) => v.status === 'failed') && <span className="muted"> (some channels could not be created; organizers were notified)</span>}
          </div>
        )}
      </div>

      {canConfirm && (
        <div className="card" style={{ borderColor: 'var(--yellow)' }}>
          <h3>Confirm the reported result</h3>
          <p>The other team reported <strong>{opposingReport.winsA}–{opposingReport.winsB}</strong>{opposingReport.games?.length ? ` (${opposingReport.games.map((g: any) => `${g.a}-${g.b}`).join(', ')})` : ''}.</p>
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={async () => { if (await run(() => api(`/api/matches/${m.id}/confirm`, { body: {} }))) { toast('Confirmed.'); reload(); } }}>Confirm result</button>
            <button className="btn danger" onClick={() => setDisputeOpen(true)}>Dispute</button>
          </div>
        </div>
      )}

      {canReport && (
        <div className="card">
          <h3>{myReport ? 'Update your report' : 'Report the result'}</h3>
          {myReport && <p className="muted small">You reported {myReport.winsA}–{myReport.winsB}. Waiting for the other team. Reporting again replaces your report.</p>}
          <p className="muted small">Enter goals per game. {nameA} is listed first (blue).</p>
          <GamesEditor bestOf={m.bestOf} games={games} setGames={setGames} nameA={nameA} nameB={nameB} />
          <div className="spacer" />
          <button className="btn primary" disabled={busy || clean(games).length === 0} onClick={submit}>Submit result</button>
        </div>
      )}

      {m.status === 'disputed' && <div className="alert warn">This result is disputed. An organizer will review it.</div>}
      <ErrorBox error={actErr} />

      {d.viewer.canManage && m.status !== 'pending' && !m.walkover && m.status !== 'void' && t.state !== 'completed' && (
        <div className="card">
          <div className="card-head">
            <h3>Organizer</h3>
            <div className="row">
              <button className="btn" onClick={() => setAdminOpen(true)}>{m.status === 'completed' ? 'Correct result' : 'Enter / resolve result'}</button>
              {m.stage === 'group' && m.status !== 'completed' && (
                <ConfirmButton className="btn danger" label="Abandon" reason="required" confirm="Abandon this group match? Depending on the tournament setting it is either voided or counted as a loss for all six players." onConfirm={async (r) => { await api(`/api/matches/${m.id}/abandon`, { body: { reason: r } }); reload(); }} />
              )}
            </div>
          </div>
          <p className="muted small">Organizer overrides and corrections need a reason and are recorded in the audit log. Correcting a result that later matches depend on resets those matches after you confirm.</p>
        </div>
      )}

      {d.reports.length > 0 && (
        <div className="card">
          <h3>History</h3>
          <div className="table-wrap"><table className="table">
            <tbody>
              {d.reports.map((r: any) => (
                <tr key={r.id} style={{ opacity: r.superseded ? 0.5 : 1 }}>
                  <td className="small muted" style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.createdAt)}</td>
                  <td><span className="badge">{r.kind.replace('_', ' ')}</span></td>
                  <td className="small">{r.userName ?? 'organizer'}{r.side ? ` (${r.side === 'a' ? nameA : nameB})` : ''}</td>
                  <td className="small">{r.winsA != null ? `${r.winsA}–${r.winsB}` : ''} {r.reason && <span className="muted">“{r.reason}”</span>}</td>
                  <td className="tiny muted">{r.source}{r.superseded ? ' · superseded' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      )}

      {disputeOpen && (
        <Modal title="Dispute result" onClose={() => setDisputeOpen(false)}>
          <Field label="What is wrong?"><textarea value={disputeReason} onChange={(e) => setDisputeReason(e.target.value)} maxLength={500} /></Field>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn danger" disabled={disputeReason.trim().length < 3 || busy} onClick={async () => { if (await run(() => api(`/api/matches/${m.id}/dispute`, { body: { reason: disputeReason } }))) { setDisputeOpen(false); toast('Disputed. Organizers were notified.'); reload(); } }}>Send dispute</button>
          </div>
        </Modal>
      )}

      {adminOpen && (
        <Modal title={m.status === 'completed' ? 'Correct result' : 'Enter result'} onClose={() => { setAdminOpen(false); setImpact(null); }}>
          <div className="stack">
            <Field label="Outcome">
              <select value={forfeit} onChange={(e) => setForfeit(e.target.value as '')}>
                <option value="">Played (enter scores)</option>
                <option value="a">Forfeit win for {nameA}</option>
                <option value="b">Forfeit win for {nameB}</option>
              </select>
            </Field>
            {!forfeit && <GamesEditor bestOf={m.bestOf} games={games} setGames={setGames} nameA={nameA} nameB={nameB} />}
            <Field label="Reason"><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. Checked replay; dispute resolved" /></Field>
            {impact && (
              <div className="alert warn">
                This correction resets {impact.length} later match(es): {impact.map((x) => `#${x.id}`).join(', ')}. Their results will be cleared and need to be played/reported again.
                <div className="row" style={{ marginTop: 8 }}><button className="btn danger" onClick={() => resolve(true)}>Reset them and save</button></div>
              </div>
            )}
            <ErrorBox error={actErr} />
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn primary" onClick={() => resolve(false)}>Save result</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
