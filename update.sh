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

say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
notify() {
  /usr/bin/osascript -e "display notification \"$1\" with title \"lykebrowsr\"" 2>/dev/null || true
}
fail() {
  say "FAILED: $1"
  notify "Update failed — $1"
  exit 1
}

say "--- update starting ---"

# Keep the log from growing without bound.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 200000 ]; then
  tail -n 400 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

OUT=$(node extract-yt-likes.js 2>&1)
EXIT=$?
echo "$OUT" >> "$LOG"
if [ $EXIT -ne 0 ]; then
  case "$OUT" in
    *YT_COOKIE*|*unauthenticated*|*expired*) fail "YouTube cookies need refreshing" ;;
    *) fail "extract failed — see update.log" ;;
  esac
fi

# Nothing new? Then there's nothing to resolve, commit or deploy.
if git diff --quiet -- data/liked-music.json; then
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

git add data/liked-music.json data/liked-music-enriched.json || fail "git add failed"
git commit -q -m "Data: automatic liked-music refresh (${ADDED:-new tracks})

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" >> "$LOG" 2>&1 || fail "commit failed"
git push -q origin main >> "$LOG" 2>&1 || fail "push failed — check the GitHub credential in Keychain"

say "published: ${ADDED:-changes} — Railway will redeploy"
notify "Liked music updated — ${ADDED:-changes}"
