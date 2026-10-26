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
echo "== OK ($APP)"
