// Pull the YouTube Music "Liked Music" playlist straight to
// data/liked-music.json — no browser, no clipboard.
//
// This is the same innertube call the web player makes (POST browse with
// browseId VLLM, then continuation tokens), authenticated the same way: a
// SAPISIDHASH computed from your SAPISID cookie. Give it the cookies once
// (YT_COOKIE in .env — see .env.example) and every refresh after that is
// just `npm run update`.
//
// Tracks carry a `firstSeen` date, preserved across refreshes, so the app can
// show what's new. Tracks that leave the playlist leave the dataset.
//
// Run with:  node extract-yt-likes.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

try {
  const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env */ }

const OUT = path.join(__dirname, 'data', 'liked-music.json');
const ORIGIN = 'https://music.youtube.com';
// Public web client key — the same constant the player ships in its page.
const KEY = process.env.YT_INNERTUBE_KEY || 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';
const CONTEXT = { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240101.01.00', hl: 'en', gl: 'NZ' } };

// `pbpaste | node extract-yt-likes.js --save-cookie` — takes the cookie header
// (or a whole "Copy as cURL") on stdin and writes YT_COOKIE into .env, so the
// value never has to survive a round trip through shell quoting.
if (process.argv.includes('--save-cookie')) {
  const raw = fs.readFileSync(0, 'utf8').trim();
  const m = raw.match(/-b\s+'([^']+)'/) || raw.match(/-H\s+'cookie:\s*([^']+)'/i)
    || raw.match(/^\s*cookie:\s*(.+)$/im);
  const val = (m ? m[1] : raw).replace(/\s+/g, ' ').trim();
  if (!/SAPISID=/.test(val)) {
    console.error('That does not look like a YouTube cookie header (no SAPISID). Nothing written.');
    process.exit(1);
  }
  const envPath = path.join(__dirname, '.env');
  let env = '';
  try { env = fs.readFileSync(envPath, 'utf8'); } catch { /* new .env */ }
  const line = `YT_COOKIE='${val.replace(/'/g, "'\\''")}'`;
  env = /^YT_COOKIE=/m.test(env) ? env.replace(/^YT_COOKIE=.*$/m, line)
    : env.replace(/\n*$/, '\n') + line + '\n';
  fs.writeFileSync(envPath, env, { mode: 0o600 });
  const names = val.split(/;\s*/).map((c) => c.split('=')[0]);
  console.log(`saved YT_COOKIE to .env (${names.length} cookies: ${names.slice(0, 8).join(', ')}…)`);
  process.exit(0);
}

const cookie = (process.env.YT_COOKIE || '').trim();
if (!cookie) {
  console.error(`No YT_COOKIE set (or the saved one has stopped authenticating).

Use an INCOGNITO window. Google rotates the session cookies of any window you
keep using, and a copy taken from your normal browsing session gets invalidated
within a day or so. A private window you never touch again keeps working.

  1. Open an incognito window (⇧⌘N) and sign in at https://music.youtube.com
  2. DevTools (⌥⌘I) → Network → filter "browse" → click the playlist, or scroll,
     until a /youtubei/v1/browse row appears.
  3. Right-click that row → Copy → Copy as cURL.
  4. Run:  pbpaste | node extract-yt-likes.js --save-cookie
  5. CLOSE the incognito window WITHOUT signing out. Signing out kills the
     session; closing it simply leaves it parked.

Treat that line like a password — it authenticates as your Google account.
.env is gitignored and written 0600.`);
  process.exit(1);
}

const cookieVal = (name) =>
  cookie.split(/;\s*/).find((c) => c.startsWith(name + '='))?.slice(name.length + 1);

const sapisid = cookieVal('SAPISID') || cookieVal('__Secure-3PAPISID') || cookieVal('__Secure-1PAPISID');
if (!sapisid) {
  console.error('YT_COOKIE has no SAPISID / __Secure-3PAPISID — copy the full cookie header, not a fragment.');
  process.exit(1);
}

const authHeader = () => {
  const ts = Math.floor(Date.now() / 1000);
  const hash = crypto.createHash('sha1').update(`${ts} ${sapisid} ${ORIGIN}`).digest('hex');
  return `SAPISIDHASH ${ts}_${hash}`;
};

async function post(body, attempt = 0) {
  const res = await fetch(`${ORIGIN}/youtubei/v1/browse?key=${KEY}&prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader(),
      Cookie: cookie,
      Origin: ORIGIN,
      'X-Origin': ORIGIN,
      'X-Goog-AuthUser': process.env.YT_AUTHUSER || '0',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    },
    body: JSON.stringify({ context: CONTEXT, ...body }),
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    return post(body, attempt + 1);
  }
  if (!res.ok) throw new Error(`innertube ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const txt = (fc) => fc?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map((r) => r.text).join('') ?? '';
// YouTube flip-flops between crediting a band and its auto-generated
// "<band> - Topic" channel across pulls; strip the suffix so the same song
// always keys the same and the noise never reaches the dataset.
const deTopic = (s) => s.replace(/ - Topic$/, '');
const parseItems = (items) => (items || []).flatMap((it) => {
  const r = it.musicResponsiveListItemRenderer;
  if (!r) return [];
  const f = r.flexColumns || [];
  const dur = r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text ?? '';
  return [{ title: txt(f[0]), artist: deTopic(txt(f[1])), album: txt(f[2]), length: dur }];
});
const findCont = (items) => (items || []).map((it) =>
  it.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token).find(Boolean);
const findShelf = (o) => {
  if (!o || typeof o !== 'object') return null;
  if (o.musicPlaylistShelfRenderer) return o.musicPlaylistShelfRenderer;
  for (const k in o) { const r = findShelf(o[k]); if (r) return r; }
  return null;
};

// Same key the resolver uses to carry work across refreshes.
const keyOf = (t) => `${t.title}|${t.artist}`;

async function main() {
  const first = await post({ browseId: 'VLLM' });
  const shelf = findShelf(first);
  if (!shelf) throw new Error('no playlist shelf in response — cookies likely expired; re-copy YT_COOKIE');
  const tracks = parseItems(shelf.contents);
  let token = findCont(shelf.contents);
  let guard = 0;
  while (token && guard++ < 80) {
    const d = await post({ continuation: token });
    const cont = d?.continuationContents?.musicPlaylistShelfContinuation;
    const items = cont?.contents || d?.onResponseReceivedActions?.[0]?.appendContinuationItemsAction?.continuationItems;
    if (!items) break;
    tracks.push(...parseItems(items));
    token = findCont(items) || cont?.continuations?.[0]?.nextContinuationData?.continuation;
    process.stdout.write(`\r  ${tracks.length} tracks…`);
  }
  process.stdout.write('\r');
  if (!tracks.length) throw new Error('0 tracks — the request went out unauthenticated; re-copy YT_COOKIE');

  // Carry firstSeen across refreshes; today for anything we've not seen before.
  let prev = { tracks: [] };
  try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* first run */ }
  const seen = new Map(prev.tracks.map((t) => [keyOf(t), t.firstSeen]));
  const today = new Date().toISOString().slice(0, 10);
  const added = [];
  tracks.forEach((t, i) => {
    t.n = i + 1;
    t.firstSeen = seen.get(keyOf(t)) || today;
    if (!seen.has(keyOf(t))) added.push(t);
  });
  const nowSet = new Set(tracks.map(keyOf));
  const gone = prev.tracks.filter((t) => !nowSet.has(keyOf(t)));

  const bad = tracks.filter((t) => /�/.test(t.title + t.artist + t.album)).length;
  if (bad) throw new Error(`${bad} tracks have replacement characters — refusing to overwrite`);

  // Nothing added or removed → leave the file untouched, so a scheduled run
  // on a quiet day produces no diff, no commit, no redeploy.
  if (!added.length && !gone.length && tracks.length === prev.tracks.length) {
    console.log(`${tracks.length} tracks — no change since last pull, file left as is`);
    return;
  }

  fs.writeFileSync(OUT, JSON.stringify({
    source: 'YouTube Music — Liked Music (playlist LM)',
    extracted: new Date().toISOString(),
    count: tracks.length,
    tracks,
  }));

  console.log(`${tracks.length} tracks → data/liked-music.json`);
  console.log(`  ${added.length} new, ${gone.length} gone since last pull`);
  for (const t of added.slice(0, 15)) console.log(`  + ${t.title} — ${t.artist}`);
  if (added.length > 15) console.log(`  … and ${added.length - 15} more`);
  for (const t of gone.slice(0, 15)) console.log(`  − ${t.title} — ${t.artist}`);
  if (gone.length > 15) console.log(`  … and ${gone.length - 15} more`);
}

main().catch((e) => { console.error(`extract failed: ${e.message}`); process.exit(1); });
