const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, fork } = require('node:child_process');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const {
  Client, GatewayIntentBits, PermissionFlagsBits: P, ChannelType,
  SlashCommandBuilder, Events, MessageFlags, EmbedBuilder,
} = require('discord.js');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource, entersState,
  VoiceConnectionStatus: VCS, AudioPlayerStatus: APS, StreamType,
  NoSubscriberBehavior, generateDependencyReport,
} = require('@discordjs/voice');
const ffmpeg = require('ffmpeg-static');
const { clean, missingPermissions, validateQueue } = require('./core');

const LOG_CHANNEL_ID = '1500372280637915177';
const DELAYED_LEAVE_USER_ID = '1440771740920971296';
const LEAVE_GRACE_MS = 3 * 60 * 1000;
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  allowedMentions: { parse: [], repliedUser: false },
});
const sessions = new Map();
const joining = new Set();
const cooldowns = new Map();
const settingsPath = path.join(__dirname, 'settings.json');
let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
const voices = [
  { id: 'en-GB-RyanNeural', name: 'Ryan', gender: 'Male', accent: 'British', language: 'English' },
  { id: 'en-GB-SoniaNeural', name: 'Sonia', gender: 'Female', accent: 'British', language: 'English' },
  { id: 'en-US-AriaNeural', name: 'Aria', gender: 'Female', accent: 'American', language: 'English' },
  { id: 'en-US-GuyNeural', name: 'Guy', gender: 'Male', accent: 'American', language: 'English' },
  { id: 'en-US-JennyNeural', name: 'Jenny', gender: 'Female', accent: 'American', language: 'English' },
  { id: 'en-AU-NatashaNeural', name: 'Natasha', gender: 'Female', accent: 'Australian', language: 'English' },
  { id: 'si-LK-ThiliniNeural', name: 'Thilini', gender: 'Female', accent: 'Sri Lankan', language: 'Sinhala' },
  { id: 'si-LK-SameeraNeural', name: 'Sameera', gender: 'Male', accent: 'Sri Lankan', language: 'Sinhala' },
  { id: 'ta-LK-SaranyaNeural', name: 'Saranya', gender: 'Female', accent: 'Sri Lankan', language: 'Tamil' },
  { id: 'ta-LK-KumarNeural', name: 'Kumar', gender: 'Male', accent: 'Sri Lankan', language: 'Tamil' },
];
const voiceLabel = v => `${v.name} | ${v.gender} | ${v.accent} | ${v.language}`;
function profile(id) {
  return settings[id] ||= { voice: 'en-GB-RyanNeural', rate: 0 };
}
function save() {
  fs.writeFileSync(`${settingsPath}.tmp`, JSON.stringify(settings, null, 2));
  fs.renameSync(`${settingsPath}.tmp`, settingsPath);
}
const command = (name, description) => new SlashCommandBuilder()
  .setName(name).setDescription(description).setDMPermission(false);
const commands = [
  command('come', 'Join your voice channel and read =messages from this text channel'),
  command('say', 'Read text aloud').addStringOption(o => o.setName('message').setDescription('What to say').setRequired(true).setMaxLength(500)),
  command('voice', 'Choose a voice by name, gender, accent, and language').addStringOption(o => o.setName('name').setDescription('British voices first — choose Ryan or Sonia for British English').setRequired(true).addChoices(...voices.map(v => ({ name: voiceLabel(v), value: v.id })))),
  command('speed', 'Change your personal speaking speed').addIntegerOption(o => o.setName('percent').setDescription('-50 to 50 percent').setRequired(true).setMinValue(-50).setMaxValue(50)),
  command('volume', 'Change session volume (session owner or Manage Server)').addIntegerOption(o => o.setName('percent').setDescription('0 to 100').setRequired(true).setMinValue(0).setMaxValue(100)),
  command('skip', 'Skip your current speech; session owner/moderators can skip anyone'),
  command('stop', 'Stop speech and clear the queue (session owner or Manage Server)'),
  command('leave', 'Disconnect (session owner or Manage Server)'),
  command('queue', 'Show waiting messages'),
  command('diagnose', 'Refresh and inspect the bot permissions in your voice channel'),
  command('help', 'Show the command list'),
];

