#!/bin/bash
# Unattended refresh: pull the liked playlist, resolve what's new, ship it.
#
# Run by launchd (see com.lykebrowsr.update.plist) — but it's an ordinary
# script, so `./update.sh` by hand does exactly the same thing.
#
# Only commits when the data actually changed, so quiet days leave no trace.
# Anything that fails raises a macOS notification rather than failing silently;
# the usual cause is YT_COOKIE expiring, which needs a fresh copy from Chrome.

set -uo pipefail
cd "$(dirname "$0")" || exit 1

export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
LOG="update.log"
STAMP=".last-refresh"
LOCK=".update.lock"

say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
notify() {
  /usr/bin/osascript -e "display notification \"$1\" with title \"lykebrowsr\"" 2>/dev/null || true
}
fail() {
  say "FAILED: $1"
  notify "Update failed — $1"
  exit 1
}

# Heartbeat: proves the updater RAN, which "extracted" can't — that only moves
# when the likes change, so a quiet week looked identical to a fortnight of
# failures. Written on every successful run, busy or quiet.
beat() {
  node -e '
    const fs = require("fs");
    const f = "data/refresh-heartbeat.json";
    const today = new Date().toISOString().slice(0, 10);
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    if (prev.lastRun !== today) fs.writeFileSync(f, JSON.stringify({ lastRun: today }));
  ' >> "$LOG" 2>&1
}

say "--- update starting ---"

# A big batch can take over an hour to resolve, which is longer than the gap
# between scheduled runs. Two passes resolving into the same files at once
# would interleave their writes, so a run that arrives early stands down.
if ! mkdir "$LOCK" 2>/dev/null; then
  HELD=$(cat "$LOCK/pid" 2>/dev/null)
  if [ -n "$HELD" ] && kill -0 "$HELD" 2>/dev/null; then
    say "a run (pid $HELD) is still going — standing down"
    exit 0
  fi
  say "clearing a stale lock left by pid ${HELD:-unknown}"
  rm -rf "$LOCK"
  mkdir "$LOCK" 2>/dev/null || { say "could not take the lock — standing down"; exit 0; }
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

# The job commits wherever HEAD happens to be but always pushes main. If the
# repo is left on a feature branch, the commit lands there, `git push main`
# reports "everything up-to-date" and the refresh silently never goes live.
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ "$BRANCH" != "main" ]; then
  fail "repo is on branch '$BRANCH', not main — refresh not published"
fi

# Keep the log from growing without bound.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 200000 ]; then
  tail -n 400 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

# Every scheduled run pulls the playlist — it's one cheap call, and it's the
# only way something liked at lunchtime reaches the site before tomorrow.
# What it costs to publish scales with what's new, not with how often we look:
# the resolve passes below are skipped entirely when nothing changed.
OUT=$(node extract-yt-likes.js 2>&1)
EXIT=$?
echo "$OUT" >> "$LOG"
# 75 = EX_TEMPFAIL: Chrome's cookies are too stale to use. Not a failure —
# just not now. Stay quiet and let the next run try.
if [ $EXIT -eq 75 ]; then
  say "postponed — Chrome's session is stale; will retry"
  exit 0
fi
if [ $EXIT -ne 0 ]; then
  case "$OUT" in
    *[Kk]eychain*) fail "grant keychain access: security find-generic-password -w -s \"Chrome Safe Storage\" -a Chrome" ;;
    *signed\ out*|*sign\ in*|*unauthenticated*|*revoked*) fail "sign in to YouTube Music in Chrome" ;;
    *) fail "extract failed — see update.log" ;;
  esac
fi

# Nothing new? Then there's nothing to resolve, commit or deploy.
if git diff --quiet -- data/liked-music.json; then
  date +%F > "$STAMP"
  beat
  if ! git diff --quiet -- data/refresh-heartbeat.json; then
    git add data/refresh-heartbeat.json
    git commit -q -m "Data: refresh heartbeat" >> "$LOG" 2>&1 && git push -q origin main >> "$LOG" 2>&1
  fi
  say "no change — done"
  exit 0
fi

ADDED=$(echo "$OUT" | grep -o '[0-9]* new' | head -1)

node resolve-liked.js >> "$LOG" 2>&1 || fail "resolve pass 1 failed"
node resolve-liked.js --genres >> "$LOG" 2>&1 || fail "genre backfill failed"
node resolve-liked.js --labels >> "$LOG" 2>&1 || fail "label pass failed"
# Decorative only — a failure here must not hold up the data.
node resolve-liked.js --covers >> "$LOG" 2>&1 || echo "cover pass failed (non-fatal)" >> "$LOG"

# Guard against shipping a truncated dataset: the count should never fall
# sharply, and the resolver should have kept its match rate up.
node -e '
const liked = require("./data/liked-music.json");
const enr = require("./data/liked-music-enriched.json");
const key = (t) => t.title + "|" + t.artist;
const matched = liked.tracks.filter((t) => enr.tracks[key(t)]?.matched).length;
const rate = matched / liked.tracks.length;
if (liked.tracks.length < 100) throw new Error("only " + liked.tracks.length + " tracks — refusing to publish");
if (rate < 0.7) throw new Error("match rate " + (rate * 100).toFixed(0) + "% — refusing to publish");
console.log("sanity ok: " + liked.tracks.length + " tracks, " + (rate * 100).toFixed(0) + "% matched");
' >> "$LOG" 2>&1 || fail "sanity check failed — data NOT published"

beat
# home-covers.json too: the cover pass regenerates it on every run, so leaving
# it out froze the live cover wall at whatever was last committed by hand.
git add data/liked-music.json data/liked-music-enriched.json \
        data/refresh-heartbeat.json data/home-covers.json || fail "git add failed"
git commit -q -m "Data: automatic liked-music refresh (${ADDED:-new tracks})

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" >> "$LOG" 2>&1 || fail "commit failed"
git push -q origin main >> "$LOG" 2>&1 || fail "push failed — check the GitHub credential in Keychain"

date +%F > "$STAMP"
say "published: ${ADDED:-changes} — Railway will redeploy"
notify "Liked music updated — ${ADDED:-changes}"
