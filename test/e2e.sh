#!/usr/bin/env bash
# End-to-end test of the fleet against the fake claude. No API calls, no cost.
set -euo pipefail
KIT="$(cd "$(dirname "$0")/.." && pwd)"
FLEET="$KIT/bin/fleet"
SCEN="${1:-gatefail}"
TMP="$(mktemp -d)"
APP="$TMP/app"
export FLEET_FAKE_SCENARIO="$SCEN" FLEET_FAKE_DELAY_MS=100 NO_COLOR=1
echo "== scenario: $SCEN  dir: $APP"
"$FLEET" init "$APP" --name fakeapp >/dev/null
node -e "
const f='$APP/.fleet/config.json'; const c=JSON.parse(require('fs').readFileSync(f));
c.claude_bin='$KIT/test/fake-claude.js'; c.dashboard.auto_start=false; c.worktree_root='$TMP/wt';
require('fs').writeFileSync(f, JSON.stringify(c,null,2));"
git init -q --bare -b main "$TMP/remote.git"; git -C "$APP" remote add origin "$TMP/remote.git"
export FAKE_CLI_LOG="$TMP/cli.log"; : > "$FAKE_CLI_LOG"
if [ "$SCEN" = "dbpush" ]; then
  node -e "
const f='$APP/.fleet/config.json'; const c=JSON.parse(require('fs').readFileSync(f));
c.connect.supabase_bin='$KIT/test/fake-supabase.js'; c.connect.vercel_bin='$KIT/test/fake-vercel.js';
require('fs').writeFileSync(f, JSON.stringify(c,null,2));"
  git -C "$APP" add -A; git -C "$APP" -c user.name=t -c user.email=t@x commit -qm "use fake clis"
  echo "== fleet connect"; (cd "$APP" && "$FLEET" connect)
  echo "== assert: connect"
  (cd "$APP" && node -e "
const fs=require('fs'),cp=require('child_process');
const fail=m=>{console.error('connect: '+m);process.exit(1);};
const env=fs.readFileSync('.env.local','utf8'); const log=fs.readFileSync(process.env.FAKE_CLI_LOG,'utf8');
if(!/VITE_SUPABASE_URL=https:\/\/abcdefghijklmnopqrst\.supabase\.co/.test(env))fail('url');
if(!/VITE_SUPABASE_ANON_KEY=sb_publishable_fake/.test(env))fail('publishable key');
if(/SERVICE-ROLE/.test(env))fail('service role key leaked into .env.local');
if(!/SUPABASE_DB_PASSWORD=\S{20,}/.test(env))fail('db password');
if((fs.statSync('.env.local').mode&0o077)!==0)fail('.env.local readable by others');
if(cp.execSync('git ls-files').toString().match(/\.env|\.vercel|supabase\/\.temp/))fail('secret or link file tracked by git');
if(!cp.execSync('git ls-files supabase').toString().includes('supabase/config.toml'))fail('supabase/ not committed');
if(JSON.parse(fs.readFileSync('.fleet/config.json')).supabase.project_ref!=='abcdefghijklmnopqrst')fail('ref not saved');
if(!/vercel git connect --yes/.test(log))fail('git connect');
if((log.match(/vercel env add/g)||[]).length!==6)fail('expected 6 env adds');
if(/db push/.test(log))fail('no migrations yet, should not db push');
console.log('connect ok');")
fi
if [ -n "${DIVERGE:-}" ]; then git -C "$APP" push -q -u origin main; git clone -q "$TMP/remote.git" "$TMP/other"; echo teammate > "$TMP/other/TEAM.md"; git -C "$TMP/other" add -A; git -C "$TMP/other" -c user.name=t -c user.email=t@x commit -qm "teammate commit"; git -C "$TMP/other" push -q; fi
cd "$APP"
if [ -n "${REQ:-}" ]; then echo "{\"name\":\"x\",\"version\":\"0.0.1\"}" > package.json; git add -A; git -c user.name=t -c user.email=t@x commit -qm "seed"; fi
"$FLEET" do "${REQ:-build a tiny add library app}"
echo "== status"; "$FLEET" status --all
echo "== git log"; git log --oneline --graph | head -30
echo "== tags"; git tag
echo "== worktrees"; git worktree list
echo "== remote"; git -C "$TMP/remote.git" log --oneline -3 main; git -C "$TMP/remote.git" tag
echo "== changelog"; sed -n '1,60p' CHANGELOG.md
if [ "$SCEN" = "blocked" ]; then
  echo "== retry blocked task"
  ID=$("$FLEET" status | awk '/needs_human/{print $1; exit}')
  "$FLEET" retry "$ID" "make it print the word resolved"
  "$FLEET" do
  "$FLEET" status --all
fi
if [ "$SCEN" = "dbpush" ]; then
  echo "== assert: merged migration was pushed exactly once, with the password"
  grep "db push" "$FAKE_CLI_LOG"
  [ "$(grep -c 'supabase db push --linked --yes \[pw\]' "$FAKE_CLI_LOG")" = "1" ] || { echo "expected exactly one db push"; exit 1; }
  if [ -n "${FAKE_DB_PUSH_FAIL:-}" ]; then grep -q "supabase db push failed" CHANGELOG.md || { echo "failed db push missing from CHANGELOG"; exit 1; }; fi
fi
if [ "$SCEN" = "reviewstuck" ]; then
  echo "== assert: out of review rounds stops without another build"
  node -e "
const fs=require('fs'),path=require('path');const d='.fleet/state';
const t=fs.readdirSync(d+'/tasks').map(f=>JSON.parse(fs.readFileSync(d+'/tasks/'+f))).find(t=>/README/.test(t.title));
const runs=[];(function walk(p){for(const f of fs.readdirSync(p)){const q=path.join(p,f);fs.statSync(q).isDirectory()?walk(q):runs.push(f);}})(d+'/runs');
const builds=runs.filter(f=>f.startsWith(t.id+'-')&&/-builder[^/]*\\.log$/.test(f));
console.log(t.id,t.state,'builds:',builds.join(' '));
if(t.state!=='needs_human'){console.error('expected needs_human');process.exit(1);}
if(builds.length!==2){console.error('expected exactly 2 builds, got '+builds.length);process.exit(1);}"
fi
if [ "$SCEN" = "lintfix" ]; then
  echo "== assert: lint failure is fixed by the fix tier, then merged, no escalation"
  node -e "
const fs=require('fs'),path=require('path');const d='.fleet/state';
const t=fs.readdirSync(d+'/tasks').map(f=>JSON.parse(fs.readFileSync(d+'/tasks/'+f))).find(t=>/scaffold/.test(t.title));
const runs=[];(function walk(p){for(const f of fs.readdirSync(p)){const q=path.join(p,f);fs.statSync(q).isDirectory()?walk(q):runs.push(f);}})(d+'/runs');
const builds=runs.filter(f=>f.startsWith(t.id+'-')&&/-builder[^/]*\\.log$/.test(f)).sort();
console.log(t.id,t.state,'escalations:',t.escalations||0,'builds:',builds.join(' '));
const want=[t.id+'-1-builder-deep.log',t.id+'-2-builder-light.log'];
if(t.state!=='merged'){console.error('expected merged');process.exit(1);}
if(JSON.stringify(builds)!==JSON.stringify(want)){console.error('expected '+want.join(' '));process.exit(1);}
if(t.escalations){console.error('expected no escalation');process.exit(1);}"
fi
echo "== OK ($APP)"