async function reply(i, content) {
  const payload = { content, allowedMentions: { parse: [] } };
  if (i.deferred || i.replied) return i.editReply(payload);
  return i.reply({ ...payload, flags: MessageFlags.Ephemeral });
}
async function notify(channel, text) {
  try { await channel.send({ content: text, allowedMentions: { parse: [] } }); }
  catch (e) { console.error('[TEXT]', e.message); }
}
function truncate(value, max = 1024) {
  const text = String(value ?? '—');
  return text.length > max ? `${text.slice(0, max - 24)}… [truncated]` : text;
}
function formatUser(user) {
  if (!user) return 'Unknown user';
  const label = user.tag || user.username || 'Unknown user';
  return `${label} (${user.id})`;
}
function buildAuditEmbed({ guild, title, description, color = 0x5865F2, fields = [] }) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({
      name: 'YapBot  •  Speech Log',
      ...(client.user && { iconURL: client.user.displayAvatarURL() }),
    })
    .setTitle(truncate(title, 256))
    .setTimestamp()
    .setFooter({ text: `Speech log  •  ${guild?.name || 'Discord'}` });
  if (description) embed.setDescription(truncate(description, 4096));
  const icon = guild?.iconURL({ size: 128 });
  if (icon) embed.setThumbnail(icon);
  embed.addFields(fields.slice(0, 25).map(field => ({
    name: truncate(field.name, 256),
    value: truncate(field.value),
    inline: Boolean(field.inline),
  })));
  return embed;
}
async function auditLog({ guild, title, description, color, fields = [] }) {
  try {
    const channel = client.channels.cache.get(LOG_CHANNEL_ID)
      || await client.channels.fetch(LOG_CHANNEL_ID);
    if (!channel?.isTextBased() || typeof channel.send !== 'function')
      throw new Error(`Configured audit channel ${LOG_CHANNEL_ID} is unavailable or not text-based.`);
    await channel.send({
      embeds: [buildAuditEmbed({ guild, title, description, color, fields })],
      allowedMentions: { parse: [] },
    });
  } catch (e) {
    console.error('[AUDIT]', e.message);
  }
}
function channelField(channel) {
  return channel ? `${channel} (${channel.id})` : 'Unknown channel';
}
async function voiceInfo(guild, userId) {
  await guild.roles.fetch();
  const me = await guild.members.fetchMe({ force: true });
  const member = await guild.members.fetch({ user: userId, force: true });
  const id = member.voice.channelId;
  if (!id) throw new Error('Join a voice channel first.');
  const channel = await guild.channels.fetch(id, { force: true });
  if (channel?.type !== ChannelType.GuildVoice)
    throw new Error('Use a normal voice channel. Stage channels are not supported.');
  const perms = channel.permissionsFor(me);
  return { me, member, channel, perms, missing: missingPermissions(perms, P) };
}
function diagnostic(info) {
  const { channel, me, perms, missing } = info;
  const rows = ['ViewChannel', 'Connect', 'Speak', 'UseVAD', 'Administrator']
    .map(name => `${name}: ${perms?.has(P[name]) ? 'YES' : 'NO'}`);
  const denies = channel.permissionOverwrites.cache
    .filter(o => o.id === me.id || me.roles.cache.has(o.id))
    .map(o => `${o.id === me.id ? 'Bot member' : `Role ${o.id}`}: deny [${o.deny.toArray().join(', ') || 'none'}], allow [${o.allow.toArray().join(', ') || 'none'}]`);
  return `Bot: ${me.user.tag} (${me.id})\nVoice channel: ${channel.name} (${channel.id})\n${rows.join('\n')}\nServer-muted: ${me.voice.serverMute ? 'YES' : 'NO'}\nUser limit: ${channel.userLimit || 'none'}; connected: ${channel.members.size}\nEffective missing: ${missing.join(', ') || 'none'}\nMatching channel overrides (effective results above include precedence):\n${denies.join('\n') || 'none'}`;
}
function getSession(member) {
  const s = sessions.get(member.guild.id);
  if (!s || s.closed || s.connection.state.status !== VCS.Ready)
    throw new Error('Use /come first. The bot needs a ready voice connection.');
  if (member.voice.channelId !== s.channelId)
    throw new Error('Join my voice channel first.');
  return s;
}
function owner(member, s) {
  if (s.owner !== member.id && !member.permissions.has(P.ManageGuild))
    throw new Error('Only the person who used /come or someone with Manage Server can do that.');
}

