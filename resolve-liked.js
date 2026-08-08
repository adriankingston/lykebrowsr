// Resolve data/liked-music.json against MusicBrainz.
//
// Two passes, checkpointed so it can be killed and rerun at any time (every
// MB response is also disk-cached, so a rerun over resolved ground is free):
//
//   1. Per track: recording search "title" + artist → the recording's
//      first-release-date (the song's ORIGINAL release, not the album we
//      happened to like it on) + candidate artist MBIDs. The dataset artist's
//      MBID is then a majority vote over its tracks' matches — far more
//      reliable than an artist-name search (q="Death" finds the metal band;
//      the recording "Keep On Knocking" by Death finds the Detroit one).
//   2. Per resolved artist: lookup with genres + artist-rels → style tags,
//      country/area of origin, and membership links (the raw material for
//      the relationship graph).
//
// Output: data/liked-music-enriched.json, written incrementally.
// Run with:  node resolve-liked.js   (logs to resolve.log)

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

const CACHE_DIR = path.join(__dirname, '.cache');
const OUT = path.join(__dirname, 'data', 'liked-music-enriched.json');
const LOG = path.join(__dirname, 'resolve.log');
const MB = 'https://musicbrainz.org/ws/2/';
const UA = `lykebrowsr/0.1 (${process.env.MB_CONTACT || 'no-contact-set; local dev'})`;
fs.mkdirSync(CACHE_DIR, { recursive: true });

