import { useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Avatar } from './components/ui';
import { HomePage } from './pages/Home';
import { AuthCompletePage, LoginPage } from './pages/Auth';
import { TournamentPage } from './pages/Tournament';
import { ManagePage } from './pages/Manage';
import { MatchPage } from './pages/Match';
import { CreatePage } from './pages/Create';
import { ServerPage, PresetPage } from './pages/Server';
import { PlayerPage, PlayersPage } from './pages/Players';
import { MePage } from './pages/Me';

export function App() {
  const { me, serverDown, loading } = useAuth();
  const loc = useLocation();
  const [menu, setMenu] = useState(false);
  return (
    <>
      <header className="header">
        <div className="container">
          <Link to="/" className="brand" onClick={() => setMenu(false)}>
            <span className="brand-logo">RL</span>
            <span>Tournaments</span>
          </Link>
          <nav className={`nav ${menu ? 'open' : ''}`} onClick={() => setMenu(false)}>
            <NavLink to="/" end>Discover</NavLink>
            {me && <NavLink to="/create">Create</NavLink>}
            <NavLink to="/players">Players</NavLink>
            {me && <NavLink to="/me">My stuff</NavLink>}
          </nav>
          <div className="right row" style={{ flexWrap: 'nowrap' }}>
            {me ? (
              <Link to="/me" className="userchip">
                <Avatar name={me.user.displayName} url={me.user.avatarUrl} />
                <span className="hide-sm">{me.user.displayName}</span>
              </Link>
            ) : (
              !loading && <Link className="btn discord small" to={`/login?returnTo=${encodeURIComponent(loc.pathname)}`}>Log in with Discord</Link>
            )}
            <button className="btn ghost small menu-btn" aria-label="Menu" onClick={() => setMenu((m) => !m)}>☰</button>
          </div>
        </div>
      </header>
      <main>
        <div className="container">
          {serverDown && (
            <div className="alert warn" style={{ marginBottom: 16 }}>
              The tournament server is not reachable right now. It may be restarting or the host computer may be offline. Pages will load again once it is back.
            </div>
          )}
          {me && me.invitations.length > 0 && !loc.pathname.startsWith('/me') && (
            <div className="alert info" style={{ marginBottom: 16 }}>
              You have {me.invitations.length} pending team invitation(s). <Link to="/me">Review them</Link>
            </div>
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
          <span>RL Tournaments · free & open source · not affiliated with Psyonix or Epic Games</span>
          <span>All times shown in your local time unless noted</span>
        </div>
      </footer>
    </>
  );
}
