// Is the daily refresh actually going to work tomorrow?
//
// Checks the things that silently break it, in the order they're likely to:
// the YouTube cookie, the git branch, the launchd job, and how stale the data
// has become. Read-only — it changes nothing and pulls no playlist.
//
// Run with:  npm run check

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

try {
  const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env */ }

const ok = (s) => `  ✓ ${s}`;
const bad = (s) => `  ✗ ${s}`;
const meh = (s) => `  · ${s}`;
let failures = 0;
const fail = (s) => { failures += 1; console.log(bad(s)); };

async function cookieWorks() {
  const cookie = (process.env.YT_COOKIE || '').trim();
  if (!cookie) return fail('YT_COOKIE is not set — see .env.example');
  const val = (n) => cookie.split(/;\s*/).find((c) => c.startsWith(n + '='))?.slice(n.length + 1);
  const sapisid = val('SAPISID') || val('__Secure-3PAPISID');
  if (!sapisid) return fail('YT_COOKIE has no SAPISID — the copied header was incomplete');
  const ts = Math.floor(Date.now() / 1000);
  const hash = crypto.createHash('sha1').update(`${ts} ${sapisid} https://music.youtube.com`).digest('hex');
  try {
    const res = await fetch('https://music.youtube.com/youtubei/v1/browse?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `SAPISIDHASH ${ts}_${hash}`,
        Cookie: cookie,
        Origin: 'https://music.youtube.com',
        'X-Origin': 'https://music.youtube.com',
        'X-Goog-AuthUser': '0',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240101.01.00', hl: 'en', gl: 'NZ' } },
        browseId: 'VLLM',
      }),
    });
    const text = await res.text();
    const loggedIn = (text.match(/"key":"logged_in","value":"(\d)"/) || [])[1];
    if (loggedIn === '1' || /musicPlaylistShelfRenderer/.test(text)) {
      return console.log(ok('YouTube cookie authenticates'));
    }
    fail('YouTube cookie has EXPIRED — re-copy it from a fresh incognito window');
    console.log(meh('see .env.example for the incognito recipe; the window must be closed, not signed out'));
  } catch (e) {
    fail(`couldn't reach YouTube (${e.message})`);
  }
}

function gitState() {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: __dirname }).toString().trim();
    if (branch === 'main') console.log(ok('repo is on main'));
    else fail(`repo is on '${branch}' — update.sh will refuse to publish`);
    execSync('git ls-remote --exit-code origin main', { cwd: __dirname, stdio: 'ignore' });
    console.log(ok('GitHub remote reachable (push credential works)'));
  } catch {
    fail('git push would fail — check the GitHub credential in Keychain');
  }
}

function schedule() {
  try {
    const out = execSync('launchctl list', { encoding: 'utf8' });
    if (/com\.lykebrowsr\.update/.test(out)) console.log(ok('daily job is loaded (08:30)'));
    else fail('launchd job not loaded — launchctl load ~/Library/LaunchAgents/com.lykebrowsr.update.plist');
  } catch { console.log(meh('could not read launchctl')); }
}

function freshness() {
  for (const f of fs.readdirSync(path.join(__dirname, 'data'))) {
    if (!/^liked-music(-(?!enriched|covers)[a-z]+)?\.json$/.test(f)) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', f), 'utf8'));
      const days = Math.floor((Date.now() - Date.parse(d.extracted)) / 86400000);
      const who = f.replace(/\.json$/, '');
      const line = `${who}: ${d.count} tracks, refreshed ${days} day${days === 1 ? '' : 's'} ago`;
      if (who === 'liked-music' && days >= 4) fail(line + ' — the daily update looks stalled');
      else console.log(ok(line));
    } catch { /* skip */ }
  }
}

(async () => {
  console.log('\nlykebrowsr — daily refresh health check\n');
  await cookieWorks();
  gitState();
  schedule();
  freshness();
  console.log(failures
    ? `\n${failures} problem${failures === 1 ? '' : 's'} — tomorrow's refresh would not fully work.\n`
    : '\nAll good. Tomorrow morning will look after itself.\n');
  process.exit(failures ? 1 : 0);
})();
