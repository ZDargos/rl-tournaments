import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, Lock, Plus, Search, Server, Swords, Trophy, Users } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Empty, ErrorBox, Segmented, Spinner, StateBadge, DiscordMark } from '../components/ui';
import { fmtDate, relTime } from '../lib/format';

export function TournamentCard({ t }: { t: any }) {
  const fill = t.capacity ? Math.min(100, Math.round((t.confirmedEntries / t.capacity) * 100)) : null;
  return (
    <Link to={`/t/${t.id}`} className="card tcard">
      <div className="row between">
        <StateBadge state={t.state} />
        <span className="row" style={{ gap: 6 }}>
          {t.role && t.role !== 'viewer' && <span className="badge blue">{t.role.replace('_', ' ')}</span>}
          {t.visibility === 'private' && <span className="badge"><Lock aria-hidden />Private</span>}
        </span>
      </div>
      <div>
        <h3>{t.name}</h3>
        <div className="muted small" style={{ marginTop: 2 }}>{t.guildName}</div>
      </div>
      <div className="meta">
        <span><Swords aria-hidden />{t.formatLabel}, {t.teamSize}v{t.teamSize}</span>
        {t.startAt && <span title={fmtDate(t.startAt)}><CalendarDays aria-hidden />{fmtDate(t.startAt)}</span>}
      </div>
      <div className="stack tight" style={{ marginTop: 'auto' }}>
        <div className="row between small">
          <span className="row" style={{ gap: 6 }}><Users aria-hidden width={15} height={15} className="faint" />{t.confirmedEntries}{t.capacity ? ` of ${t.capacity}` : ''} signed up</span>
          {t.startAt && <span className="faint">{relTime(t.startAt)}</span>}
        </div>
        {fill != null && <div className="fill-bar" aria-hidden><span style={{ width: `${fill}%` }} /></div>}
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
      <section className="home-hero">
        <div>
          <h1><span className="rise-mask"><span>Kickoff is in your Discord.</span></span></h1>
          <p className="lead enter-up d1">
            Sign up for brackets, Swiss, round robin and 6mans, report your scores and follow every match, here or with the bot.
          </p>
          <div className="row enter-up d2">
            {me ? <Link className="btn primary large" to="/create"><Plus aria-hidden />Create a tournament</Link> : <Link className="btn discord large" to="/login"><DiscordMark />Log in with Discord</Link>}
            {meta?.botInviteUrl && <a className="btn large" href={meta.botInviteUrl} target="_blank" rel="noreferrer"><Server aria-hidden />Add the bot to your server</a>}
          </div>
        </div>
        {/* A still, top-down drawing of the pitch: blue goal left, orange goal right. Decorative. */}
        <svg className="pitch" viewBox="-12 0 544 340" aria-hidden focusable="false">
          <path className="field" d="M70 10 H450 L510 70 V270 L450 330 H70 L10 270 V70 Z" />
          <line className="mark" x1="260" y1="10" x2="260" y2="330" />
          <circle className="mark" cx="260" cy="170" r="52" />
          <path className="mark" d="M10 110 H70 V230 H10" />
          <path className="mark" d="M510 110 H450 V230 H510" />
          <rect className="goal-a" x="-4" y="138" width="22" height="64" rx="3" />
          <rect className="goal-b" x="502" y="138" width="22" height="64" rx="3" />
          {[[60, 40], [460, 40], [60, 300], [460, 300], [260, 30], [260, 310], [150, 170], [370, 170]].map(([x, y]) => <circle key={`${x}-${y}`} className="pad" cx={x} cy={y} r="6" />)}
          {/* Kickoff spots: three cars a side, facing the ball. */}
          {[[120, 80, 33], [120, 260, -33], [190, 170, 0]].map(([x, y, r]) => <rect key={`a${y}`} className="car-a" x={x - 11} y={y - 6} width="22" height="12" rx="3" transform={`rotate(${r} ${x} ${y})`} />)}
          {[[400, 80, -33], [400, 260, 33], [330, 170, 0]].map(([x, y, r]) => <rect key={`b${y}`} className="car-b" x={x - 11} y={y - 6} width="22" height="12" rx="3" transform={`rotate(${r} ${x} ${y})`} />)}
          <circle className="ball" cx="260" cy="170" r="9" />
        </svg>
      </section>

      {me && guilds.length > 0 && (
        <div className="row small" style={{ marginBottom: 14 }}>
          <span className="muted">Your servers</span>
          {guilds.map((g) => <Link key={g.id} className="badge blue" to={`/s/${g.id}`}>{g.name}{g.isAdmin ? ' (admin)' : ''}</Link>)}
        </div>
      )}

      <div className="section-head"><h2>Tournaments</h2></div>
      <div style={{ marginBottom: 18 }}>
        <div className="row">
          <div className="relative" style={{ width: 'min(260px, 100%)' }}>
            <Search aria-hidden className="faint absolute" style={{ left: 11, top: 11, width: 16, height: 16 }} />
            <input placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" style={{ paddingLeft: 34 }} />
          </div>
          <Segmented label="Status" value={filter} onChange={setFilter} options={[{ id: 'active', label: 'Upcoming & live' }, { id: 'finished', label: 'Finished' }, { id: 'all', label: 'All' }]} />
          {guilds.length > 0 && (
            <select value={guild} onChange={(e) => setGuild(e.target.value)} style={{ width: 'auto', maxWidth: 220 }} aria-label="Server">
              <option value="">All servers</option>
              {guilds.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          )}
          {me && <label className="check small"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only mine</label>}
        </div>
      </div>
      <ErrorBox error={error} />
      {!list && !error && <Spinner />}
      {list && list.length === 0 && (
        <div className="card flat" style={{ borderStyle: 'dashed' }}>
          <Empty icon={Trophy} title={filter === 'finished' ? 'No finished tournaments yet' : 'Nothing upcoming right now'}>{me ? <Link to="/create">Create a tournament</Link> : 'Log in to see private tournaments from your servers.'}</Empty>
        </div>
      )}
      {list && list.length > 0 && <div className="grid auto">{list.map((t) => <TournamentCard key={t.id} t={t} />)}</div>}
    </div>
  );
}
