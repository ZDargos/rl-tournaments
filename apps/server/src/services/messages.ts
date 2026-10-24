import { describeSeries, STATE_LABELS } from '@rl/core';
import type { AppContext } from './context.js';
import type { LoadedTournament } from './access.js';
import type { Category } from './notifications.js';
import { competitorMembers, competitorName, getMatch, matchGames, matchLabel, poolName } from './queries.js';
import { discordTime, escapeDiscord } from '../lib/util.js';
import type { MessageButton } from '../discord/port.js';
import { availabilityCustomId, availabilityDigest } from './availability.js';

export interface RenderedMessage {
  channel: string;
  dm: string;
  mentionUserIds: string[];
  /** Buttons under the DM (channel posts never get them). */
  dmButtons?: MessageButton[];
}

const link = (ctx: AppContext, path: string) => `${ctx.env.WEB_URL}/#${path}`;

/** Build fresh notification content from the current database state. */
export function renderNotification(
  ctx: AppContext,
  n: { category: Category; kind: 'event' | 'reminder'; tournament: LoadedTournament | null; matchId: number | null; payload: Record<string, unknown>; audience: string },
): RenderedMessage | null {
  const t = n.tournament;
  const title = t ? `**${escapeDiscord(t.name)}**` : '';
  const tLink = t ? link(ctx, `/t/${t.id}`) : ctx.env.WEB_URL;
  const p = n.payload;
  const simple = (text: string): RenderedMessage => ({ channel: text, dm: text, mentionUserIds: [] });
  switch (n.category) {
    case 'registration_open':
      return simple(`📝 Registration is open for ${title}! Sign up on the website (${tLink}) or with \`/reg join tournament:${t?.id}\`.`);
    case 'registration_close':
      return simple(`🔒 Registration for ${title} is now closed.`);
    case 'tournament_start': {
      if (!t) return null;
      if (n.kind === 'reminder') {
        const text = `⏰ ${title} starts ${discordTime(t.cfg.schedule.startAt!, 'R')} (${discordTime(t.cfg.schedule.startAt!, 'f')}). ${t.cfg.checkIn.enabled ? 'Remember to check in! ' : ''}${tLink}`;
        return {
          channel: text,
          dm: `${text}
Can you still make it? Tap below so the organizers know.`,
          mentionUserIds: [],
          dmButtons: [
            { customId: availabilityCustomId(t.id, 'yes'), label: '✅ I can make it', style: 'success' },
            { customId: availabilityCustomId(t.id, 'no'), label: '❌ I can’t make it', style: 'danger' },
          ],
        };
      }
      if (p.event === 'paused') return simple(`⏸️ ${title} has been paused by the organizers.`);
      if (p.event === 'resumed') return simple(`▶️ ${title} has resumed.`);
      return simple(`🚀 ${title} has started! Check your match assignment: ${tLink}`);
    }
    case 'check_in': {
      if (!t) return null;
      const closes = new Date(Date.parse(t.cfg.schedule.startAt!) - t.cfg.checkIn.closesMinutesBefore * 60000).toISOString();
      if (p.phase === 'open') return simple(`✅ Check-in for ${title} is open until ${discordTime(closes, 'f')}. Use \`/reg checkin tournament:${t.id}\` or the website.`);
      return simple(`⚠️ You have not checked in for ${title}. Check-in closes ${discordTime(closes, 'R')}. \`/reg checkin tournament:${t.id}\``);
    }
    case 'match_assigned':
    case 'match_start': {
      if (!n.matchId || !t) return null;
      const m = getMatch(ctx, n.matchId);
      if (!m) return null;
      const label = matchLabel(m, poolName(ctx, m.pool_id));
      const a = competitorName(ctx, m.competitor_a);
      const b = competitorName(ctx, m.competitor_b);
      const players = [...competitorMembers(ctx, m.competitor_a), ...competitorMembers(ctx, m.competitor_b)];
      const voice = ctx.db
        .prepare("SELECT slot, channel_id FROM voice_channels WHERE match_id = ? AND status = 'active'")
        .all(m.id) as { slot: 'a' | 'b'; channel_id: string }[];
      const voiceLine = voice.length
        ? `\nVoice: ${voice.map((v) => `${v.slot === 'a' ? escapeDiscord(a) : escapeDiscord(b)} → <#${v.channel_id}>`).join(' · ')} (join yours if you were not moved automatically)`
        : '';
      const head = n.category === 'match_start' ? `⏰ Reminder: your match is waiting for a result.` : `🎮 Match ready!`;
      const body = `${head} ${title} — ${label}: **${escapeDiscord(a)}** vs **${escapeDiscord(b)}** (best of ${m.best_of}).${voiceLine}\nReport: \`/match report match:${m.id}\` or ${link(ctx, `/m/${m.id}`)}`;
      return { channel: `${body}\n${players.map((u) => `<@${u}>`).join(' ')}`, dm: body, mentionUserIds: players };
    }
    case 'match_result': {
      if (!n.matchId || !t) return null;
      const m = getMatch(ctx, n.matchId);
      if (!m) return null;
      const label = matchLabel(m, poolName(ctx, m.pool_id));
      const a = escapeDiscord(competitorName(ctx, m.competitor_a));
      const b = escapeDiscord(competitorName(ctx, m.competitor_b));
      if (p.event === 'awaiting_confirmation') {
        const msg = `📨 A result was reported for ${title} — ${label}: ${a} vs ${b}, ${describeSeries({ winsA: Number(p.winsA), winsB: Number(p.winsB), games: (p.games as { a: number; b: number }[]) ?? [] })}. Please confirm or dispute: \`/match confirm match:${m.id}\` · ${link(ctx, `/m/${m.id}`)}`;
        const confirmers = n.audience.startsWith('side:') ? competitorMembers(ctx, n.audience.endsWith('a') ? m.competitor_a : m.competitor_b) : [];
        return { channel: `${msg}\n${confirmers.map((u) => `<@${u}>`).join(' ')}`, dm: msg, mentionUserIds: confirmers };
      }
      if (p.event === 'disputed') return simple(`⚠️ Result dispute in ${title} — ${label}: ${a} vs ${b}. An organizer needs to resolve it: ${link(ctx, `/m/${m.id}`)}`);
      if (m.status !== 'completed') return null;
      const winner = m.winner === 'a' ? a : b;
      const score = m.forfeit ? 'by forfeit' : describeSeries({ winsA: m.wins_a ?? 0, winsB: m.wins_b ?? 0, games: matchGames(m) });
      const corrected = p.event === 'corrected' ? ' (corrected)' : '';
      return simple(`🏁 ${title} — ${label}: **${winner}** wins ${a} vs ${b} ${score}${corrected}.`);
    }
    case 'bracket_change':
      return simple(`🔀 ${title}: ${escapeDiscord(String(p.text ?? 'The bracket was updated.'))} ${tLink}`);
    case 'standings':
      return simple(`📊 ${title}: ${escapeDiscord(String(p.text ?? 'Standings updated.'))} ${tLink}`);
    case 'tournament_complete': {
      if (!t) return null;
      if (t.state === 'cancelled') return simple(`❌ ${title} was cancelled.${p.reason ? ` Reason: ${escapeDiscord(String(p.reason))}` : ''}`);
      const top = ctx.db
        .prepare('SELECT p.placement, c.name FROM placements p JOIN competitors c ON c.id = p.competitor_id WHERE p.tournament_id = ? AND p.placement <= 3 ORDER BY p.placement, c.name')
        .all(t.id) as { placement: number; name: string }[];
      const medals = ['🥇', '🥈', '🥉'];
      const lines = top.map((r) => `${medals[r.placement - 1] ?? r.placement} ${escapeDiscord(r.name)}`).join('\n');
      return simple(`🏆 ${title} is complete!\n${lines}\nFull results: ${tLink}`);
    }
    case 'availability_digest': {
      if (!t) return null;
      const body = availabilityDigest(ctx, t);
      if (!body) return null;
      return simple(`📋 ${title} starts ${discordTime(t.cfg.schedule.startAt!, 'R')}. Who can make it:\n${body}\n${link(ctx, `/t/${t.id}/manage`)}`);
    }
    case 'organizer_alert':
      return simple(`🛠️ Organizer notice for ${title || 'your tournament'}: ${escapeDiscord(String(p.text ?? ''))}${t ? ` ${link(ctx, `/t/${t.id}/manage`)}` : ''}`);
    case 'personal':
      return simple(`${String(p.text ?? '')}${t ? `\n${tLink}` : ''}`);
    default:
      return t ? simple(`${title}: ${STATE_LABELS[t.state]}`) : null;
  }
}
