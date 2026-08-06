# musikbrowsr — next features plan

Three pieces of work, in suggested build order (2 → 1 → 3; the deep-link is an
hour, the genre backfill feeds the style map, and the style map is the big one).

## 1. Genre backfill — shrink the "unknown" lane (61 artists)

The 61 artists MusicBrainz has no genre list for are mostly exactly the bands
Wikidata/Wikipedia is thin on too — so cascade through sources, cheapest and
most-exact first, and record where each verdict came from:

1. **MusicBrainz raw tags** (`inc=tags`): the folksonomy behind the curated
   genre list. Some artists have tags but no promoted genres. One re-fetch per
   artist, same polite queue. Filter against a genre whitelist (tags include
   junk like "seen live").
2. **Wikidata P136 (genre)**: we already hold each artist's Wikidata QID via
   the MB url-rels (exact match, keyless). `wbgetentities` → P136 claims →
   genre labels. Strong for anything with a Wikipedia page.
3. **Discogs release styles**: MB stores the exact Discogs artist id; Discogs
   `/artists/<id>/releases` → per-release `styles` (Discogs is unusually good
   on obscure punk). Aggregate style counts across releases, take the top few.
   Keyless at low volume; DISCOGS_TOKEN raises limits.
4. **Last.fm `artist.getTopTags`** (optional, needs a free API key from
   Adrian): accepts MBIDs directly, excellent indie coverage. Skip unless
   1–3 still leave gaps.

Mechanics: a `--genres` flag on `resolve-liked.js` that only touches artists
with empty `genres`; writes `genres: [{name, count, source}]` into the same
enriched file. Normalise names through a small synonym map ("Hardcore" →
"hardcore punk", "Punk" → "punk rock" etc.) so backfilled tags line up with
MB's vocabulary. ~61 artists × ≤3 calls ≈ minutes, not hours.

## 2. musikrawlr ↔ musikbrowsr deep links

musikrawlr has no URL scheme yet (was on its "obvious next steps" list).

- **musikrawlr**: on boot, parse `#seed=<mbid>` → fetch the artist → `addSeed`
  it (reusing the existing search-pick path). ~20 lines in app.js. Works
  locally and, once pushed, on the Railway deploy for free.
- **musikbrowsr → musikrawlr**: artist pages and graph nodes get an
  "open in musikrawlr ↗" link → `http://localhost:4700/#seed=<mbid>`.
  (Graph: a small link in a node-tap info strip rather than hijacking the
  tap-to-open-artist behaviour — tap = artist page, link = graph.)
- **musikrawlr → musikbrowsr**: symmetric panel link
  `http://localhost:4800/#/artist/<mbid>` — the graph's answer to "now show me
  the records".
- Host handling: emit links against `localhost` when the page itself is on
  localhost; on the Railway deploy, hide the musikbrowsr link (it isn't
  deployed) unless/until it is.

## 3. Style relationship map — "how does sludge relate to noise?"

Two *kinds* of edges, complementary; build both and let the view toggle them:

**a. Empirical edges — zero new data needed.** MB gives most artists several
genres; two styles are related in *this library* when bands carry both tags
(Whores. = noise rock + sludge metal + pigfuck…). Edge weight = number of
shared bands (optionally weighted by liked-track counts). This is computable
today from `liked-music-enriched.json` and is personal: it maps how the styles
relate *in Adrian's listening*, not in theory.

**b. Curated lineage edges — Wikipedia/Wikidata, as suggested.**

- **Wikidata SPARQL first**: one query pulls the whole music-genre universe —
  `?g wdt:P31/wdt:P279* wd:Q188451` (instance of music genre) with its
  `P279` (subclass of) and `P737` (influenced by) links, labels in one shot.
  Cache as `data/genre-graph.json`. Then intersect with our style names
  (match via lowercase label + aliases). Gets the subgenre tree cheaply.
- **Wikipedia infobox for the styles we actually have** (~40): genre pages
  carry the richest fields — *Stylistic origins*, *Derivative forms*,
  *Subgenres*, *Fusion genres* (e.g. sludge metal ← doom metal + hardcore
  punk; noise rock ← punk + no wave). Fetch each page's wikitext via the
  API, regex the infobox fields for `[[links]]`. Resolve page titles from the
  Wikidata item's sitelink (we'll have the QID from the SPARQL pass — no
  fuzzy title guessing). Edge types: `origin`, `derivative`, `subgenre`,
  `fusion`.
- Server side: one new resolver script (`resolve-genres.js`) with the same
  cache/UA etiquette (Wikimedia is not rate-limited like MB, so it's fast);
  serves through the existing `/api/data` door.

**View**: a new `Styles` tab on the dataset — Cytoscape again. Nodes = styles
in the library (size = liked-track count; colour = the timeline palette).
Edge toggles: "in my library" (empirical, undirected, width = shared bands)
vs "lineage" (directed arrows, labelled origin/subgenre/fusion). Tap a style
→ highlight its bands (chips below the canvas). The sludge↔noise answer then
reads both ways: *empirically* linked through Whores., KEN mode, Big Ups…,
and *canonically* cousins (both descend from punk/hardcore; sludge via doom,
noise rock via no wave).

Open questions
- Last.fm: worth registering a key, or stop at Discogs?
- Style map scope: only styles in the library, or one hop out into
  neighbouring genres (shows *where the library sits* in the wider map)?
