'use strict';
// Checks that a "small" task really was small, against the actual diff. A
// small task escapes review by construction, so the boundary is enforced by
// code, not by trust in the planner's label.
const path = require('path');

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
      else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(ch)) re += '\\' + ch;
    else re += ch;
  }
  return new RegExp('^' + re + '$', 'i');
}

function check(stat, smallCfg) {
  const reasons = [];
  if (stat.files.length > smallCfg.max_files) reasons.push(`${stat.files.length} files changed (small allows ${smallCfg.max_files})`);
  if (stat.lines > smallCfg.max_lines) reasons.push(`${stat.lines} lines changed (small allows ${smallCfg.max_lines})`);
  const patterns = (smallCfg.sensitive || []).map(globToRegex);
  const sensitive = stat.files.filter(f => patterns.some(re => re.test(f) || re.test(path.basename(f))));
  if (sensitive.length) reasons.push(`touches sensitive paths: ${sensitive.slice(0, 4).join(', ')}${sensitive.length > 4 ? '…' : ''}`);
  return { ok: reasons.length === 0, reasons };
}

module.exports = { check, globToRegex };
