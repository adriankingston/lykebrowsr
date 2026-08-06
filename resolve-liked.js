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
const UA = `musikbrowsr/0.1 (${process.env.MB_CONTACT || 'no-contact-set; local dev'})`;
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

function load() {
  try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {
    return { source: 'liked-music', updated: null, tracks: {}, artists: {}, phase: 'tracks' };
  }
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

async function main() {
  if (process.argv.includes('--genres')) return backfillGenres();
  const liked = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'liked-music.json'), 'utf8'));
  const st = load();
  log(`start — ${liked.tracks.length} tracks, ${Object.keys(st.tracks).length} already resolved`);

  // --- Pass 1: recordings ----------------------------------------------------
  let done = 0;
  for (const t of liked.tracks) {
    if (st.tracks[t.n]) { done++; continue; }
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
    st.tracks[t.n] = rec;
    done++;
    if (done % 25 === 0) { save(st); log(`tracks ${done}/${liked.tracks.length}`); }
  }
  save(st);
  log(`pass 1 complete — ${Object.values(st.tracks).filter((r) => r.matched).length}/${liked.tracks.length} matched`);

  // --- Majority vote: dataset artist name → MBID -----------------------------
  const votes = {};
  for (const t of liked.tracks) {
    const r = st.tracks[t.n];
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
