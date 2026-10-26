#!/usr/bin/env node
// Stand-in for the vercel CLI: records every call and writes .vercel/ like `vercel link`.
'use strict';
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CLI_LOG || '/dev/null', `vercel ${a.join(' ')}\n`);
if (a[0] === 'whoami') { console.log('neil'); process.exit(0); }
if (a[0] === 'link') { fs.mkdirSync('.vercel', { recursive: true }); fs.writeFileSync('.vercel/project.json', '{"projectId":"prj_fake"}'); process.exit(0); }
if (a[0] === 'git' && a[1] === 'connect') process.exit(0);
if (a[0] === 'env' && a[1] === 'add') process.exit(0);
console.error('fake vercel: unhandled ' + a.join(' ')); process.exit(2);