const log = (s) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${s}`;
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
};

// Same polite queue as server.js (duplicated: both stay zero-dep and tiny).
let lastFetchAt = 0;
const cachePathFor = (url) =>
  path.join(CACHE_DIR, crypto.createHash('sha1').update(url).digest('hex') + '.json');

async function mbFetch(pathAndQuery) {
  const url = MB + pathAndQuery + (pathAndQuery.includes('?') ? '&' : '?') + 'fmt=json';
  const file = cachePathFor(url);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not cached */ }
  for (let attempt = 0; ; attempt++) {
    const wait = lastFetchAt + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastFetchAt = Date.now();
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if ((res.status === 503 || res.status === 429) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`MusicBrainz ${res.status} for ${pathAndQuery}`);
    const data = await res.json();
    fs.writeFileSync(file, JSON.stringify(data));
    return data;
  }
}

const luceneEscape = (s) => s.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&');

// Loose artist-name match: normalised equality, containment, or ≥50% token
// overlap ("Del Tha Funkee Homosapien" ≈ "Del the Funky Homosapien").
const norm = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/\p{M}/gu, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
function nameMatch(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const shared = [...ta].filter((t) => tb.has(t)).length;
  return shared / Math.min(ta.size, tb.size) >= 0.5;
}

// The dataset's artist strings can be joins ("Gorillaz & Del The Funky
// Homosapien"); the first segment is the primary credit we vote with.
const primaryName = (s) => String(s || '').split(/ & |, | feat\.? /i)[0].trim();

// Pass-1 results are keyed by "title|artist", not by playlist position: new
// likes land at the top of the Liked Music playlist and shift every n, which
// would silently pair each track with the previous occupant's resolution.
const trackKey = (t) => `${t.title}|${t.artist}`;

function load(liked) {
  let st;
  try { st = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {
    return { source: 'liked-music', keyed: 'title|artist', updated: null, tracks: {}, artists: {}, phase: 'tracks' };
  }
  if (st.keyed !== 'title|artist' && liked) {
    // Migrate a position-keyed checkpoint. Safe only where the numbering still
    // matches the dataset it was built from; anything that doesn't line up is
    // dropped and simply re-resolves (cached, so it costs no requests).
    const byN = st.tracks || {};
    const moved = {};
    for (const t of liked.tracks) if (byN[t.n]) moved[trackKey(t)] = byN[t.n];
    log(`migrated checkpoint: ${Object.keys(moved).length}/${Object.keys(byN).length} entries re-keyed by title|artist`);
    st.tracks = moved;
    st.keyed = 'title|artist';
  }
  return st;
}
const save = (st) => {
  st.updated = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(st));
};

// --- Genre backfill (--genres): fill artists MB has no genre list for -------
// Cascade: MB raw tags → Wikidata P136 → Discogs release styles → Last.fm
// (only if LASTFM_API_KEY is set). Each verdict records its source.
async function webFetch(url, headers = {}) {
  const file = cachePathFor(url);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not cached */ }
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
  if (!res.ok) throw new Error(`Upstream ${res.status}`);
  const data = await res.json();
  fs.writeFileSync(file, JSON.stringify(data));
  return data;
}

// Map non-MB vocabularies onto MB's where they differ predictably; anything
// already in the MB genre whitelist passes through untouched.
const SYNONYM = {
  hardcore: 'hardcore punk', punk: 'punk rock', 'post punk': 'post-punk',
  'noise': 'noise rock', 'garage': 'garage rock', 'metal': 'heavy metal',
  'rock & roll': "rock 'n' roll", 'indie': 'indie rock',
};

async function mbGenreWhitelist() {
  const names = new Set();
  let offset = 0;
  for (;;) {
    const d = await mbFetch(`genre/all?limit=100&offset=${offset}`);
    for (const g of d.genres || []) names.add(g.name.toLowerCase());
    offset += 100;
    if (offset >= (d['genre-count'] || 0)) break;
  }
  return names;
}

async function backfillGenres() {
  const st = load();
  const wl = await mbGenreWhitelist();
  log(`genre backfill — whitelist ${wl.size} genres`);
  const clean = (name) => {
    const n = String(name || '').toLowerCase().trim();
    if (wl.has(n)) return n;
    if (SYNONYM[n] && wl.has(SYNONYM[n])) return SYNONYM[n];
    return null; // junk tag ("seen live") or vocabulary we can't anchor
  };
  const gaps = Object.entries(st.artists).filter(([, a]) => a.id && !(a.genres || []).length);
  log(`${gaps.length} artists lacking genres`);
  let lastDiscogs = 0;
  let filled = 0;

  for (const [name, a] of gaps) {
    let genres = [];
    let rels = [];
    try {
      const d = await mbFetch(`artist/${a.id}?inc=tags+url-rels`);
      rels = d.relations || [];
      genres = (d.tags || [])
        .map((t) => ({ name: clean(t.name), count: t.count, source: 'mb-tag' }))
        .filter((g) => g.name && g.count > 0)
        .sort((x, y) => y.count - x.count).slice(0, 5);
    } catch (e) { log(`tags ${name}: ${e.message}`); }

    if (!genres.length) {
      const wd = rels.find((r) => r.type === 'wikidata' && r.url);
      const qid = wd ? (wd.url.resource.match(/(Q\d+)/) || [])[1] : null;
      if (qid) {
        try {
          const c = await webFetch(`https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${qid}&property=P136&format=json`);
          const gids = (c.claims?.P136 || []).map((x) => x.mainsnak?.datavalue?.value?.id).filter(Boolean);
          if (gids.length) {
            const e = await webFetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${gids.join('|')}&props=labels&languages=en&format=json`);
            genres = gids
              .map((g) => ({ name: clean(e.entities?.[g]?.labels?.en?.value), count: 1, source: 'wikidata' }))
              .filter((g) => g.name).slice(0, 5);
          }
        } catch (e) { log(`wikidata ${name}: ${e.message}`); }
      }
    }

    if (!genres.length) {
      const dg = rels.find((r) => r.type === 'discogs' && r.url);
      const dgId = dg ? (dg.url.resource.match(/\/artist\/(\d+)/) || [])[1] : null;
      if (dgId) {
        try {
          // Unauthenticated Discogs allows 25 req/min — space calls ≥2.5s.
          const headers = process.env.DISCOGS_TOKEN
            ? { Authorization: `Discogs token=${process.env.DISCOGS_TOKEN}` } : {};
          const throttle = async () => {
            const wait = lastDiscogs + 2600 - Date.now();
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
            lastDiscogs = Date.now();
          };
          await throttle();
          const rl = await webFetch(`https://api.discogs.com/artists/${dgId}/releases?sort=year&per_page=25`, headers);
          const masters = (rl.releases || []).filter((r) => r.type === 'master' && r.role === 'Main').slice(0, 3);
          const styleCount = {};
          for (const m of masters) {
            await throttle();
            const md = await webFetch(`https://api.discogs.com/masters/${m.id}`, headers);
            for (const s of [...(md.styles || []), ...(md.genres || [])]) {
              const n = clean(s);
              if (n) styleCount[n] = (styleCount[n] || 0) + 1;
            }
          }
          genres = Object.entries(styleCount).sort((x, y) => y[1] - x[1]).slice(0, 5)
            .map(([n, c]) => ({ name: n, count: c, source: 'discogs' }));
        } catch (e) { log(`discogs ${name}: ${e.message}`); }
      }
    }

    if (!genres.length && process.env.LASTFM_API_KEY) {
      try {
        const lf = await webFetch(`https://ws.audioscrobbler.com/2.0/?method=artist.gettoptags&mbid=${a.id}&api_key=${process.env.LASTFM_API_KEY}&format=json`);
        genres = (lf.toptags?.tag || [])
          .map((t) => ({ name: clean(t.name), count: t.count, source: 'lastfm' }))
          .filter((g) => g.name && g.count >= 10)
          .slice(0, 5);
      } catch (e) { log(`lastfm ${name}: ${e.message}`); }
    }

    if (genres.length) {
      a.genres = genres;
      filled++;
      log(`${name} ← ${genres.map((g) => g.name).join(', ')} (${genres[0].source})`);
    }
    save(st);
  }
  log(`genre backfill done — filled ${filled}/${gaps.length}`);
}

