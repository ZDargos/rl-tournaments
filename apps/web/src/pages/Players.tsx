import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Avatar, Empty, ErrorBox, Spinner, StateBadge } from '../components/ui';
import { fmtDate } from '../lib/format';

export function PlayersPage() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<any[] | null>(null);
  const [err, setErr] = useState<any>(null);
  useEffect(() => {
    if (q.trim().length < 2) { setRows(null); return; }
    const h = setTimeout(() => api<any[]>(`/api/players?q=${encodeURIComponent(q.trim())}`).then(setRows).catch(setErr), 250);
    return () => clearTimeout(h);
  }, [q]);
  return (
    <div className="stack">
      <h1>Players</h1>
      <input placeholder="Search by Discord name…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <ErrorBox error={err} />
      {rows && rows.length === 0 && <Empty icon="🔎" title="No players found">Only players with a public profile appear in search.</Empty>}
      {rows && <div className="grid cols-3">{rows.map((u) => <Link key={u.id} to={`/p/${u.id}`} className="card row"><Avatar name={u.displayName} url={u.avatarUrl} /><div><strong>{u.displayName}</strong><div className="muted small">@{u.username}</div></div></Link>)}</div>}
    </div>
  );
}

export function PlayerPage() {
  const { uid } = useParams();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  useEffect(() => { setD(null); api<any>(`/api/players/${uid}`).then(setD).catch(setErr); }, [uid]);
  if (err) return <ErrorBox error={err} />;
  if (!d) return <Spinner />;
  const t = d.totals;
  const pct = (w: number, n: number) => (n ? `${Math.round((w / n) * 100)}%` : '—');
  return (
    <div className="stack">
      <div className="row">
        <Avatar name={d.user.displayName} url={d.user.avatarUrl} />
        <div><h1>{d.user.displayName}</h1><div className="muted">@{d.user.username}{!d.profilePublic && ' · profile is private (only you can see this)'}</div></div>
      </div>
      <div className="grid cols-4">
        <div className="card stat"><div className="muted small">Tournaments</div><div className="big">{t.tournaments}</div></div>
        <div className="card stat"><div className="muted small">Titles 🏆</div><div className="big">{t.titles}</div></div>
        <div className="card stat"><div className="muted small">Series W–L</div><div className="big">{t.team.wins}–{t.team.losses}</div><div className="muted tiny">{pct(t.team.wins, t.team.matches)} · games {t.team.gamesWon}–{t.team.gamesLost}</div></div>
        <div className="card stat"><div className="muted small">6mans group W–L</div><div className="big">{t.sixmans.wins}–{t.sixmans.losses}</div><div className="muted tiny">{t.sixmans.points} pts · GD {t.sixmans.goalsFor - t.sixmans.goalsAgainst >= 0 ? '+' : ''}{t.sixmans.goalsFor - t.sixmans.goalsAgainst}</div></div>
      </div>
      <div className="card">
        <h3>History</h3>
        {d.history.length === 0 ? <p className="muted">No tournaments yet.</p> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Tournament</th><th>Date</th><th>Format</th><th>Team</th><th>Record</th><th>Finish</th></tr></thead>
            <tbody>{d.history.map((h: any) => (
              <tr key={h.tournamentId}>
                <td><Link to={`/t/${h.tournamentId}`}>{h.name}</Link> <StateBadge state={h.state} /></td>
                <td className="small muted">{fmtDate(h.date)}</td>
                <td className="small">{h.formatLabel}</td>
                <td className="small">{h.team ?? '—'}</td>
                <td className="small">
                  {h.sixmansGroup && <div>Group {h.sixmansGroup.wins}–{h.sixmansGroup.losses} ({h.sixmansGroup.points} pts){h.sixmansGroup.poolRank ? `, pool #${h.sixmansGroup.poolRank}` : ''}{h.sixmansGroup.qualified ? ' ✅' : ''}</div>}
                  {(h.teamRecord.wins + h.teamRecord.losses > 0) && <div>{h.sixmansGroup ? 'Finals ' : ''}{h.teamRecord.wins}–{h.teamRecord.losses}</div>}
                </td>
                <td>{h.placement ? (h.placement === 1 ? '🥇 1st' : h.placement === 2 ? '🥈 2nd' : h.placement === 3 ? '🥉 3rd' : `#${h.placement}`) : '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