class Session {
  constructor(guild, channel, textChannel, ownerId, connection) {
    this.guild = guild;
    this.channelId = channel.id;
    this.textChannel = textChannel;
    this.owner = ownerId;
    this.connection = connection;
    this.queue = [];
    this.volume = 0.8;
    this.last = Date.now();
    this.closed = false;
    this.running = false;
    this.current = null;
    this.cancelSynthesis = null;
    this.cancelPlayback = null;
    this.targetLeaveTimer = null;
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    this.player.on('error', e => {
      console.error('[PLAYER]', e.message);
    });
    this.subscription = connection.subscribe(this.player);
    connection.on('error', e => {
      console.error('[VOICE]', e.message);
    });
    connection.on(VCS.Disconnected, () => {
      this.recover().catch(e => console.error('[RECOVER]', e.message));
    });
    connection.on(VCS.Destroyed, () => this.close());
  }
  async recover() {
    if (this.closed || this.recovering) return;
    this.recovering = true;
    try {
      await Promise.race([
        entersState(this.connection, VCS.Signalling, 5000),
        entersState(this.connection, VCS.Connecting, 5000),
      ]);
      await entersState(this.connection, VCS.Ready, 20000);
    } catch {
      if (!this.closed) {
        this.close('The voice connection could not recover.');
        await notify(this.textChannel, 'Voice connection lost. Join your VC and use /come again.');
      }
    } finally { this.recovering = false; }
  }
  skip() {
    if (this.current) this.current.cancelled = true;
    this.cancelSynthesis?.();
    this.cancelPlayback?.();
    this.player.stop(true);
  }
  startTargetLeaveCountdown(user) {
    if (this.closed || this.targetLeaveTimer) return;
    console.log(`[VOICE] ${formatUser(user)} left; disconnecting in 3 minutes unless they return.`);
    this.targetLeaveTimer = setTimeout(() => {
      this.targetLeaveTimer = null;
      if (this.closed || sessions.get(this.guild.id) !== this) return;
      const state = this.guild.voiceStates.cache.get(DELAYED_LEAVE_USER_ID);
      if (state?.channelId === this.channelId) return;
      this.close(`${formatUser(user)} did not return within 3 minutes.`);
    }, LEAVE_GRACE_MS);
  }
  cancelTargetLeaveCountdown(user) {
    if (!this.targetLeaveTimer) return;
    clearTimeout(this.targetLeaveTimer);
    this.targetLeaveTimer = null;
    console.log(`[VOICE] ${formatUser(user)} returned; cancelled the pending disconnect.`);
  }
  close(reason = 'Voice connection closed.') {
    if (this.closed) return;
    this.closed = true;
    if (this.targetLeaveTimer) clearTimeout(this.targetLeaveTimer);
    this.targetLeaveTimer = null;
    this.queue = [];
    this.skip();
    this.subscription?.unsubscribe();
    if (this.connection.state.status !== VCS.Destroyed)     this.connection.destroy();
    if (sessions.get(this.guild.id) === this) sessions.delete(this.guild.id);
    console.log(`[VOICE] Disconnected: ${reason}`);
  }
  async play(file) {
    const proc = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file,
      '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'], { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', b => { stderr = (stderr + b).slice(-1000); });
    const resource = createAudioResource(proc.stdout, { inputType: StreamType.Raw, inlineVolume: true });
    resource.volume.setVolume(this.volume);
    this.resource = resource;
    try {
      await new Promise((resolve, reject) => {
        let timer;
        const finish = error => {
          clearTimeout(timer);
          this.player.off(APS.Idle, idle);
          this.player.off('error', fail);
          this.cancelPlayback = null;
          error ? reject(error) : resolve();
        };
        const idle = () => finish();
        const fail = error => finish(error);
        this.cancelPlayback = idle;
        this.player.once(APS.Idle, idle);
        this.player.once('error', fail);
        proc.once('error', fail);
        proc.once('close', code => {
          if (code && !this.closed && !this.current?.cancelled)
            fail(new Error(`FFmpeg exited ${code}: ${stderr}`));
        });
        timer = setTimeout(() => finish(new Error('Playback timed out after 3 minutes.')), 180000);
        this.player.play(resource);
      });
    } finally {
      this.player.stop(true);
      proc.kill();
      await new Promise(resolve => {
        if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
        proc.once('close', resolve);
      });
      this.resource = null;
    }
  }
  async synthesize(item, file) {
    await new Promise((resolve, reject) => {
      const child = fork(path.join(__dirname, 'tts-worker.js'), [], {
        silent: true, windowsHide: true,
        env: { ...process.env, DISCORD_TOKEN: '' },
      });
      let error;
      let success = false;
      let stderr = '';
      child.stderr.on('data', data => { stderr = (stderr + data).slice(-600); });
      const timer = setTimeout(() => {
        error = new Error('TTS timed out after 30 seconds. Check internet access to Microsoft speech.');
        child.kill();
      }, 30000);
      this.cancelSynthesis = () => {
        error = new Error('Speech cancelled.');
        child.kill();
      };
      child.on('message', result => {
        success = result.ok;
        if (!result.ok) error = new Error(result.error);
      });
      child.once('error', e => { error = e; });
      child.once('close', code => {
        clearTimeout(timer);
        this.cancelSynthesis = null;
        if (error) reject(error);
        else if (!success || code) reject(new Error(`TTS worker failed: ${stderr || code}`));
        else resolve();
      });
      child.send({ text: item.text, voice: item.voice, rate: item.rate, file }, e => {
        if (e) { error = e; child.kill(); }
      });
    });
  }
  async pump() {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      while (this.queue.length && !this.closed) {
        const item = this.queue.shift();
        this.current = item;
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'yapbot-'));
        try {
          const file = path.join(folder, 'speech.mp3');
          await this.synthesize(item, file);
          if (this.closed || item.cancelled) continue;
          if (this.guild.members.cache.get(item.userId)?.voice.channelId !== this.channelId) continue;
          await entersState(this.connection, VCS.Ready, 15000);
          if (this.closed || item.cancelled) continue;
          if (!fs.existsSync(file) || fs.statSync(file).size < 100) throw new Error('TTS returned no audio.');
          await this.play(file);
        } catch (e) {
          console.error('[SPEECH]', e.message);
          if (!this.closed && !item.cancelled)
            await notify(this.textChannel, 'Speech failed. Check the [SPEECH] error in the terminal.');
        } finally {
          fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          this.current = null;
          this.last = Date.now();
        }
      }
    } finally { this.running = false; }
  }
}

