import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, DiscordAPIError, OverwriteType, PermissionFlagsBits, type Client, type Guild, type GuildMember,
} from 'discord.js';
import { DiscordApiError, DiscordCodes, type BotPermissionReport, type CreateVoiceChannelInput, type DiscordMemberInfo, type DiscordPort, type MessageContent } from './port.js';

const STYLE = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger };

function components(message: MessageContent) {
  if (!message.buttons?.length) return [];
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(message.buttons.slice(0, 5).map((b) => new ButtonBuilder().setCustomId(b.customId).setLabel(b.label.slice(0, 80)).setStyle(STYLE[b.style])))];
}

const PERMANENT_CODES = new Set<number>([DiscordCodes.UnknownChannel, DiscordCodes.UnknownMember, DiscordCodes.UnknownUser, DiscordCodes.MissingAccess, DiscordCodes.CannotDM, DiscordCodes.MissingPermissions, DiscordCodes.TargetNotInVoice]);

/** Translate discord.js errors into DiscordApiError. Rate limits are queued and retried by discord.js itself. */
function mapError(err: unknown): never {
  if (err instanceof DiscordAPIError) {
    const code = typeof err.code === 'number' ? err.code : Number(err.code) || 0;
    throw new DiscordApiError(err.message, code, err.status, PERMANENT_CODES.has(code) || err.status === 403 || err.status === 404);
  }
  if (err instanceof DiscordApiError) throw err;
  throw new DiscordApiError(err instanceof Error ? err.message : String(err), 'network', 0, false);
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    mapError(err);
  }
}

function memberInfo(m: GuildMember): DiscordMemberInfo {
  return {
    userId: m.id,
    username: m.user.username,
    displayName: m.displayName,
    avatar: m.user.avatar,
    roleIds: m.roles.cache.filter((r) => r.id !== m.guild.id).map((r) => r.id),
    isAdmin: m.permissions.has(PermissionFlagsBits.ManageGuild) || m.permissions.has(PermissionFlagsBits.Administrator),
  };
}

/** Production DiscordPort backed by a logged-in discord.js client. */
export class DiscordJsAdapter implements DiscordPort {
  readonly enabled = true;
  constructor(private client: Client) {}

  private async guild(id: string): Promise<Guild> {
    return call(() => this.client.guilds.fetch(id));
  }

  async getMember(guildId: string, userId: string) {
    const g = await this.guild(guildId);
    try {
      return memberInfo(await g.members.fetch(userId));
    } catch (err) {
      if (err instanceof DiscordAPIError && (err.code === DiscordCodes.UnknownMember || err.code === DiscordCodes.UnknownUser)) return null;
      mapError(err);
    }
  }

  async searchMembers(guildId: string, query: string) {
    const g = await this.guild(guildId);
    const found = await call(() => g.members.search({ query, limit: 25 }));
    return [...found.values()].map(memberInfo);
  }

  async listChannels(guildId: string) {
    const g = await this.guild(guildId);
    const chans = await call(() => g.channels.fetch());
    return [...chans.values()].filter((c) => c != null).map((c) => ({
      id: c!.id,
      name: c!.name,
      type: c!.type === ChannelType.GuildText || c!.type === ChannelType.GuildAnnouncement ? ('text' as const) : c!.type === ChannelType.GuildVoice ? ('voice' as const) : c!.type === ChannelType.GuildCategory ? ('category' as const) : ('other' as const),
      parentId: c!.parentId ?? null,
    }));
  }

