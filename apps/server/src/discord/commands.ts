/**
 * Slash command definitions (Discord application command JSON). Registered globally, or to
 * DISCORD_DEV_GUILD_ID for instant updates during development (`npm run register-commands`).
 */
const STRING = 3, INTEGER = 4, BOOLEAN = 5, USER = 6, CHANNEL = 7, ROLE = 8, SUB = 1;

type Opt = { type: number; name: string; description: string; required?: boolean; autocomplete?: boolean; choices?: { name: string; value: string | number }[]; channel_types?: number[]; min_value?: number; max_value?: number; max_length?: number };
const sub = (name: string, description: string, options: Opt[] = []) => ({ type: SUB, name, description, options });
const tournament = (required = true): Opt => ({ type: INTEGER, name: 'tournament', description: 'Tournament', required, autocomplete: true });
const match: Opt = { type: INTEGER, name: 'match', description: 'Match number (shown on the website and in match messages)', required: true, min_value: 1 };
const preset = (required = true): Opt => ({ type: INTEGER, name: 'preset', description: 'Server preset', required, autocomplete: true });
const reason = (required = true): Opt => ({ type: STRING, name: 'reason', description: 'Reason (kept in the audit log)', required, max_length: 300 });
const user = (name = 'user', description = 'Discord user', required = true): Opt => ({ type: USER, name, description, required });
const FORMAT_CHOICES = [
  { name: 'Single elimination', value: 'single_elim' }, { name: 'Double elimination', value: 'double_elim' }, { name: 'Swiss', value: 'swiss' },
  { name: 'Round robin', value: 'round_robin' }, { name: '6mans', value: 'sixmans' },
];
const EXPORT_CHOICES = ['participants', 'teams', 'pools', 'schedule', 'results', 'standings', 'placements', 'player_stats'].map((k) => ({ name: k, value: k }));

