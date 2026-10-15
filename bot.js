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
    GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration,
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
      name: 'YapBot  •  Security & Activity Log',
      ...(client.user && { iconURL: client.user.displayAvatarURL() }),
    })
    .setTitle(truncate(title, 256))
    .setTimestamp()
    .setFooter({ text: `YapBot Audit  •  ${guild?.name || 'Discord'}` });
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
function commandOptions(options) {
  const values = [];
  const visit = entries => {
    for (const entry of entries || []) {
      if (entry.options?.length) visit(entry.options);
      else if (entry.value !== undefined) values.push(`${entry.name}: ${entry.value}`);
    }
  };
  visit(options);
  return values.join('\n') || 'No options';
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
      auditLog({
        guild: this.guild,
        title: '⚠️ Audio player error',
        description: e.message,
        color: 0xED4245,
        fields: [{ name: 'Voice channel', value: `<#${this.channelId}>` }],
      });
    });
    this.subscription = connection.subscribe(this.player);
    connection.on('error', e => {
      console.error('[VOICE]', e.message);
      auditLog({
        guild: this.guild,
        title: '⚠️ Voice connection error',
        description: e.message,
        color: 0xED4245,
        fields: [{ name: 'Voice channel', value: `<#${this.channelId}>` }],
      });
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
    auditLog({
      guild: this.guild,
      title: '⏳ Scheduled voice departure',
      description: `${formatUser(user)} left the bot’s voice channel. The bot will leave in 3 minutes unless they rejoin.`,
      color: 0xF1C40F,
      fields: [
        { name: 'Voice channel', value: `<#${this.channelId}>`, inline: true },
        { name: 'Grace period', value: '3 minutes', inline: true },
        { name: 'Scheduled action', value: 'Disconnect from voice if the user has not returned.' },
      ],
    });
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
    auditLog({
      guild: this.guild,
      title: '✅ Scheduled departure cancelled',
      description: `${formatUser(user)} rejoined the bot’s voice channel before the 3-minute grace period expired.`,
      color: 0x57F287,
      fields: [{ name: 'Voice channel', value: `<#${this.channelId}>` }],
    });
  }
  close(reason = 'Voice connection closed.') {
    if (this.closed) return;
    this.closed = true;
    if (this.targetLeaveTimer) clearTimeout(this.targetLeaveTimer);
    this.targetLeaveTimer = null;
    this.queue = [];
    this.skip();
    this.subscription?.unsubscribe();
    if (this.connection.state.status !== VCS.Destroyed) this.connection.destroy();
    if (sessions.get(this.guild.id) === this) sessions.delete(this.guild.id);
    auditLog({
      guild: this.guild,
      title: '🔌 Bot left voice',
      description: reason,
      color: 0xED4245,
      fields: [{ name: 'Voice channel', value: `<#${this.channelId}>` }],
    });
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
          auditLog({
            guild: this.guild,
            title: '⚠️ Speech request failed',
            description: e.message,
            color: 0xED4245,
            fields: [
              { name: 'Requested by', value: formatUser(this.guild.members.cache.get(item.userId)?.user) },
              { name: 'Voice channel', value: `<#${this.channelId}>` },
            ],
          });
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
      auditLog({
        guild: i.guild,
        title: '🔊 Bot joined voice',
        description: `${formatUser(i.user)} started a voice session.`,
        color: 0x57F287,
        fields: [
          { name: 'Voice channel', value: channelField(info.channel), inline: true },
          { name: 'Text channel', value: channelField(i.channel), inline: true },
        ],
      });
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
  if (name === 'say') return reply(i, `Queued. Position: ${enqueue(member, i.options.getString('message', true))}.`);
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
    await auditLog({
      guild: i.guild,
      title: '⚡ Slash command completed',
      description: `/${i.commandName} completed successfully.`,
      color: 0x5865F2,
      fields: [
        { name: 'User', value: formatUser(i.user), inline: true },
        { name: 'Command', value: `/${i.commandName}`, inline: true },
        { name: 'Options', value: commandOptions(i.options.data) },
        { name: 'Used in', value: channelField(i.channel) },
        ...(i.member?.voice?.channel ? [{ name: 'Voice channel', value: channelField(i.member.voice.channel) }] : []),
      ],
    });
  } catch (e) {
    console.error('[COMMAND]', e.message);
    await auditLog({
      guild: i.guild,
      title: '⚠️ Slash command failed',
      description: `/${i.commandName} failed: ${e.message}`,
      color: 0xED4245,
      fields: [
        { name: 'User', value: formatUser(i.user), inline: true },
        { name: 'Command', value: `/${i.commandName}`, inline: true },
        { name: 'Options', value: commandOptions(i.options.data) },
        { name: 'Used in', value: channelField(i.channel) },
      ],
    });
    await reply(i, e.message.slice(0, 1900)).catch(err => console.error('[REPLY]', err.message));
  }
});
client.on(Events.MessageCreate, async m => {
  if (!m.guild || m.channelId === LOG_CHANNEL_ID) return;
  void auditLog({
    guild: m.guild,
    title: '📝 Message sent',
    description: m.content || '(no text content)',
    color: 0x3498DB,
    fields: [
      { name: 'Author', value: formatUser(m.author), inline: true },
      { name: 'Channel', value: channelField(m.channel), inline: true },
      ...(m.attachments.size ? [{
        name: `Attachments (${m.attachments.size})`,
        value: [...m.attachments.values()].map(a => `${a.name || 'file'} — ${a.url}`).join('\n'),
      }] : []),
      { name: 'Message ID', value: m.id, inline: true },
    ],
  });
  if (m.author.bot || !m.content.startsWith('=')) return;
  const s = sessions.get(m.guildId);
  if (!s || m.channelId !== s.textChannel.id) return;
  try { enqueue(m.member || await m.guild.members.fetch(m.author.id), m.cleanContent.slice(1)); }
  catch (e) {
    await auditLog({
      guild: m.guild,
      title: '⚠️ Prefix command rejected',
      description: e.message,
      color: 0xED4245,
      fields: [
        { name: 'User', value: formatUser(m.author), inline: true },
        { name: 'Channel', value: channelField(m.channel), inline: true },
        { name: 'Message', value: m.content },
      ],
    });
    await notify(m.channel, e.message);
  }
});
client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  if (!newMessage.guild || newMessage.channelId === LOG_CHANNEL_ID) return;
  let before = oldMessage;
  let after = newMessage;
  try {
    if (before.partial) before = await before.fetch();
    if (after.partial) after = await after.fetch();
  } catch (e) {
    console.error('[AUDIT] Could not fetch an edited message:', e.message);
  }
  const beforeAttachments = [...(before.attachments?.values() || [])].map(a => a.url).join('\n');
  const afterAttachments = [...(after.attachments?.values() || [])].map(a => a.url).join('\n');
  if (before.content === after.content && beforeAttachments === afterAttachments) return;
  await auditLog({
    guild: newMessage.guild,
    title: '✏️ Message edited',
    description: `**Before**\n${before.content || '(no text content)'}\n\n**After**\n${after.content || '(no text content)'}`,
    color: 0xF1C40F,
    fields: [
      { name: 'Author', value: formatUser(after.author), inline: true },
      { name: 'Channel', value: channelField(after.channel), inline: true },
      ...(before.attachments?.size ? [{
        name: 'Attachments before',
        value: [...before.attachments.values()].map(a => `${a.name || 'file'} — ${a.url}`).join('\n'),
      }] : []),
      ...(after.attachments?.size ? [{
        name: 'Attachments after',
        value: [...after.attachments.values()].map(a => `${a.name || 'file'} — ${a.url}`).join('\n'),
      }] : []),
      { name: 'Message', value: `[Open message](https://discord.com/channels/${newMessage.guildId}/${newMessage.channelId}/${newMessage.id})` },
    ],
  });
});
client.on(Events.MessageDelete, async message => {
  if (!message.guild || message.channelId === LOG_CHANNEL_ID) return;
  let deleted = message;
  try { if (deleted.partial) deleted = await deleted.fetch(); }
  catch (e) { console.error('[AUDIT] Deleted message content was unavailable:', e.message); }
  await auditLog({
    guild: message.guild,
    title: '🗑️ Message deleted',
    description: deleted.content || '(content unavailable or no text content)',
    color: 0xED4245,
    fields: [
      { name: 'Author', value: formatUser(deleted.author), inline: true },
      { name: 'Channel', value: channelField(message.channel), inline: true },
      ...(deleted.attachments?.size ? [{
        name: `Deleted attachments (${deleted.attachments.size})`,
        value: [...deleted.attachments.values()].map(a => `${a.name || 'file'} — ${a.url}`).join('\n'),
      }] : []),
      { name: 'Message ID', value: message.id, inline: true },
    ],
  });
});
client.on(Events.MessageBulkDelete, async messages => {
  const first = messages.first();
  if (!first?.guild || first.channelId === LOG_CHANNEL_ID) return;
  await auditLog({
    guild: first.guild,
    title: '🧹 Bulk message deletion',
    color: 0xED4245,
    fields: [
      { name: 'Channel', value: channelField(first.channel), inline: true },
      { name: 'Messages deleted', value: String(messages.size), inline: true },
      { name: 'Cached message IDs', value: [...messages.keys()].slice(0, 40).join(', ') || 'Unavailable' },
    ],
  });
});
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = newState.guild;
  const user = newState.member?.user || oldState.member?.user;
  const session = sessions.get(guild.id);
  if (session && user?.id === DELAYED_LEAVE_USER_ID) {
    if (oldState.channelId === session.channelId && newState.channelId !== session.channelId)
      session.startTargetLeaveCountdown(user);
    else if (newState.channelId === session.channelId)
      session.cancelTargetLeaveCountdown(user);
  }
  const changes = [];
  if (oldState.channelId !== newState.channelId) {
    changes.push(`Channel: ${oldState.channel ? channelField(oldState.channel) : 'not in voice'} → ${newState.channel ? channelField(newState.channel) : 'not in voice'}`);
  }
  if (oldState.serverMute !== newState.serverMute) changes.push(`Server mute: ${oldState.serverMute ? 'on' : 'off'} → ${newState.serverMute ? 'on' : 'off'}`);
  if (oldState.serverDeaf !== newState.serverDeaf) changes.push(`Server deaf: ${oldState.serverDeaf ? 'on' : 'off'} → ${newState.serverDeaf ? 'on' : 'off'}`);
  if (oldState.selfMute !== newState.selfMute) changes.push(`Self mute: ${oldState.selfMute ? 'on' : 'off'} → ${newState.selfMute ? 'on' : 'off'}`);
  if (oldState.selfDeaf !== newState.selfDeaf) changes.push(`Self deaf: ${oldState.selfDeaf ? 'on' : 'off'} → ${newState.selfDeaf ? 'on' : 'off'}`);
  if (oldState.streaming !== newState.streaming) changes.push(`Streaming: ${oldState.streaming ? 'on' : 'off'} → ${newState.streaming ? 'on' : 'off'}`);
  if (oldState.selfVideo !== newState.selfVideo) changes.push(`Camera: ${oldState.selfVideo ? 'on' : 'off'} → ${newState.selfVideo ? 'on' : 'off'}`);
  if (!changes.length) return;
  await auditLog({
    guild,
    title: '🎙️ Voice activity',
    color: 0x9B59B6,
    fields: [
      { name: 'User', value: formatUser(user), inline: true },
      { name: 'Changes', value: changes.join('\n') },
    ],
  });
});
client.on(Events.GuildMemberAdd, member => auditLog({
  guild: member.guild,
  title: '👋 Member joined',
  color: 0x57F287,
  fields: [
    { name: 'Member', value: formatUser(member.user), inline: true },
    { name: 'Account created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:F>`, inline: true },
  ],
}));
client.on(Events.GuildMemberRemove, member => auditLog({
  guild: member.guild,
  title: '🚪 Member left',
  color: 0xED4245,
  fields: [{ name: 'Member', value: formatUser(member.user) }],
}));
client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
  const changes = [];
  if (oldMember.nickname !== newMember.nickname)
    changes.push(`Nickname: ${oldMember.nickname || 'none'} → ${newMember.nickname || 'none'}`);
  const addedRoles = newMember.roles.cache.filter(role => !oldMember.roles.cache.has(role.id));
  const removedRoles = oldMember.roles.cache.filter(role => !newMember.roles.cache.has(role.id));
  if (addedRoles.size) changes.push(`Roles added: ${addedRoles.map(role => role.name).join(', ')}`);
  if (removedRoles.size) changes.push(`Roles removed: ${removedRoles.map(role => role.name).join(', ')}`);
  if (oldMember.communicationDisabledUntilTimestamp !== newMember.communicationDisabledUntilTimestamp)
    changes.push(`Timeout: ${oldMember.communicationDisabledUntil?.toISOString() || 'none'} → ${newMember.communicationDisabledUntil?.toISOString() || 'none'}`);
  if (!changes.length) return;
  return auditLog({
    guild: newMember.guild,
    title: '🛡️ Member updated',
    color: 0xE67E22,
    fields: [
      { name: 'Member', value: formatUser(newMember.user), inline: true },
      { name: 'Changes', value: changes.join('\n') },
    ],
  });
});
client.on(Events.GuildBanAdd, ban => auditLog({
  guild: ban.guild,
  title: '⛔ Member banned',
  color: 0xED4245,
  fields: [{ name: 'User', value: formatUser(ban.user), inline: true }],
}));
client.on(Events.GuildBanRemove, ban => auditLog({
  guild: ban.guild,
  title: '♻️ Member unbanned',
  color: 0x57F287,
  fields: [{ name: 'User', value: formatUser(ban.user), inline: true }],
}));
client.on(Events.ChannelCreate, channel => {
  if (channel.guild) return auditLog({
    guild: channel.guild,
    title: '📁 Channel created',
    color: 0x57F287,
    fields: [
      { name: 'Channel', value: channelField(channel), inline: true },
      { name: 'Type', value: String(channel.type), inline: true },
    ],
  });
});
client.on(Events.ChannelDelete, channel => {
  if (channel.guild) return auditLog({
    guild: channel.guild,
    title: '🗃️ Channel deleted',
    color: 0xED4245,
    fields: [
      { name: 'Channel', value: `${channel.name} (${channel.id})`, inline: true },
      { name: 'Type', value: String(channel.type), inline: true },
    ],
  });
});
client.on(Events.ChannelUpdate, (oldChannel, newChannel) => {
  if (!newChannel.guild) return;
  const changes = [];
  for (const key of ['name', 'topic', 'parentId', 'bitrate', 'userLimit', 'rateLimitPerUser', 'nsfw']) {
    if (oldChannel[key] !== newChannel[key])
      changes.push(`${key}: ${oldChannel[key] ?? 'none'} → ${newChannel[key] ?? 'none'}`);
  }
  if (changes.length) return auditLog({
    guild: newChannel.guild,
    title: '🛠️ Channel updated',
    color: 0xF1C40F,
    fields: [
      { name: 'Channel', value: channelField(newChannel), inline: true },
      { name: 'Changes', value: changes.join('\n') },
    ],
  });
});
client.on(Events.GuildRoleCreate, role => auditLog({
  guild: role.guild,
  title: '🪪 Role created',
  color: 0x57F287,
  fields: [{ name: 'Role', value: `${role.name} (${role.id})` }],
}));
client.on(Events.GuildRoleDelete, role => auditLog({
  guild: role.guild,
  title: '🪪 Role deleted',
  color: 0xED4245,
  fields: [{ name: 'Role', value: `${role.name} (${role.id})` }],
}));
client.on(Events.GuildRoleUpdate, (oldRole, newRole) => {
  const changes = [];
  for (const key of ['name', 'color', 'hoist', 'mentionable', 'position']) {
    if (oldRole[key] !== newRole[key])
      changes.push(`${key}: ${oldRole[key]} → ${newRole[key]}`);
  }
  if (changes.length) return auditLog({
    guild: newRole.guild,
    title: '🪪 Role updated',
    color: 0xF1C40F,
    fields: [
      { name: 'Role', value: `${newRole.name} (${newRole.id})`, inline: true },
      { name: 'Changes', value: changes.join('\n') },
    ],
  });
});
client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => auditLog({
  guild,
  title: '📋 Server audit action',
  color: 0xE67E22,
  fields: [
    { name: 'Action', value: String(entry.action), inline: true },
    { name: 'Executor', value: formatUser(entry.executor), inline: true },
    { name: 'Target', value: entry.target ? `${entry.target} (${entry.targetId})` : entry.targetId || 'Unknown target', inline: true },
    { name: 'Reason', value: entry.reason || 'No reason provided' },
    ...(entry.changes?.length ? [{
      name: 'Changes',
      value: JSON.stringify(entry.changes, (_, value) =>
        typeof value === 'bigint' ? value.toString() : value),
    }] : []),
  ],
}));
client.on(Events.Error, e => {
  console.error('[DISCORD]', e.message);
  auditLog({
    title: '⚠️ Discord client error',
    description: e.message,
    color: 0xED4245,
  });
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
    const missingLogPermissions = ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ViewAuditLog']
      .filter(name => !logPermissions?.has(P[name]));
    if (missingLogPermissions.length)
      throw new Error(`The bot needs ${missingLogPermissions.join(', ')} in audit channel ${LOG_CHANNEL_ID}.`);
    await guild.commands.set(commands.map(cmd => cmd.toJSON()));
    console.log(`[COMMANDS] Registered. Audit logs go to ${LOG_CHANNEL_ID}. Join VC and use /come.`);
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