  async createVoiceChannel(input: CreateVoiceChannelInput) {
    const g = await this.guild(input.guildId);
    const me = this.client.user!.id;
    // Overwrites for users who are not (or no longer) in the server are rejected by Discord, so only include members.
    const ids = [...new Set([...input.memberIds, ...input.organizerIds, ...input.viewerIds])].filter((id) => id !== me);
    const present = new Set<string>();
    if (ids.length) {
      try {
        const fetched = await g.members.fetch({ user: ids });
        for (const id of fetched.keys()) present.add(id);
      } catch {
        for (const id of ids) {
          const m = await g.members.fetch(id).catch(() => null);
          if (m) present.add(id);
        }
      }
    }
    const players = new Set(input.memberIds);
    const overwrites = [
      { id: g.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
      { id: me, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers] },
      ...[...present].map((id) => ({
        id,
        type: OverwriteType.Member,
        allow: players.has(id) || input.organizerIds.includes(id) ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] : [PermissionFlagsBits.ViewChannel],
      })),
    ];
    const ch = await call(() => g.channels.create({ name: input.name.slice(0, 100), type: ChannelType.GuildVoice, parent: input.parentId ?? undefined, permissionOverwrites: overwrites, reason: 'Tournament match voice channel' }));
    return { id: ch.id };
  }

  async deleteChannel(_guildId: string, channelId: string) {
    try {
      const ch = await this.client.channels.fetch(channelId);
      if (!ch) return 'not_found' as const;
      await ch.delete('Tournament match finished');
      return 'deleted' as const;
    } catch (err) {
      if (err instanceof DiscordAPIError && err.code === DiscordCodes.UnknownChannel) return 'not_found' as const;
      mapError(err);
    }
  }

  async channelExists(_guildId: string, channelId: string) {
    try {
      return !!(await this.client.channels.fetch(channelId));
    } catch (err) {
      if (err instanceof DiscordAPIError && (err.code === DiscordCodes.UnknownChannel || err.code === DiscordCodes.MissingAccess)) return false;
      mapError(err);
    }
  }

  async getMemberVoiceChannel(guildId: string, userId: string) {
    // The GuildVoiceStates intent keeps this cache current from the gateway.
    const g = this.client.guilds.cache.get(guildId) ?? (await this.guild(guildId));
    return g.voiceStates.cache.get(userId)?.channelId ?? null;
  }

  async moveMember(guildId: string, userId: string, channelId: string) {
    const g = await this.guild(guildId);
    await call(() => g.members.edit(userId, { channel: channelId }));
  }

  async sendChannelMessage(channelId: string, message: MessageContent) {
    const ch = await call(() => this.client.channels.fetch(channelId));
    if (!ch || !ch.isSendable()) throw new DiscordApiError('Channel is not a text channel the bot can post in.', DiscordCodes.UnknownChannel, 404, true);
    const msg = await call<{ id: string }>(() => ch.send({ content: message.content, components: components(message), allowedMentions: { parse: [], users: message.mentionUserIds ?? [] } }));
    return { id: msg.id };
  }

  async editChannelMessage(channelId: string, messageId: string, message: MessageContent) {
    const ch = await call(() => this.client.channels.fetch(channelId));
    if (!ch || !ch.isTextBased()) throw new DiscordApiError('Channel is not a text channel.', DiscordCodes.UnknownChannel, 404, true);
    // Edits never ping anyone again.
    await call(() => ch.messages.edit(messageId, { content: message.content, components: components(message), allowedMentions: { parse: [] } }));
  }

  async deleteChannelMessage(channelId: string, messageId: string) {
    try {
      const ch = await this.client.channels.fetch(channelId);
      if (!ch || !ch.isTextBased()) return 'not_found' as const;
      await ch.messages.delete(messageId);
      return 'deleted' as const;
    } catch (err) {
      if (err instanceof DiscordAPIError && (err.code === DiscordCodes.UnknownMessage || err.code === DiscordCodes.UnknownChannel)) return 'not_found' as const;
      mapError(err);
    }
  }

  async sendDM(userId: string, message: MessageContent) {
    const msg = await call(() => this.client.users.send(userId, { content: message.content, components: components(message), allowedMentions: { parse: [] } }));
    return { id: msg.id };
  }

  async botPermissions(guildId: string): Promise<BotPermissionReport> {
    const g = await this.guild(guildId);
    const me = g.members.me ?? (await call(() => g.members.fetchMe()));
    const p = me.permissions;
    const report = {
      manageChannels: p.has(PermissionFlagsBits.ManageChannels),
      moveMembers: p.has(PermissionFlagsBits.MoveMembers),
      viewChannel: p.has(PermissionFlagsBits.ViewChannel),
      sendMessages: p.has(PermissionFlagsBits.SendMessages),
      connect: p.has(PermissionFlagsBits.Connect),
    };
    const missing = Object.entries({ manageChannels: 'Manage Channels', moveMembers: 'Move Members', viewChannel: 'View Channels', sendMessages: 'Send Messages', connect: 'Connect' })
      .filter(([k]) => !report[k as keyof typeof report])
      .map(([, v]) => v);
    return { ...report, missing };
  }
}
