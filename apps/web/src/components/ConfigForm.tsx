import { FORMAT_LABELS, FORMATS, NOTIFICATION_CATEGORIES, NOTIFICATION_CATEGORY_LABELS, type TournamentConfig } from '@rl/core';
import { Check, Field, Help } from './ui';
import { CATEGORY_HELP, HELP } from './settingHelp';
import { isoToLocalInput, localInputToIso, TIMEZONES } from '../lib/format';
import { RoundsPreview } from './sixmansRounds';
import { useState } from 'react';

type Cfg = TournamentConfig;
type Set = (fn: (c: Cfg) => void) => void;

const num = (v: string, fallback: number | null = null) => (v === '' ? fallback : Number(v));
const listText = (xs: number[]) => xs.join(', ');
// A server that has not been updated yet still sends start reminders in minutes.
const reminderHours = (cfg: Cfg) => cfg.notifications.startReminderHours ?? ((cfg.notifications as { startReminders?: number[] }).startReminders ?? []).map((m) => Math.round((m / 60) * 10000) / 10000);
const parseList = (s: string) => s.split(/[,\s]+/).filter(Boolean).map(Number).filter((n) => Number.isFinite(n) && n >= 0);

/**
 * Settings editor shared by the create wizard, the manage page and the preset editor.
 * `locked` disables structural settings once a tournament has started (the server enforces it too).
 */
