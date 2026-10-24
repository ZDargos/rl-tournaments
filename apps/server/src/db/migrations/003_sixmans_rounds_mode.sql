-- 6mans now defaults to "equal games" rounds (each pool plays enough rounds for everyone to play the
-- same number of games). Tournaments that already have a schedule, or have started, keep the fixed
-- rounds they were set up with so nothing changes under them.
UPDATE tournaments
SET config = json_set(config, '$.sixmans.roundsMode', 'fixed')
WHERE json_extract(config, '$.format') = 'sixmans'
  AND json_extract(config, '$.sixmans.roundsMode') IS NULL
  AND (state IN ('in_progress', 'paused', 'completed', 'cancelled')
       OR EXISTS (SELECT 1 FROM sixmans_plans p WHERE p.tournament_id = tournaments.id AND p.kind = 'schedule'));
