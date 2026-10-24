-- Rocket League tournament platform: initial schema.
-- All timestamps are ISO-8601 UTC strings. Discord ids (users, guilds, channels) are TEXT snowflakes.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  global_name TEXT,
  avatar TEXT,
  dms_enabled INTEGER NOT NULL DEFAULT 1 CHECK (dms_enabled IN (0, 1)),
  dm_blocked_until TEXT,
  profile_public INTEGER NOT NULL DEFAULT 1 CHECK (profile_public IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                       -- sha256(token); the raw token is never stored
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  return_to TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE login_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE guilds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  bot_present INTEGER NOT NULL DEFAULT 0,
  announcement_channel_id TEXT,
  voice_category_id TEXT,
  policy TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE guild_members (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_admin INTEGER NOT NULL DEFAULT 0,
  role_ids TEXT NOT NULL DEFAULT '[]',
  display_name TEXT,
  source TEXT NOT NULL CHECK (source IN ('oauth', 'bot', 'interaction')),
  refreshed_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX guild_members_user ON guild_members(user_id);

CREATE TABLE presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX presets_name ON presets(guild_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE tournaments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL REFERENCES guilds(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  state TEXT NOT NULL CHECK (state IN ('draft','published','registration_open','registration_closed','ready','in_progress','paused','completed','cancelled')),
  stage TEXT CHECK (stage IN ('main','group','group_complete','finals')),
  format TEXT NOT NULL CHECK (format IN ('single_elim','double_elim','swiss','round_robin','sixmans')),
  config TEXT NOT NULL,
  structure TEXT NOT NULL,                    -- JSON of the locked (structural) settings
  preset_id INTEGER REFERENCES presets(id) ON DELETE SET NULL,
  preset_version INTEGER,
  created_by TEXT NOT NULL REFERENCES users(id),
  start_at TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  started_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  archived_at TEXT,
  champion_competitor_id INTEGER,
  auto_start_error TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tournaments_guild ON tournaments(guild_id, state);
CREATE INDEX tournaments_start ON tournaments(state, start_at);

-- Absolute format lock: once started, structural settings can never change (any code path).
CREATE TRIGGER tournaments_format_lock
BEFORE UPDATE OF format, structure ON tournaments
WHEN OLD.state IN ('in_progress', 'paused', 'completed')
  AND (NEW.format IS NOT OLD.format OR NEW.structure IS NOT OLD.structure)
BEGIN
  SELECT RAISE(ABORT, 'FORMAT_LOCKED');
END;

-- Finished tournaments cannot be moved back into play.
CREATE TRIGGER tournaments_final_state
BEFORE UPDATE OF state ON tournaments
WHEN OLD.state IN ('completed', 'cancelled') AND NEW.state IS NOT OLD.state
BEGIN
  SELECT RAISE(ABORT, 'TOURNAMENT_FINISHED');
END;

CREATE TABLE tournament_admins (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (tournament_id, user_id)
);

CREATE TABLE tournament_invites (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tournament_id, user_id)
);

-- A registration unit: a single player (individual mode) or a team (captain-led mode).
CREATE TABLE entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('player', 'team')),
  user_id TEXT REFERENCES users(id),          -- player entries
  name TEXT,                                  -- team entries
  captain_id TEXT REFERENCES users(id),       -- team entries
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','waitlisted','withdrawn','removed','rejected')),
  seed INTEGER,
  rank TEXT,
  rank_division INTEGER CHECK (rank_division IS NULL OR rank_division BETWEEN 1 AND 4),
  checked_in_at TEXT,
  checked_in_by TEXT,
  waitlisted_at TEXT,
  roster_locked INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'discord', 'admin')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((kind = 'player' AND user_id IS NOT NULL) OR (kind = 'team' AND name IS NOT NULL AND captain_id IS NOT NULL))
);
CREATE INDEX entries_t ON entries(tournament_id, status);
CREATE UNIQUE INDEX entries_player_active ON entries(tournament_id, user_id)
  WHERE kind = 'player' AND status IN ('pending', 'confirmed', 'waitlisted');
