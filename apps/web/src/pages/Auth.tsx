import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, loginUrl } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ErrorBox, Field, Spinner } from '../components/ui';

export function LoginPage() {
  const { meta, me } = useAuth();
  const [params] = useSearchParams();
  const returnTo = params.get('returnTo') || '/';
  const nav = useNavigate();
  const { setSession } = useAuth();
  const [dev, setDev] = useState({ userId: '', username: '', guildId: '', admin: true });
  const [error, setError] = useState<any>(null);
  useEffect(() => {
    if (me) nav(returnTo, { replace: true });
  }, [me, nav, returnTo]);
  return (
    <div className="card" style={{ maxWidth: 520, margin: '20px auto' }}>
      <h1>Log in</h1>
      <p className="muted">We use Discord to know who you are and which servers you are in. We only ask for <code>identify</code> and <code>guilds</code>; we never see your messages or password, and we never store your Discord token.</p>
      {meta?.oauthConfigured === false && <div className="alert warn">Discord login is not configured on this server yet (missing client id/secret).</div>}
      <a className="btn discord" style={{ width: '100%', padding: 12 }} href={loginUrl(returnTo)}>Continue with Discord</a>
      {meta?.devLogin && (
        <details style={{ marginTop: 18 }} open>
          <summary>Developer login (local testing only)</summary>
          <form
            className="stack"
            style={{ marginTop: 10 }}
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const r = await api<{ token: string }>('/auth/dev-login', { body: { ...dev, guildId: dev.guildId || undefined } });
                await setSession(r.token);
              } catch (err) {
                setError(err);
              }
            }}
          >
            <div className="form-grid">
              <Field label="Discord user id"><input name="userId" value={dev.userId} onChange={(e) => setDev({ ...dev, userId: e.target.value })} placeholder="100000000000000001" /></Field>
              <Field label="Username"><input name="username" value={dev.username} onChange={(e) => setDev({ ...dev, username: e.target.value })} /></Field>
              <Field label="Server id"><input name="guildId" value={dev.guildId} onChange={(e) => setDev({ ...dev, guildId: e.target.value })} placeholder="optional" /></Field>
            </div>
            <label className="check"><input type="checkbox" checked={dev.admin} onChange={(e) => setDev({ ...dev, admin: e.target.checked })} /> Server admin</label>
            <ErrorBox error={error} />
            <button className="btn" type="submit">Dev login</button>
          </form>
        </details>
      )}
    </div>
  );
}

const ERRORS: Record<string, string> = {
  cancelled: 'You cancelled the Discord login.',
  expired: 'The login took too long or was already used. Please try again.',
  failed: 'Discord login failed. Please try again in a moment.',
};

export function AuthCompletePage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { setSession } = useAuth();
  const [error, setError] = useState<string | null>(params.get('error') ? ERRORS[params.get('error')!] ?? ERRORS.failed : null);
  const once = useRef(false);
  useEffect(() => {
    const code = params.get('code');
    if (!code || once.current) return;
    once.current = true;
    api<{ token: string }>('/auth/exchange', { body: { code }, idempotent: false })
      .then(async (r) => {
        await setSession(r.token);
        const back = params.get('returnTo') || '/';
        nav(back.startsWith('/') && !back.startsWith('//') ? back : '/', { replace: true });
      })
      .catch((e) => setError(e.message));
  }, [params, nav, setSession]);
  if (error)
    return (
      <div className="card" style={{ maxWidth: 520, margin: '20px auto' }}>
        <ErrorBox error={error} />
        <div className="spacer" />
        <Link className="btn discord" to="/login">Try again</Link>
      </div>
    );
  return <Spinner label="Logging you in…" />;
}