// --- Label pass (--labels): which record companies released each artist ----
// One release-browse per artist with inc=labels; tally the label credits
// across up to 100 releases and keep the top few. Far better coverage than
// artist-label "recording contract" rels, and the counts double as weight.
async function resolveLabels() {
  const st = load();
  const artists = Object.entries(st.artists).filter(([, a]) => a.id);
  log(`label pass — ${artists.length} artists`);
  let done = 0;
  for (const [name, a] of artists) {
    done++;
    if (a.labels) continue; // resumable
    try {
      const d = await mbFetch(`release?artist=${a.id}&limit=100&inc=labels`);
      const tally = new Map();
      for (const rel of d.releases || []) {
        for (const li of rel['label-info'] || []) {
          const lb = li.label;
          if (!lb || !lb.id || lb.name === '[no label]') continue;
          if (!tally.has(lb.id)) tally.set(lb.id, { id: lb.id, name: lb.name, count: 0 });
          tally.get(lb.id).count++;
        }
      }
      a.labels = [...tally.values()].sort((x, y) => y.count - x.count).slice(0, 5);
    } catch (e) {
      log(`labels ${name}: ${e.message}`);
      a.labels = [];
    }
    if (done % 20 === 0) { save(st); log(`labels ${done}/${artists.length}`); }
  }
  save(st);
  const withLabels = artists.filter(([, a]) => (a.labels || []).length).length;
  log(`label pass done — ${withLabels}/${artists.length} artists have labels`);
}