CREATE UNIQUE INDEX entries_team_name_active ON entries(tournament_id, lower(name))
  WHERE kind = 'team' AND status IN ('pending', 'confirmed', 'waitlisted');

CREATE TABLE entry_members (
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('captain', 'player', 'substitute')),
  active INTEGER NOT NULL DEFAULT 1,
  joined_at TEXT NOT NULL,
  left_at TEXT,
  PRIMARY KEY (entry_id, user_id)
);
-- A user can hold only one active roster position per tournament.
CREATE UNIQUE INDEX entry_members_one_position ON entry_members(tournament_id, user_id) WHERE active = 1;

CREATE TABLE invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  invitee_id TEXT NOT NULL REFERENCES users(id),
  inviter_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('player', 'substitute')),
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','declined','revoked','expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  responded_at TEXT
);
CREATE UNIQUE INDEX invitations_pending ON invitations(entry_id, invitee_id) WHERE status = 'pending';
CREATE INDEX invitations_invitee ON invitations(invitee_id, status);

-- Competitors are the units that play matches (snapshotted at start): players, teams, or 6mans temporary teams.
CREATE TABLE competitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  entry_id INTEGER REFERENCES entries(id),
  kind TEXT NOT NULL CHECK (kind IN ('player', 'team', 'temp_team')),
  stage TEXT NOT NULL CHECK (stage IN ('main', 'group', 'finals')),
  name TEXT NOT NULL,
  seed INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX competitors_t ON competitors(tournament_id, stage);

CREATE TABLE competitor_members (
  competitor_id INTEGER NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('captain', 'player', 'substitute')),
  PRIMARY KEY (competitor_id, user_id)
);
CREATE INDEX competitor_members_user ON competitor_members(user_id);

CREATE TABLE pools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  name TEXT NOT NULL,
  UNIQUE (tournament_id, idx)
);

CREATE TABLE pool_members (
  pool_id INTEGER NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  skill REAL NOT NULL,
  PRIMARY KEY (pool_id, user_id),
  UNIQUE (tournament_id, user_id)
);

-- Proposed/confirmed 6mans artifacts (pool proposal, schedule, finals) before they are materialised.
CREATE TABLE sixmans_plans (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('pools', 'schedule', 'finals')),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed')),
  data TEXT NOT NULL,
  fingerprint TEXT NOT NULL,                 -- hash of the inputs; stale plans are detected
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tournament_id, kind)
);

CREATE TABLE matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('main', 'group', 'finals')),
  bracket TEXT NOT NULL,
  round INTEGER NOT NULL,
  position INTEGER NOT NULL,
  key TEXT NOT NULL,
  pool_id INTEGER REFERENCES pools(id),
  best_of INTEGER NOT NULL CHECK (best_of IN (1, 3, 5, 7)),
  source_a TEXT,
  source_b TEXT,
  competitor_a INTEGER REFERENCES competitors(id),
  competitor_b INTEGER REFERENCES competitors(id),
  status TEXT NOT NULL CHECK (status IN ('pending','ready','awaiting_confirmation','disputed','completed','void','cancelled')),
  winner TEXT CHECK (winner IN ('a', 'b')),
  walkover INTEGER NOT NULL DEFAULT 0,
  forfeit INTEGER NOT NULL DEFAULT 0,
  wins_a INTEGER,
  wins_b INTEGER,
  goals_a INTEGER,
  goals_b INTEGER,
  games TEXT,
  live_games TEXT,
  ready_at TEXT,
  completed_at TEXT,
  result_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tournament_id, stage, key),
  CHECK (competitor_a IS NULL OR competitor_b IS NULL OR competitor_a <> competitor_b)
);
CREATE INDEX matches_t ON matches(tournament_id, stage, status);
CREATE INDEX matches_ca ON matches(competitor_a);
CREATE INDEX matches_cb ON matches(competitor_b);

