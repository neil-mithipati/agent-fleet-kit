'use strict';
// Terminal output. Plain lines, one per event, role tags in brackets.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = s => c('2', s);
const bold = s => c('1', s);
const green = s => c('32', s);
const yellow = s => c('33', s);
const red = s => c('31', s);
const cyan = s => c('36', s);

function stamp() {
  const d = new Date();
  return dim(d.toTimeString().slice(0, 8));
}
function line(tag, msg) { process.stdout.write(`${stamp()} ${tag} ${msg}\n`); }

module.exports = {
  info: (m) => line(dim('·'), m),
  ok: (m) => line(green('✓'), m),
  warn: (m) => line(yellow('!'), m),
  err: (m) => line(red('✗'), m),
  agent: (role, m) => line(cyan(`[${role}]`), m),
  task: (id, m) => line(bold(id), m),
  raw: (m) => process.stdout.write(m + '\n'),
  dim, bold, green, yellow, red, cyan,
};
