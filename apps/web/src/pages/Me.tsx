import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsync } from '../lib/hooks';
import { Check, Empty, ErrorBox, Spinner, useToast } from '../components/ui';
import { fmtDate } from '../lib/format';

export function MePage() {
  const { me, refresh, logout, loading } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [guilds, setGuilds] = useState<any[] | null>(null);
  const { busy, error, run } = useAsync();
  useEffect(() => { if (me) api<any[]>('/api/me/guilds').then(setGuilds).catch(() => setGuilds([])); }, [me]);
  if (loading) return <Spinner />;
  if (!me) return <Empty icon="🔑" title="Log in to see your account"><Link className="btn primary" to="/login">Log in with Discord</Link></Empty>;
  const prefs = me.preferences;
  const setPref = async (patch: Record<string, boolean>) => { if (await run(() => api('/api/me/preferences', { method: 'PATCH', body: patch }))) { toast('Saved'); refresh(); } };
  return (
    <div className="stack">
      <div className="row between">
        <h1>{me.user.displayName}</h1>
        <div className="row"><Link className="btn" to={`/p/${me.user.id}`}>My profile</Link><button className="btn ghost" onClick={async () => { await logout(); nav('/'); }}>Log out</button></div>
      </div>
      <ErrorBox error={error} />
      {me.invitations.length > 0 && (
        <div className="card" style={{ borderColor: 'var(--orange)' }}>
          <h3>Team invitations</h3>
          {me.invitations.map((i: any) => (
            <div key={i.id} className="row between" style={{ marginBottom: 8 }}>
              <span><strong>{i.team_name}</strong> invited you as {i.role} in <Link to={`/t/${i.tournament_id}`}>{i.tournament_name}</Link> <span className="muted tiny">(expires {fmtDate(i.expires_at)})</span></span>
              <span className="row">
                <button className="btn small primary" disabled={busy} onClick={async () => { if (await run(() => api(`/api/invitations/${i.id}/accept`, { body: {} }))) { toast('Joined the team'); refresh(); } }}>Accept</button>
                <button className="btn small ghost" disabled={busy} onClick={async () => { if (await run(() => api(`/api/invitations/${i.id}/decline`, { body: {} }))) { toast('Declined'); refresh(); } }}>Decline</button>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="grid cols-2">
        <div className="card stack">
          <h3>Notifications & privacy</h3>
          <Check label="Allow direct messages from the bot (match ready, confirmations, reminders)" checked={prefs.dmsEnabled} disabled={busy} onChange={(v) => setPref({ dmsEnabled: v })} />
          <Check label="Public profile (appear in player search and show your tournament history)" checked={prefs.profilePublic} disabled={busy} onChange={(v) => setPref({ profilePublic: v })} />
          {prefs.dmBlockedUntil && <div className="alert warn small">Discord rejected our last DM to you (your privacy settings may block DMs from server members). We’ll retry after {fmtDate(prefs.dmBlockedUntil)}; organizers see you as unreachable until then.</div>}
          {me.mutes.length > 0 && (
            <div>
              <div className="muted small">Muted tournaments (no reminders):</div>
              {me.mutes.map((tid: number) => <div key={tid} className="row between"><Link to={`/t/${tid}`}>Tournament #{tid}</Link><button className="btn small ghost" onClick={async () => { if (await run(() => api(`/api/me/mutes/${tid}`, { method: 'DELETE', body: {} }))) refresh(); }}>Unmute</button></div>)}
            </div>
          )}
        </div>
        <div className="card">
          <h3>Your servers</h3>
          {!guilds ? <Spinner /> : guilds.length === 0 ? <p className="muted small">None of your Discord servers have the bot yet.</p> : guilds.map((g) => (
            <Link key={g.id} to={`/s/${g.id}`} className="row between" style={{ marginBottom: 6 }}>
              <span>{g.name}</span>
              <span className="row">{g.isAdmin && <span className="badge blue">admin</span>}{g.canCreate && <span className="badge">can create</span>}{!g.botPresent && <span className="badge red">bot missing</span>}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
