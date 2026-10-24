import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Empty, ErrorBox, Spinner, StateBadge } from '../components/ui';
import { fmtDate, relTime } from '../lib/format';

export function TournamentCard({ t }: { t: any }) {
  return (
    <Link to={`/t/${t.id}`} className="card tcard">
      <div className="row between" style={{ marginBottom: 6 }}>
        <StateBadge state={t.state} />
        {t.visibility === 'private' && <span className="badge">🔒 Private</span>}
      </div>
      <h3>{t.name}</h3>
      <div className="meta">
        <span>{t.formatLabel}</span>·<span>{t.teamSize}v{t.teamSize}</span>·<span>{t.guildName}</span>
      </div>
      <div className="meta" style={{ marginTop: 8 }}>
        <span>👥 {t.confirmedEntries}{t.capacity ? ` / ${t.capacity}` : ''}</span>
        {t.startAt && <span title={fmtDate(t.startAt)}>🗓 {fmtDate(t.startAt)} ({relTime(t.startAt)})</span>}
        {t.role && t.role !== 'viewer' && <span className="badge blue">{t.role.replace('_', ' ')}</span>}
      </div>
    </Link>
  );
}

export function HomePage() {
  const { me, meta } = useAuth();
  const [filter, setFilter] = useState<'active' | 'finished' | 'all'>('active');
  const [q, setQ] = useState('');
  const [guild, setGuild] = useState('');
  const [mine, setMine] = useState(false);
  const [list, setList] = useState<any[] | null>(null);
  const [guilds, setGuilds] = useState<any[]>([]);
  const [error, setError] = useState<any>(null);

  useEffect(() => {
    if (me) api<any[]>('/api/me/guilds').then(setGuilds).catch(() => setGuilds([]));
  }, [me]);

  useEffect(() => {
    const p = new URLSearchParams();
    if (filter !== 'all') p.set('state', filter);
    if (q.trim()) p.set('q', q.trim());
    if (guild) p.set('guildId', guild);
    if (mine) p.set('mine', 'true');
    const t = setTimeout(() => {
      api<any[]>(`/api/tournaments?${p}`).then((l) => {
        setList(l);
        setError(null);
      }).catch(setError);
    }, 200);
    return () => clearTimeout(t);
  }, [filter, q, guild, mine, me]);

  return (
    <div>
      <section className="hero">
        <h1>
          Rocket League tournaments, <span className="accent">run from Discord</span>
        </h1>
        <p className="muted" style={{ maxWidth: 680 }}>
          Brackets, Swiss, round robin and 6mans with balanced pools and no repeated trios. Sign up, report scores and follow every match here or with the bot.
        </p>
        <div className="row">
          {me ? <Link className="btn primary" to="/create">Create a tournament</Link> : <Link className="btn discord" to="/login">Log in with Discord</Link>}
          {meta?.botInviteUrl && <a className="btn" href={meta.botInviteUrl} target="_blank" rel="noreferrer">Add the bot to your server</a>}
        </div>
      </section>
      {me && guilds.length > 0 && (
        <div className="row" style={{ margin: '18px 0 6px' }}>
          <span className="muted small">Your servers:</span>
          {guilds.map((g) => <Link key={g.id} className="badge blue" to={`/s/${g.id}`}>{g.name}{g.isAdmin ? ' ★' : ''}</Link>)}
        </div>
      )}
      <div className="card flat" style={{ marginTop: 18 }}>
        <div className="row">
          <input placeholder="Search tournaments…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} aria-label="Search" />
          <select value={filter} onChange={(e) => setFilter(e.target.value as 'active')} style={{ maxWidth: 160 }} aria-label="Status">
            <option value="active">Upcoming & live</option><option value="finished">Finished</option><option value="all">All</option>
          </select>
          {guilds.length > 0 && (
            <select value={guild} onChange={(e) => setGuild(e.target.value)} style={{ maxWidth: 200 }} aria-label="Server">
              <option value="">All servers</option>
              {guilds.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          )}
          {me && <label className="check"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Mine only</label>}
        </div>
      </div>
      <div className="spacer" />
      <ErrorBox error={error} />
      {!list && !error && <Spinner />}
      {list && list.length === 0 && (
        <Empty title="No tournaments here yet">{me ? <Link to="/create">Create the first one</Link> : 'Log in to see private tournaments from your servers.'}</Empty>
      )}
      {list && list.length > 0 && <div className="grid auto">{list.map((t) => <TournamentCard key={t.id} t={t} />)}</div>}
    </div>
  );
}
