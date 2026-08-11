// lykebrowsr — local server + polite MusicBrainz proxy.
//
// Companion to musikrawlr (the band↔musician knowledge graph): where the graph
// browses relationships, this browses the catalogue — artists, release groups,
// releases, recordings, labels — one entity page at a time.
//
// Zero dependencies. Serves ./public and routes /api/* to the MusicBrainz
// web service (https://musicbrainz.org/ws/2/), respecting its etiquette:
//   - at most 1 outbound request per second (all requests share one queue)
//   - a descriptive User-Agent with contact info (set MB_CONTACT in .env)
//   - aggressive local caching (.cache/, gitignored) so repeat lookups
//     never hit the network at all.
//
// Run with:  node server.js   →   http://localhost:4800

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- Load .env (tiny parser, no dependency) ----------------------------------
try {
  const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch { /* no .env file — fall back to real environment */ }

const PORT = process.env.PORT || 4800;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_DIR = path.join(__dirname, '.cache');
const DATA_DIR = path.join(__dirname, 'data');
const MB = 'https://musicbrainz.org/ws/2/';
const UA = `lykebrowsr/0.1 (${process.env.MB_CONTACT || 'no-contact-set; local dev'})`;

fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

// --- Polite MusicBrainz fetcher ----------------------------------------------
// Disk cache → in-flight dedup → a single promise chain that spaces outbound
// requests ≥1.1s apart. 503/429 (throttled) retries with backoff.
const inflight = new Map();
let queueTail = Promise.resolve();
let lastFetchAt = 0;

const cachePathFor = (url) =>
  path.join(CACHE_DIR, crypto.createHash('sha1').update(url).digest('hex') + '.json');

// Cached fetch for non-MusicBrainz hosts (Wikidata, Wikipedia, Discogs):
// disk cache + in-flight dedup + identifying UA, but no rate-limit queue.
function webFetch(url, headers = {}) {
  const file = cachePathFor(url);
  try { return Promise.resolve(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* not cached */ }
  if (inflight.has(url)) return inflight.get(url);
  const p = (async () => {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
    if (!res.ok) throw new Error(`Upstream ${res.status}`);
    const data = await res.json();
    fs.writeFile(file, JSON.stringify(data), () => {});
    return data;
  })();
  inflight.set(url, p);
  p.catch(() => {}).then(() => inflight.delete(url));
  return p;
}

// Discogs profile text uses its own markup ([a=Artist], [l=Label], [b]…);
// strip it down to plain prose and keep it to a paragraph.
function cleanDiscogsProfile(s) {
  let t = String(s || '')
    .replace(/\[(?:a|l|m|r)=([^\]]+)\]/g, '$1')
    .replace(/\[(?:a|l|m|r)\d+\]/g, '')
    .replace(/\[url=[^\]]*\]([^[]*)\[\/url\]/g, '$1')
    .replace(/\[\/?[bius]\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > 620) {
    const cut = t.slice(0, 620);
    const stop = cut.lastIndexOf('. ');
    t = stop > 200 ? cut.slice(0, stop + 1) : cut + '…';
  }
  return t;
}

function mbFetch(pathAndQuery) {
  const url = MB + pathAndQuery + (pathAndQuery.includes('?') ? '&' : '?') + 'fmt=json';
  const file = cachePathFor(url);
  try { return Promise.resolve(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* not cached */ }
  if (inflight.has(url)) return inflight.get(url);

  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastFetchAt + 1100 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastFetchAt = Date.now();
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if ((res.status === 503 || res.status === 429) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`MusicBrainz responded ${res.status}`);
      const data = await res.json();
      fs.writeFile(file, JSON.stringify(data), () => {});
      return data;
    }
  };

  const p = (queueTail = queueTail.catch(() => {}).then(run));
  inflight.set(url, p);
  p.catch(() => {}).then(() => inflight.delete(url));
  return p;
}

const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Lucene special characters would break (or hijack) the search query syntax.
const luceneEscape = (s) => s.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&');

// The catalogue browser is deliberately generic: one search route, one lookup
// route, one browse route, each constrained to what MusicBrainz actually
// serves. New entity types cost one line here and a renderer client-side.
const ENTITY_TYPES = new Set([
  'artist', 'release-group', 'release', 'recording', 'label', 'work',
  'event', 'place', 'series', 'area', 'instrument', 'url', 'genre',
]);

// inc= is a plus-joined word list; anything outside that shape is refused
// rather than forwarded, so the proxy can't be steered to arbitrary queries.
const INC_RE = /^[a-z0-9+-]{0,200}$/;

// Browse: which linked-entity parameters each type accepts (the useful subset
// of https://musicbrainz.org/doc/MusicBrainz_API — extend as pages need them).
const BROWSE_LINKS = {
  'release-group': ['artist', 'release'],
  release: ['artist', 'release-group', 'label', 'recording', 'area'],
  recording: ['artist', 'release', 'work'],
  artist: ['release-group', 'release', 'recording', 'work', 'area'],
  label: ['artist', 'release', 'area'],
  work: ['artist'],
  event: ['artist', 'place', 'area'],
  place: ['area'],
};

// --- API routes --------------------------------------------------------------
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function apiSearch(req, res, url) {
  const q = (url.searchParams.get('q') || '').trim();
  const type = url.searchParams.get('type') || 'artist';
  if (!q) return sendJson(res, 400, { error: 'Missing q' });
  if (!ENTITY_TYPES.has(type)) return sendJson(res, 400, { error: 'Unknown type' });
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const data = await mbFetch(
    `${type}?query=${encodeURIComponent(luceneEscape(q))}&limit=${limit}&offset=${offset}`);
  sendJson(res, 200, data);
}

async function apiLookup(req, res, url) {
  const id = (url.searchParams.get('id') || '').trim();
  const type = url.searchParams.get('type') || 'artist';
  // `+` in a query string decodes to a space — turn it back before validating.
  const inc = (url.searchParams.get('inc') || '').replace(/ /g, '+');
  if (!MBID_RE.test(id)) return sendJson(res, 400, { error: 'Invalid MBID' });
  if (!ENTITY_TYPES.has(type)) return sendJson(res, 400, { error: 'Unknown type' });
  if (!INC_RE.test(inc)) return sendJson(res, 400, { error: 'Bad inc' });
  const data = await mbFetch(`${type}/${id}${inc ? `?inc=${inc}` : ''}`);
  sendJson(res, 200, data);
}

async function apiBrowse(req, res, url) {
  const type = url.searchParams.get('type') || '';
  const links = BROWSE_LINKS[type];
  if (!links) return sendJson(res, 400, { error: 'Unknown browse type' });
  const linkKey = links.find((k) => url.searchParams.get(k));
  if (!linkKey) return sendJson(res, 400, { error: `Need one of: ${links.join(', ')}` });
  const linkId = url.searchParams.get(linkKey).trim();
  if (!MBID_RE.test(linkId)) return sendJson(res, 400, { error: 'Invalid MBID' });
  const inc = (url.searchParams.get('inc') || '').replace(/ /g, '+');
  if (!INC_RE.test(inc)) return sendJson(res, 400, { error: 'Bad inc' });
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 100));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const data = await mbFetch(
    `${type}?${linkKey}=${linkId}&limit=${limit}&offset=${offset}${inc ? `&inc=${inc}` : ''}`);
  sendJson(res, 200, data);
}