// --- Home cover wall (--covers) ---------------------------------------------
// The home page's 20 background covers used to cost 20 live MusicBrainz
// browses, which (a) took ~32s on a cold cache and (b) monopolised the app's
// single polite queue, so a real user's artist lookup queued behind decoration.
// Precomputing here moves that cost to the nightly job.
//
// We also resolve each cover past the Cover Art Archive's first redirect:
// coverartarchive.org 307s to archive.org, and each hop is a fresh TLS
// handshake (~950ms). We pin the archive.org/download URL — but deliberately
// NOT the final dn*/ia* storage node, whose hostnames rotate and can degrade
// to 20s transfers when stale.
async function resolveCovers() {
  const liked = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'liked-music.json'), 'utf8'));
  const st = load();
  const counts = new Map();
  for (const t of liked.tracks) {
    const k = primaryName(t.artist);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  // Roll up by resolved MBID so spelling variants count once (as the app does).
  const byId = new Map();
  for (const [name, a] of Object.entries(st.artists)) {
    if (!a.id) continue;
    const m = byId.get(a.id) || { id: a.id, name: a.mbName || name, n: 0 };
    m.n += counts.get(name) || 0;
    byId.set(a.id, m);
  }
  const top = [...byId.values()].sort((x, y) => y.n - x.n).slice(0, 20);
  log(`cover pass — top ${top.length} artists`);

  const covers = [];
  for (const a of top) {
    try {
      const rgs = await mbFetch(`release-group?artist=${a.id}&limit=100`);
      const albums = (rgs['release-groups'] || [])
        .filter((g) => g['primary-type'] === 'Album')
        .sort((x, y) => (x['first-release-date'] || '9999').localeCompare(y['first-release-date'] || '9999'))
        .slice(0, 3);
      let picked = null;
      for (const g of albums) {
        try {
          const caa = await webFetch(`https://coverartarchive.org/release-group/${g.id}`);
          const front = (caa.images || []).find((im) => im.front) || (caa.images || [])[0];
          // The request 307s to archive.org's index.json, which carries no
          // `release` field — the release MBID is in each image's URL.
          const relId = (caa.release || front?.image || '').match(/release\/([0-9a-f-]{36})/)?.[1];
          if (!front || !relId) continue;
          picked = {
            artist: a.name,
            n: a.n,
            releaseGroup: g.id,
            title: g.title,
            // Hop-2 URL: skips coverartarchive.org's redirect entirely.
            url: `https://archive.org/download/mbid-${relId}/mbid-${relId}-${front.id}_thumb250.jpg`,
          };
          break;
        } catch { /* no art for this album — try the next */ }
      }
      if (picked) { covers.push(picked); log(`cover ${a.name} ← ${picked.title}`); }
      else log(`cover ${a.name}: no art on first ${albums.length} albums`);
    } catch (e) { log(`cover ${a.name} failed: ${e.message}`); }
  }
  fs.writeFileSync(path.join(__dirname, 'data', 'home-covers.json'), JSON.stringify({
    source: 'First-album covers for the top lyked artists (Cover Art Archive)',
    updated: new Date().toISOString(),
    covers,
  }));
  log(`cover pass done — ${covers.length}/${top.length} artists have art`);
}

