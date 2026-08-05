// musikbrowsr — hash-routed catalogue browser over the local MB proxy.
// Routes:  #/                       home
//          #/search/<type>/<query>  search results
//          #/<type>/<mbid>          entity page
(() => {
  const view = document.getElementById('view');
  const form = document.getElementById('search-form');
  const qInput = document.getElementById('q');
  const typeSel = document.getElementById('search-type');

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const api = async (path) => {
    const r = await fetch(path);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  };

  // MusicBrainz pluralises inconsistently; map type → results key.
  const RESULT_KEY = {
    artist: 'artists', 'release-group': 'release-groups', release: 'releases',
    recording: 'recordings', label: 'labels', work: 'works',
    event: 'events', place: 'places',
  };
  const TYPE_LABEL = {
    artist: 'Artist', 'release-group': 'Album', release: 'Release',
    recording: 'Recording', label: 'Label', work: 'Work',
    event: 'Event', place: 'Place',
  };

  const fmtLen = (ms) => {
    if (!ms) return '';
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const lifespan = (ls) => {
    if (!ls || (!ls.begin && !ls.end)) return '';
    return `${(ls.begin || '').slice(0, 4) || '?'}–${ls.ended ? (ls.end || '').slice(0, 4) || '?' : ''}`;
  };
  const credit = (ac) => (ac || []).map((c) => c.name + (c.joinphrase || '')).join('');
  const creditLinks = (ac) => (ac || []).map((c) =>
    `<a href="#/artist/${c.artist?.id}">${esc(c.name)}</a>${esc(c.joinphrase || '')}`).join('');

  const loading = (msg) => { view.innerHTML = `<p class="loading">${esc(msg)}…</p>`; };
  const fail = (e) => { view.innerHTML = `<p class="error">${esc(e.message || e)}</p>`; };

  // Broken covers collapse to a music-note placeholder rather than a 404 tile.
  function coverCell(rgId, title, year, href) {
    return `<a class="cover" href="${href}">
      <img src="https://coverartarchive.org/release-group/${rgId}/front-250" alt="" loading="lazy"
           onerror="this.outerHTML='<div class=&quot;c-blank&quot;>♪</div>'">
      <div class="c-title">${esc(title)}</div>
      <div class="c-year">${esc(year || '')}</div>
    </a>`;
  }

  // --- Router ----------------------------------------------------------------
  function route() {
    const parts = decodeURIComponent(location.hash.slice(1)).split('/').filter(Boolean);
    window.scrollTo(0, 0);
    if (!parts.length) return renderHome();
    if (parts[0] === 'search') return renderSearch(parts[1], parts.slice(2).join('/'));
    if (parts[0] === 'data' && parts[1]) return renderDataset(parts[1]);
    if (RESULT_KEY[parts[0]] && parts[1]) return renderEntity(parts[0], parts[1]);
    renderHome();
  }
  window.addEventListener('hashchange', route);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = qInput.value.trim();
    if (q) location.hash = `#/search/${typeSel.value}/${encodeURIComponent(q)}`;
  });

  // --- Home ------------------------------------------------------------------
  async function renderHome() {
    view.innerHTML = `
      <div class="hero">
        <h1>dig into the detail</h1>
        <p>The catalogue behind the graph — search any artist, album, recording or
           label, and follow the credits wherever they lead.
           Companion to <a href="http://localhost:4700" target="_blank" rel="noopener">musikrawlr</a>.</p>
        <p class="starters">
          <button class="chip" data-go="#/artist/149e6720-4e4a-41a4-afca-6d29083fc091">Bad Religion</button>
          <button class="chip" data-go="#/artist/25302723-b24f-4d0d-ab5d-1b4ae0195ac6">Swingin’ Utters</button>
          <button class="chip" data-go="#/artist/449c400c-8312-4c1d-bed8-c8d774090759">METZ</button>
          <button class="chip" data-go="#/artist/d5da1841-9bc8-4813-9f89-11098090148e">The Fall</button>
          <button class="chip" data-go="#/artist/626e7b64-3035-4f58-92a6-49790f600e30">John Reis</button>
        </p>
      </div>
      <div class="datasets" id="datasets"></div>`;
    view.querySelectorAll('[data-go]').forEach((b) =>
      b.addEventListener('click', () => { location.hash = b.dataset.go; }));
    try {
      const { sets } = await api('/api/data');
      if (sets.length) {
        document.getElementById('datasets').innerHTML = `
          <h2 class="sect">Local datasets</h2>
          <div class="rows">${sets.map((s) => `
            <a class="row" href="#/data/${esc(s.name)}">
              <span class="r-name">${esc(s.name)}</span>
              <span class="r-end">${(s.bytes / 1024).toFixed(1)} KB</span>
            </a>`).join('')}
          </div>
          <p class="more-note">Drop a .json file in <code>data/</code> to add more.</p>`;
      }
    } catch { /* datasets are optional */ }
  }

  // --- Search ----------------------------------------------------------------
  async function renderSearch(type, q) {
    if (!RESULT_KEY[type] || !q) return renderHome();
    qInput.value = q;
    typeSel.value = type;
    loading(`Searching ${TYPE_LABEL[type].toLowerCase()}s for “${q}”`);
    try {
      const data = await api(`/api/search?type=${type}&q=${encodeURIComponent(q)}`);
      const items = data[RESULT_KEY[type]] || [];
      view.innerHTML = `
        <h2 class="sect">${items.length ? `${data.count} result${data.count === 1 ? '' : 's'}` : 'No results'}</h2>
        <div class="rows">${items.map((it) => searchRow(type, it)).join('')}</div>`;
    } catch (e) { fail(e); }
  }

  function searchRow(type, it) {
    const name = it.name || it.title || '?';
    const bits = [];
    if (type === 'artist') {
      bits.push(it.type, it.area?.name, lifespan(it['life-span']));
    } else if (type === 'release-group' || type === 'release') {
      bits.push(credit(it['artist-credit']), it['primary-type'] || it.status,
        (it['first-release-date'] || it.date || '').slice(0, 4));
    } else if (type === 'recording') {
      bits.push(credit(it['artist-credit']), fmtLen(it.length));
    } else if (type === 'label') {
      bits.push(it.type, it.area?.name, lifespan(it['life-span']));
    } else if (type === 'event' || type === 'place') {
      bits.push(it.type, it.area?.name, (it['life-span']?.begin || '').slice(0, 4));
    }
    if (it.disambiguation) bits.push(it.disambiguation);
    return `<a class="row" href="#/${type}/${it.id}">
      <span class="r-name">${esc(name)}</span>
      <span class="r-sub">${esc(bits.filter(Boolean).join(' · '))}</span>
      <span class="r-end">${it.score != null ? it.score : ''}</span>
    </a>`;
  }

  // --- Local datasets --------------------------------------------------------
  async function renderDataset(name) {
    loading(`Loading ${name}`);
    try {
      const data = await api(`/api/data?set=${encodeURIComponent(name)}`);
      // A track list (anything with .tracks[]) gets the listening-data view;
      // any other shape falls back to raw JSON so nothing dead-ends.
      if (!Array.isArray(data.tracks)) {
        view.innerHTML = `
          <span class="ent-kind">Dataset</span>
          <h1 class="ent-title">${esc(name)}</h1>
          <pre class="raw">${esc(JSON.stringify(data, null, 2)).slice(0, 20000)}</pre>`;
        return;
      }
      const tracks = data.tracks;
      const byArtist = new Map();
      let secs = 0;
      for (const t of tracks) {
        const a = (t.artist || '(unknown)').trim();
        byArtist.set(a, (byArtist.get(a) || 0) + 1);
        const p = String(t.length || '').split(':').map(Number);
        if (p.length === 2) secs += p[0] * 60 + p[1];
      }
      const top = [...byArtist.entries()].sort((x, y) => y[1] - x[1]).slice(0, 30);
      const searchHref = (a) => `#/search/artist/${encodeURIComponent(a)}`;

      view.innerHTML = `
        <span class="ent-kind">Dataset</span>
        <h1 class="ent-title">${esc(name)}</h1>
        <p class="ent-meta">${esc(data.source || '')}${data.extracted ? ` · extracted ${esc(data.extracted.slice(0, 10))}` : ''}</p>
        <p class="ent-meta">${tracks.length} tracks · ${byArtist.size} artists · ${(secs / 3600).toFixed(1)} hours</p>
        <h2 class="sect">Top artists</h2>
        <div class="rows">${top.map(([a, n]) => `
          <a class="row" href="${searchHref(a)}">
            <span class="r-name">${esc(a)}</span>
            <span class="r-end">${n} track${n === 1 ? '' : 's'}</span>
          </a>`).join('')}</div>
        <h2 class="sect">All tracks</h2>
        <table class="tracks">
          <tr><th></th><th>Title</th><th>Artist</th><th>Album</th><th></th></tr>
          ${tracks.map((t) => `
            <tr>
              <td class="n">${esc(t.n ?? '')}</td>
              <td>${esc(t.title)}</td>
              <td><a href="${searchHref(t.artist || '')}">${esc(t.artist || '')}</a></td>
              <td class="r-sub">${esc(t.album || '')}</td>
              <td class="len">${esc(t.length || '')}</td>
            </tr>`).join('')}
        </table>`;
    } catch (e) { fail(e); }
  }

  // --- Entity pages ----------------------------------------------------------
  async function renderEntity(type, id) {
    loading('Loading');
    try {
      if (type === 'artist') return await pageArtist(id);
      if (type === 'release-group') return await pageReleaseGroup(id);
      if (type === 'release') return await pageRelease(id);
      if (type === 'recording') return await pageRecording(id);
      if (type === 'label') return await pageLabel(id);
      // No dedicated page yet — show the raw record so nothing dead-ends.
      const data = await api(`/api/lookup?type=${type}&id=${id}`);
      view.innerHTML = `
        <span class="ent-kind">${esc(TYPE_LABEL[type] || type)}</span>
        <h1 class="ent-title">${esc(data.name || data.title || id)}</h1>
        <pre class="raw">${esc(JSON.stringify(data, null, 2))}</pre>`;
    } catch (e) { fail(e); }
  }

  function entHead(kind, title, metaBits, enrich) {
    return `
      <div class="ent-head">
        ${enrich?.image ? `<img class="ent-img" src="${esc(enrich.image)}" alt="">` : ''}
        <div>
          <span class="ent-kind">${esc(kind)}</span>
          <h1 class="ent-title">${title}</h1>
          <p class="ent-meta">${metaBits.filter(Boolean).map(esc).join(' · ')}</p>
          ${enrich?.bio ? `<p class="ent-bio">${esc(enrich.bio.text)}
            <span class="src">— <a href="${esc(enrich.bio.url || '#')}" target="_blank" rel="noopener">${esc(enrich.bio.source)}</a></span></p>` : ''}
        </div>
      </div>`;
  }

  function extLinks(relations) {
    const links = (relations || []).filter((r) => r.url).slice(0, 20)
      .map((r) => `<a href="${esc(r.url.resource)}" target="_blank" rel="noopener">${esc(r.type)}</a>`);
    return links.length ? `<h2 class="sect">Links</h2><div class="ext-links">${links.join('')}</div>` : '';
  }

  async function pageArtist(id) {
    // Core record first so the page appears fast; enrichment + discography
    // land asynchronously (each is its own rate-limited call server-side).
    const a = await api(`/api/lookup?type=artist&id=${id}&inc=genres+url-rels+artist-rels`);
    const genres = (a.genres || []).sort((x, y) => y.count - x.count).slice(0, 8);
    const rels = a.relations || [];
    const members = rels.filter((r) => r.type === 'member of band' && r.direction === 'backward' && r.artist);
    const bands = rels.filter((r) => r.type === 'member of band' && r.direction === 'forward' && r.artist);

    view.innerHTML = `
      <div id="head">${entHead('Artist', esc(a.name), [
        a.type, a.area?.name, lifespan(a['life-span']), a.disambiguation,
      ], null)}</div>
      ${genres.length ? `<div class="tags">${genres.map((g) => `<span class="tag">${esc(g.name)}</span>`).join('')}</div>` : ''}
      ${memberList('Members', members)}
      ${memberList('Bands', bands)}
      <h2 class="sect">Discography</h2>
      <div id="disco" class="loading">Loading…</div>
      ${extLinks(rels)}`;

    api(`/api/enrich?type=artist&id=${id}`).then((en) => {
      const head = document.getElementById('head');
      if (head) head.innerHTML = entHead('Artist', esc(a.name), [
        a.type, a.area?.name, lifespan(a['life-span']), a.disambiguation,
      ], en);
    }).catch(() => {});

    api(`/api/browse?type=release-group&artist=${id}&limit=100`).then((d) => {
      const disco = document.getElementById('disco');
      if (!disco) return;
      const rgs = (d['release-groups'] || [])
        .sort((x, y) => (x['first-release-date'] || '9999').localeCompare(y['first-release-date'] || '9999'));
      const albums = rgs.filter((rg) => rg['primary-type'] === 'Album' && !(rg['secondary-types'] || []).length);
      const rest = rgs.filter((rg) => !albums.includes(rg));
      const grid = (list) => `<div class="covers">${list.map((rg) =>
        coverCell(rg.id, rg.title, (rg['first-release-date'] || '').slice(0, 4), `#/release-group/${rg.id}`)).join('')}</div>`;
      disco.classList.remove('loading');
      disco.innerHTML = (albums.length ? grid(albums) : '<p class="more-note">No studio albums recorded.</p>')
        + (rest.length ? `<h2 class="sect">Singles, EPs, live &amp; compilations (${rest.length})</h2>${grid(rest.slice(0, 24))}
            ${rest.length > 24 ? `<p class="more-note">Showing 24 of ${rest.length}.</p>` : ''}` : '');
      if (d['release-group-count'] > 100) {
        disco.insertAdjacentHTML('beforeend',
          `<p class="more-note">First 100 of ${d['release-group-count']} release groups.</p>`);
      }
    }).catch((e) => {
      const disco = document.getElementById('disco');
      if (disco) disco.outerHTML = `<p class="error">Discography failed: ${esc(e.message)}</p>`;
    });
  }

  function memberList(title, rels) {
    if (!rels.length) return '';
    const seen = new Set();
    const rows = rels
      .sort((x, y) => (x.begin || '9999').localeCompare(y.begin || '9999'))
      .filter((r) => !seen.has(r.artist.id) && seen.add(r.artist.id))
      .map((r) => {
        const yrs = r.begin || r.end
          ? `${(r.begin || '').slice(0, 4) || '?'}–${r.ended ? (r.end || '').slice(0, 4) || '?' : ''}` : '';
        const instr = (r.attributes || []).filter((a) => a !== 'original').join(', ');
        return `<a class="row" href="#/artist/${r.artist.id}">
          <span class="r-name">${esc(r.artist.name)}</span>
          <span class="r-sub">${esc(instr)}</span>
          <span class="r-end">${esc(yrs)}</span>
        </a>`;
      });
    return `<h2 class="sect">${esc(title)} (${rows.length})</h2><div class="rows">${rows.join('')}</div>`;
  }

  async function pageReleaseGroup(id) {
    const rg = await api(`/api/lookup?type=release-group&id=${id}&inc=artists+releases+genres+url-rels`);
    const year = (rg['first-release-date'] || '').slice(0, 4);
    const genres = (rg.genres || []).sort((x, y) => y.count - x.count).slice(0, 8);
    const releases = (rg.releases || [])
      .sort((x, y) => (x.date || '9999').localeCompare(y.date || '9999'));
    view.innerHTML = `
      <div class="ent-head">
        <img class="ent-img" src="https://coverartarchive.org/release-group/${id}/front-500" alt=""
             onerror="this.remove()">
        <div>
          <span class="ent-kind">${esc(rg['primary-type'] || 'Release group')}</span>
          <h1 class="ent-title">${esc(rg.title)}</h1>
          <p class="ent-meta">${creditLinks(rg['artist-credit'])}${year ? ` · ${year}` : ''}</p>
          ${genres.length ? `<div class="tags">${genres.map((g) => `<span class="tag">${esc(g.name)}</span>`).join('')}</div>` : ''}
        </div>
      </div>
      <h2 class="sect">Releases (${releases.length})</h2>
      <div class="rows">${releases.map((r) => `
        <a class="row" href="#/release/${r.id}">
          <span class="r-name">${esc(r.title)}</span>
          <span class="r-sub">${esc([r.country, r.status, r.disambiguation].filter(Boolean).join(' · '))}</span>
          <span class="r-end">${esc(r.date || '')}</span>
        </a>`).join('')}</div>
      ${extLinks(rg.relations)}`;
  }

  async function pageRelease(id) {
    const rel = await api(`/api/lookup?type=release&id=${id}&inc=recordings+artist-credits+labels+release-groups`);
    const rgId = rel['release-group']?.id;
    const media = rel.media || [];
    const label = (rel['label-info'] || []).map((li) =>
      li.label ? `<a href="#/label/${li.label.id}">${esc(li.label.name)}</a>${li['catalog-number'] ? ` (${esc(li['catalog-number'])})` : ''}` : '').filter(Boolean).join(', ');
    view.innerHTML = `
      <div class="ent-head">
        ${rgId ? `<img class="ent-img" src="https://coverartarchive.org/release-group/${rgId}/front-500" alt="" onerror="this.remove()">` : ''}
        <div>
          <span class="ent-kind">Release</span>
          <h1 class="ent-title">${esc(rel.title)}</h1>
          <p class="ent-meta">${creditLinks(rel['artist-credit'])}
            ${rel.date ? ` · ${esc(rel.date)}` : ''}${rel.country ? ` · ${esc(rel.country)}` : ''}
            ${label ? ` · ${label}` : ''}</p>
          ${rgId ? `<p class="ent-meta"><a href="#/release-group/${rgId}">All releases of this album →</a></p>` : ''}
        </div>
      </div>
      ${media.map((m) => `
        <h2 class="sect">${esc([m.format, m.title].filter(Boolean).join(' — ') || 'Tracklist')} (${m['track-count']})</h2>
        <table class="tracks">
          ${(m.tracks || []).map((t) => `
            <tr>
              <td class="n">${esc(t.number)}</td>
              <td><a href="#/recording/${t.recording?.id}">${esc(t.title)}</a></td>
              <td class="r-sub">${esc(credit(t['artist-credit']) !== credit(rel['artist-credit']) ? credit(t['artist-credit']) : '')}</td>
              <td class="len">${fmtLen(t.length)}</td>
            </tr>`).join('')}
        </table>`).join('')}`;
  }

  async function pageRecording(id) {
    const rec = await api(`/api/lookup?type=recording&id=${id}&inc=artist-credits+releases+isrcs+url-rels`);
    const releases = (rec.releases || [])
      .sort((x, y) => (x.date || '9999').localeCompare(y.date || '9999'));
    view.innerHTML = `
      <span class="ent-kind">Recording</span>
      <h1 class="ent-title">${esc(rec.title)}</h1>
      <p class="ent-meta">${creditLinks(rec['artist-credit'])}${rec.length ? ` · ${fmtLen(rec.length)}` : ''}
        ${rec.disambiguation ? ` · ${esc(rec.disambiguation)}` : ''}</p>
      <h2 class="sect">Appears on (${releases.length})</h2>
      <div class="rows">${releases.map((r) => `
        <a class="row" href="#/release/${r.id}">
          <span class="r-name">${esc(r.title)}</span>
          <span class="r-sub">${esc([r.country, r.status].filter(Boolean).join(' · '))}</span>
          <span class="r-end">${esc(r.date || '')}</span>
        </a>`).join('')}</div>
      ${extLinks(rec.relations)}`;
  }

  async function pageLabel(id) {
    const lb = await api(`/api/lookup?type=label&id=${id}&inc=url-rels+genres`);
    view.innerHTML = `
      <div id="head">${entHead('Label', esc(lb.name), [
        lb.type, lb.area?.name, lifespan(lb['life-span']), lb.disambiguation,
      ], null)}</div>
      <h2 class="sect">Releases</h2>
      <div id="lbrel" class="loading">Loading…</div>
      ${extLinks(lb.relations)}`;

    api(`/api/enrich?type=label&id=${id}`).then((en) => {
      const head = document.getElementById('head');
      if (head) head.innerHTML = entHead('Label', esc(lb.name), [
        lb.type, lb.area?.name, lifespan(lb['life-span']), lb.disambiguation,
      ], en);
    }).catch(() => {});

    api(`/api/browse?type=release&label=${id}&limit=100`).then((d) => {
      const el = document.getElementById('lbrel');
      if (!el) return;
      const rels = (d.releases || []).sort((x, y) => (x.date || '9999').localeCompare(y.date || '9999'));
      el.classList.remove('loading');
      el.innerHTML = `<div class="rows">${rels.map((r) => `
        <a class="row" href="#/release/${r.id}">
          <span class="r-name">${esc(r.title)}</span>
          <span class="r-sub">${esc([r.country, r.status].filter(Boolean).join(' · '))}</span>
          <span class="r-end">${esc(r.date || '')}</span>
        </a>`).join('')}</div>
        ${d['release-count'] > 100 ? `<p class="more-note">First 100 of ${d['release-count']} releases.</p>` : ''}`;
    }).catch((e) => {
      const el = document.getElementById('lbrel');
      if (el) el.outerHTML = `<p class="error">Releases failed: ${esc(e.message)}</p>`;
    });
  }

  route();
})();
