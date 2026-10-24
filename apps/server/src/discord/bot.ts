import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits,
  type AutocompleteInteraction, type ButtonInteraction, type ChatInputCommandInteraction, type CommandInteractionOption, type Interaction,
} from 'discord.js';
import type { AppContext } from '../services/context.js';
import { upsertGuild } from '../services/guilds.js';
import { autocomplete, handleInteraction, type BotInteraction, type BotReply } from './handlers.js';

/** Only non-privileged intents: guild metadata and voice states (for moving players into match channels). */
export function createClient(): Client {
  return new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
}

const STYLE = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger };

function toPayload(r: BotReply) {
  const components = r.buttons?.length
    ? [new ActionRowBuilder<ButtonBuilder>().addComponents(r.buttons.slice(0, 5).map((b) => new ButtonBuilder().setCustomId(b.customId).setLabel(b.label).setStyle(STYLE[b.style])))]
    : [];
  return {
    content: r.content,
    components,
    files: r.file ? [{ attachment: r.file.data, name: r.file.name }] : [],
    allowedMentions: { parse: [] as never[] },
  };
}

function flattenOptions(opts: readonly CommandInteractionOption[], out: BotInteraction['options'] = {}) {
  for (const o of opts) {
    if (o.options?.length) flattenOptions(o.options, out);
    else if (o.user) out[o.name] = { id: o.user.id, username: o.user.username, globalName: o.user.globalName };
    else if (o.value !== undefined) out[o.name] = o.value as string | number | boolean;
  }
  return out;
}

function memberFacts(i: ChatInputCommandInteraction | ButtonInteraction) {
  const roles = i.member?.roles;
  const roleIds = Array.isArray(roles) ? roles : roles ? [...roles.cache.keys()].filter((id) => id !== i.guildId) : [];
  const nick = i.member && 'displayName' in i.member ? (i.member.displayName as string) : (i.member as { nick?: string | null } | null)?.nick ?? null;
  return {
    memberIsAdmin: !!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild) || !!i.memberPermissions?.has(PermissionFlagsBits.Administrator),
    memberRoleIds: roleIds,
    memberDisplayName: nick,
  };
}

function toBotInteraction(i: ChatInputCommandInteraction | ButtonInteraction): BotInteraction {
  const base = {
    id: i.id,
    guildId: i.guildId,
    guildName: i.guild?.name ?? null,
    user: { id: i.user.id, username: i.user.username, globalName: i.user.globalName, avatar: i.user.avatar },
    ...memberFacts(i),
  };
  if (i.isButton()) return { ...base, kind: 'button', command: '', subcommand: null, options: {}, customId: i.customId };
  return { ...base, kind: 'command', command: i.commandName, subcommand: i.options.getSubcommand(false), options: flattenOptions(i.options.data) };
}

/**
 * Interactions must be acknowledged within 3 seconds. Most commands finish in milliseconds; if one is
 * slower (voice repair, Discord lookups) we defer (ephemerally) and edit the reply when it completes.
 */
async function respond(ctx: AppContext, i: ChatInputCommandInteraction | ButtonInteraction) {
  let deferred = false;
  const timer = setTimeout(() => {
    deferred = true;
    i.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }, 2000);
  let result: BotReply | null;
  try {
    result = await handleInteraction(ctx, toBotInteraction(i));
  } finally {
    clearTimeout(timer);
  }
  if (!result) return; // duplicate delivery: the first copy already answered
  const payload = toPayload(result);
  if (deferred) await i.editReply(payload);
  else await i.reply({ ...payload, flags: result.ephemeral ? MessageFlags.Ephemeral : undefined });
}

async function onAutocomplete(ctx: AppContext, i: AutocompleteInteraction) {
  const focused = i.options.getFocused(true);
  const choices = await autocomplete(ctx, { guildId: i.guildId, userId: i.user.id, option: focused.name, value: String(focused.value ?? '') });
  await i.respond(choices);
}

export function attachBot(ctx: AppContext, client: Client) {
  client.once(Events.ClientReady, (c) => {
    ctx.log.info({ user: c.user.tag, guilds: c.guilds.cache.size }, 'discord bot ready');
    for (const g of c.guilds.cache.values()) upsertGuild(ctx, { id: g.id, name: g.name, icon: g.icon, botPresent: true });
  });
  client.on(Events.GuildCreate, (g) => upsertGuild(ctx, { id: g.id, name: g.name, icon: g.icon, botPresent: true }));
  client.on(Events.GuildDelete, (g) => {
    if (g.available) upsertGuild(ctx, { id: g.id, name: g.name ?? 'Discord server', icon: g.icon, botPresent: false });
  });
  client.on(Events.InteractionCreate, async (i: Interaction) => {
    try {
      if (i.isAutocomplete()) await onAutocomplete(ctx, i);
      else if (i.isChatInputCommand() || i.isButton()) await respond(ctx, i);
    } catch (err) {
      ctx.log.error({ err: String(err) }, 'interaction failed');
    }
  });
  client.on(Events.Error, (err) => ctx.log.error({ err: String(err) }, 'discord client error'));
  client.on(Events.ShardResume, () => ctx.kick(null));
}