-- A completed result can only change through an explicit, versioned correction.
CREATE TRIGGER matches_completed_immutable
BEFORE UPDATE ON matches
WHEN OLD.status = 'completed' AND NEW.result_version = OLD.result_version
  AND (NEW.winner IS NOT OLD.winner OR NEW.wins_a IS NOT OLD.wins_a OR NEW.wins_b IS NOT OLD.wins_b
       OR NEW.games IS NOT OLD.games OR NEW.status IS NOT OLD.status
       OR NEW.competitor_a IS NOT OLD.competitor_a OR NEW.competitor_b IS NOT OLD.competitor_b)
BEGIN
  SELECT RAISE(ABORT, 'COMPLETED_MATCH_IMMUTABLE');
END;

-- 6mans: a trio (canonical sorted user ids) may be teammates only once per pool.
CREATE TABLE sixmans_trios (
  pool_id INTEGER NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  trio_key TEXT NOT NULL,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  PRIMARY KEY (pool_id, trio_key)
);

CREATE TABLE match_byes (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  round INTEGER NOT NULL,
  competitor_id INTEGER NOT NULL REFERENCES competitors(id),
  PRIMARY KEY (tournament_id, stage, round, competitor_id)
);

CREATE TABLE round_meta (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  round INTEGER NOT NULL,
  log TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  PRIMARY KEY (tournament_id, stage, round)
);

CREATE TABLE result_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id),
  side TEXT CHECK (side IN ('a', 'b')),
  kind TEXT NOT NULL CHECK (kind IN ('report','confirm','dispute','admin_result','forfeit','correction','auto_confirm','reset')),
  wins_a INTEGER,
  wins_b INTEGER,
  games TEXT,
  reason TEXT,
  source TEXT NOT NULL CHECK (source IN ('web', 'discord', 'system')),
  result_version INTEGER NOT NULL,
  superseded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX result_reports_match ON result_reports(match_id);

CREATE TABLE qualifications (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  pool_id INTEGER REFERENCES pools(id),
  pool_rank INTEGER,
  qualified INTEGER NOT NULL,
  reason TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  PRIMARY KEY (tournament_id, user_id)
);

CREATE TABLE placements (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  competitor_id INTEGER NOT NULL REFERENCES competitors(id),
  placement INTEGER NOT NULL,
  PRIMARY KEY (tournament_id, competitor_id)
);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
  match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('event', 'reminder')),
  idempotency_key TEXT NOT NULL UNIQUE,
  run_at TEXT NOT NULL,
  expires_at TEXT,
  audience TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','processing','sent','partial','failed','cancelled','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX notifications_due ON notifications(status, run_at);

CREATE TABLE notification_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('channel', 'dm')),
  target TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed', 'skipped')),
  error TEXT,
  attempted_at TEXT NOT NULL,
  UNIQUE (notification_id, method, target)
);

CREATE TABLE tournament_mutes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, tournament_id)
);

CREATE TABLE voice_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL,
  slot TEXT NOT NULL CHECK (slot IN ('a', 'b')),
  generation INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  channel_id TEXT,
  member_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('creating','active','deleting','deleted','failed')),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX voice_channels_live ON voice_channels(match_id, slot) WHERE status IN ('creating', 'active', 'deleting');
CREATE INDEX voice_channels_status ON voice_channels(status);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT,
  tournament_id INTEGER,
  actor_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX audit_t ON audit_events(tournament_id, id);

CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events
WHEN (SELECT COUNT(*) FROM tournaments WHERE id = OLD.tournament_id) > 0
BEGIN SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY'); END;

CREATE TABLE processed_interactions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  response TEXT NOT NULL,
  status INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE job_state (
  name TEXT PRIMARY KEY,
  last_run_at TEXT,
  data TEXT NOT NULL DEFAULT '{}'
);