// Best-effort enrichment for entity pages. MusicBrainz gives us the Wikidata
// id (exact match, no fuzzy name lookups); Wikidata gives the enwiki title +
// portrait (P18); Wikipedia's REST summary gives the extract. Discogs fills
// the gaps for artists Wikipedia hasn't heard of. Cover art URLs are built
// client-side against the keyless Cover Art Archive.
async function apiEnrich(req, res, url) {
  const id = (url.searchParams.get('id') || '').trim();
  const type = url.searchParams.get('type') || 'artist';
  if (!MBID_RE.test(id)) return sendJson(res, 400, { error: 'Invalid MBID' });
  if (!ENTITY_TYPES.has(type)) return sendJson(res, 400, { error: 'Unknown type' });
  const entity = await mbFetch(`${type}/${id}?inc=url-rels`);
  const out = { bio: null, image: null };

  const wd = (entity.relations || []).find((r) => r.type === 'wikidata' && r.url);
  const qid = wd ? (wd.url.resource.match(/(Q\d+)/) || [])[1] : null;
  if (qid) {
    try {
      const sl = await webFetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=sitelinks&sitefilter=enwiki&format=json`);
      const title = sl.entities?.[qid]?.sitelinks?.enwiki?.title;
      const pc = await webFetch(`https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${qid}&property=P18&format=json`);
      const p18 = pc.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
      if (p18) {
        out.image = 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(p18) + '?width=480';
      }
      if (title) {
        const sum = await webFetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title.replace(/ /g, '_')));
        if (sum.extract) {
          out.bio = { text: sum.extract, source: 'Wikipedia', url: sum.content_urls?.desktop?.page };
        }
        if (!out.image && sum.thumbnail?.source) out.image = sum.thumbnail.source;
      }
    } catch { /* enrichment is best-effort — ship what we have */ }
  }

  if (type === 'artist' && (!out.bio || !out.image)) {
    const dg = (entity.relations || []).find((r) => r.type === 'discogs' && r.url);
    const dgId = dg ? (dg.url.resource.match(/\/artist\/(\d+)/) || [])[1] : null;
    if (dgId) {
      try {
        const headers = process.env.DISCOGS_TOKEN
          ? { Authorization: `Discogs token=${process.env.DISCOGS_TOKEN}` }
          : {};
        const dgData = await webFetch(`https://api.discogs.com/artists/${dgId}`, headers);
        if (!out.bio && dgData.profile) {
          const text = cleanDiscogsProfile(dgData.profile);
          if (text) out.bio = { text, source: 'Discogs', url: `https://www.discogs.com/artist/${dgId}` };
        }
        if (!out.image && Array.isArray(dgData.images) && dgData.images.length) {
          const img = dgData.images.find((i) => i.type === 'primary') || dgData.images[0];
          if (img && img.uri) out.image = img.uri;
        }
      } catch { /* best-effort */ }
    }
  }
  sendJson(res, 200, out);
}

