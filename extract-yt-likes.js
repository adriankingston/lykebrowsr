// Pull the YouTube Music "Liked Music" playlist straight to
// data/liked-music.json — no browser, no clipboard.
//
// This is the same innertube call the web player makes (POST browse with
// browseId VLLM, then continuation tokens), authenticated the same way: a
// SAPISIDHASH computed from your SAPISID cookie — read live from the running
// Chrome each time (see chrome-cookies.js), so nothing goes stale in a file.
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

// Cookies come from the running Chrome, fresh, every time — see
// chrome-cookies.js for why storing them was the bug.
const { youtubeCookieHeader, CookieError } = require('./chrome-cookies');

// Exit 75 (EX_TEMPFAIL) means "not now, try later" — used when Chrome's
// cookies are too stale to be safe. update.sh treats it as a quiet retry
// rather than a failure worth shouting about.
const EX_TEMPFAIL = 75;
const MAX_COOKIE_AGE_MIN = 180;

let cookie;
try {
  const live = youtubeCookieHeader();
  cookie = live.cookie;
  if (live.ageMinutes != null && live.ageMinutes > MAX_COOKIE_AGE_MIN) {
    console.error(`Chrome's YouTube session was last refreshed ${live.ageMinutes} minutes ago — `
      + 'too stale to use safely. Open Chrome (and visit YouTube Music) and this will run.');
    process.exit(EX_TEMPFAIL);
  }
  console.log(`using Chrome's live cookies (${live.count} cookies, `
    + `${live.ageMinutes == null ? 'age unknown' : live.ageMinutes + ' min old'})`);
} catch (e) {
  console.error(e instanceof CookieError ? e.message : `Couldn't read Chrome's cookies: ${e.message}`);
  process.exit(e instanceof CookieError && e.kind === 'keychain' ? 1 : 1);
}

const cookieVal = (name) => cookie.split(/;\s*/).find((c) => c.startsWith(name + '='))?.slice(name.length + 1);
const sapisid = cookieVal('SAPISID') || cookieVal('__Secure-3PAPISID') || cookieVal('__Secure-1PAPISID');

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
  if (!shelf) throw new Error('no playlist shelf — Chrome\'s YouTube session is signed out or revoked; open YouTube Music in Chrome and sign in');
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
  if (!tracks.length) throw new Error('0 tracks — the request went out unauthenticated; sign in to YouTube Music in Chrome');

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
