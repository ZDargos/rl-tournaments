/**
 * What every tournament setting does, shown when you hover (or tap) the ⓘ next to its name.
 * Keep these in line with what the server actually does with each setting.
 */
const LOCK = ' Locked once the tournament starts.';

export const HELP = {
  // Basics
  server: 'The Discord server the tournament belongs to. Its members can see it (if public) and sign up, and the bot posts and DMs there.',
  name: 'Shown on the website and in every Discord message about the tournament.',
  visibility: 'Public: anyone in the server can see it and sign up. Private: only organizers, participants and invited members can see it, and it only announces in a channel you pick in its settings.',
  preset: 'Copies a saved set of settings into this tournament. Later edits to the preset do not change it.',
  description: 'Rules, prizes, links. Shown on the tournament page.',

  // Format
  format:
    'How the tournament is played. Single elimination: lose once and you are out. Double elimination: you are out after two losses (winners and losers brackets). Swiss: a set number of rounds against opponents with the same record. Round robin: everyone plays everyone. 6mans: players sign up alone, are split into skill-balanced pools and play with new teammates every game; the best of each pool play the finals.' + LOCK,
  teamSize: 'Players per side. 1v1 tournaments are always individual sign-up; 6mans is always 3v3.' + LOCK,
  registrationMode:
    'Teams: a captain registers a team and invites teammates, who accept by DM or on the website. Individual: everyone signs up alone and teams are drafted automatically when the tournament starts.' + LOCK,
  bestOf: 'How many games a match lasts. The first side to win more than half wins (best of 3 = first to 2 wins). Applies to every match.' + LOCK,
  minEntrants: 'The tournament cannot start with fewer confirmed entries (players or teams) than this. If auto-start is on and there are too few, the start is skipped and organizers get a DM.' + LOCK,
  requireGameScores: 'Reports must include the goals of every game, not only who won. Needed for goal-difference tie-breakers and goal stats. Off: the series score is enough.' + LOCK,
  thirdPlaceMatch: 'The two semifinal losers play one more match to decide third place.' + LOCK,
  grandFinalReset: 'The winners-bracket team reaches the grand final unbeaten. If the losers-bracket team wins it, a second deciding final is played, so the champion is never someone with more losses.' + LOCK,
  swissRounds: 'Number of Swiss rounds. Empty: enough rounds for one unbeaten winner (log2 of the entrants, rounded up).' + LOCK,
  swissPoints: 'Standings points for a win, a loss and a bye (sitting out a round when the number of entrants is odd).' + LOCK,
  rrEncounters: 'How many times every pair plays each other. 2 = everyone plays everyone twice.' + LOCK,
  rrPoints: 'Standings points for a win and for a loss.' + LOCK,

  // 6mans
  poolCount: 'How many groups the players are split into. Each pool plays its own games; the top players of every pool go to the finals. Pools are balanced by skill.' + LOCK,
  poolShuffleTolerance: 'When you press Make pools, players this close in skill may be swapped between pools for variety while keeping pools balanced. 4 = one full rank, 1 = one division, 0 = only identical skill.' + LOCK,
  roundsMode: 'Automatic: each pool plays as many rounds as needed for every player, in every pool, to play the same number of games (a bigger pool plays more rounds). Fixed: every pool plays the same number of rounds, so games per player can differ by one.' + LOCK,
  roundsPerPool: 'Rounds every pool plays. Each round, a pool plays the matches set below; players who are not needed sit out that round.' + LOCK,
  gamesPerPlayer: 'Group games each player plays. Empty: the smallest fair number (at least 3). Rounded up when the pools cannot split it evenly.' + LOCK,
  matchesPerRound: 'Matches a pool plays at the same time in one round. 1 match uses 6 players, 2 use 12, and so on; anyone else sits out that round.' + LOCK,
  skillMethod: 'What pools and balanced teams are built from: each player’s Rocket League rank (asked at sign-up) or a seed you give each player on the Registrations tab (1 = best).' + LOCK,
  missingSkill: 'How to rate players who have no rank or seed: as the weakest player, or as an average (median) player.' + LOCK,
  groupBestOf: 'Series length of group-stage matches.' + LOCK,
  finalsBestOf: 'Series length of finals matches.' + LOCK,
  qualifiersPerPool: 'How many players from each pool reach the finals. Empty: 1 pool = top 6, 2 pools = top 3 each, 3 or more pools = top 2 each.' + LOCK,
  qualifierAdjustment: 'Finals teams have 3 players, so the number of qualifiers must be a multiple of 3. Adding takes the next-best players in; dropping removes the lowest qualifiers.' + LOCK,
  finalsTeamFormation: 'Skill-balanced: finals teams are built to be as even as possible. Snake: players are dealt to teams by group finish, back and forth (1-2-3, 3-2-1…). You can still hand-pick the finals teams.' + LOCK,
  abandoned: 'What an abandoned group match counts as: void (ignored in the standings) or a loss for all six players.' + LOCK,
  sixPoints: 'Standings points each player gets for a group win and for a group loss.' + LOCK,
  skillBalancedTeams: 'Group teams are picked so both sides are as even as possible. Off: random teams. Either way, the same three players are never teammates twice in a pool.' + LOCK,

  // Registration & schedule
  timezone: 'The time zone you enter and see the times below in. In Discord, everyone sees times in their own time zone.' + LOCK,
  startAt: 'When the tournament begins. Start reminders, check-in and the organizers’ availability list (24 hours before) are timed from this. Moving it reschedules them and resets everyone’s “can you make it” answers.' + LOCK,
  opensAt: 'Registration opens automatically at this time. Empty: it opens when you open it.' + LOCK,
  closesAt: 'Registration closes automatically at this time (it must be before the start). Empty: it stays open until you close it.' + LOCK,
  capacity: 'The most confirmed entries allowed (players, or teams in team mode). Empty = unlimited. When full, new sign-ups join the waitlist if it is on, or are turned away.' + LOCK,
  maxSubstitutes: 'Extra players a team may have beyond its starters, who can fill in.' + LOCK,
  inviteExpiryHours: 'How long a team invitation can be accepted before it expires.' + LOCK,
  rosterLock: 'When teams can no longer change their players: at the start, when registration closes, or only when you lock them by hand.' + LOCK,
  matchDeadlineMinutes: 'How long a match can stay unreported after it is ready before it counts as overdue.' + LOCK,
  seeding: 'Who is placed where in the bracket. Registration order: the first to sign up is seed 1. Random: shuffled, but the same shuffle every time. Manual: you set seeds on the Registrations tab.' + LOCK,
  autoStart: 'Start the tournament by itself at the start time. If something blocks it (too few entrants, missing check-ins), it stays waiting and organizers get a DM.' + LOCK,
  requireApproval: 'New sign-ups wait as pending until an organizer approves them on the Registrations tab.' + LOCK,
  waitlist: 'When the tournament is full, extra sign-ups join a waitlist and move up automatically, in order, when a spot opens. Off: sign-ups are refused once full.' + LOCK,
  allowWithdrawal: 'Players (or team captains) can withdraw themselves before the start. Off: only organizers can remove them.' + LOCK,
  lateRegistration: 'Let people keep signing up after registration closes, up until the tournament starts.' + LOCK,
  checkIn: 'Confirmed players must check in during a window before the start, on the website or with /reg checkin. They get reminders while they have not.' + LOCK,
  checkInOpens: 'Minutes before the start when check-in opens.' + LOCK,
  checkInCloses: 'Minutes before the start when check-in closes.' + LOCK,
  removeNoShows: 'At the start, entries that did not check in are removed. Off: the start is blocked until an organizer checks them in or removes them.' + LOCK,

  // Results
  confirmation: 'Opponent confirms: one side reports and a player on the other side confirms (or disputes). One report is enough: the first report counts. Organizers enter results: players cannot report.' + LOCK,
  autoConfirmMinutes: 'A reported result that nobody confirms or disputes counts by itself after this many minutes. Empty = it waits for a confirmation.' + LOCK,

  // Score reporting in Discord
  scoreChannel: 'Text channel where every live match gets a card with one button per team. Players tap the winner; once enough votes agree, the result is recorded and the next match starts. Finished matches’ cards are deleted, so the channel only shows matches being played. Empty = off. The bot needs View Channel and Send Messages there.',
  votesNeeded: 'How many players must tap the same winner before the result counts.',
  requireBothTeams: 'The matching votes must include at least one player from each team, so one team cannot record its own win alone. If the teams vote for different winners, the match goes to an organizer.',
  mentionPlayers: 'On: the players in the match get a Discord notification (an @mention) when its card is posted. Off: their names still show on the card, but nobody is pinged.',

  // Notifications
  announcementChannel: 'Text channel for tournament announcements (registration, start, results, standings). Empty: the server’s default channel. Private tournaments only post in a channel you pick here.',
  startReminderHours:
    'Hours before the start to remind every player, separated by commas (0.5 = 30 minutes). The DM asks “Can you still make it?” with two buttons. Anyone who has not answered a day after being asked is marked as maybe (orange) and organizers get a DM, so make the first reminder at least 48 hours before the start. Players with DMs off are never asked.',
  checkInReminders: 'Minutes before check-in closes to remind players who have not checked in yet, separated by commas.',
  matchReminders: 'Minutes after a match is ready to remind its players if it still has no result, separated by commas.',
  channelAnnouncements: 'Post announcements in the announcement channel. Off: nothing is posted in channels (DMs still go out if they are on).',
  dms: 'Send DMs to players (match assignments, reminders, results to confirm). Off: players only see channel posts, and start reminders cannot ask whether they can make it. Organizer DMs always go out.',
  perEvent: 'Choose, for each kind of event, whether it is posted in the channel, sent by DM, both or neither.',

  // Voice
  voiceEnabled: 'Create a private voice channel for each side of every live match. Only those players (and organizers) can join.',
  moveConnectedPlayers: 'Players already in a voice channel are moved into their match channel when the match starts.',
  deleteOnComplete: 'Delete a match’s voice channels as soon as it has a result.',
  lobby: 'Voice channel players are moved to after each game. After the lobby time, the bot opens their next match’s channels and moves them in. Empty = off.',
  lobbySeconds: 'How long players wait in the lobby before being moved to their next match.',
  voiceCategory: 'Discord category the match voice channels are created in. Empty: the server default.',
} as const;

export type HelpKey = keyof typeof HELP;

/** Per-event delivery rows. */
export const CATEGORY_HELP: Record<string, string> = {
  registration_open: 'When registration opens.',
  registration_close: 'When registration closes.',
  tournament_start: 'The start, pauses and resumes, and the start reminders (the DM version asks whether the player can make it).',
  check_in: 'Check-in opening and reminders to players who have not checked in.',
  match_assigned: 'A player’s match is ready, with their voice channels.',
  match_start: 'Reminders about matches that still have no result.',
  match_result: 'Final results, results waiting for confirmation, and disputes.',
  bracket_change: 'Changes to the bracket or pairings after they were published.',
  standings: 'Standings updates after rounds.',
  tournament_complete: 'The final placements, or a cancellation.',
};
