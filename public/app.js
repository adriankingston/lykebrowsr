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
    if (parts[0] === 'data' && parts[1]) return renderDataset(parts[1], parts[2] || 'overview');
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
  // Must mirror resolve-liked.js: the first credit segment is the join key.
  const primaryName = (s) => String(s || '').split(/ & |, | feat\.? /i)[0].trim();

  const PAL = ['#4aa8ff', '#2ee6c8', '#ffd166', '#ff6b8f', '#b78cff', '#7fe08a',
    '#ff9e5e', '#5ed4ff', '#e6a1ff', '#c9e05e', '#ff7b6b', '#8fb0ff'];

  const COUNTRY = { US: 'United States', GB: 'United Kingdom', NZ: 'New Zealand',
    AU: 'Australia', CA: 'Canada', SE: 'Sweden', FI: 'Finland', DE: 'Germany',
    JP: 'Japan', IE: 'Ireland', CH: 'Switzerland', HR: 'Croatia', MX: 'Mexico',
    IN: 'India', MN: 'Mongolia', NO: 'Norway', DK: 'Denmark', FR: 'France',
    NL: 'Netherlands', ES: 'Spain', IT: 'Italy', BE: 'Belgium', TR: 'Turkey',
    UA: 'Ukraine', GR: 'Greece', BR: 'Brazil' };

  const dsCache = new Map();
  async function loadDataset(name) {
    if (dsCache.has(name)) return dsCache.get(name);
    const liked = await api(`/api/data?set=${encodeURIComponent(name)}`);
    let enr = null;
    try { enr = await api(`/api/data?set=${encodeURIComponent(name)}-enriched`); } catch { /* not resolved yet */ }
    const d = { liked, enr };
    if (enr?.phase === 'complete') dsCache.set(name, d);
    return d;
  }

  // Join a track to its resolution + its artist's style; styles are bucketed
  // into the dataset's top N genres so colours stay legible.
  function joinTracks(d) {
    const tracks = d.liked.tracks.map((t) => {
      const r = d.enr?.tracks?.[t.n] || null;
      const a = d.enr?.artists?.[primaryName(t.artist)] || null;
      return {
        ...t,
        date: r?.date || null,
        year: r?.date ? Number(r.date.slice(0, 4)) : null,
        recordingId: r?.recordingId || null,
        artistInfo: a && a.id ? a : null,
        genre: a?.genres?.[0]?.name || null,
      };
    });
    const counts = new Map();
    for (const t of tracks) if (t.genre) counts.set(t.genre, (counts.get(t.genre) || 0) + 1);
    const topStyles = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, PAL.length - 1).map(([g]) => g);
    const styleOf = (t) => (t.genre && topStyles.includes(t.genre)) ? t.genre : (t.genre ? 'other' : 'unknown');
    return { tracks, topStyles, styleOf };
  }

  const styleColor = (style, topStyles) => {
    const i = topStyles.indexOf(style);
    return i >= 0 ? PAL[i] : '#6b7f88';
  };

  function dsTabs(name, active, enr) {
    const tab = (id, label) => `<a class="dtab${active === id ? ' on' : ''}"
      href="#/data/${esc(name)}${id === 'overview' ? '' : '/' + id}">${label}</a>`;
    const resolved = enr ? Object.keys(enr.tracks || {}).length : 0;
    const status = !enr ? '<span class="dtab-note">resolving not started</span>'
      : enr.phase !== 'complete' ? `<span class="dtab-note">resolving… ${resolved} tracks so far — refresh for more</span>` : '';
    return `<nav class="dtabs">${tab('overview', 'Overview')}${tab('timeline', 'Timeline')}${tab('bands', 'Bands')}${tab('graph', 'Graph')}${status}</nav>`;
  }

  async function renderDataset(name, sub) {
    loading(`Loading ${name}`);
    try {
      const d = await loadDataset(name);
      if (!Array.isArray(d.liked.tracks)) {
        view.innerHTML = `
          <span class="ent-kind">Dataset</span>
          <h1 class="ent-title">${esc(name)}</h1>
          <pre class="raw">${esc(JSON.stringify(d.liked, null, 2)).slice(0, 20000)}</pre>`;
        return;
      }
      const head = `
        <span class="ent-kind">Dataset</span>
        <h1 class="ent-title">${esc(name)}</h1>
        <p class="ent-meta">${esc(d.liked.source || '')}${d.liked.extracted ? ` · extracted ${esc(d.liked.extracted.slice(0, 10))}` : ''}</p>
        ${dsTabs(name, sub, d.enr)}`;
      if (sub === 'timeline') return viewTimeline(head, d);
      if (sub === 'bands') return viewBands(head, d);
      if (sub === 'graph') return viewGraph(head, d);
      viewOverview(head, d);
    } catch (e) { fail(e); }
  }

  function viewOverview(head, d) {
    const tracks = d.liked.tracks;
    const byArtist = new Map();
    let secs = 0;
    for (const t of tracks) {
      const a = (t.artist || '(unknown)').trim();
      byArtist.set(a, (byArtist.get(a) || 0) + 1);
      const p = String(t.length || '').split(':').map(Number);
      if (p.length === 2) secs += p[0] * 60 + p[1];
    }
    const top = [...byArtist.entries()].sort((x, y) => y[1] - x[1]).slice(0, 30);
    const artistHref = (a) => {
      const info = d.enr?.artists?.[primaryName(a)];
      return info?.id ? `#/artist/${info.id}` : `#/search/artist/${encodeURIComponent(a)}`;
    };
    view.innerHTML = `${head}
      <p class="ent-meta">${tracks.length} tracks · ${byArtist.size} artists · ${(secs / 3600).toFixed(1)} hours</p>
      <h2 class="sect">Top artists</h2>
      <div class="rows">${top.map(([a, n]) => `
        <a class="row" href="${artistHref(a)}">
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
            <td><a href="${artistHref(t.artist || '')}">${esc(t.artist || '')}</a></td>
            <td class="r-sub">${esc(t.album || '')}</td>
            <td class="len">${esc(t.length || '')}</td>
          </tr>`).join('')}
      </table>`;
  }

  // Songs by ORIGINAL release year (recording first-release-date), one swim
  // lane per style, dot per song.
  function viewTimeline(head, d) {
    if (!d.enr) { view.innerHTML = `${head}<p class="loading">No resolved data yet — run <code>node resolve-liked.js</code>.</p>`; return; }
    const { tracks, topStyles, styleOf } = joinTracks(d);
    const dated = tracks.filter((t) => t.year && t.year > 1900);
    if (!dated.length) { view.innerHTML = `${head}<p class="loading">No release dates resolved yet — refresh in a minute.</p>`; return; }
    const y0 = Math.min(...dated.map((t) => t.year));
    const y1 = Math.max(...dated.map((t) => t.year), new Date().getFullYear());
    const lanes = [...topStyles, 'other', 'unknown']
      .map((s) => ({ style: s, tracks: dated.filter((t) => styleOf(t) === s) }))
      .filter((l) => l.tracks.length);
    const W = 1000;
    const LANE = 40;
    const LEFT = 150;
    const H = lanes.length * LANE + 46;
    const x = (yr) => LEFT + (yr - y0) / (y1 - y0) * (W - LEFT - 20);
    const jitter = (n) => ((n * 2654435761) % 24) - 12;
    let svg = `<svg viewBox="0 0 ${W} ${H}" class="tl-chart" role="img" aria-label="Songs by original release year and style">`;
    for (let yr = Math.ceil(y0 / 10) * 10; yr <= y1; yr += 10) {
      svg += `<line x1="${x(yr)}" y1="20" x2="${x(yr)}" y2="${H - 26}" class="tl-grid"/>
        <text x="${x(yr)}" y="${H - 10}" class="tl-tick">${yr}</text>`;
    }
    lanes.forEach((l, i) => {
      const cy = 26 + i * LANE + LANE / 2;
      const col = l.style === 'other' || l.style === 'unknown' ? '#6b7f88' : styleColor(l.style, topStyles);
      svg += `<text x="${LEFT - 10}" y="${cy + 4}" class="tl-lane" fill="${col}">${esc(l.style)} (${l.tracks.length})</text>`;
      for (const t of l.tracks) {
        svg += `<circle cx="${x(t.year).toFixed(1)}" cy="${(cy + jitter(t.n) * 0.9).toFixed(1)}" r="3.4"
          fill="${col}" class="tl-dot" data-rec="${t.recordingId || ''}">
          <title>${esc(t.title)} — ${esc(t.artist)} (${t.year})</title></circle>`;
      }
    });
    svg += '</svg>';
    const undated = tracks.length - dated.length;
    view.innerHTML = `${head}
      <p class="ent-meta">${dated.length} songs placed by the <em>earliest release MusicBrainz knows</em> for each
        recording${undated ? ` · ${undated} not yet resolved` : ''}. Hover a dot; click opens the recording.</p>
      ${svg}`;
    view.querySelectorAll('.tl-dot').forEach((c) => c.addEventListener('click', () => {
      if (c.dataset.rec) location.hash = `#/recording/${c.dataset.rec}`;
    }));
  }

  // Bands grouped by style or by country of origin.
  function viewBands(head, d) {
    if (!d.enr) { view.innerHTML = `${head}<p class="loading">No resolved data yet.</p>`; return; }
    const { topStyles } = joinTracks(d);
    const counts = new Map();
    for (const t of d.liked.tracks) {
      const k = primaryName(t.artist);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const artists = Object.entries(d.enr.artists || {})
      .filter(([, a]) => a.id)
      .map(([name, a]) => ({ name, ...a, n: counts.get(name) || 0 }));
    const mode = (location.search || '').includes('by=country') ? 'country' : 'style';

    const groups = new Map();
    for (const a of artists) {
      const key = mode === 'country'
        ? (COUNTRY[a.country] || a.country || a.area || 'Unknown')
        : (a.genres?.[0]?.name || 'unknown');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    const sections = [...groups.entries()].sort((x, y) => y[1].length - x[1].length);
    const toggle = `<div class="bv-toggle">
      <a class="dtab${mode === 'style' ? ' on' : ''}" href="?by=style#/data/liked-music/bands">By style</a>
      <a class="dtab${mode === 'country' ? ' on' : ''}" href="?by=country#/data/liked-music/bands">By country</a>
    </div>`;
    view.innerHTML = `${head}
      <p class="ent-meta">${artists.length} resolved artists, grouped by ${mode === 'country' ? 'main country of origin' : 'top MusicBrainz genre'}.</p>
      ${toggle}
      ${sections.map(([key, list]) => `
        <h2 class="sect">${esc(key)} (${list.length})</h2>
        <div class="chips">${list.sort((x, y) => y.n - x.n).map((a) => `
          <a class="bchip" href="#/artist/${a.id}" style="border-color:${styleColor(a.genres?.[0]?.name, topStyles)}"
             title="${esc([a.mbName, a.type, a.beginArea || a.area, a.country, (a.genres || []).map((g) => g.name).slice(0, 3).join(', ')].filter(Boolean).join(' · '))}">
            ${esc(a.name)}<span class="bn">${a.n}</span>
            ${mode === 'style' && a.country ? `<span class="bc">${esc(a.country)}</span>` : ''}
            ${mode === 'country' && a.genres?.[0] ? `<span class="bc">${esc(a.genres[0].name)}</span>` : ''}
          </a>`).join('')}</div>`).join('')}`;
  }

  // Relationship graph: liked artists as nodes, an edge where two share a
  // member (or one is a member of / collaborator with the other).
  function viewGraph(head, d) {
    if (!d.enr) { view.innerHTML = `${head}<p class="loading">No resolved data yet.</p>`; return; }
    const { topStyles } = joinTracks(d);
    const counts = new Map();
    for (const t of d.liked.tracks) {
      const k = primaryName(t.artist);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const artists = Object.entries(d.enr.artists || {})
      .filter(([, a]) => a.id)
      .map(([name, a]) => ({ name, ...a, n: counts.get(name) || 0 }));
    const byId = new Map(artists.map((a) => [a.id, a]));

    // person id → the liked groups they play(ed) in.
    const memberOf = new Map();
    for (const a of artists) {
      for (const l of a.links || []) {
        if (l.rel !== 'member') continue;
        // group side sees members as backward; a liked person's own bands are forward.
        if (a.type === 'Person' && l.dir === 'forward') continue; // handled from the group side or as direct edge
        if (!memberOf.has(l.id)) memberOf.set(l.id, []);
        memberOf.get(l.id).push({ group: a, since: l.begin });
      }
    }
    const edges = new Map();
    const addEdge = (a, b, label) => {
      if (a.id === b.id) return;
      const key = [a.id, b.id].sort().join('|');
      if (!edges.has(key)) edges.set(key, { a, b, labels: new Set() });
      edges.get(key).labels.add(label);
    };
    for (const [pid, groups] of memberOf) {
      const person = byId.get(pid);
      const pname = person?.mbName || groups[0] && (artists.find((x) => (x.links || []).some((l) => l.id === pid))?.links.find((l) => l.id === pid)?.name) || '?';
      for (let i = 0; i < groups.length; i++) {
        for (let j = i + 1; j < groups.length; j++) addEdge(groups[i].group, groups[j].group, pname);
      }
      if (person) for (const g of groups) addEdge(person, g.group, 'member');
    }
    for (const a of artists) {
      for (const l of a.links || []) {
        if (byId.has(l.id) && l.rel === 'collab') addEdge(a, byId.get(l.id), 'collab');
        if (byId.has(l.id) && l.rel === 'member' && a.type === 'Person') addEdge(a, byId.get(l.id), 'member');
      }
    }

    const connected = new Set();
    for (const e of edges.values()) { connected.add(e.a.id); connected.add(e.b.id); }
    view.innerHTML = `${head}
      <p class="ent-meta">${connected.size} of ${artists.length} liked artists are linked by shared members or
        collaborations (${edges.size} connections). Unconnected artists are hidden — drag, scroll to zoom, click a node
        to open the artist.</p>
      <div id="dv-graph"></div>`;

    const els = [];
    for (const a of artists) {
      if (!connected.has(a.id)) continue;
      els.push({ data: { id: a.id, label: a.name, n: a.n,
        col: styleColor(a.genres?.[0]?.name, topStyles), person: a.type === 'Person' ? 1 : 0 } });
    }
    for (const e of edges.values()) {
      els.push({ data: { id: e.a.id + '|' + e.b.id, source: e.a.id, target: e.b.id,
        label: [...e.labels].slice(0, 3).join(', ') } });
    }
    const cy = cytoscape({
      container: document.getElementById('dv-graph'),
      elements: els,
      style: [
        { selector: 'node', style: {
          'background-color': 'data(col)',
          label: 'data(label)',
          color: '#e5edf0',
          'font-family': 'Quantico, sans-serif',
          'font-size': 11,
          'text-valign': 'bottom',
          'text-margin-y': 4,
          width: (n) => 12 + Math.min(n.data('n'), 60) * 0.5,
          height: (n) => 12 + Math.min(n.data('n'), 60) * 0.5,
        } },
        { selector: 'node[person = 1]', style: { shape: 'diamond' } },
        { selector: 'edge', style: {
          width: 1.4,
          'line-color': '#2e4a56',
          'curve-style': 'bezier',
          label: 'data(label)',
          'font-size': 8,
          color: '#91a7b0',
          'text-opacity': 0,
        } },
        { selector: 'edge:selected, edge.hl', style: { 'text-opacity': 1, 'line-color': '#2ee6c8' } },
        { selector: 'node:selected', style: { 'border-width': 2, 'border-color': '#fff' } },
      ],
      layout: { name: 'cose', idealEdgeLength: 110, nodeRepulsion: 120000, numIter: 2500, animate: false },
      wheelSensitivity: 0.3,
    });
    // The Claude preview pane loads pages at 0×0 — resize before fitting or
    // the viewport math is garbage (musikrawlr lesson).
    const ro = new ResizeObserver(() => { cy.resize(); cy.fit(undefined, 30); });
    ro.observe(document.getElementById('dv-graph'));
    cy.on('tap', 'node', (ev) => { location.hash = `#/artist/${ev.target.id()}`; });
    cy.on('mouseover', 'edge', (ev) => ev.target.addClass('hl'));
    cy.on('mouseout', 'edge', (ev) => ev.target.removeClass('hl'));
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
