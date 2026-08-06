// Build data/genre-graph.json — how the styles in the library relate.
//
// Sources, both cached forever:
//   - Wikidata: one SPARQL pull of the whole music-genre universe (instance
//     of Q188451) with subclass-of (P279) and influenced-by (P737) edges and
//     enwiki sitelinks. Library styles match by lowercase English label, with
//     a targeted alt-label query for stragglers ("pigfuck" → noise rock).
//   - Wikipedia: each matched genre page's infobox — Stylistic origins,
//     Derivative forms, Subgenres, Fusion genres — the richest genre-lineage
//     data anywhere. Genres one hop out that aren't in the library are kept
//     as `external` nodes so the map shows where the library sits.
//
// Run AFTER resolve-liked.js (+ --genres):  node resolve-genres.js

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
const OUT = path.join(__dirname, 'data', 'genre-graph.json');
const UA = `musikbrowsr/0.1 (${process.env.MB_CONTACT || 'no-contact-set; local dev'})`;
fs.mkdirSync(CACHE_DIR, { recursive: true });
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

const cachePathFor = (url) =>
  path.join(CACHE_DIR, crypto.createHash('sha1').update(url).digest('hex') + '.json');

async function webFetch(url, headers = {}) {
  const file = cachePathFor(url);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not cached */ }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`Upstream ${res.status} for ${url.slice(0, 90)}`);
    const data = await res.json();
    fs.writeFileSync(file, JSON.stringify(data));
    return data;
  }
}

const sparql = (q) => webFetch(
  'https://query.wikidata.org/sparql?query=' + encodeURIComponent(q),
  { Accept: 'application/sparql-results+json' });

const qidOf = (uri) => (String(uri).match(/(Q\d+)$/) || [])[1];

// "Industrial music" / "Punk rock (UK)" → canonical lowercase style names.
function canonName(s) {
  let n = String(s || '').toLowerCase().replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  return n;
}
const dropMusicSuffix = (n) => n.replace(/ music$/, '');

