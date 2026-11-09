-- Organizers propose moving the tournament to one new date and time, with a reason. Every player
-- registered at that moment is asked "can you make it?" (DM, website, and a card in the
-- registration channel). Organizers see the answers and then move the start or keep it.
CREATE TABLE date_change_votes (
  id INTEGER PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  -- UTC ISO time the organizers propose, and the start time when the vote began (NULL = none set)
  proposed_at TEXT NOT NULL,
  previous_at TEXT,
  reason TEXT NOT NULL,
  -- open: players are answering · applied: the start moved · kept: the start stayed · cancelled: the tournament started or was cancelled
  status TEXT NOT NULL CHECK (status IN ('open', 'applied', 'kept', 'cancelled')),
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
CREATE UNIQUE INDEX date_change_votes_one_open ON date_change_votes(tournament_id) WHERE status = 'open';

-- Who was asked (the registered players when the vote began).
CREATE TABLE date_change_recipients (
  vote_id INTEGER NOT NULL REFERENCES date_change_votes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (vote_id, user_id)
);

CREATE TABLE date_change_answers (
  vote_id INTEGER NOT NULL REFERENCES date_change_votes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  answer TEXT NOT NULL CHECK (answer IN ('yes', 'no')),
  answered_at TEXT NOT NULL,
  PRIMARY KEY (vote_id, user_id)
);
