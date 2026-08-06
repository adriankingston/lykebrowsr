# lykebrowsr

**dig into the detail** — a MusicBrainz catalogue browser, and companion to
[musikrawlr](https://github.com/adriankingston/musikrawlr): where the graph
browses *relationships* (who played with whom), this browses *the catalogue*
(what they actually made). Artists, albums, releases, tracklists, recordings
and labels, one linkable page at a time.

Zero dependencies — a single Node server (`server.js`) fronting the
[MusicBrainz web service](https://musicbrainz.org/doc/MusicBrainz_API) with a
polite shared queue (≤1 request/second), retries, and a permanent disk cache,
plus a vanilla-JS hash-routed front end in `public/`.

## Run

```
cp .env.example .env    # set MB_CONTACT to your email (MusicBrainz etiquette)
node server.js          # → http://localhost:4800
```

## API

| Route | What it does |
| --- | --- |
| `GET /api/search?type=&q=` | Search any entity type (artist, release-group, release, recording, label, work, event, place…) |
| `GET /api/lookup?type=&id=&inc=` | Entity lookup by MBID, with a validated `inc=` pass-through |
| `GET /api/browse?type=&<link>=<mbid>` | MB browse — e.g. all release-groups by an artist, all releases on a label |
| `GET /api/enrich?type=&id=` | Wikipedia bio + portrait via Wikidata (exact MBID match), Discogs as fallback for artists |
| `GET /api/notability?ids=` | Wikidata sitelink counts (fame signal), batched via SPARQL P434 |
| `GET /api/data[?set=]` | Local datasets from `data/*.json` — the door for non-API data |

Cover art is hotlinked client-side from the keyless
[Cover Art Archive](https://coverartarchive.org) by release-group MBID.

## More data

The `data/` folder is the extension point: any `.json` dropped there is listed
on the home page and served at `/api/data?set=<name>`. Personal listening
data, scraped extras, hand-built overlays — anything the public APIs don't
have. Feature code that joins a dataset to MusicBrainz ids belongs in
`public/app.js` renderers; new upstream sources belong in `server.js` next to
`webFetch` (cached, deduped, no rate queue) or `mbFetch` (the polite queue).

## Family

- [musikrawlr](https://github.com/adriankingston/musikrawlr) — the knowledge
  graph this is a companion to (localhost:4700).
