# Extract your YouTube Music liked songs (instructions for Claude Code)

Paste everything below this line as a prompt to Claude Code. You need the
**Claude in Chrome** extension installed and signed in, and Chrome must be
logged into the Google account whose YouTube Music likes you want.

---

Please extract my YouTube Music "Liked Music" playlist to a JSON file. Follow
these steps exactly — they are known to work and avoid several traps.

**Step 1 — open the playlist.** Using the Claude in Chrome tools, open a tab at
`https://music.youtube.com/playlist?list=LM`. If it shows a sign-in page, stop
and ask me to sign in first.

**Step 2 — extract via the page's own API.** Do NOT try to scroll the page to
load all tracks (the lazy-loader ignores scripted scrolling). Instead run this
in the tab with the javascript tool — it calls YouTube's internal API with the
page's own credentials and pages through everything:

```js
const cfg = window.ytcfg.data_;
const sapisid = document.cookie.split('; ').find(c => c.startsWith('SAPISID=') || c.startsWith('__Secure-3PAPISID='))?.split('=')[1];
const ts = Math.floor(Date.now() / 1000);
const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${ts} ${sapisid} https://music.youtube.com`));
const hash = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const hdrs = { 'Content-Type': 'application/json',
  'Authorization': `SAPISIDHASH ${ts}_${hash}`,
  'X-Origin': 'https://music.youtube.com',
  'X-Goog-AuthUser': String(cfg.SESSION_INDEX ?? 0) };
const post = (body) => fetch(`/youtubei/v1/browse?key=${cfg.INNERTUBE_API_KEY}&prettyPrint=false`, {
  method: 'POST', headers: hdrs, credentials: 'include',
  body: JSON.stringify({context: cfg.INNERTUBE_CONTEXT, ...body})
}).then(r => r.json());
const txt = (fc) => fc?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map(r => r.text).join('') ?? '';
const parseItems = (items) => (items || []).flatMap(it => {
  const r = it.musicResponsiveListItemRenderer;
  if (!r) return [];
  const f = r.flexColumns || [];
  const dur = r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text ?? '';
  return [{title: txt(f[0]), artist: txt(f[1]), album: txt(f[2]), length: dur}];
});
const findCont = (items) => (items || []).map(it =>
  it.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token).find(Boolean);
const findShelf = (o) => { if (!o || typeof o !== 'object') return null;
  if (o.musicPlaylistShelfRenderer) return o.musicPlaylistShelfRenderer;
  for (const k in o) { const r = findShelf(o[k]); if (r) return r; } return null; };
const first = await post({browseId: 'VLLM'});
const shelf = findShelf(first);
const tracks = parseItems(shelf.contents);
let token = findCont(shelf.contents);
let guard = 0;
while (token && guard++ < 60) {
  const d = await post({continuation: token});
  const cont = d?.continuationContents?.musicPlaylistShelfContinuation;
  const items = cont?.contents || d?.onResponseReceivedActions?.[0]?.appendContinuationItemsAction?.continuationItems;
  if (!items) break;
  tracks.push(...parseItems(items));
  token = findCont(items) || cont?.continuations?.[0]?.nextContinuationData?.continuation;
}
tracks.forEach((t, i) => t.n = i + 1);
window.__payload = JSON.stringify({
  source: 'YouTube Music — Liked Music (playlist LM)',
  extracted: new Date().toISOString(),
  count: tracks.length,
  tracks
});
({count: tracks.length, bytes: window.__payload.length});
```

If the count is 0, the request went out unauthenticated — check the page is
signed in. Sanity-check the count against the number shown on the playlist
header (the API returns slightly fewer because deleted videos are skipped).

**Step 3 — get the data out via the clipboard.** Known traps: you cannot
`fetch` from the page to localhost (Chrome blocks it), `clipboard.writeText`
fails unless the tab has focus, and raw text through `pbpaste` corrupts
non-ASCII characters. The working pattern is an on-page button + base64:

```js
const bytes = new TextEncoder().encode(window.__payload);
let bin = '';
for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
window.__b64 = btoa(bin);
const ov = document.createElement('div');
ov.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center';
const btn = document.createElement('button');
btn.textContent = 'Copy my likes for Claude';
btn.style.cssText = 'font-size:24px;padding:20px 40px;background:#2ee6c8;border:none;cursor:pointer;font-weight:bold';
ov.appendChild(btn);
document.body.appendChild(ov);
btn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(window.__b64);
  window.__copied = true;
  btn.textContent = 'Copied ✓';
  setTimeout(() => ov.remove(), 2000);
});
'button installed';
```

Then ask me to click over to that YouTube Music tab and press the big teal
button. After I say it's done, confirm `window.__copied === true` in the tab.

**Step 4 — decode to a file and validate.** In the shell (macOS):

```bash
pbpaste | base64 -d > ~/Desktop/liked-music.json
node -e '
const d = JSON.parse(require("fs").readFileSync(process.env.HOME + "/Desktop/liked-music.json", "utf8"));
const bad = d.tracks.filter(t => /�/.test(t.title + t.artist + t.album)).length;
console.log("tracks:", d.tracks.length, "| corrupted:", bad, "| first:", d.tracks[0].title);
'
```

`corrupted` must be 0. (On Linux, use `xclip -selection clipboard -o` in place
of `pbpaste`.)

**Step 5 — done.** Tell me the file is at `~/Desktop/liked-music.json` and how
many tracks it holds. I'll send that one file onward myself.

---

*This file is part of [lykebrowsr](https://github.com/adriankingston/lykebrowsr);
the JSON it produces drops straight into the app's `data/` folder.*
