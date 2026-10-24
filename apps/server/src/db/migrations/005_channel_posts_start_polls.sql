-- Every message the bot posts for a tournament in its announcement or registration channel, so the
-- channels can be cleared when the tournament ends.
CREATE TABLE channel_posts (
  id INTEGER PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  -- posted: still in the channel · deleted: removed (or already gone) · failed: the bot could not delete it
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'deleted', 'failed')),
  error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (channel_id, message_id)
);
CREATE INDEX channel_posts_t ON channel_posts(tournament_id, status);

-- Players vote on the start time: organizers list the options, the most votes wins.
CREATE TABLE start_polls (
  id INTEGER PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  -- JSON array of UTC ISO times, in the order the organizer gave them
  options TEXT NOT NULL,
  closes_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'cancelled')),
  -- index into options; NULL while open, or when nobody voted
  winner INTEGER,
  tie INTEGER NOT NULL DEFAULT 0,
  -- the vote card in Discord (none: not posted yet)
  channel_id TEXT,
  message_id TEXT,
  card_status TEXT NOT NULL DEFAULT 'none' CHECK (card_status IN ('none', 'posting', 'posted', 'failed')),
  rendered TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  closed_by TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX start_polls_one_open ON start_polls(tournament_id) WHERE status = 'open';
CREATE INDEX start_polls_due ON start_polls(status, closes_at);

CREATE TABLE start_poll_votes (
  poll_id INTEGER NOT NULL REFERENCES start_polls(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  option INTEGER NOT NULL,
  voted_at TEXT NOT NULL,
  PRIMARY KEY (poll_id, user_id, option)
);
