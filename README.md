# YapBot — Node.js version

## Voice picker update

`/voice` now labels every option as **Name | Gender | Accent | Language**, with British voices first:

- **Ryan | Male | British | English**
- **Sonia | Female | British | English**

Ryan is the default for new users. Existing saved choices stay intact: run `/voice` and select Ryan to change yours. For a slightly slower, more measured delivery, try `/speed percent:-10`; this is a preference, not a special formal speaking style. Sonia is the British female alternative. Preview either with `/say`.

To update an existing installation, stop the bot and replace **bot.js** with the version in this ZIP, then run `npm start`. Keep your existing `.env` and `settings.json`. Startup re-registers the command choices, so Discord shows the readable labels. If the menu looks stale, close and reopen the command picker. A fresh install still follows the setup below.

JavaScript for Node.js. No Python required. Free online Edge text-to-speech; no paid API key. Run it on your PC, which must stay on and connected. This does not include free cloud hosting.

## Start on Windows

1. Stop the old Python bot (Ctrl+C in its terminal). Do not run both versions with the same token.
2. Install a current **64-bit Node.js LTS, version 24.17.0 or newer** from https://nodejs.org . Open a new terminal after installing. Run `node -v` to verify. Older Node 24.13 installs need an update for this package's voice dependency.
3. Extract the ZIP. In this folder, copy `.env.example` to `.env`. Paste your existing bot token and server ID into `.env`:

```env
DISCORD_TOKEN=your_existing_bot_token
GUILD_ID=your_server_id
```

4. In https://discord.com/developers/applications → your bot → Bot, enable **Message Content Intent** and **Server Members Intent**. These are used for `=messages` and member audit logs. Keep your token private.
5. Open a terminal inside the extracted folder:

```powershell
npm install
npm start
```

6. Join a normal voice channel. Run `/come` in the text channel you want to use. Type `=hello` or `/say message:hello`.

FFmpeg installs with the dependencies; no separate PATH setup normally needed. Installation must be allowed to run npm dependency scripts. DAVE support comes with @discordjs/voice. This package uses OpusScript to avoid requiring a local C++ compiler for the Opus encoder; supported native DAVE binaries are still required.

## Fixing the permissions message

The old Python version returned the same list of three permissions whenever any one was missing. That did not establish that all three were absent.

This bot refreshes roles, the bot member, and the exact voice channel before computing effective permissions. It attempts the connection instead of blocking solely on a preflight check. `/diagnose` displays the exact bot identity, channel, effective flags, applicable channel overrides, server mute state, and channel capacity. Failed connections with all three permissions enabled are reported as connection failures, rather than permission failures.

Your own account's permissions do not give permissions to the bot. A bot role's server permissions can also be changed by channel or category overrides. If `/diagnose` shows a missing permission:

1. Right-click **the voice channel you are in** → Edit Channel → Permissions.
2. Add **the YapBot member itself** and explicitly allow View Channel, Connect, and Speak. Allow Use Voice Activity too if voice activity is restricted.
3. If the channel is synced to a category, inspect that category's permissions as well. The diagnostic shows the channel's actual overrides.
4. If the bot is server-muted, a moderator must unmute it. Check the channel isn't full.
5. Retry `/come`.

The bot does not change server permissions automatically. Administrator is unnecessary. This code cannot bypass Discord's access restrictions.

If permissions all show YES but joining times out, inspect `[JOIN]` and `[COME]` in the terminal. Check Windows Firewall, UDP connectivity, a VPN, and whether the channel is full. TTS service failures occur after joining and appear as `[SPEECH]` errors, separately from voice connection errors.

## Commands

| Command | What it does |
|---|---|
| `/come` | Join your VC, bind `=messages` to this text channel |
| `/say message` | Read text aloud |
| `=message` | Read text from the bound text channel |
| `/voice name` | Choose a saved personal voice, including English, Sinhala, Tamil |
| `/speed percent` | Save personal speed between -50 and 50 |
| `/volume percent` | Session volume between 0 and 100 |
| `/skip` | Skip your active speech; session owner/moderators can skip anyone |
| `/stop` | Stop active speech and clear queue |
| `/queue` | Waiting count |
| `/leave` | Disconnect |
| `/diagnose` | Fresh bot permission report for your VC |
| `/help` | Command list |

`/come` registers `=messages` in the text channel it was run from. Prefix messages elsewhere are ignored. Only people in the bot's VC can submit speech. Queue limit: 20 waiting overall, 3 per user. Cooldown: 3 seconds. Maximum: 500 characters. The bot skips queued speech if the sender has left its VC. Personal settings persist in settings.json. Commands that affect the whole session require the member who summoned it or Manage Server. One voice connection per server; multiple servers are supported.

Auto-disconnect: when everyone leaves the VC, or after 5 minutes idle, checked every 15 seconds. If user `1440771740920971296` leaves the bot's VC, the bot logs a 3-minute countdown and disconnects when it expires; rejoining that VC cancels the countdown. That user's 3-minute grace period takes precedence over the empty-channel disconnect, including if they were the last person in the VC. Other empty voice channels still cause an immediate disconnect.

## Security and activity logs

The bot sends rich audit embeds to channel `1500372280637915177`. It logs guild message content and edits/deletions (including available attachment links), slash-command options and outcomes, voice joins/leaves and state changes, member joins/leaves/updates, bans, channel and role changes, and Discord audit-log actions. The audit channel itself is excluded from message-content logging to prevent log recursion.

Because message contents and attachment URLs are included, restrict access to the audit channel to trusted moderators. The bot needs View Channel, Send Messages, Embed Links, and View Audit Log in that channel. Startup checks those permissions and stops with an explicit error if the audit destination is unavailable. Audit logs are messages in your Discord server; they are subject to your server's retention and access settings.

## Bot invite and registration

Use OAuth2 URL Generator in the Developer Portal with `bot` and `applications.commands`. Give the bot View Channels, Send Messages, Embed Links, Connect, Speak, and Use Voice Activity; also grant View Audit Log for server audit events. Invite the existing application to your server if needed. No second bot account is required.

On startup the package **replaces the guild-scoped slash-command list for this bot application in GUILD_ID** with the 11 commands above. This is intended for the dedicated YapBot application. Do not use a token belonging to a different multipurpose bot whose commands you need to retain. Commands are registered only in that server; the voice logic supports multiple servers if you add equivalent command registration there. Old global commands are not deleted by this package.

## Free speech source

Uses https://github.com/SchneeHertz/node-edge-tts and Microsoft's online Edge speech service. No subscription key is required. It is an unofficial integration: service availability, throttling, and compatibility can change. It is not guaranteed unlimited or permanent free access. Text you submit is sent to Microsoft for synthesis. Your Discord bot token is unrelated to a paid TTS API key.

Voice source and requirements: https://discord.js.org/docs/packages/voice/stable .
Discord permissions: https://docs.discord.com/developers/topics/permissions .

## Checks

Run `npm run check` for syntax and `npm test` for permission-report, queue-limit, command-payload, and PCM-to-Opus regression tests. These checks passed during packaging, and FFmpeg and the DAVE dependency loaded successfully. The Microsoft speech endpoint was unreachable from the build environment (DNS EAI_AGAIN), so live speech service playback could not be validated here. Audible playback and channel permissions must still be verified on your Discord server with your token; a local test cannot establish them.
