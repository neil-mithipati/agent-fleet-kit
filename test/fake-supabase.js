#!/usr/bin/env node
// Stand-in for the supabase CLI: records every call, mimics the files the real
// CLI writes, and requires SUPABASE_DB_PASSWORD where the real one would prompt.
'use strict';
const fs = require('fs');
const path = require('path');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CLI_LOG || '/dev/null', `supabase ${a.join(' ')}${process.env.SUPABASE_DB_PASSWORD ? ' [pw]' : ''}\n`);
const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(0); };
const needPw = () => { if (!process.env.SUPABASE_DB_PASSWORD) { console.error('password required'); process.exit(1); } };
const cmd = a.slice(0, 2).join(' ');
if (cmd === 'projects list') out([]);
if (a[0] === 'init') { fs.mkdirSync('supabase', { recursive: true }); fs.writeFileSync('supabase/config.toml', 'project_id = "app"\n'); fs.writeFileSync('supabase/.gitignore', '.branches\n.temp\n'); process.exit(0); }
if (cmd === 'orgs list') out([{ id: 'org_fake', name: 'neil' }]);
if (cmd === 'projects create') out({ id: 'abcdefghijklmnopqrst', name: a[2], region: 'us-east-1' });
if (a[0] === 'link') { needPw(); fs.mkdirSync('supabase/.temp', { recursive: true }); fs.writeFileSync('supabase/.temp/project-ref', a[a.indexOf('--project-ref') + 1]); process.exit(0); }
if (cmd === 'projects api-keys') out([{ name: 'anon', api_key: 'eyJ-anon' }, { name: 'service_role', api_key: 'eyJ-SERVICE-ROLE-SECRET' }, { name: 'default', type: 'publishable', api_key: 'sb_publishable_fake' }]);
if (cmd === 'db push') { needPw(); process.exit(process.env.FAKE_DB_PUSH_FAIL ? 1 : 0); }
console.error('fake supabase: unhandled ' + a.join(' ')); process.exit(2);
