/**
 * The only surface through which the backend talks to Discord. The production implementation
 * wraps discord.js (adapter.ts); tests and DISCORD_DISABLED mode use FakeDiscord.
 */
export interface DiscordMemberInfo {
  userId: string;
  username: string;
  displayName: string;
  avatar: string | null;
  roleIds: string[];
  isAdmin: boolean;
}

export interface MessageContent {
  content: string;
  /** User ids that may be pinged. Everyone else (including @everyone) is suppressed. */
  mentionUserIds?: string[];
}

export interface CreateVoiceChannelInput {
  guildId: string;
  name: string;
  parentId: string | null;
  memberIds: string[];
  organizerIds: string[];
  viewerIds: string[];
}

export class DiscordApiError extends Error {
  constructor(
    message: string,
    readonly code: number | string,
    readonly httpStatus: number,
    /** Retrying cannot help (missing permission, unknown channel, DMs closed). */
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

/** Discord JSON error codes we react to. */
export const DiscordCodes = {
  UnknownChannel: 10003,
  UnknownMember: 10007,
  UnknownUser: 10013,
  MissingAccess: 50001,
  CannotDM: 50007,
  MissingPermissions: 50013,
  TargetNotInVoice: 40032,
} as const;

export interface BotPermissionReport {
  manageChannels: boolean;
  moveMembers: boolean;
  viewChannel: boolean;
  sendMessages: boolean;
  connect: boolean;
  missing: string[];
}

export interface DiscordPort {
  readonly enabled: boolean;
  getMember(guildId: string, userId: string): Promise<DiscordMemberInfo | null>;
  searchMembers(guildId: string, query: string): Promise<DiscordMemberInfo[]>;
  listChannels(guildId: string): Promise<{ id: string; name: string; type: 'text' | 'voice' | 'category' | 'other'; parentId: string | null }[]>;
  createVoiceChannel(input: CreateVoiceChannelInput): Promise<{ id: string }>;
  deleteChannel(guildId: string, channelId: string): Promise<'deleted' | 'not_found'>;
  channelExists(guildId: string, channelId: string): Promise<boolean>;
  getMemberVoiceChannel(guildId: string, userId: string): Promise<string | null>;
  moveMember(guildId: string, userId: string, channelId: string): Promise<void>;
  sendChannelMessage(channelId: string, message: MessageContent): Promise<{ id: string }>;
  sendDM(userId: string, message: MessageContent): Promise<{ id: string }>;
  botPermissions(guildId: string): Promise<BotPermissionReport>;
}

/** In-memory Discord used by tests and local runs without a bot token. */
export class FakeDiscord implements DiscordPort {
  readonly enabled: boolean;
  members = new Map<string, DiscordMemberInfo>(); // `${guild}:${user}`
  channels = new Map<string, { id: string; guildId: string; name: string; type: 'text' | 'voice' | 'category'; parentId: string | null; memberIds: string[]; organizerIds: string[]; viewerIds: string[] }>();
  voiceStates = new Map<string, string>(); // `${guild}:${user}` -> channel
  sent: { kind: 'channel' | 'dm'; target: string; content: string; mentions: string[] }[] = [];
  dmClosed = new Set<string>();
  failCreateVoice: DiscordApiError | null = null;
  permissions: BotPermissionReport = { manageChannels: true, moveMembers: true, viewChannel: true, sendMessages: true, connect: true, missing: [] };
  private seq = 900000000000000000n;

  constructor(enabled = true) {
    this.enabled = enabled;
  }

  nextId() {
    this.seq += 1n;
    return this.seq.toString();
  }

  addMember(guildId: string, m: Partial<DiscordMemberInfo> & { userId: string }) {
    this.members.set(`${guildId}:${m.userId}`, {
      userId: m.userId, username: m.username ?? `user${m.userId.slice(-4)}`, displayName: m.displayName ?? m.username ?? `User ${m.userId.slice(-4)}`,
      avatar: null, roleIds: m.roleIds ?? [], isAdmin: m.isAdmin ?? false,
    });
  }

  async getMember(guildId: string, userId: string) {
    return this.members.get(`${guildId}:${userId}`) ?? null;
  }
  async searchMembers(guildId: string, query: string) {
    const q = query.toLowerCase();
    return [...this.members.entries()].filter(([k, m]) => k.startsWith(`${guildId}:`) && (m.username.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q))).map(([, m]) => m);
  }
  async listChannels(guildId: string) {
    return [...this.channels.values()].filter((c) => c.guildId === guildId).map((c) => ({ id: c.id, name: c.name, type: c.type, parentId: c.parentId }));
  }
  async createVoiceChannel(input: CreateVoiceChannelInput) {
    if (this.failCreateVoice) throw this.failCreateVoice;
    const id = this.nextId();
    this.channels.set(id, { id, guildId: input.guildId, name: input.name, type: 'voice', parentId: input.parentId, memberIds: input.memberIds, organizerIds: input.organizerIds, viewerIds: input.viewerIds });
    return { id };
  }
  async deleteChannel(_guildId: string, channelId: string) {
    if (!this.channels.has(channelId)) return 'not_found' as const;
    this.channels.delete(channelId);
    for (const [k, v] of this.voiceStates) if (v === channelId) this.voiceStates.delete(k);
    return 'deleted' as const;
  }
  async channelExists(_guildId: string, channelId: string) {
    return this.channels.has(channelId);
  }
  async getMemberVoiceChannel(guildId: string, userId: string) {
    return this.voiceStates.get(`${guildId}:${userId}`) ?? null;
  }
  async moveMember(guildId: string, userId: string, channelId: string) {
    if (!this.voiceStates.has(`${guildId}:${userId}`)) throw new DiscordApiError('Target user is not connected to voice.', DiscordCodes.TargetNotInVoice, 400, true);
    this.voiceStates.set(`${guildId}:${userId}`, channelId);
  }
  async sendChannelMessage(channelId: string, message: MessageContent) {
    this.sent.push({ kind: 'channel', target: channelId, content: message.content, mentions: message.mentionUserIds ?? [] });
    return { id: this.nextId() };
  }
  async sendDM(userId: string, message: MessageContent) {
    if (this.dmClosed.has(userId)) throw new DiscordApiError('Cannot send messages to this user', DiscordCodes.CannotDM, 403, true);
    this.sent.push({ kind: 'dm', target: userId, content: message.content, mentions: [] });
    return { id: this.nextId() };
  }
  async botPermissions() {
    return this.permissions;
  }
}
