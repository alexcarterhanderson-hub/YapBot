const required = ['ViewChannel', 'Connect', 'Speak'];

function clean(text) {
  return text.replace(/https?:\/\/\S+/gi, ' link ')
    .replace(/<a?:(\w+):\d+>/g, '$1')
    .replace(/<[@#][!&]?\d+>/g, ' mention ')
    .replace(/@everyone|@here/g, 'everyone')
    .replace(/\s+/g, ' ').trim();
}

function missingPermissions(permissions, flags) {
  return required.filter(name => !permissions?.has(flags[name]));
}

function validateQueue(session, userId, text, last = 0, now = Date.now()) {
  if (!text || text.length > 500) throw new Error('Use 1–500 characters.');
  if (now - last < 3000) throw new Error('Wait 3 seconds between messages.');
  if (session.queue.length >= 20) throw new Error('The queue is full. Try again shortly.');
  if (session.queue.filter(item => item.userId === userId).length >= 3)
    throw new Error('You already have 3 messages waiting.');
}

module.exports = { clean, missingPermissions, validateQueue };
