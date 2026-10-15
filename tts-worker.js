const { EdgeTTS } = require('node-edge-tts');
process.once('message', async ({ text, voice, rate, file }) => {
  try {
    const tts = new EdgeTTS({ voice, lang: voice.split('-').slice(0, 2).join('-'),
      rate: `${rate >= 0 ? '+' : ''}${rate}%`, timeout: 20000 });
    await tts.ttsPromise(text, file);
    process.send({ ok: true }, () => process.exit(0));
  } catch (e) {
    process.send({ ok: false, error: String(e?.message || e) }, () => process.exit(1));
  }
});
