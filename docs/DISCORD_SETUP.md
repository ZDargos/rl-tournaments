# Discord setup

You need one Discord application. It provides the login (OAuth2) and the bot. Everything here is free.

## 1. Create the application

1. Go to https://discord.com/developers/applications → **New Application** and give it a name.
2. **General Information:** copy the **Application ID**. This is `DISCORD_CLIENT_ID`.
3. **OAuth2:**
   - Click **Reset Secret** and copy it. This is `DISCORD_CLIENT_SECRET`.
   - Under **Redirects**, add exactly `<PUBLIC_API_URL>/auth/discord/callback`, for example `https://my-machine.tail1234.ts.net/auth/discord/callback`. For local testing also add `http://localhost:8787/auth/discord/callback`.
4. **Bot:**
   - Click **Reset Token** and copy it. This is `DISCORD_BOT_TOKEN`.
   - Leave **Public Bot** on if other servers should be able to add it, or off to keep it to servers you invite it to.
   - Leave all three **Privileged Gateway Intents** off (Presence, Server Members, Message Content). The bot doesn't use them.

Put the three values only in the server's `.env` file. Never put them in the website, in GitHub variables, in a commit, or in chat. If one leaks, reset it in the portal straight away and update `.env`.

## 2. Invite the bot

Use this URL, replacing `CLIENT_ID`:

```
https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot%20applications.commands&permissions=19942416
```

`19942416` grants exactly these permissions, and nothing else:

| Permission | Why |
|---|---|
| View Channels | see the announcement channel and voice channels it creates |
| Send Messages, Embed Links | announcements and match messages (if you choose channel delivery) |
| Manage Channels | create and delete the temporary match voice channels |
| Connect, Speak | required to grant those rights on the private voice channels it creates |
| Move Members | move connected players into their team channel |

The bot does **not** need Administrator, Manage Roles, Manage Server, or any privileged intent.

If you choose a voice category, the bot must be able to view and manage channels in that category. Check any category-level overrides that deny the bot's role. Run `/server info` in Discord to see which permissions the bot actually has, and `/voice repair` to retry failed channels.

## 3. Register the slash commands

On the server machine, with `.env` filled in:

```bash
npm run build
npm run register-commands
```

- If `DISCORD_DEV_GUILD_ID` is set, commands register to that one server instantly, which is good for testing.
- If it isn't set, they register globally. Discord may take a while to show global commands everywhere.

Run this again after upgrading if the commands changed.

## 4. Server settings

A member with **Manage Server** can open the server page on the website (or use `/server settings`) to set:

- **The default announcement channel and voice category.**
- **Who can create tournaments:** admins only, specific roles, or everyone.
- **Which roles can manage presets.**
- **Whether server admins can manage or see every tournament.** Both are off by default, so a private tournament stays private even from server admins unless you enable this.

## DMs

Bot DMs only reach members who allow DMs from server members (Discord privacy setting).

- **When a DM is rejected:** the player is marked unreachable for a while and organizers see this on the Control tab.
- **Channel announcements still work.**
- **Player opt-out:** players can turn DMs off with `/notify dms` or on the website.
