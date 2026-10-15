const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clean, missingPermissions, validateQueue } = require('./core');

test('reports only the missing permission, rather than all three', () => {
  const flags = { ViewChannel: 1n, Connect: 2n, Speak: 4n };
  assert.deepEqual(missingPermissions({ has: flag => flag !== 4n }, flags), ['Speak']);
  assert.deepEqual(missingPermissions({ has: () => true }, flags), []);
  assert.deepEqual(missingPermissions(null, flags), ['ViewChannel', 'Connect', 'Speak']);
});
test('cleans links, raw mentions and custom emoji before speech', () => {
  assert.equal(clean('Hi <@123> https://example.com <:wave:456>'), 'Hi mention link wave');
});
test('queue limits isolate users and reject spam', () => {
  assert.throws(() => validateQueue({ queue: [] }, 'a', 'hello', 9000, 10000), /3 seconds/);
  assert.throws(() => validateQueue({ queue: Array(20).fill({ userId: 'b' }) }, 'a', 'hello'), /full/);
  assert.throws(() => validateQueue({ queue: Array(3).fill({ userId: 'a' }) }, 'a', 'hello'), /3 messages/);
  assert.doesNotThrow(() => validateQueue({ queue: Array(3).fill({ userId: 'b' }) }, 'a', 'hello'));
  assert.throws(() => validateQueue({ queue: [] }, 'a', 'x'.repeat(501)), /500/);
});

test('real Discord permission bitfields handle administrator and a single denied flag', () => {
  const { PermissionsBitField, PermissionFlagsBits: P } = require('discord.js');
  assert.deepEqual(missingPermissions(new PermissionsBitField(P.Administrator), P), []);
  assert.deepEqual(missingPermissions(new PermissionsBitField(P.ViewChannel | P.Connect), P), ['Speak']);
});

test('all slash commands serialize and audio pipeline produces Opus packets', async () => {
  const { commands, client, buildAuditEmbed, LEAVE_GRACE_MS } = require('./bot');
  const { Readable } = require('node:stream');
  const { createAudioResource, StreamType } = require('@discordjs/voice');
  const names = commands.map(c => c.toJSON().name);
  assert.equal(new Set(names).size, 11);
  assert.ok(names.includes('diagnose'));
  assert.equal(LEAVE_GRACE_MS, 180000);
  const audit = buildAuditEmbed({
    title: '📝 Message sent',
    fields: [{ name: 'Message', value: 'the exact message text' }],
  }).toJSON();
  assert.equal(audit.fields[0].value, 'the exact message text');
  assert.ok(audit.timestamp);
  const fullMessage = 'm'.repeat(2000);
  const messageAudit = buildAuditEmbed({
    title: '📝 Message sent',
    description: fullMessage,
  }).toJSON();
  assert.equal(messageAudit.description, fullMessage);
  const voice = JSON.parse(JSON.stringify(commands.find(c => c.name === 'voice').toJSON()));
  assert.deepEqual(voice.options[0].choices[0], {
    name: 'Ryan | Male | British | English', value: 'en-GB-RyanNeural',
  });
  assert.deepEqual(voice.options[0].choices[1], {
    name: 'Sonia | Female | British | English', value: 'en-GB-SoniaNeural',
  });
  for (const choice of voice.options[0].choices) {
    assert.equal(choice.name.split(' | ').length, 4);
    assert.ok(choice.name.length <= 100);
  }
  const resource = createAudioResource(Readable.from([Buffer.alloc(19200)]), {
    inputType: StreamType.Raw, inlineVolume: true,
  });
  let count = 0;
  for await (const packet of resource.playStream) if (packet.length) count++;
  assert.ok(count > 0);
  await client.destroy();
});