// How widely written-about an artist is. Wikidata stores MusicBrainz ids
// (P434), so one SPARQL query resolves a whole batch at once — no name
// matching. Counts are cached forever (they barely move).
const NOTA_FILE = path.join(CACHE_DIR, 'notability.json');
let notaStore = null;

function loadNotability() {
  if (!notaStore) {
    try { notaStore = JSON.parse(fs.readFileSync(NOTA_FILE, 'utf8')); } catch { notaStore = {}; }
  }
  return notaStore;
}

async function notabilityFor(ids) {
  const store = loadNotability();
  const missing = ids.filter((id) => !(id in store));
  if (missing.length) {
    const values = missing.map((id) => `"${id}"`).join(' ');
    const q = `SELECT ?mbid (COUNT(DISTINCT ?sl) AS ?n) WHERE {`
      + ` VALUES ?mbid { ${values} } ?item wdt:P434 ?mbid .`
      + ` OPTIONAL { ?sl schema:about ?item } } GROUP BY ?mbid`;
    try {
      const r = await fetch('https://query.wikidata.org/sparql?query=' + encodeURIComponent(q), {
        headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' },
      });
      if (r.ok) {
        const j = await r.json();
        for (const b of j.results.bindings) store[b.mbid.value] = Number(b.n.value) || 0;
      }
    } catch { /* fame is a bonus signal — never fail the request over it */ }
    for (const id of missing) if (!(id in store)) store[id] = 0;
    fs.writeFile(NOTA_FILE, JSON.stringify(store), () => {});
  }
  return Object.fromEntries(ids.map((id) => [id, store[id] || 0]));
}

async function apiNotability(req, res, url) {
  const ids = (url.searchParams.get('ids') || '')
    .split(',').map((s) => s.trim()).filter((s) => MBID_RE.test(s)).slice(0, 150);
  if (!ids.length) return sendJson(res, 400, { error: 'No valid ids' });
  sendJson(res, 200, { sitelinks: await notabilityFor(ids) });
}

