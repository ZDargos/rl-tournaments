import { useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Dialog, DropdownMenu } from 'radix-ui';
import { Compass, LogOut, Menu, Plus, Settings2, Trophy, User, Users, X } from 'lucide-react';
import { API_MISSING } from './lib/api';
import { useAuth } from './lib/auth';
import { Alert, Avatar } from './components/ui';
import { HomePage } from './pages/Home';
import { AuthCompletePage, LoginPage } from './pages/Auth';
import { TournamentPage } from './pages/Tournament';
import { ManagePage } from './pages/Manage';
import { MatchPage } from './pages/Match';
import { CreatePage } from './pages/Create';
import { ServerPage, PresetPage } from './pages/Server';
import { PlayerPage, PlayersPage } from './pages/Players';
import { MePage } from './pages/Me';

function UserMenu() {
  const { me, logout } = useAuth();
  const nav = useNavigate();
  if (!me) return null;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="userchip" aria-label="Account menu">
        <Avatar name={me.user.displayName} url={me.user.avatarUrl} />
        <span className="hide-sm">{me.user.displayName}</span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" align="end" sideOffset={8}>
          <DropdownMenu.Label className="menu-label">Signed in as @{me.user.username}</DropdownMenu.Label>
          <DropdownMenu.Item className="menu-item" onSelect={() => nav('/me')}><Settings2 aria-hidden />My tournaments & settings</DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item" onSelect={() => nav(`/p/${me.user.id}`)}><User aria-hidden />My profile</DropdownMenu.Item>
          <DropdownMenu.Separator className="menu-sep" />
          <DropdownMenu.Item className="menu-item" onSelect={async () => { await logout(); nav('/'); }}><LogOut aria-hidden />Log out</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function App() {
  const { me, serverDown, loading } = useAuth();
  const loc = useLocation();
  const [menu, setMenu] = useState(false);
  const links = (
    <>
      <NavLink to="/" end><Compass aria-hidden />Tournaments</NavLink>
      <NavLink to="/players"><Users aria-hidden />Players</NavLink>
      {me && <NavLink to="/me"><Trophy aria-hidden />My stuff</NavLink>}
    </>
  );
  return (
    <>
      <header className="header">
        <div className="container">
          <Link to="/" className="brand">
            <span className="brand-mark" aria-hidden><span /><span /></span>
            <span>RL Tournaments</span>
          </Link>
          <nav className="nav" aria-label="Main">{links}</nav>
          <div className="right row" style={{ flexWrap: 'nowrap', gap: 8 }}>
            {me && <Link className="btn primary small hide-sm" to="/create"><Plus aria-hidden />Create</Link>}
            {me ? <UserMenu /> : !loading && <Link className="btn discord small" to={`/login?returnTo=${encodeURIComponent(loc.pathname)}`}>Log in with Discord</Link>}
            <Dialog.Root open={menu} onOpenChange={setMenu}>
              <Dialog.Trigger className="btn ghost small icon-btn show-sm" aria-label="Menu"><Menu /></Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Overlay className="sheet-overlay" />
                <Dialog.Content className="sheet" onClick={(e) => { if ((e.target as HTMLElement).closest('a')) setMenu(false); }}>
                  <div className="row between" style={{ marginBottom: 10 }}>
                    <Dialog.Title className="display" style={{ fontSize: '1.3rem', fontWeight: 800, margin: 0 }}>Menu</Dialog.Title>
                    <Dialog.Close className="btn ghost small icon-btn" aria-label="Close menu"><X /></Dialog.Close>
                  </div>
                  <Dialog.Description className="sr-only">Site navigation</Dialog.Description>
                  {links}
                  {me && <NavLink to="/create"><Plus aria-hidden />Create a tournament</NavLink>}
                  {me && <NavLink to={`/p/${me.user.id}`}><User aria-hidden />My profile</NavLink>}
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          </div>
        </div>
      </header>
      <main>
        <div className="container">
          {API_MISSING ? (
            <Alert kind="warn" className="mb-4">
              This website is not connected to a tournament server yet. The site owner needs to run the server and set the <code>VITE_API_URL</code> repository variable (see docs/DEPLOYMENT.md).
            </Alert>
          ) : serverDown && (
            <Alert kind="warn" className="mb-4">
              The tournament server is not reachable right now. It may be restarting or the host computer may be offline. Pages will load again once it is back.
            </Alert>
          )}
          {me && me.invitations.length > 0 && !loc.pathname.startsWith('/me') && (
            <Alert kind="info" className="mb-4">
              You have {me.invitations.length} pending team invitation{me.invitations.length === 1 ? '' : 's'}. <Link to="/me">Review them</Link>
            </Alert>
          )}
          {/* Keyed by path so a page never carries form state from one match/tournament to the next. */}
          <Routes key={loc.pathname}>
            <Route path="/" element={<HomePage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/auth/complete" element={<AuthCompletePage />} />
            <Route path="/create" element={<CreatePage />} />
            <Route path="/t/:id" element={<TournamentPage />} />
            <Route path="/t/:id/manage" element={<ManagePage />} />
            <Route path="/m/:id" element={<MatchPage />} />
            <Route path="/s/:gid" element={<ServerPage />} />
            <Route path="/presets/:id" element={<PresetPage />} />
            <Route path="/players" element={<PlayersPage />} />
            <Route path="/p/:uid" element={<PlayerPage />} />
            <Route path="/me" element={<MePage />} />
            <Route path="*" element={<div className="card"><h2>Page not found</h2><Link to="/">Back to tournaments</Link></div>} />
          </Routes>
        </div>
      </main>
      <footer className="footer">
        <div className="container row between">
          <span>RL Tournaments is free and open source. Not affiliated with Psyonix or Epic Games.</span>
          <span>Times are shown in your local time unless noted.</span>
        </div>
      </footer>
    </>
  );
}