async function main() {
  if (process.argv.includes('--genres')) return backfillGenres();
  if (process.argv.includes('--labels')) return resolveLabels();
  if (process.argv.includes('--covers')) return resolveCovers();
  const liked = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'liked-music.json'), 'utf8'));
  const st = load(liked);
  // Tracks that have left the playlist leave the dataset; drop their entries
  // so the checkpoint doesn't grow forever.
  const live = new Set(liked.tracks.map(trackKey));
  for (const k of Object.keys(st.tracks)) if (!live.has(k)) delete st.tracks[k];
  const todo = liked.tracks.filter((t) => !st.tracks[trackKey(t)]).length;
  log(`start — ${liked.tracks.length} tracks, ${Object.keys(st.tracks).length} already resolved, ${todo} to do`);

  // --- Pass 1: recordings ----------------------------------------------------
  let done = 0;
  for (const t of liked.tracks) {
    if (st.tracks[trackKey(t)]) { done++; continue; }
    const artist = primaryName(t.artist);
    const rec = { matched: false, date: null, artistId: null };
    try {
      const cleanTitle = t.title.replace(/\s*\((feat|with)[^)]*\)\s*/ig, ' ').trim();
      let data = await mbFetch(`recording?query=${encodeURIComponent(
        `recording:"${luceneEscape(cleanTitle)}" AND artist:"${luceneEscape(artist)}"`)}&limit=8`);
      let cands = (data.recordings || []).filter((r) =>
        (r['artist-credit'] || []).some((c) => nameMatch(c.name || c.artist?.name, artist)));
      if (!cands.length && /[([]/.test(t.title)) {
        // Titles like "Song (Official Video)" search better fully stripped.
        const bare = t.title.replace(/\s*[([].*$/, '').trim();
        data = await mbFetch(`recording?query=${encodeURIComponent(
          `recording:"${luceneEscape(bare)}" AND artist:"${luceneEscape(artist)}"`)}&limit=8`);
        cands = (data.recordings || []).filter((r) =>
          (r['artist-credit'] || []).some((c) => nameMatch(c.name || c.artist?.name, artist)));
      }
      if (cands.length) {
        rec.matched = true;
        // Earliest first-release-date across the matched recordings: covers
        // re-recordings and reissues listed as separate recordings.
        const dates = cands.map((r) => r['first-release-date']).filter(Boolean).sort();
        rec.date = dates[0] || null;
        const credit = (cands[0]['artist-credit'] || []).find((c) => nameMatch(c.name || c.artist?.name, artist));
        rec.artistId = credit?.artist?.id || null;
        rec.recordingId = cands[0].id;
      }
    } catch (e) { log(`track ${t.n} "${t.title}" failed: ${e.message}`); }
    st.tracks[trackKey(t)] = rec;
    done++;
    if (done % 25 === 0) { save(st); log(`tracks ${done}/${liked.tracks.length}`); }
  }
  save(st);
  // Counted over tracks, not checkpoint keys: the playlist holds duplicates,
  // which share one key (and one lookup) but are several tracks.
  log(`pass 1 complete — ${liked.tracks.filter((t) => st.tracks[trackKey(t)]?.matched).length}/${liked.tracks.length} matched `
    + `(${Object.keys(st.tracks).length} unique title+artist)`);

  // --- Majority vote: dataset artist name → MBID -----------------------------
  const votes = {};
  for (const t of liked.tracks) {
    const r = st.tracks[trackKey(t)];
    if (!r?.artistId) continue;
    const key = primaryName(t.artist);
    (votes[key] = votes[key] || {})[r.artistId] = (votes[key][r.artistId] || 0) + 1;
  }
  const artistIds = {};
  for (const [name, v] of Object.entries(votes)) {
    artistIds[name] = Object.entries(v).sort((a, b) => b[1] - a[1])[0][0];
  }
  // Names with no matched track at all: fall back to a plain artist search.
  const allNames = [...new Set(liked.tracks.map((t) => primaryName(t.artist)))];
  for (const name of allNames) {
    if (artistIds[name] || st.artists[name]?.unresolved) continue;
    try {
      const d = await mbFetch(`artist?query=${encodeURIComponent(luceneEscape(name))}&limit=3`);
      const hit = (d.artists || []).find((a) => nameMatch(a.name, name));
      if (hit) artistIds[name] = hit.id;
      else st.artists[name] = { unresolved: true };
    } catch (e) { log(`artist search "${name}" failed: ${e.message}`); }
  }

  // --- Pass 2: artist detail -------------------------------------------------
  const names = Object.keys(artistIds);
  let adone = 0;
  for (const name of names) {
    adone++;
    if (st.artists[name] && !st.artists[name].unresolved) continue;
    const id = artistIds[name];
    try {
      const a = await mbFetch(`artist/${id}?inc=genres+artist-rels`);
      const links = (a.relations || [])
        .filter((r) => r.artist && (r.type === 'member of band' || r.type === 'collaboration'))
        .map((r) => ({
          id: r.artist.id, name: r.artist.name,
          rel: r.type === 'member of band' ? 'member' : 'collab',
          dir: r.direction,
          begin: r.begin || null, end: r.end || null,
        }));
      st.artists[name] = {
        id,
        mbName: a.name,
        type: a.type || null,
        country: a.country || null,
        area: a.area?.name || null,
        beginArea: a['begin-area']?.name || null,
        genres: (a.genres || []).sort((x, y) => y.count - x.count).slice(0, 6)
          .map((g) => ({ name: g.name, count: g.count })),
        links,
      };
    } catch (e) { log(`artist "${name}" (${id}) failed: ${e.message}`); }
    if (adone % 20 === 0) { save(st); log(`artists ${adone}/${names.length}`); }
  }
  st.phase = 'complete';
  save(st);
  const resolved = Object.values(st.artists).filter((a) => a.id).length;
  log(`done — ${resolved}/${allNames.length} artists resolved, output ${OUT}`);
}

main().catch((e) => { log(`FATAL ${e.stack}`); process.exit(1); });