// Local datasets — the "more data" door. Drop a JSON file in ./data and it's
// served here: GET /api/data lists what exists, GET /api/data?set=<name>
// returns it. Personal listening data, scraped extras, hand-built overlays —
// anything the public APIs don't have lives in this folder.
// Freshness of each library, cheaply. The file's mtime is no use — Railway
// checks the repo out fresh on every deploy — so read the extraction date the
// extractor stamps inside the file. Lets the UI notice a stalled daily update.
async function apiStatus(req, res) {
  const sets = [];
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!/^liked-music(-(?!enriched|covers)[a-z]+)?\.json$/.test(f)) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      sets.push({
        name: f.replace(/\.json$/, ''),
        extracted: d.extracted || null,
        count: d.count || (d.tracks || []).length,
      });
    } catch { /* unreadable — skip */ }
  }
  let heartbeat = null;
  try { heartbeat = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'refresh-heartbeat.json'), 'utf8')).lastRun; } catch { /* none yet */ }
  sendJson(res, 200, { sets, heartbeat, now: new Date().toISOString() });
}

async function apiData(req, res, url) {
  const set = url.searchParams.get('set');
  if (!set) {
    const sets = fs.readdirSync(DATA_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const st = fs.statSync(path.join(DATA_DIR, f));
        return { name: f.replace(/\.json$/, ''), bytes: st.size, modified: st.mtime.toISOString() };
      });
    return sendJson(res, 200, { sets });
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(set)) return sendJson(res, 400, { error: 'Bad set name' });
  const file = path.join(DATA_DIR, set + '.json');
  fs.readFile(file, 'utf8', (err, data) => {
    if (err) return sendJson(res, 404, { error: 'No such dataset' });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(data);
  });
}

const routes = {
  'GET /api/search': apiSearch,
  'GET /api/lookup': apiLookup,
  'GET /api/browse': apiBrowse,
  'GET /api/enrich': apiEnrich,
  'GET /api/notability': apiNotability,
  'GET /api/data': apiData,
  'GET /api/status': apiStatus,
  'GET /api/ytm/find': apiYtmFind,
  'POST /api/ytm/like': apiYtmLike,
};

// --- Server ------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};


// --- YouTube Music, from the local machine only -------------------------------
// Lets the "worth another listen?" page like a track without leaving the page.
// Authenticated with Chrome's live cookies (chrome-cookies.js), so these routes
// only work on Adrian's Mac — on Railway there is no Chrome and they 404.
let ytm = null;
try { ytm = require('./chrome-cookies'); } catch { /* not available */ }