async function main() {
  const enr = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'liked-music-enriched.json'), 'utf8'));
  const libStyles = new Set();
  for (const a of Object.values(enr.artists)) {
    for (const g of (a.genres || []).slice(0, 4)) libStyles.add(g.name.toLowerCase());
  }
  log(`library styles: ${libStyles.size}`);

  // --- Wikidata universe -----------------------------------------------------
  log('fetching Wikidata music-genre universe…');
  const uni = await sparql(`SELECT ?g ?gLabel ?parent ?inf ?article WHERE {
    ?g wdt:P31 wd:Q188451 .
    OPTIONAL { ?g wdt:P279 ?parent . }
    OPTIONAL { ?g wdt:P737 ?inf . }
    OPTIONAL { ?article schema:about ?g ; schema:isPartOf <https://en.wikipedia.org/> . }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
  }`);
  const byQid = new Map();   // qid → {label, article, parents:Set, inf:Set}
  const byLabel = new Map(); // canonical label → qid
  for (const b of uni.results.bindings) {
    const q = qidOf(b.g.value);
    if (!byQid.has(q)) byQid.set(q, { label: b.gLabel?.value || q, article: null, parents: new Set(), inf: new Set() });
    const n = byQid.get(q);
    if (b.article) n.article = decodeURIComponent(b.article.value.split('/wiki/')[1] || '');
    if (b.parent) n.parents.add(qidOf(b.parent.value));
    if (b.inf) n.inf.add(qidOf(b.inf.value));
  }
  for (const [q, n] of byQid) {
    const c = canonName(n.label);
    if (!byLabel.has(c)) byLabel.set(c, q);
    const short = dropMusicSuffix(c);
    if (short !== c && !byLabel.has(short)) byLabel.set(short, q);
  }
  log(`universe: ${byQid.size} genres`);

  // --- Match library styles --------------------------------------------------
  const matched = new Map(); // style name → qid
  const unmatched = [];
  for (const s of libStyles) {
    const q = byLabel.get(s) || byLabel.get(dropMusicSuffix(s));
    if (q) matched.set(s, q);
    else unmatched.push(s);
  }
  // Stragglers: alt-labels, one targeted query for the whole batch.
  if (unmatched.length) {
    const values = unmatched.map((s) => `"${s.replace(/"/g, '\\"')}"@en`).join(' ');
    try {
      const alt = await sparql(`SELECT ?g ?name WHERE {
        VALUES ?name { ${values} }
        ?g skos:altLabel ?name ; wdt:P31 wd:Q188451 .
      }`);
      for (const b of alt.results.bindings) {
        const q = qidOf(b.g.value);
        if (byQid.has(q)) matched.set(b.name.value, q);
      }
    } catch (e) { log(`alt-label query failed: ${e.message}`); }
  }
  log(`matched ${matched.size}/${libStyles.size} styles to Wikidata (unmatched: ${[...libStyles].filter((s) => !matched.has(s)).join(', ') || 'none'})`);

  // --- Assemble nodes: library styles + everything one hop out ---------------
  const nameOfQid = (q) => {
    for (const [s, mq] of matched) if (mq === q) return s; // prefer the library's own name
    const n = byQid.get(q);
    return n ? dropMusicSuffix(canonName(n.label)) : null;
  };
  const styles = {}; // name → {qid, wiki, external}
  const edges = [];
  const seenEdge = new Set();
  const addEdge = (from, to, type, source) => {
    if (!from || !to || from === to) return;
    const key = `${from}|${to}|${type}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({ from, to, type, source });
  };
  const addStyle = (name, qid, external) => {
    if (!name) return;
    if (!styles[name]) {
      styles[name] = { qid: qid || null, wiki: qid ? (byQid.get(qid)?.article || null) : null, external: !!external };
    } else if (!external) styles[name].external = false;
  };
  for (const s of libStyles) addStyle(s, matched.get(s), false);

  // Wikidata edges touching a library style (either direction).
  const libQids = new Set(matched.values());
  for (const [q, n] of byQid) {
    const from = nameOfQid(q);
    for (const p of n.parents) {
      if (!libQids.has(q) && !libQids.has(p)) continue;
      const to = nameOfQid(p);
      addStyle(from, q, !libQids.has(q));
      addStyle(to, p, !libQids.has(p));
      addEdge(from, to, 'subgenre-of', 'wikidata');
    }
    for (const i of n.inf) {
      if (!byQid.has(i) || (!libQids.has(q) && !libQids.has(i))) continue;
      const to = nameOfQid(i);
      addStyle(from, q, !libQids.has(q));
      addStyle(to, i, !libQids.has(i));
      addEdge(to, from, 'influenced', 'wikidata');
    }
  }

  // --- Wikipedia infoboxes for the library styles ----------------------------
  const FIELDS = [
    ['stylistic_origins', 'origin'],     // linked → style
    ['derivatives', 'derivative'],       // style → linked
    ['subgenres', 'subgenre'],           // linked is a child of style
    ['fusiongenres', 'fusion'],
  ];
  for (const [s, q] of matched) {
    const article = byQid.get(q)?.article;
    if (!article) continue;
    try {
      const d = await webFetch(`https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(article)}&prop=wikitext&section=0&redirects=1&format=json`);
      const wt = d.parse?.wikitext?.['*'] || '';
      for (const [field, type] of FIELDS) {
        const m = wt.match(new RegExp(`\\|\\s*${field}\\s*=([\\s\\S]*?)(?=\\n\\s*\\|\\s*[a-z_]+\\s*=|\\n\\}\\})`, 'i'));
        if (!m) continue;
        for (const link of m[1].matchAll(/\[\[([^\]|#]+)/g)) {
          const target = dropMusicSuffix(canonName(link[1]));
          if (!target || target === s) continue;
          const tq = byLabel.get(target) || byLabel.get(dropMusicSuffix(target));
          const known = tq ? nameOfQid(tq) : target;
          addStyle(known, tq, !libStyles.has(known));
          if (type === 'origin') addEdge(known, s, 'origin-of', 'wikipedia');
          else if (type === 'derivative') addEdge(s, known, 'origin-of', 'wikipedia');
          else if (type === 'subgenre') addEdge(known, s, 'subgenre-of', 'wikipedia');
          else addEdge(s, known, 'fusion', 'wikipedia');
        }
      }
    } catch (e) { log(`wiki ${article}: ${e.message}`); }
  }

  const out = { updated: new Date().toISOString(), styles, edges };
  fs.writeFileSync(OUT, JSON.stringify(out));
  const ext = Object.values(styles).filter((x) => x.external).length;
  log(`done — ${Object.keys(styles).length} styles (${ext} external), ${edges.length} edges → ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
