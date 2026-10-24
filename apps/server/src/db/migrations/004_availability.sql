-- Start reminders are now set in hours (notifications.startReminderHours) instead of minutes
-- (notifications.startReminders). Convert every stored tournament and preset exactly:
-- 1440, 60, 15 minutes become 24, 1, 0.25 hours. Reminder keys stay in minutes, so reminders
-- already queued are neither lost nor sent twice.
UPDATE tournaments
SET config = json_remove(
  json_set(config, '$.notifications.startReminderHours',
    json((SELECT json_group_array(round(value / 60.0, 4)) FROM json_each(tournaments.config, '$.notifications.startReminders')))),
  '$.notifications.startReminders')
WHERE json_type(config, '$.notifications.startReminders') = 'array';

UPDATE presets
SET config = json_remove(
  json_set(config, '$.notifications.startReminderHours',
    json((SELECT json_group_array(round(value / 60.0, 4)) FROM json_each(presets.config, '$.notifications.startReminders')))),
  '$.notifications.startReminders')
WHERE json_type(config, '$.notifications.startReminders') = 'array';

-- Whether each player can still make it, answered from the reminder DM buttons or the website.
-- One row per player per tournament; an answer only counts for the start time it was given for.
CREATE TABLE availability (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  -- schedule.startAt when this row was written ('' when there is none); a moved start makes it stale
  start_at TEXT NOT NULL,
  -- awaiting: asked, no reply yet · maybe: no reply a day after being asked · confirmed / declined: answered
  status TEXT NOT NULL CHECK (status IN ('awaiting', 'confirmed', 'declined', 'maybe')),
  asked_at TEXT,
  answered_at TEXT,
  -- who answered (an organizer can set it for a player)
  answered_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tournament_id, user_id)
);
CREATE INDEX availability_awaiting ON availability(status, asked_at);