const YTM_ORIGIN = 'https://music.youtube.com';
const YTM_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';
const YTM_CONTEXT = { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240101.01.00', hl: 'en', gl: 'NZ' } };

async function ytmCall(endpoint, body) {
  const { cookie } = ytm.youtubeCookieHeader();
  const val = (n) => cookie.split(/;\s*/).find((c) => c.startsWith(n + '='))?.slice(n.length + 1);
  const sapisid = val('SAPISID') || val('__Secure-3PAPISID');
  const ts = Math.floor(Date.now() / 1000);
  const hash = crypto.createHash('sha1').update(`${ts} ${sapisid} ${YTM_ORIGIN}`).digest('hex');
  const res = await fetch(`${YTM_ORIGIN}/youtubei/v1/${endpoint}?key=${YTM_KEY}&prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `SAPISIDHASH ${ts}_${hash}`,
      Cookie: cookie,
      Origin: YTM_ORIGIN,
      'X-Origin': YTM_ORIGIN,
      'X-Goog-AuthUser': '0',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    },
    body: JSON.stringify({ context: YTM_CONTEXT, ...body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${endpoint} ${res.status}`);
  return JSON.parse(text);
}

const ytmNorm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
  .replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

// Title and artist are scored SEPARATELY, because the dangerous failure is a
// perfect title by the wrong band ("Vikings" exists by several artists).
function ytmScore(cand, artist, title) {
  const t = ytmNorm(cand.title); const want = ytmNorm(title);
  const m = ytmNorm(cand.meta); const wantA = ytmNorm(artist);
  let titleScore = 0;
  if (t === want) titleScore = 1;
  else if (t.startsWith(want) || want.startsWith(t)) titleScore = 0.8;
  else {
    const a = new Set(t.split(' ')); const b = new Set(want.split(' '));
    titleScore = [...b].filter((x) => a.has(x)).length / Math.max(b.size, 1);
  }
  let artistScore = 0;
  if (m.includes(wantA)) artistScore = 1;
  else {
    const a = new Set(m.split(' ')); const b = new Set(wantA.split(' '));
    artistScore = [...b].filter((x) => a.has(x)).length / Math.max(b.size, 1);
  }
  return { titleScore, artistScore };
}

function ytmCandidates(json) {
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    const r = o.musicResponsiveListItemRenderer;
    if (r) {
      const cols = (r.flexColumns || []).map((c) =>
        c.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map((x) => x.text).join('') ?? '');
      const vid = r.playlistItemData?.videoId
        || r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
          ?.playNavigationEndpoint?.watchEndpoint?.videoId;
      if (vid) out.push({ videoId: vid, title: cols[0] || '', meta: cols[1] || '' });
    }
    for (const k in o) walk(o[k]);
  };
  walk(json);
  return out;
}

async function apiYtmFind(req, res, url) {
  if (!ytm) return sendJson(res, 404, { error: 'Local only' });
  const artist = (url.searchParams.get('artist') || '').trim();
  const title = (url.searchParams.get('title') || '').trim();
  if (!artist || !title) return sendJson(res, 400, { error: 'Need artist and title' });
  const data = await ytmCall('search', {
    query: `${artist} ${title}`, params: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D' });
  const ranked = ytmCandidates(data).slice(0, 12)
    .map((c) => ({ ...c, ...ytmScore(c, artist, title) }))
    .sort((a, b) => (b.titleScore + b.artistScore) - (a.titleScore + a.artistScore));
  const top = ranked[0] || null;
  // Two separate failures, and both were happening:
  //  - right title, wrong band ("Vikings" by someone else entirely)
  //  - right band, wrong song (Sommerset has 2 of his 46 tracks on the
  //    service, so every other search returned a nearest-neighbour)
  // Anything without a real title match is NOT a candidate at all — offering
  // it as a "best guess" invited a yes and quietly liked the wrong track.
  const plausible = !!top && top.titleScore >= 0.6;
  const best = plausible ? top : null;
  const confident = plausible && top.titleScore >= 0.95 && top.artistScore >= 0.7;
  sendJson(res, 200, {
    best,
    confident,
    // Say WHY, so the page can be honest rather than vague.
    reason: !top ? 'nothing found'
      : !plausible ? 'not on YouTube Music'
        : confident ? 'match' : 'different artist',
    alternatives: ranked.slice(1, 5),
  });
}

async function apiYtmLike(req, res, url) {
  if (!ytm) return sendJson(res, 404, { error: 'Local only' });
  const videoId = (url.searchParams.get('videoId') || '').trim();
  const remove = url.searchParams.get('remove') === '1';
  if (!/^[\w-]{6,20}$/.test(videoId)) return sendJson(res, 400, { error: 'Bad videoId' });
  await ytmCall(remove ? 'like/removelike' : 'like/like', { target: { videoId } });
  sendJson(res, 200, { ok: true, videoId, removed: remove });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    Promise.resolve(handler(req, res, url)).catch((e) => {
      if (!res.headersSent) sendJson(res, 502, { error: String(e.message || e) });
    });
    return;
  }

  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      // Local dev tool whose files change often — never serve a stale UI.
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n  lykebrowsr → http://localhost:${PORT}\n`);
  if (!process.env.MB_CONTACT) {
    console.log('  ⚠  No MB_CONTACT in .env — MusicBrainz asks for contact info in the User-Agent.\n');
  }
});