export const COMMANDS = [
  {
    name: 'tourney', description: 'Create, find and run tournaments', dm_permission: false,
    options: [
      sub('create', 'Create a tournament (draft)', [
        { type: STRING, name: 'name', description: 'Tournament name', required: true, max_length: 80 },
        { type: STRING, name: 'format', description: 'Format (ignored if a preset is chosen)', choices: FORMAT_CHOICES },
        { type: INTEGER, name: 'team_size', description: 'Players per team', choices: [{ name: '1v1', value: 1 }, { name: '2v2', value: 2 }, { name: '3v3', value: 3 }] },
        preset(false),
        { type: STRING, name: 'visibility', description: 'Who can see it', choices: [{ name: 'Public', value: 'public' }, { name: 'Private', value: 'private' }] },
        { type: STRING, name: 'start', description: 'Start time, e.g. 2026-11-02 19:00 (in the timezone below)', max_length: 40 },
        { type: STRING, name: 'timezone', description: 'IANA timezone, e.g. Europe/London (default UTC)', max_length: 64 },
        { type: STRING, name: 'description', description: 'Short description', max_length: 500 },
      ]),
      sub('list', 'List tournaments in this server', [{ type: STRING, name: 'filter', description: 'Which ones', choices: [{ name: 'Active', value: 'active' }, { name: 'Finished', value: 'finished' }, { name: 'All', value: 'all' }] }]),
      sub('info', 'Show a tournament', [tournament()]),
      sub('publish', 'Publish a draft', [tournament()]),
      sub('open', 'Open registration', [tournament()]),
      sub('close', 'Close registration', [tournament()]),
      sub('start', 'Start now (runs all start checks)', [tournament()]),
      sub('pause', 'Pause a running tournament', [tournament()]),
      sub('resume', 'Resume a paused tournament', [tournament()]),
      sub('cancel', 'Cancel a tournament', [tournament(), reason(false)]),
      sub('set', 'Change a setting, e.g. series.bestOf 5', [tournament(), { type: STRING, name: 'setting', description: 'Setting path', required: true, autocomplete: true }, { type: STRING, name: 'value', description: 'New value', required: true, max_length: 200 }]),
      sub('admin-add', 'Add a tournament admin', [tournament(), user()]),
      sub('admin-remove', 'Remove a tournament admin', [tournament(), user()]),
      sub('invite', 'Invite someone to a private tournament', [tournament(), user()]),
      sub('apply-preset', 'Preview and apply a preset before the start', [tournament(), preset()]),
      sub('export', 'Export CSV', [tournament(), { type: STRING, name: 'kind', description: 'What to export', required: true, choices: EXPORT_CHOICES }]),
      sub('link', 'Get the website link', [tournament()]),
      sub('score-channel', 'Channel where players vote on match results', [
        tournament(),
        { type: CHANNEL, name: 'channel', description: 'Text channel for the vote cards', channel_types: [0, 5] },
        { type: INTEGER, name: 'votes', description: 'Matching votes needed (default 2)', min_value: 1, max_value: 6 },
        { type: BOOLEAN, name: 'both_teams', description: 'Votes must include a player from each team (default on)' },
        { type: BOOLEAN, name: 'off', description: 'Turn vote cards off' },
      ]),
    ],
  },
  {
    name: 'reg', description: 'Registration and check-in', dm_permission: false,
    options: [
      sub('join', 'Register (solo, or as captain with a team name)', [tournament(), { type: STRING, name: 'team_name', description: 'Team name (team tournaments: you become captain)', max_length: 40 }, { type: STRING, name: 'rank', description: 'Your Rocket League rank (6mans rank mode), e.g. Champion 2', max_length: 30 }]),
      sub('leave', 'Withdraw from a tournament', [tournament()]),
      sub('checkin', 'Check in', [tournament()]),
      sub('list', 'Show registrations', [tournament()]),
      sub('myrank', 'Set your own rank (6mans, before pools are confirmed)', [tournament(), { type: STRING, name: 'rank', description: 'e.g. Grand Champion 1', required: true, max_length: 30 }, { type: INTEGER, name: 'division', description: 'Division 1-4', min_value: 1, max_value: 4 }]),
      sub('approve', 'Approve a registration', [tournament(), user()]),
      sub('reject', 'Reject a registration', [tournament(), user(), reason(false)]),
      sub('remove', 'Remove a registration', [tournament(), user(), reason(false)]),
      sub('add', 'Add a player directly', [tournament(), user()]),
      sub('seed', 'Set a seed (1 = strongest)', [tournament(), user(), { type: INTEGER, name: 'seed', description: 'Seed', required: true, min_value: 1, max_value: 1024 }]),
      sub('rank', 'Set a player’s rank (skill input)', [tournament(), user(), { type: STRING, name: 'rank', description: 'e.g. Diamond 3', required: true, max_length: 30 }, { type: INTEGER, name: 'division', description: 'Division 1-4', min_value: 1, max_value: 4 }]),
    ],
  },
  {
    name: 'team', description: 'Team rosters and invitations', dm_permission: false,
    options: [
      sub('invite', 'Invite a teammate (captains)', [tournament(), user(), { type: BOOLEAN, name: 'substitute', description: 'Invite as a substitute' }]),
      sub('accept', 'Accept an invitation', [{ type: INTEGER, name: 'invitation', description: 'Invitation number', required: true, min_value: 1 }]),
      sub('decline', 'Decline an invitation', [{ type: INTEGER, name: 'invitation', description: 'Invitation number', required: true, min_value: 1 }]),
      sub('kick', 'Remove a teammate (captains)', [tournament(), user()]),
      sub('roster', 'Show your team roster', [tournament()]),
      sub('rename', 'Rename your team (captains)', [tournament(), { type: STRING, name: 'name', description: 'New name', required: true, max_length: 40 }]),
    ],
  },
  {
    name: 'preset', description: 'Server tournament presets', dm_permission: false,
    options: [
      sub('list', 'List presets'),
      sub('show', 'Show a preset', [preset()]),
      sub('create', 'Create a preset from defaults', [{ type: STRING, name: 'name', description: 'Preset name', required: true, max_length: 60 }, { type: STRING, name: 'format', description: 'Format', required: true, choices: FORMAT_CHOICES }, { type: INTEGER, name: 'team_size', description: 'Players per team', choices: [{ name: '1v1', value: 1 }, { name: '2v2', value: 2 }, { name: '3v3', value: 3 }] }]),
      sub('save', 'Save a tournament’s settings as a preset', [tournament(), { type: STRING, name: 'name', description: 'Preset name', required: true, max_length: 60 }]),
      sub('set', 'Change a preset setting', [preset(), { type: STRING, name: 'setting', description: 'Setting path', required: true, autocomplete: true }, { type: STRING, name: 'value', description: 'New value', required: true, max_length: 200 }]),
      sub('rename', 'Rename a preset', [preset(), { type: STRING, name: 'name', description: 'New name', required: true, max_length: 60 }]),
      sub('duplicate', 'Duplicate a preset', [preset(), { type: STRING, name: 'name', description: 'Name for the copy', max_length: 60 }]),
      sub('delete', 'Delete a preset (existing tournaments keep their settings)', [preset()]),
    ],
  },
  {
    name: 'match', description: 'Your matches and results', dm_permission: false,
    options: [
      sub('mine', 'Show your current match', [tournament()]),
      sub('info', 'Show a match', [match]),
      sub('report', 'Report a result (goals per game, your match’s Team A first)', [match, { type: STRING, name: 'scores', description: 'Goals per game, Team A first: 3-1, 2-4, 1-0', required: true, max_length: 80 }]),
      sub('confirm', 'Confirm the opponent’s reported result', [match]),
      sub('dispute', 'Dispute the reported result', [match, reason()]),
      sub('resolve', 'Organizers: set the result', [match, { type: STRING, name: 'scores', description: 'Goals per game, Team A first', required: true, max_length: 80 }, reason(false), { type: BOOLEAN, name: 'confirm_reset', description: 'Allow resetting later matches that depend on this result' }]),
      sub('forfeit', 'Organizers: award a forfeit win', [match, { type: STRING, name: 'winner', description: 'Winning side', required: true, choices: [{ name: 'Team A', value: 'a' }, { name: 'Team B', value: 'b' }] }, reason()]),
      sub('abandon', 'Organizers: abandon a 6mans group match', [match, reason()]),
    ],
  },
  {
    name: 'view', description: 'Standings, brackets and schedules', dm_permission: false,
    options: [
      sub('standings', 'Standings', [tournament()]),
      sub('bracket', 'Bracket and results', [tournament()]),
      sub('pools', '6mans pools', [tournament()]),
      sub('schedule', 'Upcoming and live matches', [tournament()]),
    ],
  },
  {
    name: 'sixmans', description: '6mans organizer workflow', dm_permission: false,
    options: [
      sub('make-pools', 'Make Pools (preview)', [tournament(), { type: INTEGER, name: 'pools', description: 'Number of pools', min_value: 1, max_value: 32 }]),
      sub('confirm-pools', 'Confirm the proposed pools', [tournament()]),
      sub('schedule', 'Generate the group-stage schedule (preview)', [
        tournament(),
        { type: INTEGER, name: 'games', description: 'Games per player, same for everyone (rounds are worked out per pool)', min_value: 1, max_value: 60 },
        { type: INTEGER, name: 'rounds', description: 'Instead: a fixed number of rounds for every pool', min_value: 1, max_value: 60 },
        { type: BOOLEAN, name: 'skill_balanced', description: 'Balance teams by skill' },
      ]),
      sub('swap', 'Swap two players within a scheduled round', [tournament(), { type: INTEGER, name: 'pool', description: 'Pool number (1 = A)', required: true, min_value: 1 }, { type: INTEGER, name: 'round', description: 'Round', required: true, min_value: 1 }, user('player_a', 'First player'), user('player_b', 'Second player')]),
      sub('confirm-schedule', 'Confirm the schedule', [tournament()]),
      sub('finals-teams', 'Hand-pick the finals teams (first team = top seed)', [tournament(), { type: STRING, name: 'teams', description: 'Mentions, 3 per team, teams split by | e.g. @a @b @c | @d @e @f', required: true, max_length: 1500 }]),
      sub('finals', 'Preview finals options and teams', [tournament(), { type: STRING, name: 'option', description: 'Finals structure option id (from the preview)', max_length: 30 }, { type: INTEGER, name: 'qualifiers', description: 'Qualifiers per pool', min_value: 1, max_value: 64 }]),
      sub('start-finals', 'Start the finals bracket', [tournament()]),
    ],
  },
  {
    name: 'notify', description: 'Your notification preferences',
    options: [
      sub('dms', 'Turn bot DMs on or off', [{ type: BOOLEAN, name: 'enabled', description: 'Receive DMs from the bot', required: true }]),
      sub('mute', 'Mute a tournament', [tournament()]),
      sub('unmute', 'Unmute a tournament', [tournament()]),
      sub('status', 'Show your preferences'),
    ],
  },
  {
    name: 'voice', description: 'Tournament voice channels', dm_permission: false,
    options: [
      sub('repair', 'Recreate missing channels / clean up stale ones', [tournament()]),
      sub('status', 'Show match voice channels', [tournament()]),
      sub('lobby', 'Voice channel players wait in between games', [
        tournament(),
        { type: CHANNEL, name: 'channel', description: 'Lobby voice channel', channel_types: [2] },
        { type: INTEGER, name: 'seconds', description: 'Time in the lobby before the next match (default 30)', min_value: 1, max_value: 3600 },
        { type: BOOLEAN, name: 'off', description: 'Turn the lobby off' },
      ]),
    ],
  },
  {
    name: 'server', description: 'Server-wide tournament settings', dm_permission: false,
    options: [
      sub('settings', 'Change server settings (Manage Server)', [
        { type: CHANNEL, name: 'announce_channel', description: 'Default announcement channel', channel_types: [0, 5] },
        { type: CHANNEL, name: 'voice_category', description: 'Category for match voice channels', channel_types: [4] },
        { type: STRING, name: 'who_can_create', description: 'Who can create tournaments', choices: [{ name: 'Server admins', value: 'admins' }, { name: 'Admins + creator roles', value: 'roles' }, { name: 'Any member', value: 'members' }] },
        { type: BOOLEAN, name: 'admins_manage_all', description: 'Server admins can manage every tournament' },
      ]),
      sub('role', 'Grant a role a server capability', [{ type: STRING, name: 'capability', description: 'Capability', required: true, choices: [{ name: 'Create tournaments', value: 'creator' }, { name: 'Manage presets', value: 'presets' }] }, { type: ROLE, name: 'role', description: 'Role', required: true }, { type: BOOLEAN, name: 'remove', description: 'Remove instead of add' }]),
      sub('info', 'Show server settings and bot permissions'),
    ],
  },
];

