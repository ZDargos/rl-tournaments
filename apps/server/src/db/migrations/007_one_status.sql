-- One status per registered player instead of a separate "can you make it?" answer.
-- Signing up makes a player confirmed (no row = confirmed). Each "can you still make it?" check sets
-- them back to pending ('awaiting'; 'maybe' once a day passes with no reply). "Can't make it"
-- ('declined') keeps them out of pools and the start until they change it. Answers no longer reset
-- when the start time moves, so the start_at column is informational only.

-- Existing registrants who did not say they can't make it (for the current start time) are confirmed.
UPDATE availability SET status = 'confirmed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status IN ('awaiting', 'maybe')
   OR start_at <> COALESCE((SELECT t.start_at FROM tournaments t WHERE t.id = availability.tournament_id), '');

-- Signing up (again) starts a player as confirmed: forget any earlier answer.
CREATE TRIGGER availability_reset_on_signup AFTER INSERT ON entry_members
BEGIN
  DELETE FROM availability WHERE tournament_id = NEW.tournament_id AND user_id = NEW.user_id;
END;
