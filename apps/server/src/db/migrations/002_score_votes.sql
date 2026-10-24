-- Discord score reporting: one vote card (message) per live match, and the players' votes.
CREATE TABLE match_cards (
  match_id INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  -- matches.result_version the card was posted for (a reset match gets a fresh card)
  result_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('posting', 'open', 'closed', 'failed')),
  -- last rendered text, so the card is only edited when something changed
  rendered TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX match_cards_t ON match_cards(tournament_id, status);

CREATE TABLE match_votes (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  result_version INTEGER NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  -- the voter's own team, and the team they say won
  voter_side TEXT NOT NULL CHECK (voter_side IN ('a', 'b')),
  winner TEXT NOT NULL CHECK (winner IN ('a', 'b')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (match_id, result_version, user_id)
);