function enqueue(member, raw) {
  const s = getSession(member);
  const text = clean(raw);
  const key = `${member.guild.id}:${member.id}`;
  validateQueue(s, member.id, text, cooldowns.get(key));
  const p = profile(member.id);
  s.queue.push({ userId: member.id, text, voice: p.voice, rate: p.rate, cancelled: false });
  const position = s.queue.length;
  cooldowns.set(key, Date.now());
  s.last = Date.now();
  s.pump().catch(e => console.error('[QUEUE]', e.message));
  return position;
}

async function handle(i) {
  const name = i.commandName;
  if (name === 'help') return reply(i, '**YapBot**\n/come — join your VC; enable =messages here\n/say — read text\n/voice and /speed — your saved voice settings\n/queue — waiting count\n/skip — skip your speech\n/stop, /volume, /leave — session owner or Manage Server\n/diagnose — fresh bot permissions and voice status');
  const member = await i.guild.members.fetch({ user: i.user.id, force: true });
  if (name === 'come' || name === 'diagnose') {
    const info = await voiceInfo(i.guild, i.user.id);
    const report = diagnostic(info);
    console.log(`[DIAGNOSE]\n${report}`);
    if (name === 'diagnose') return reply(i, `\`\`\`\n${report.slice(0, 1800)}\n\`\`\``);
    if (joining.has(i.guildId)) throw new Error('A voice connection is already being opened. Try again shortly.');
    joining.add(i.guildId);
    let connection;
    try {
      const previous = sessions.get(i.guildId);
      if (previous) { owner(member, previous); previous.close('A new voice session replaced the previous session.'); }
      connection = joinVoiceChannel({ channelId: info.channel.id, guildId: i.guildId,
        adapterCreator: i.guild.voiceAdapterCreator, selfDeaf: true, selfMute: false });
      connection.on('error', e => console.error('[JOIN]', e.message));
      await entersState(connection, VCS.Ready, 30000);
      const s = new Session(i.guild, info.channel, i.channel, i.user.id, connection);
      sessions.set(i.guildId, s);
      const warning = info.missing.length ? `\nDiscord reports these permissions missing: ${info.missing.join(', ')}. Fix them on the bot's channel permissions if audio fails.` : '';
      const muted = info.me.voice.serverMute ? '\nThe bot is server-muted. A moderator must unmute it.' : '';
      return reply(i, `Joined **${info.channel.name}**. Use /say or type \`=hello\` here.${warning}${muted}`);
    } catch (e) {
      if (connection && connection.state.status !== VCS.Destroyed) connection.destroy();
      if (sessions.get(i.guildId)?.connection === connection) sessions.get(i.guildId).close();
      console.error('[COME]', e.message);
      if (e.message.startsWith('Only the person')) throw e;
      const explanation = info.missing.length
        ? `Discord's effective permissions for **the bot** are missing: **${info.missing.join(', ')}**. Open ${info.channel.name} → Edit Channel → Permissions → add the bot member and allow those permissions.`
        : 'The bot has View Channel, Connect, and Speak. The connection failed for another reason. Check the [JOIN] log, UDP/firewall access, whether the channel is full, and run /diagnose.';
      throw new Error(`${explanation}\nConnection error: ${e.message.slice(0, 250)}`);
    } finally { joining.delete(i.guildId); }
  }
  if (name === 'voice') {
    const selected = voices.find(v => v.id === i.options.getString('name', true));
    if (!selected) throw new Error('That voice is no longer listed. Pick one from /voice again.');
    profile(member.id).voice = selected.id; save();
    return reply(i, `Your voice: **${selected.name}**\nGender: ${selected.gender}\nAccent: ${selected.accent}\nLanguage: ${selected.language}\nTry /say with a short sentence to hear it.${selected.accent === 'British' ? '\nFor a slightly more measured pace, try /speed percent:-10.' : ''}`);
  }
  if (name === 'speed') {
    profile(member.id).rate = i.options.getInteger('percent', true); save();
    return reply(i, `Your speed is now ${profile(member.id).rate}%.`);
  }
  if (name === 'say') {
    const text = i.options.getString('message', true);
    const position = enqueue(member, text);
    await auditLog({
      guild: i.guild,
      title: `🗣️ ${member.displayName} said`,
      description: text,
      color: 0x3498DB,
      fields: [{ name: 'From', value: '/say', inline: true }],
    });
    return reply(i, `Queued. Position: ${position}.`);
  }
  const s = getSession(member);
  if (name === 'queue') return reply(i, `Waiting: ${s.queue.length}/20. Active speech: ${s.current ? 'yes' : 'no'}.`);
  if (name === 'skip') {
    if (!s.current) throw new Error('Nothing is playing.');
    if (s.current.userId !== member.id) owner(member, s);
    s.skip(); return reply(i, 'Skipped. If still generating, that speech will be discarded.');
  }
  owner(member, s);
  if (name === 'stop') { s.queue = []; s.skip(); return reply(i, 'Stopped and cleared the queue.'); }
  if (name === 'leave') { s.close(`Disconnected by ${formatUser(i.user)} using /leave.`); return reply(i, 'Disconnected.'); }
  if (name === 'volume') {
    s.volume = i.options.getInteger('percent', true) / 100;
    s.resource?.volume?.setVolume(s.volume);
    return reply(i, `Volume: ${Math.round(s.volume * 100)}%.`);
  }
}
client.on(Events.InteractionCreate, async i => {
  if (!i.isChatInputCommand() || !i.inGuild()) return;
  try {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    await handle(i);
  } catch (e) {
    console.error('[COMMAND]', e.message);
    await reply(i, e.message.slice(0, 1900)).catch(err => console.error('[REPLY]', err.message));
  }
});
client.on(Events.MessageCreate, async m => {
  if (m.author.bot || !m.guild || !m.content.startsWith('=')) return;
  const s = sessions.get(m.guildId);
  if (!s || m.channelId !== s.textChannel.id) return;
  const text = m.content.slice(1).trim();
  try {
    enqueue(m.member || await m.guild.members.fetch(m.author.id), text);
    await auditLog({
      guild: m.guild,
      title: `🗣️ ${m.member?.displayName || m.author.username} said`,
      description: text || '(empty message)',
      color: 0x3498DB,
      fields: [{ name: 'From', value: channelField(m.channel), inline: true }],
    });
  }
  catch (e) {
    await notify(m.channel, e.message);
  }
});
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const guild = newState.guild;
  const user = newState.member?.user || oldState.member?.user;
  const session = sessions.get(guild.id);
  if (session && user?.id === DELAYED_LEAVE_USER_ID) {
    if (oldState.channelId === session.channelId && newState.channelId !== session.channelId)
      session.startTargetLeaveCountdown(user);
    else if (newState.channelId === session.channelId)
      session.cancelTargetLeaveCountdown(user);
  }
});
client.once(Events.ClientReady, async c => {
  console.log(`[READY] ${c.user.tag}\n${generateDependencyReport()}`);
  try {
    const gid = process.env.GUILD_ID;
    if (!/^\d{17,20}$/.test(gid || '')) throw new Error('Set GUILD_ID to your server ID in .env.');
    const guild = await c.guilds.fetch(gid);
    const logChannel = await c.channels.fetch(LOG_CHANNEL_ID, { force: true });
    if (!logChannel?.isTextBased() || !logChannel.guild)
      throw new Error(`Audit channel ${LOG_CHANNEL_ID} is unavailable or is not a guild text channel.`);
    const logBotMember = await logChannel.guild.members.fetchMe({ force: true });
    const logPermissions = logChannel.permissionsFor(logBotMember);
    const missingLogPermissions = ['ViewChannel', 'SendMessages', 'EmbedLinks']
      .filter(name => !logPermissions?.has(P[name]));
    if (missingLogPermissions.length)
      throw new Error(`The bot needs ${missingLogPermissions.join(', ')} in audit channel ${LOG_CHANNEL_ID}.`);
    await guild.commands.set(commands.map(cmd => cmd.toJSON()));
    console.log(`[COMMANDS] Registered. Speech logs go to ${LOG_CHANNEL_ID}. Join VC and use /come.`);
  } catch (e) { console.error('[SETUP]', e.message); process.exitCode = 1; await client.destroy(); }
});
setInterval(() => {
  for (const s of sessions.values()) {
    const channel = s.guild.channels.cache.get(s.channelId);
    const alone = !channel || !channel.members.some(m => !m.user.bot);
    if (alone && !s.targetLeaveTimer) s.close('Everyone left the voice channel.');
    else if (!s.current && !s.queue.length && Date.now() - s.last > 300000)
      s.close('The voice session was idle for 5 minutes.');
  }
  for (const [key, time] of cooldowns) if (Date.now() - time > 60000) cooldowns.delete(key);
}, 15000).unref();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  for (const s of sessions.values()) s.close();
  client.destroy();
  process.exit(0);
});
if (require.main === module) {
if (!process.env.DISCORD_TOKEN || process.env.DISCORD_TOKEN === 'YOUR_BOT_TOKEN') {
  console.error('Copy .env.example to .env and set DISCORD_TOKEN and GUILD_ID.');
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN).catch(e => {
  console.error('[LOGIN]', e.message, '\nFor Disallowed Intents, enable Message Content Intent in the Developer Portal.');
  process.exit(1);
});
}
module.exports = { Session, commands, client, diagnostic, buildAuditEmbed, LEAVE_GRACE_MS };