export const SETTING_SUGGESTIONS = [
  'series.bestOf', 'series.requireGameScores', 'registration.capacity', 'registration.requireApproval', 'registration.waitlist', 'registration.maxSubstitutes',
  'registration.rosterLock', 'registration.opensAt', 'registration.closesAt', 'checkIn.enabled', 'checkIn.opensMinutesBefore', 'checkIn.closesMinutesBefore',
  'schedule.startAt', 'schedule.timezone', 'schedule.autoStart', 'seeding.method', 'results.confirmation', 'results.autoConfirmMinutes', 'minEntrants',
  'singleElim.thirdPlaceMatch', 'doubleElim.grandFinalReset', 'swiss.rounds', 'roundRobin.encounters', 'sixmans.poolCount', 'sixmans.skillMethod',
  'sixmans.roundsMode', 'sixmans.gamesPerPlayer', 'sixmans.roundsPerPool', 'sixmans.skillBalancedTeams', 'sixmans.groupBestOf', 'sixmans.finalsBestOf', 'sixmans.qualifiersPerPool', 'sixmans.qualifierAdjustment',
  'notifications.channelAnnouncements', 'notifications.dms', 'notifications.announcementChannelId', 'notifications.startReminders', 'notifications.matchReminders',
  'scoreReports.channelId', 'scoreReports.votesNeeded', 'scoreReports.requireBothTeams', 'voice.lobbyChannelId', 'voice.lobbySeconds',
  'sixmans.poolShuffleTolerance', 'voice.enabled', 'voice.moveConnectedPlayers', 'voice.visibleToParticipants', 'voice.categoryId', 'teamSize', 'registrationMode', 'format',
];