export function ConfigForm({ cfg, onChange, locked = false, sections = 'all', channels = [], playerCount }: { cfg: Cfg; onChange: (c: Cfg) => void; locked?: boolean; sections?: 'all' | 'basic'; channels?: { id: string; name: string; type: string }[]; playerCount?: number }) {
  const [previewPlayers, setPreviewPlayers] = useState<number | null>(null);
  const set: Set = (fn) => {
    const c = structuredClone(cfg);
    fn(c);
    if (c.format === 'sixmans') {
      c.teamSize = 3;
      c.registrationMode = 'individual';
    }
    if (c.teamSize === 1) c.registrationMode = 'individual';
    onChange(c);
  };
  const tz = cfg.schedule.timezone;
  const six = cfg.format === 'sixmans';
  const textChannels = channels.filter((c) => c.type === 'text');
  const categories = channels.filter((c) => c.type === 'category');
  const voiceChannels = channels.filter((c) => c.type === 'voice');
  const channelPicker = (value: string | null, list: typeof channels, onPick: (v: string | null) => void, emptyLabel: string, prefix = '#') =>
    list.length ? (
      <select value={value ?? ''} onChange={(e) => onPick(e.target.value || null)}>
        <option value="">{emptyLabel}</option>
        {list.map((ch) => <option key={ch.id} value={ch.id}>{prefix}{ch.name}</option>)}
      </select>
    ) : (
      <input value={value ?? ''} placeholder="Channel id, e.g. 123456789012345678" onChange={(e) => onPick(e.target.value.trim() || null)} />
    );
  return (
    <div className="stack">
      {locked && <div className="alert info">The tournament has started: format, registration and structure settings are locked. Notifications, voice and display settings can still change.</div>}
      <section>
        <h3>Format</h3>
        <div className="form-grid">
          <Field help={HELP.format} label="Format">
            <select value={cfg.format} disabled={locked} onChange={(e) => set((c) => void (c.format = e.target.value as Cfg['format']))}>
              {FORMATS.map((f) => <option key={f} value={f}>{FORMAT_LABELS[f]}</option>)}
            </select>
          </Field>
          <Field help={HELP.teamSize} label="Team size">
            <select value={cfg.teamSize} disabled={locked || six} onChange={(e) => set((c) => void (c.teamSize = Number(e.target.value) as 1 | 2 | 3))}>
              <option value={1}>1v1</option><option value={2}>2v2</option><option value={3}>3v3</option>
            </select>
          </Field>
          {!six && cfg.teamSize > 1 && (
            <Field help={HELP.registrationMode} label="Registration" hint="Team: a captain registers and invites teammates. Individual: players sign up alone and teams are drafted at start.">
              <select value={cfg.registrationMode} disabled={locked} onChange={(e) => set((c) => void (c.registrationMode = e.target.value as 'team' | 'individual'))}>
                <option value="team">Teams (captain + invites)</option><option value="individual">Individual sign-up</option>
              </select>
            </Field>
          )}
          {!six && (
            <Field help={HELP.bestOf} label="Series length">
              <select value={cfg.series.bestOf} disabled={locked} onChange={(e) => set((c) => void (c.series.bestOf = Number(e.target.value) as 1 | 3 | 5 | 7))}>
                {[1, 3, 5, 7].map((b) => <option key={b} value={b}>Best of {b}</option>)}
              </select>
            </Field>
          )}
          <Field help={HELP.minEntrants} label="Minimum entrants to start">
            <input type="number" min={2} max={512} value={cfg.minEntrants} disabled={locked} onChange={(e) => set((c) => void (c.minEntrants = num(e.target.value, 2)!))} />
          </Field>
        </div>
        <div className="row" style={{ marginTop: 10, gap: 20 }}>
          {!six && <Check help={HELP.requireGameScores} label="Require goals for every game" checked={cfg.series.requireGameScores} disabled={locked} onChange={(v) => set((c) => void (c.series.requireGameScores = v))} />}
          {cfg.format === 'single_elim' && <Check help={HELP.thirdPlaceMatch} label="Third-place match" checked={cfg.singleElim.thirdPlaceMatch} disabled={locked} onChange={(v) => set((c) => void (c.singleElim.thirdPlaceMatch = v))} />}
          {cfg.format === 'double_elim' && <Check help={HELP.grandFinalReset} label="Grand-final reset (bracket reset if the losers-side team wins)" checked={cfg.doubleElim.grandFinalReset} disabled={locked} onChange={(v) => set((c) => void (c.doubleElim.grandFinalReset = v))} />}
        </div>
        {cfg.format === 'swiss' && (
          <div className="form-grid" style={{ marginTop: 10 }}>
            <Field help={HELP.swissRounds} label="Swiss rounds" hint="Empty = automatic (log2 of entrants)">
              <input type="number" min={1} max={20} value={cfg.swiss.rounds ?? ''} disabled={locked} onChange={(e) => set((c) => void (c.swiss.rounds = num(e.target.value)))} />
            </Field>
            <Field help={HELP.swissPoints} label="Points: win / loss / bye">
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input type="number" value={cfg.swiss.pointsWin} disabled={locked} onChange={(e) => set((c) => void (c.swiss.pointsWin = num(e.target.value, 0)!))} />
                <input type="number" value={cfg.swiss.pointsLoss} disabled={locked} onChange={(e) => set((c) => void (c.swiss.pointsLoss = num(e.target.value, 0)!))} />
                <input type="number" value={cfg.swiss.pointsBye} disabled={locked} onChange={(e) => set((c) => void (c.swiss.pointsBye = num(e.target.value, 0)!))} />
              </div>
            </Field>
          </div>
        )}
        {cfg.format === 'round_robin' && (
          <div className="form-grid" style={{ marginTop: 10 }}>
            <Field help={HELP.rrEncounters} label="Times each pair meets">
              <input type="number" min={1} max={4} value={cfg.roundRobin.encounters} disabled={locked} onChange={(e) => set((c) => void (c.roundRobin.encounters = num(e.target.value, 1)!))} />
            </Field>
            <Field help={HELP.rrPoints} label="Points: win / loss">
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input type="number" value={cfg.roundRobin.pointsWin} disabled={locked} onChange={(e) => set((c) => void (c.roundRobin.pointsWin = num(e.target.value, 0)!))} />
                <input type="number" value={cfg.roundRobin.pointsLoss} disabled={locked} onChange={(e) => set((c) => void (c.roundRobin.pointsLoss = num(e.target.value, 0)!))} />
              </div>
            </Field>
          </div>
        )}
      </section>

      {six && (
        <section>
          <h3>6mans</h3>
          {cfg.sixmans.roundsMode === 'equal_games' && (() => {
            const players = previewPlayers ?? (playerCount && playerCount >= 6 ? playerCount : cfg.registration.capacity ?? 16);
            return (
              <div className="stack" style={{ marginBottom: 10 }}>
                <label className="row small muted">Preview for <input type="number" min={6} max={1024} value={players} onChange={(e) => setPreviewPlayers(num(e.target.value, 6))} style={{ width: 80 }} /> players{playerCount != null ? ` (${playerCount} confirmed now)` : ''}</label>
                <RoundsPreview players={players} poolCount={cfg.sixmans.poolCount} matchesPerRound={cfg.sixmans.matchesPerRound} games={cfg.sixmans.gamesPerPlayer} />
              </div>
            );
          })()}
          <div className="form-grid">
            <Field help={HELP.poolCount} label="Pools"><input type="number" min={1} max={32} value={cfg.sixmans.poolCount} disabled={locked} onChange={(e) => set((c) => void (c.sixmans.poolCount = num(e.target.value, 1)!))} /></Field>
            <Field help={HELP.poolShuffleTolerance} label="Pool shuffle range" hint="Make pools may swap players this close in skill (4 = one rank, 1 = one division). 0 = only identical ranks.">
              <input type="number" min={0} max={20} step={1} value={cfg.sixmans.poolShuffleTolerance} disabled={locked} onChange={(e) => set((c) => void (c.sixmans.poolShuffleTolerance = num(e.target.value, 0)!))} />
            </Field>
            <Field help={HELP.roundsMode} label="Rounds">
              <select value={cfg.sixmans.roundsMode} disabled={locked} onChange={(e) => set((c) => void (c.sixmans.roundsMode = e.target.value as 'equal_games'))}>
                <option value="equal_games">Automatic: everyone plays the same number of games</option>
                <option value="fixed">Fixed number of rounds per pool</option>
              </select>
            </Field>
            {cfg.sixmans.roundsMode === 'fixed' ? (
              <Field help={HELP.roundsPerPool} label="Rounds per pool" hint="Every pool plays this many rounds. Games per player can then differ by one."><input type="number" min={1} max={60} value={cfg.sixmans.roundsPerPool} disabled={locked} onChange={(e) => set((c) => void (c.sixmans.roundsPerPool = num(e.target.value, 1)!))} /></Field>
            ) : (
              <Field help={HELP.gamesPerPlayer} label="Games per player" hint="Empty = automatic (at least 3). Rounded up if the pools can't split it evenly.">
                <input type="number" min={1} max={60} placeholder="Auto" value={cfg.sixmans.gamesPerPlayer ?? ''} disabled={locked} onChange={(e) => set((c) => void (c.sixmans.gamesPerPlayer = num(e.target.value)))} />
              </Field>
            )}
            <Field help={HELP.matchesPerRound} label="Matches per round per pool"><input type="number" min={1} max={5} value={cfg.sixmans.matchesPerRound} disabled={locked} onChange={(e) => set((c) => void (c.sixmans.matchesPerRound = num(e.target.value, 1)!))} /></Field>
            <Field help={HELP.skillMethod} label="Skill input">
              <select value={cfg.sixmans.skillMethod} disabled={locked} onChange={(e) => set((c) => void (c.sixmans.skillMethod = e.target.value as 'rank' | 'manual_seed'))}>
                <option value="rank">Rocket League rank</option><option value="manual_seed">Manual seed (1 = best)</option>
              </select>
            </Field>
            <Field help={HELP.missingSkill} label="Players without skill">
              <select value={cfg.sixmans.missingSkill} disabled={locked} onChange={(e) => set((c) => void (c.sixmans.missingSkill = e.target.value as 'lowest' | 'median'))}>
                <option value="lowest">Treat as lowest</option><option value="median">Use the median</option>
              </select>
            </Field>
            <Field help={HELP.groupBestOf} label="Group matches"><select value={cfg.sixmans.groupBestOf} disabled={locked} onChange={(e) => set((c) => void (c.sixmans.groupBestOf = Number(e.target.value) as 1))}>{[1, 3, 5, 7].map((b) => <option key={b} value={b}>Best of {b}</option>)}</select></Field>
            <Field help={HELP.finalsBestOf} label="Finals matches"><select value={cfg.sixmans.finalsBestOf} disabled={locked} onChange={(e) => set((c) => void (c.sixmans.finalsBestOf = Number(e.target.value) as 1))}>{[1, 3, 5, 7].map((b) => <option key={b} value={b}>Best of {b}</option>)}</select></Field>
            <Field help={HELP.qualifiersPerPool} label="Qualifiers per pool" hint="Empty = default (2 pools: top 3, 3+ pools: top 2)."><input type="number" min={1} max={64} value={cfg.sixmans.qualifiersPerPool ?? ''} disabled={locked} onChange={(e) => set((c) => void (c.sixmans.qualifiersPerPool = num(e.target.value)))} /></Field>
            <Field help={HELP.qualifierAdjustment} label="Uneven qualifier count">
              <select value={cfg.sixmans.qualifierAdjustment} disabled={locked} onChange={(e) => set((c) => void (c.sixmans.qualifierAdjustment = e.target.value as 'expand' | 'reduce'))}>
                <option value="expand">Prefer adding next-best players</option><option value="reduce">Prefer dropping lowest qualifiers</option>
              </select>
            </Field>
            <Field help={HELP.finalsTeamFormation} label="Finals teams">
              <select value={cfg.sixmans.finalsTeamFormation} disabled={locked} onChange={(e) => set((c) => void (c.sixmans.finalsTeamFormation = e.target.value as 'balanced'))}>
                <option value="balanced">Skill-balanced</option><option value="standings_snake">Snake by group finish</option>
              </select>
            </Field>
            <Field help={HELP.abandoned} label="Abandoned group matches">
              <select value={cfg.sixmans.abandoned} disabled={locked} onChange={(e) => set((c) => void (c.sixmans.abandoned = e.target.value as 'void'))}>
                <option value="void">Void (not counted)</option><option value="loss_for_both">Loss for all six players</option>
              </select>
            </Field>
            <Field help={HELP.sixPoints} label="Points: win / loss">
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input type="number" value={cfg.sixmans.scoring.win} disabled={locked} onChange={(e) => set((c) => void (c.sixmans.scoring.win = num(e.target.value, 0)!))} />
                <input type="number" value={cfg.sixmans.scoring.loss} disabled={locked} onChange={(e) => set((c) => void (c.sixmans.scoring.loss = num(e.target.value, 0)!))} />
              </div>
            </Field>
          </div>
          <div style={{ marginTop: 10 }}>
            <Check help={HELP.skillBalancedTeams} label="Skill-balanced group teams" checked={cfg.sixmans.skillBalancedTeams} disabled={locked} onChange={(v) => set((c) => void (c.sixmans.skillBalancedTeams = v))} />
          </div>
          <p className="muted small" style={{ marginTop: 8 }}>Hard rule: the same three players are never teammates twice in a pool. Tie-breakers: points, goal difference, goals for, seed.</p>
        </section>
      )}

      <section>
        <h3>Registration & schedule</h3>
        <div className="form-grid">
          <Field help={HELP.timezone} label="Time zone">
            <select value={tz} onChange={(e) => set((c) => void (c.schedule.timezone = e.target.value))} disabled={locked}>
              {TIMEZONES.map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          </Field>
          <Field help={HELP.startAt} label={`Start (${tz})`}>
            <input type="datetime-local" value={isoToLocalInput(cfg.schedule.startAt, tz)} disabled={locked} onChange={(e) => set((c) => void (c.schedule.startAt = localInputToIso(e.target.value, tz)))} />
          </Field>
          <Field help={HELP.opensAt} label={`Registration opens (${tz})`} hint="Empty = when you open it">
            <input type="datetime-local" value={isoToLocalInput(cfg.registration.opensAt, tz)} disabled={locked} onChange={(e) => set((c) => void (c.registration.opensAt = localInputToIso(e.target.value, tz)))} />
          </Field>
          <Field help={HELP.closesAt} label={`Registration closes (${tz})`} hint="Empty = when you close it">
            <input type="datetime-local" value={isoToLocalInput(cfg.registration.closesAt, tz)} disabled={locked} onChange={(e) => set((c) => void (c.registration.closesAt = localInputToIso(e.target.value, tz)))} />
          </Field>
          <Field help={HELP.capacity} label={`Capacity (${cfg.registrationMode === 'team' && cfg.teamSize > 1 ? 'teams' : 'players'})`} hint="Empty = unlimited">
            <input type="number" min={2} max={1024} value={cfg.registration.capacity ?? ''} disabled={locked} onChange={(e) => set((c) => void (c.registration.capacity = num(e.target.value)))} />
          </Field>
          {cfg.registrationMode === 'team' && cfg.teamSize > 1 && (
            <>
              <Field help={HELP.maxSubstitutes} label="Substitutes per team"><input type="number" min={0} max={3} value={cfg.registration.maxSubstitutes} disabled={locked} onChange={(e) => set((c) => void (c.registration.maxSubstitutes = num(e.target.value, 0)!))} /></Field>
              <Field help={HELP.inviteExpiryHours} label="Invitation expiry (hours)"><input type="number" min={1} max={720} value={cfg.registration.inviteExpiryHours} disabled={locked} onChange={(e) => set((c) => void (c.registration.inviteExpiryHours = num(e.target.value, 72)!))} /></Field>
              <Field help={HELP.rosterLock} label="Roster lock">
                <select value={cfg.registration.rosterLock} disabled={locked} onChange={(e) => set((c) => void (c.registration.rosterLock = e.target.value as 'on_start'))}>
                  <option value="on_start">At start</option><option value="on_registration_close">When registration closes</option><option value="manual">Manually</option>
                </select>
              </Field>
            </>
          )}
          <Field help={HELP.matchDeadlineMinutes} label="Match deadline (minutes)" hint="Used for reminders about unreported matches.">
            <input type="number" min={5} max={1440} value={cfg.schedule.matchDeadlineMinutes} disabled={locked} onChange={(e) => set((c) => void (c.schedule.matchDeadlineMinutes = num(e.target.value, 30)!))} />
          </Field>
          <Field help={HELP.seeding} label="Seeding">
            <select value={cfg.seeding.method} disabled={locked} onChange={(e) => set((c) => void (c.seeding.method = e.target.value as 'manual'))}>
              <option value="registration_order">Registration order</option><option value="random">Random (reproducible)</option><option value="manual">Manual seeds</option>
            </select>
          </Field>
        </div>
        <div className="row" style={{ marginTop: 10, gap: 20 }}>
          <Check help={HELP.autoStart} label="Auto-start at the start time" checked={cfg.schedule.autoStart} disabled={locked} onChange={(v) => set((c) => void (c.schedule.autoStart = v))} />
          <Check help={HELP.requireApproval} label="Organizer approval required" checked={cfg.registration.requireApproval} disabled={locked} onChange={(v) => set((c) => void (c.registration.requireApproval = v))} />
          <Check help={HELP.waitlist} label="Waitlist when full" checked={cfg.registration.waitlist} disabled={locked} onChange={(v) => set((c) => void (c.registration.waitlist = v))} />
          <Check help={HELP.allowWithdrawal} label="Allow withdrawal" checked={cfg.registration.allowWithdrawal} disabled={locked} onChange={(v) => set((c) => void (c.registration.allowWithdrawal = v))} />
          <Check help={HELP.lateRegistration} label="Late registration" checked={cfg.registration.lateRegistration} disabled={locked} onChange={(v) => set((c) => void (c.registration.lateRegistration = v))} />
        </div>
        <div className="form-grid" style={{ marginTop: 10 }}>
          <Check help={HELP.checkIn} label="Check-in required" checked={cfg.checkIn.enabled} disabled={locked} onChange={(v) => set((c) => void (c.checkIn.enabled = v))} />
          {cfg.checkIn.enabled && (
            <>
              <Field help={HELP.checkInOpens} label="Check-in opens (min before start)"><input type="number" min={5} value={cfg.checkIn.opensMinutesBefore} disabled={locked} onChange={(e) => set((c) => void (c.checkIn.opensMinutesBefore = num(e.target.value, 60)!))} /></Field>
              <Field help={HELP.checkInCloses} label="Check-in closes (min before start)"><input type="number" min={0} value={cfg.checkIn.closesMinutesBefore} disabled={locked} onChange={(e) => set((c) => void (c.checkIn.closesMinutesBefore = num(e.target.value, 10)!))} /></Field>
              <Check help={HELP.removeNoShows} label="Remove no-shows at start" checked={cfg.checkIn.removeNoShows} disabled={locked} onChange={(v) => set((c) => void (c.checkIn.removeNoShows = v))} />
            </>
          )}
        </div>
      </section>

      {sections === 'all' && (
        <>
          <section>
            <h3>Results</h3>
            <div className="form-grid">
              <Field help={HELP.confirmation} label="Confirmation" hint="Default: one team reports, a player on the other team confirms.">
                <select value={cfg.results.confirmation} disabled={locked} onChange={(e) => set((c) => void (c.results.confirmation = e.target.value as 'opponent_confirm'))}>
                  <option value="opponent_confirm">Opponent confirms</option><option value="single_report">One report is enough</option><option value="admin_only">Organizers enter results</option>
                </select>
              </Field>
              <Field help={HELP.autoConfirmMinutes} label="Auto-confirm after (minutes)" hint="Empty = never">
                <input type="number" min={5} value={cfg.results.autoConfirmMinutes ?? ''} disabled={locked} onChange={(e) => set((c) => void (c.results.autoConfirmMinutes = num(e.target.value)))} />
              </Field>
            </div>
          </section>
          <section>
            <h3>Score reporting in Discord</h3>
            <p className="small muted">Each live match gets a card in this channel. The players tap the team that won; once enough matching votes are in, the result is recorded and the next match starts.</p>
            <div className="form-grid">
              <Field help={HELP.scoreChannel} label="Score report channel" hint="Empty = off">
                {channelPicker(cfg.scoreReports.channelId, textChannels, (v) => set((c) => void (c.scoreReports.channelId = v)), 'Off')}
              </Field>
              <Field help={HELP.votesNeeded} label="Votes needed">
                <input type="number" min={1} max={6} value={cfg.scoreReports.votesNeeded} onChange={(e) => set((c) => void (c.scoreReports.votesNeeded = num(e.target.value, 2)!))} />
              </Field>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <Check help={HELP.requireBothTeams} label="Votes must include a player from each team" checked={cfg.scoreReports.requireBothTeams} onChange={(v) => set((c) => void (c.scoreReports.requireBothTeams = v))} />
              <Check help={HELP.mentionPlayers} label="Ping the players when a card is posted" checked={cfg.scoreReports.mentionPlayers} onChange={(v) => set((c) => void (c.scoreReports.mentionPlayers = v))} />
            </div>
          </section>
          <section>
            <h3>Notifications</h3>
            <div className="form-grid">
              <Field help={HELP.announcementChannel} label="Announcement channel" hint={textChannels.length ? 'Empty = the server default' : 'Channel id (the bot lists channels when it is in the server)'}>
                {textChannels.length ? (
                  <select value={cfg.notifications.announcementChannelId ?? ''} onChange={(e) => set((c) => void (c.notifications.announcementChannelId = e.target.value || null))}>
                    <option value="">Server default</option>
                    {textChannels.map((ch) => <option key={ch.id} value={ch.id}>#{ch.name}</option>)}
                  </select>
                ) : (
                  <input value={cfg.notifications.announcementChannelId ?? ''} placeholder="e.g. 123456789012345678" onChange={(e) => set((c) => void (c.notifications.announcementChannelId = e.target.value.trim() || null))} />
                )}
              </Field>
              <Field help={HELP.startReminderHours} label="Start reminders (hours before)" hint="e.g. 48, 24, 1 (0.5 = 30 minutes)"><input defaultValue={listText(reminderHours(cfg))} onBlur={(e) => set((c) => void (c.notifications.startReminderHours = parseList(e.target.value)))} /></Field>
              <Field help={HELP.checkInReminders} label="Check-in reminders (min before close)"><input defaultValue={listText(cfg.notifications.checkInReminders)} onBlur={(e) => set((c) => void (c.notifications.checkInReminders = parseList(e.target.value)))} /></Field>
              <Field help={HELP.matchReminders} label="Unreported match reminders (min after ready)"><input defaultValue={listText(cfg.notifications.matchReminders)} onBlur={(e) => set((c) => void (c.notifications.matchReminders = parseList(e.target.value)))} /></Field>
            </div>
            <div className="row" style={{ marginTop: 10, gap: 20 }}>
              <Check help={HELP.channelAnnouncements} label="Post announcements in the channel" checked={cfg.notifications.channelAnnouncements} onChange={(v) => set((c) => void (c.notifications.channelAnnouncements = v))} />
              <Check help={HELP.dms} label="Send DMs" checked={cfg.notifications.dms} onChange={(v) => set((c) => void (c.notifications.dms = v))} />
            </div>
            <details style={{ marginTop: 10 }}>
              <summary>Per-event delivery <Help text={HELP.perEvent} /></summary>
              <div className="table-wrap" style={{ marginTop: 8 }}>
                <table className="table">
                  <thead><tr><th>Event</th><th>Channel</th><th>DM</th></tr></thead>
                  <tbody>
                    {NOTIFICATION_CATEGORIES.map((k) => {
                      const d = cfg.notifications.categories[k] ?? { channel: false, dm: false };
                      return (
                        <tr key={k}>
                          <td>{NOTIFICATION_CATEGORY_LABELS[k]}<Help text={CATEGORY_HELP[k]} /></td>
                          <td><input type="checkbox" aria-label={`${k} channel`} checked={d.channel} onChange={(e) => set((c) => void (c.notifications.categories[k] = { ...d, channel: e.target.checked }))} /></td>
                          <td><input type="checkbox" aria-label={`${k} DM`} checked={d.dm} onChange={(e) => set((c) => void (c.notifications.categories[k] = { ...d, dm: e.target.checked }))} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </details>
          </section>
          <section>
            <h3>Voice channels</h3>
            <div className="row" style={{ gap: 20 }}>
              <Check help={HELP.voiceEnabled} label={cfg.teamSize === 1 ? 'Private voice channel per player' : 'Private voice channel per team'} checked={cfg.voice.enabled} onChange={(v) => set((c) => void (c.voice.enabled = v))} />
              <Check help={HELP.moveConnectedPlayers} label="Move connected players automatically" checked={cfg.voice.moveConnectedPlayers} onChange={(v) => set((c) => void (c.voice.moveConnectedPlayers = v))} />
              <Check help={HELP.deleteOnComplete} label="Delete when the match completes" checked={cfg.voice.deleteOnComplete} onChange={(v) => set((c) => void (c.voice.deleteOnComplete = v))} />
            </div>
            <div className="form-grid" style={{ marginTop: 10 }}>
              <Field help={HELP.lobby} label="Between-games lobby" hint="Players wait here after each game, then get moved to their next match. Empty = off.">
                {channelPicker(cfg.voice.lobbyChannelId, voiceChannels, (v) => set((c) => void (c.voice.lobbyChannelId = v)), 'Off', '🔊 ')}
              </Field>
              <Field help={HELP.lobbySeconds} label="Lobby time (seconds)">
                <input type="number" min={1} max={3600} value={cfg.voice.lobbySeconds} onChange={(e) => set((c) => void (c.voice.lobbySeconds = Math.max(1, num(e.target.value, 30)!)))} />
              </Field>
            </div>
            {categories.length > 0 && (
              <div className="form-grid" style={{ marginTop: 10 }}>
                <Field help={HELP.voiceCategory} label="Category">
                  <select value={cfg.voice.categoryId ?? ''} onChange={(e) => set((c) => void (c.voice.categoryId = e.target.value || null))}>
                    <option value="">Server default</option>
                    {categories.map((ch) => <option key={ch.id} value={ch.id}>{ch.name}</option>)}
                  </select>
                </Field>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
