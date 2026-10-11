'use strict';

/* =====================================================================
   MyTube — app.js
   Sections: config · storage · cache · API · helpers · rendering ·
             list views · watch view · router · events
   ===================================================================== */

/* ---------- Config ---------- */
const REGION = 'US';            // region for "popular" charts, e.g. 'DK' for Denmark
const PAGE_SIZE = 24;
const MIN = 60 * 1000, HOUR = 60 * MIN;
const KEY_STORAGE = 'mytube_api_key';
const SAVED_STORAGE = 'mytube_saved';
const LIKED_STORAGE = 'mytube_liked';
const QUOTA_STORAGE = 'mytube_quota';
const AVATAR_STORAGE = 'mytube_avatars';
const SIDEBAR_STORAGE = 'mytube_sidebar';
const RECENT_STORAGE = 'mytube_recent';
const SEARCH_PAGE = 50;        // a search costs 100 units whatever the size, so ask for the max
const SEARCH_TTL = 6 * HOUR;   // repeat searches within this time cost nothing
const AUTO_PAGES = 8;           // infinite scroll loads this many pages by itself, then shows a button
const CACHE_PREFIX = 'mytube_cache_v1:';
const MAX_CACHE_ENTRIES = 80;
const DAILY_QUOTA = 10000;      // default YouTube Data API quota per day

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

/* ---------- Safe localStorage wrappers ---------- */
function lsGet(k, fallback = null) { try { const v = localStorage.getItem(k); return v === null ? fallback : v; } catch { return fallback; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } }
function lsRemove(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
function readSaved() { try { return JSON.parse(lsGet(SAVED_STORAGE, '[]')) || []; } catch { return []; } }
function readAvatars() { try { return JSON.parse(lsGet(AVATAR_STORAGE, '{}')) || {}; } catch { return {}; } }
function readLiked() { try { return JSON.parse(lsGet(LIKED_STORAGE, '[]')) || []; } catch { return []; } }

/* ---------- State ---------- */
const state = {
  key: lsGet(KEY_STORAGE, ''),
  saved: readSaved(),
  liked: readLiked(),   // likes are stored in this browser only
  avatars: readAvatars(), // channel id -> avatar url ('' = none), kept in this browser
  watch: null,         // state of the open watch page
  token: 0,            // incremented on every navigation; stale async work checks it
  list: null,          // current paged list
  index: new Map()     // video id -> normalized video (used by save buttons)
};

/* ---------- Elements ---------- */
const results = $('#results'), statusEl = $('#status'), emptyEl = $('#empty'), moreBtn = $('#more'), sentinel = $('#sentinel');

/* =====================================================================
   Cache (memory + localStorage, with expiry) and quota estimate
   ===================================================================== */
const memCache = new Map();

function cacheKey(path, params) {
  const parts = Object.keys(params).sort()
    .filter(k => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .map(k => k + '=' + params[k]);
  return path + '?' + parts.join('&');
}

function cacheGet(ck) {
  const now = Date.now();
  const m = memCache.get(ck);
  if (m && m.exp > now) return m.data;
  const raw = lsGet(CACHE_PREFIX + ck);
  if (!raw) return null;
  try {
    const e = JSON.parse(raw);
    if (e.exp > now) { memCache.set(ck, e); return e.data; }
  } catch { /* fall through */ }
  lsRemove(CACHE_PREFIX + ck);
  return null;
}

function cacheSet(ck, data, ttl) {
  const e = { exp: Date.now() + ttl, at: Date.now(), data };
  memCache.set(ck, e);
  const raw = JSON.stringify(e);
  if (!lsSet(CACHE_PREFIX + ck, raw)) {   // storage full: make room and retry once
    pruneCache(true);
    lsSet(CACHE_PREFIX + ck, raw);
  }
}

function cacheEntries() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(CACHE_PREFIX)) continue;
      try { const e = JSON.parse(localStorage.getItem(k)); out.push({ k, exp: e.exp || 0, at: e.at || 0 }); }
      catch { out.push({ k, exp: 0, at: 0 }); }
    }
  } catch { /* ignore */ }
  return out;
}

function pruneCache(force = false) {
  const now = Date.now();
  const entries = cacheEntries();
  entries.filter(e => e.exp <= now).forEach(e => lsRemove(e.k));
  const live = entries.filter(e => e.exp > now).sort((a, b) => a.at - b.at);
  const limit = force ? Math.floor(MAX_CACHE_ENTRIES / 2) : MAX_CACHE_ENTRIES;
  while (live.length > limit) lsRemove(live.shift().k);
}

function clearCache() {
  memCache.clear();
  cacheEntries().forEach(e => lsRemove(e.k));
}

/* Quota resets at midnight Pacific Time. This is only an estimate. */
function pacificDay() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); }
function readQuota() {
  try { const q = JSON.parse(lsGet(QUOTA_STORAGE, 'null')); if (q && q.day === pacificDay()) return q; } catch { /* ignore */ }
  return { day: pacificDay(), units: 0 };
}
function addQuota(n) { const q = readQuota(); q.units += n; lsSet(QUOTA_STORAGE, JSON.stringify(q)); renderQuota(); }
function renderQuota() {
  $('#quota').textContent = `≈ ${readQuota().units.toLocaleString()} of ${DAILY_QUOTA.toLocaleString()} daily quota units used (estimate)`;
}

/* =====================================================================
   YouTube API
   ===================================================================== */
class ApiError extends Error {
  constructor(message, code, reason) { super(message); this.code = code; this.reason = reason; }
}

async function api(path, params = {}, { ttl = 30 * MIN } = {}) {
  if (!state.key) throw new ApiError('Add your API key first.', 'NOKEY');
  const ck = cacheKey(path, params);
  const hit = cacheGet(ck);
  if (hit) return hit;

  const u = new URL('https://www.googleapis.com/youtube/v3/' + path);
  Object.entries({ ...params, key: state.key }).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  });

  let r;
  try { r = await fetch(u); }
  catch { throw new ApiError('Network error. Check your internet connection.', 'NETWORK'); }
  let d = {};
  try { d = await r.json(); } catch { /* non-JSON error body */ }
  addQuota(path === 'search' ? 100 : 1);

  if (!r.ok) {
    const reason = d.error?.errors?.[0]?.reason;
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
      throw new ApiError('Your daily YouTube API quota is used up. It resets at midnight Pacific Time.', 'QUOTA');
    }
    throw new ApiError(d.error?.message || 'YouTube API request failed', 'HTTP', reason);
  }
  if (ttl > 0) cacheSet(ck, d, ttl);
  return d;
}

/* =====================================================================
   Helpers
   ===================================================================== */
function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function decodeEntities(s = '') { const t = document.createElement('textarea'); t.innerHTML = s; return t.value; }
function shortNum(n) {
  const x = Number(n || 0);
  return x >= 1e9 ? (x / 1e9).toFixed(1) + 'B' : x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'K' : String(x);
}
function timeAgo(iso) {
  const t = Date.parse(iso);
  if (!t) return '';
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [name, sec] of units) {
    if (s >= sec) { const c = Math.floor(s / sec); return c + ' ' + name + (c > 1 ? 's' : '') + ' ago'; }
  }
  return 'just now';
}

/* Turn an API item into { id, snippet, statistics }. Search results return
   HTML-escaped text, so those are decoded first. */
function norm(v, decode = false) {
  const id = (typeof v.id === 'string') ? v.id : (v.id?.videoId || '');
  let snippet = v.snippet || {};
  if (decode) {
    snippet = { ...snippet, title: decodeEntities(snippet.title), channelTitle: decodeEntities(snippet.channelTitle), description: decodeEntities(snippet.description) };
  }
  return { id, snippet, statistics: v.statistics || null, duration: v.contentDetails ? parseDuration(v.contentDetails.duration) : 0 };
}

const icon = n => `<svg class="i" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const saveLabel = on => on ? icon('check') + ' Saved' : icon('plus') + ' Watch later';

function durBadge(v) {
  const b = v.snippet?.liveBroadcastContent;
  const live = b === 'live', soon = b === 'upcoming';
  const text = live ? 'LIVE' : soon ? 'UPCOMING' : fmtDuration(v.duration);
  return text ? `<span class="dur${live ? ' live' : soon ? ' upcoming' : ''}">${text}</span>` : '';
}

function avatarColor(name = '') {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 42% 34%)`;
}

/* Real channel avatars: one channels call (1 unit) covers up to 50 channels,
   and every answer is remembered in this browser so each channel is looked up once. */
const pendingAvatars = new Set();

function paintAvatars() {
  $$('.channel-avatar[data-cid]:not(.has-img)').forEach(el => {
    const url = state.avatars[el.dataset.cid];
    if (!url) return;
    const im = document.createElement('img');
    im.className = 'avatar-img'; im.alt = ''; im.src = url; im.referrerPolicy = 'no-referrer';
    el.textContent = '';
    el.appendChild(im);
    el.classList.add('has-img');
  });
}

async function hydrateAvatars(items) {
  if (!state.key) return;
  const missing = [...new Set(items.map(v => v.snippet?.channelId).filter(id => id && !(id in state.avatars) && !pendingAvatars.has(id)))];
  if (!missing.length) return;
  missing.forEach(id => pendingAvatars.add(id));
  try {
    for (let i = 0; i < missing.length; i += 50) {
      const batch = missing.slice(i, i + 50);
      const d = await api('channels', { part: 'snippet', id: batch.join(','), maxResults: 50 }, { ttl: 0 });
      const found = new Map((d.items || []).map(c => [c.id, c.snippet?.thumbnails?.default?.url || c.snippet?.thumbnails?.medium?.url || '']));
      batch.forEach(id => { state.avatars[id] = found.get(id) || ''; });
    }
  } catch { /* avatars are optional: letters stay, and we try again next time */ }
  missing.forEach(id => pendingAvatars.delete(id));
  const keys = Object.keys(state.avatars);
  if (keys.length > 800) keys.slice(0, keys.length - 600).forEach(k => delete state.avatars[k]);
  lsSet(AVATAR_STORAGE, JSON.stringify(state.avatars));
  paintAvatars();
}

function isSaved(id) { return state.saved.some(x => x.id === id); }
function isLiked(id) { return state.liked.some(x => x.id === id); }
function setStatus(t) { statusEl.textContent = t; }

function showEmpty(title, msg, showSetup = false) {
  $('#emptyTitle').textContent = title;
  $('#emptyMsg').textContent = msg;
  $('#emptySettings').classList.toggle('hidden', !showSetup);
  emptyEl.classList.remove('hidden');
}
function hideEmpty() { emptyEl.classList.add('hidden'); }

function openSettings(open = true) {
  $('#settingsModal').classList.toggle('open', open);
  if (open) $('#apiKey').value = state.key;
}

/* =====================================================================
   Rendering
   ===================================================================== */
function render(items, append = false) {
  if (!append) results.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const v of items) {
    if (!v.id) continue;
    state.index.set(v.id, v);
    const sn = v.snippet;
    const thumb = sn.thumbnails?.medium?.url || sn.thumbnails?.high?.url || sn.thumbnails?.default?.url || '';
    const channel = sn.channelTitle || 'YouTube channel';
    const watchHref = '#/watch?v=' + encodeURIComponent(v.id);
    const chHref = sn.channelId ? '#/channel/' + encodeURIComponent(sn.channelId) : '';
    const avatarInner = escapeHtml(channel.slice(0, 1));
    const avStyle = `style="background:${avatarColor(channel)}"`;
    const avatar = chHref
      ? `<a class="channel-avatar" ${avStyle} data-cid="${escapeHtml(sn.channelId)}" href="${chHref}" aria-label="${escapeHtml(channel)}">${avatarInner}</a>`
      : `<div class="channel-avatar" ${avStyle}>${avatarInner}</div>`;
    const channelLine = chHref
      ? `<a class="meta" href="${chHref}">${escapeHtml(channel)}</a>`
      : `<div class="meta">${escapeHtml(channel)}</div>`;
    const meta = [v.statistics?.viewCount ? shortNum(v.statistics.viewCount) + ' views' : '', timeAgo(sn.publishedAt)].filter(Boolean).join(' · ');

    const card = document.createElement('article');
    if (results.classList.contains('list-layout')) {
      const desc = (sn.description || '').replace(/\s+/g, ' ').trim().slice(0, 220);
      card.className = 'video row';
      card.innerHTML = `
        <a class="thumb-link" href="${watchHref}"><img class="thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy">${durBadge(v)}</a>
        <div class="row-text">
          <h3><a href="${watchHref}">${escapeHtml(sn.title || 'Untitled video')}</a></h3>
          <div class="meta">${escapeHtml(meta)}</div>
          ${chHref
            ? `<a class="row-channel" href="${chHref}"><span class="channel-avatar sm" ${avStyle} data-cid="${escapeHtml(sn.channelId)}">${avatarInner}</span><span class="meta">${escapeHtml(channel)}</span></a>`
            : `<div class="meta">${escapeHtml(channel)}</div>`}
          ${desc ? `<p class="row-desc">${escapeHtml(desc)}</p>` : ''}
          <button class="save-video secondary" data-id="${escapeHtml(v.id)}">${saveLabel(isSaved(v.id))}</button>
        </div>`;
      frag.appendChild(card);
      continue;
    }
    card.className = 'video';
    card.innerHTML = `
      <a class="thumb-link" href="${watchHref}"><img class="thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy">${durBadge(v)}</a>
      <div class="video-info">
        ${avatar}
        <div class="video-text">
          <h3><a href="${watchHref}">${escapeHtml(sn.title || 'Untitled video')}</a></h3>
          ${channelLine}
          <div class="meta">${escapeHtml(meta)}</div>
          <button class="save-video secondary" data-id="${escapeHtml(v.id)}">${saveLabel(isSaved(v.id))}</button>
        </div>
      </div>`;
    frag.appendChild(card);
  }
  results.appendChild(frag);
  paintAvatars();
  hydrateAvatars(items);
}

/* Grey shimmering cards shown while a page is loading */
function showSkeletons(n) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const el = document.createElement('article');
    const row = results.classList.contains('list-layout');
    el.className = 'video skeleton' + (row ? ' row' : '');
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = row
      ? '<div class="sk sk-thumb"></div><div class="row-text"><div class="sk sk-line" style="width:80%"></div><div class="sk sk-line" style="width:35%"></div><div class="sk sk-line" style="width:55%"></div></div>'
      : '<div class="sk sk-thumb"></div><div class="video-info"><div class="sk sk-avatar"></div><div class="video-text" style="flex:1"><div class="sk sk-line" style="width:92%"></div><div class="sk sk-line" style="width:60%"></div><div class="sk sk-line" style="width:40%"></div></div></div>';
    frag.appendChild(el);
  }
  results.appendChild(frag);
}
function clearSkeletons() { results.querySelectorAll('.skeleton').forEach(e => e.remove()); }

function updateSaveButtons() {
  $$('.save-video').forEach(b => { b.innerHTML = saveLabel(isSaved(b.dataset.id)); });
}

function toggleSaved(id) {
  const v = state.index.get(id);
  if (!v) return;
  const i = state.saved.findIndex(x => x.id === id);
  if (i >= 0) state.saved.splice(i, 1); else state.saved.unshift({ id, snippet: v.snippet });
  lsSet(SAVED_STORAGE, JSON.stringify(state.saved));
  if (currentRoute().name === 'saved') renderSaved(); else updateSaveButtons();
}

/* =====================================================================
   List views (home, search, trending, categories, channel, saved)
   ===================================================================== */
function popularPage(categoryId) {
  const fetchPage = async pageToken => {
    const d = await api('videos', {
      part: 'snippet,statistics,contentDetails', chart: 'mostPopular', regionCode: REGION,
      maxResults: PAGE_SIZE, videoCategoryId: categoryId, pageToken
    }, { ttl: 15 * MIN });
    return { items: (d.items || []).map(v => norm(v)), next: d.nextPageToken || null };
  };
  fetchPage.cheap = () => true;   // 1 quota unit per page, so infinite scroll is fine
  return fetchPage;
}

function searchPage(q, extra = {}) {
  return async pageToken => {
    const d = await api('search', {
      part: 'snippet', type: 'video', q, maxResults: SEARCH_PAGE,
      safeSearch: 'moderate', pageToken, ...extra
    }, { ttl: SEARCH_TTL });
    const items = (d.items || []).map(v => norm(v, true));
    return { items: await withDetails(items), next: d.nextPageToken || null };
  };
}

/* Search results carry no duration or view count. One videos call (1 unit) adds both. */
async function withDetails(items) {
  const ids = items.map(v => v.id).filter(Boolean);
  if (!ids.length) return items;
  try {
    const d = await api('videos', { part: 'snippet,statistics,contentDetails', id: ids.join(',') }, { ttl: SEARCH_TTL });
    const full = new Map((d.items || []).map(x => [x.id, norm(x)]));
    const out = items.map(v => full.get(v.id)).filter(Boolean);   // also drops deleted/private videos
    return out.length ? out : items;
  } catch { return items; }
}

/* Chart calls cost 1 quota unit, searches cost 100. Use the chart for a
   category and fall back to search if the region has no chart for it. */
function categoryPage(cat) {
  const chart = popularPage(cat.id), search = searchPage(cat.q);
  let useSearch = false;
  const fetchPage = async token => {
    if (useSearch) return search(token);
    try { return await chart(token); }
    catch (e) { if (e.code === 'HTTP') { useSearch = true; return search(token); } throw e; }
  };
  fetchPage.cheap = () => !useSearch;
  return fetchPage;
}

function startList(cfg) {
  showView('list');
  $('#pageTitle').textContent = cfg.title;
  $('#subtitle').textContent = cfg.subtitle || '';
  document.title = cfg.title + ' — MyTube';
  $('#chips').classList.toggle('hidden', !cfg.chips);
  setActiveChip(cfg.chipQuery);
  results.innerHTML = '';
  moreBtn.classList.add('hidden');
  hideEmpty();
  clearSkeletons();
  results.classList.toggle('list-layout', !!cfg.layout);
  $('#filters').classList.toggle('hidden', !cfg.filters);

  if (!state.key) {
    state.list = null;
    setStatus('Add your YouTube API key to load real videos.');
    showEmpty('Welcome to MyTube', 'Add your YouTube Data API key to load real video results.', true);
    return;
  }
  state.list = { ...cfg, next: null, items: [], busy: false, pages: 0, paused: false, dur: cfg.dur || 'any', sort: cfg.sort || 'relevance' };
  loadPage(false);
}

/* Duration and sort work on what is already loaded, so changing them is free. */
const durClass = v => !v.duration ? '' : v.duration < 240 ? 'short' : v.duration <= 1200 ? 'medium' : 'long';

function viewItems(L) {
  let a = L.items.slice();
  if (L.dur !== 'any') a = a.filter(v => durClass(v) === L.dur);
  if (L.sort === 'date') a.sort((x, y) => Date.parse(y.snippet.publishedAt) - Date.parse(x.snippet.publishedAt));
  else if (L.sort === 'views') a.sort((x, y) => Number(y.statistics?.viewCount || 0) - Number(x.statistics?.viewCount || 0));
  return a;
}

function renderView() {
  const L = state.list;
  if (!L) return;
  const view = viewItems(L);
  render(view, false);
  if (L.items.length && !view.length) {
    showEmpty('No videos match these filters', 'Try another duration, or load more results.');
    setStatus('');
  } else {
    hideEmpty();
    setStatus(L.dur !== 'any' ? `${view.length} of ${L.items.length} loaded videos match.` : `${L.items.length} results.`);
  }
}

/* Infinite scroll only runs for cheap (1-unit) pages. Searches cost 100 units
   a page, so they keep a "Load more" button, and so does a list that hit its
   automatic page limit or had an error. */
function autoActive(L) {
  const cheap = typeof L.fetchPage.cheap === 'function' ? L.fetchPage.cheap() : false;
  return cheap && !L.paused && L.pages < AUTO_PAGES;
}

function updateMore() {
  const L = state.list;
  moreBtn.classList.toggle('hidden', !(L && L.next && !autoActive(L)));
}

function pokeSentinel() { if (sentinelObs) { sentinelObs.unobserve(sentinel); sentinelObs.observe(sentinel); } }

let sentinelObs = null;
if (typeof IntersectionObserver !== 'undefined') {
  sentinelObs = new IntersectionObserver(entries => {
    const L = state.list;
    if (entries.some(e => e.isIntersecting) && L && L.next && !L.busy && autoActive(L)) loadPage(true);
  }, { rootMargin: '700px 0px' });
  sentinelObs.observe(sentinel);
}

async function loadPage(append) {
  const L = state.list;
  if (!L || L.busy) return;
  L.busy = true;
  moreBtn.disabled = true;
  moreBtn.classList.add('hidden');
  setStatus(append ? '' : 'Loading videos…');
  showSkeletons(append ? 6 : 12);
  try {
    const { items, next } = await L.fetchPage(append ? L.next : null);
    if (L !== state.list) return;
    clearSkeletons();
    L.next = next;
    L.pages++;
    L.paused = false;
    L.items = L.items.concat(items);
    if (!L.clientFilter) render(items, append);
    if (L.afterLoad && !append && items[0]) L.afterLoad(items);
    if (!L.items.length) { showEmpty('No videos found', 'Try a different search.'); setStatus(''); }
    else if (L.clientFilter) renderView();
    else { hideEmpty(); setStatus(autoActive(L) ? '' : `${L.items.length} videos loaded.`); }
  } catch (e) {
    if (L !== state.list) return;
    clearSkeletons();
    L.paused = true;   // stop auto-loading; the button below becomes a retry
    if (e.code === 'NOKEY') { showEmpty('Welcome to MyTube', 'Add your YouTube Data API key to load real video results.', true); setStatus(''); return; }
    setStatus('Could not load videos: ' + e.message);
    if (!append) showEmpty('Could not load videos', e.code === 'QUOTA' ? e.message : 'Check your API key, quota, internet connection, and that YouTube Data API v3 is enabled.');
  } finally {
    L.busy = false;
    moreBtn.disabled = false;
    if (L === state.list) { updateMore(); pokeSentinel(); }
  }
}

function renderSaved() {
  const items = state.saved.map(x => ({ id: x.id, snippet: x.snippet || {}, statistics: null }));
  render(items, false);
  moreBtn.classList.add('hidden');
  if (!items.length) { showEmpty('Nothing saved yet', 'Tap “Watch later” on any video and it will show up here.'); setStatus(''); }
  else { hideEmpty(); setStatus(`${items.length} saved video${items.length === 1 ? '' : 's'}.`); }
}

/* =====================================================================
   Watch view: player, info row, description, related videos, comments
   ===================================================================== */
function showView(name) {
  $('#listView').classList.toggle('hidden', name !== 'list');
  $('#watchView').classList.toggle('hidden', name !== 'watch');
}

function embedUrl(id, start = 0) {
  return 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id) + '?autoplay=1&rel=0' + (start ? '&start=' + start : '');
}

function closeWatch() {
  const p = $('#player');
  if (p.getAttribute('src')) p.src = 'about:blank';   // stops playback
  if (state.watch && state.watch.obs) state.watch.obs.disconnect();
  state.watch = null;
}

function seekTo(sec) {
  if (!state.watch) return;
  $('#player').src = embedUrl(state.watch.id, sec);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------- Small helpers ---------- */
function parseDuration(iso = '') {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

function fmtDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/* Turn plain text into DOM with clickable links and timestamps. Built from
   text nodes and anchors only, so nothing from YouTube is parsed as HTML. */
const LINK_RE = /(https?:\/\/[^\s<]+)|(\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b)/g;
function linkify(text = '') {
  const frag = document.createDocumentFragment();
  let last = 0, m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(text))) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[1]) {
      let url = m[1], trail = '';
      const t = /[.,;:!?)\]]+$/.exec(url);
      if (t) { trail = t[0]; url = url.slice(0, -trail.length); }
      const a = document.createElement('a');
      a.href = url; a.textContent = url; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow';
      frag.appendChild(a);
      if (trail) frag.appendChild(document.createTextNode(trail));
    } else {
      const parts = m[2].split(':').map(Number);
      const sec = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
      const valid = parts[parts.length - 1] < 60 && (parts.length < 3 || parts[1] < 60);
      if (valid) {
        const a = document.createElement('a');
        a.href = '#'; a.className = 'ts'; a.dataset.t = String(sec); a.textContent = m[2];
        frag.appendChild(a);
      } else {
        frag.appendChild(document.createTextNode(m[2]));
      }
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------- Like / share ---------- */
function updateLikeButton() {
  const w = state.watch;
  if (!w) return;
  const on = isLiked(w.id);
  $('#watchLike').classList.toggle('on', on);
  $('#watchLike').setAttribute('aria-pressed', String(on));
}

function toggleLiked(id) {
  const v = state.index.get(id);
  if (!v) return;
  const i = state.liked.findIndex(x => x.id === id);
  if (i >= 0) state.liked.splice(i, 1); else state.liked.unshift({ id, snippet: v.snippet });
  lsSet(LIKED_STORAGE, JSON.stringify(state.liked));
  updateLikeButton();
}

async function shareVideo() {
  if (!state.watch) return;
  const url = location.href, title = $('#watchTitle').textContent;
  if (navigator.share) {
    try { await navigator.share({ title, url }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('Link copied'); }
  catch { window.prompt('Copy this link:', url); }
}

/* ---------- Watch page content ---------- */
function resetWatchUi(id) {
  $('#watchTitle').textContent = 'Loading…';
  $('#watchNote').textContent = '';
  $('#watchChannelName').textContent = '';
  $('#watchSubs').textContent = '';
  $('#watchAvatar').textContent = '';
  $('#watchChannel').setAttribute('href', '#/');
  $('#watchLike').classList.add('hidden');
  $('#watchSave').classList.add('hidden');
  $('#watchOpen').setAttribute('href', 'https://www.youtube.com/watch?v=' + encodeURIComponent(id));
  $('#descBox').classList.add('hidden');
  $('#descBox').classList.remove('open');
  $('#watchDesc').textContent = '';
  $('#descToggle').textContent = '…more';
  $('#descToggle').classList.add('hidden');
  $('#relatedList').innerHTML = '<p class="meta">Loading suggestions…</p>';
  $('#comments').classList.add('hidden');
  $('#commentsList').textContent = '';
  $('#commentsStatus').textContent = '';
  $('#commentsCount').textContent = 'Comments';
  $('#moreComments').classList.add('hidden');
  $('#commentSort').classList.remove('hidden');
  $$('#commentSort button').forEach(b => b.classList.toggle('active', b.dataset.sort === 'relevance'));
}

function setDescOpen(open) {
  const w = state.watch;
  if (!w) return;
  $('#descBox').classList.toggle('open', open);
  $('#descToggle').textContent = open ? 'Show less' : '…more';
  $('#watchStats').textContent = open ? w.statsFull : w.statsShort;
}

function fillWatch(v) {
  const w = state.watch, sn = v.snippet, st = v.statistics || {};
  document.title = (sn.title || 'Watch') + ' — MyTube';
  $('#watchTitle').textContent = sn.title || 'Untitled video';
  $('#watchChannelName').textContent = sn.channelTitle || '';
  $('#watchAvatar').textContent = (sn.channelTitle || '').slice(0, 1).toUpperCase();
  if (sn.channelId) $('#watchChannel').setAttribute('href', '#/channel/' + encodeURIComponent(sn.channelId));

  const views = st.viewCount !== undefined ? Number(st.viewCount) : null;
  const date = sn.publishedAt ? new Date(sn.publishedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  w.statsShort = [views !== null ? shortNum(views) + ' views' : '', timeAgo(sn.publishedAt)].filter(Boolean).join(' · ');
  w.statsFull = [views !== null ? views.toLocaleString() + ' views' : '', date].filter(Boolean).join(' · ');
  $('#watchStats').textContent = w.statsShort;

  const text = sn.description || '';
  const desc = $('#watchDesc');
  desc.textContent = '';
  desc.appendChild(linkify(text));
  $('#descToggle').classList.toggle('hidden', !text);
  $('#descBox').classList.remove('hidden');

  $('#likeCount').textContent = st.likeCount !== undefined ? shortNum(st.likeCount) : 'Like';
  $('#watchLike').dataset.id = v.id;
  $('#watchLike').classList.remove('hidden');
  $('#watchSave').dataset.id = v.id;
  $('#watchSave').innerHTML = saveLabel(isSaved(v.id));
  $('#watchSave').classList.remove('hidden');
  updateLikeButton();
}

async function showWatch(token, id) {
  showView('watch');
  document.title = 'Watch — MyTube';
  const w = state.watch = { id, video: null, sort: 'relevance', nextComments: null, commentsReq: 0, obs: null, statsShort: '', statsFull: '' };
  $('#player').src = embedUrl(id);
  resetWatchUi(id);

  try {
    const d = await api('videos', { part: 'snippet,statistics,contentDetails', id }, { ttl: HOUR });
    if (token !== state.token) return;
    const raw = d.items && d.items[0];
    if (!raw) { $('#watchTitle').textContent = 'Video unavailable'; $('#relatedList').textContent = ''; return; }
    const v = norm(raw);
    state.index.set(v.id, v);
    w.video = v;
    fillWatch(v);
    loadChannelInfo(token, v);   // these three run on their own and can fail separately
    loadRelated(token, v);
    armComments(token, v);
  } catch (e) {
    if (token !== state.token) return;
    $('#relatedList').textContent = '';
    if (e.code === 'NOKEY') {
      $('#watchTitle').textContent = 'Video';
      $('#watchNote').textContent = 'Add an API key to see the title, suggestions and comments.';
    } else {
      $('#watchTitle').textContent = 'Could not load details';
      $('#watchNote').textContent = e.message;
    }
  }
}

async function loadChannelInfo(token, v) {
  const cid = v.snippet.channelId;
  if (!cid) return;
  try {
    const d = await api('channels', { part: 'snippet,statistics', id: cid }, { ttl: HOUR });
    if (token !== state.token) return;
    const ch = d.items && d.items[0];
    if (!ch) return;
    const img = ch.snippet?.thumbnails?.default?.url || ch.snippet?.thumbnails?.medium?.url;
    if (img) {
      const im = document.createElement('img');
      im.className = 'avatar-img'; im.alt = ''; im.src = img;
      const av = $('#watchAvatar');
      av.textContent = '';
      av.appendChild(im);
    }
    const s = ch.statistics || {};
    $('#watchSubs').textContent = (!s.hiddenSubscriberCount && s.subscriberCount) ? shortNum(s.subscriberCount) + ' subscribers' : '';
  } catch { /* channel info is optional */ }
}

/* ---------- Related videos ----------
   YouTube shut off its "related videos" API in 2023, so this is an
   approximation: recent uploads from the same channel mixed with what is
   popular in the same category. Costs about 3 quota units. */
function mixLists(a, b, currentId, max = 20) {
  const seen = new Set([currentId]), out = [];
  for (let i = 0; out.length < max && (i < a.length || i < b.length); i++) {
    for (const x of [a[i], b[i]]) {
      if (x && x.id && !seen.has(x.id) && out.length < max) { seen.add(x.id); out.push(x); }
    }
  }
  return out;
}

function relatedEl(v) {
  const sn = v.snippet;
  const thumb = sn.thumbnails?.medium?.url || sn.thumbnails?.high?.url || sn.thumbnails?.default?.url || '';
  const meta = [v.statistics?.viewCount ? shortNum(v.statistics.viewCount) + ' views' : '', timeAgo(sn.publishedAt)].filter(Boolean).join(' · ');
  const a = document.createElement('a');
  a.className = 'rel';
  a.href = '#/watch?v=' + encodeURIComponent(v.id);
  a.innerHTML = `
    <div class="thumb-wrap"><img class="thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy">${durBadge(v)}</div>
    <div class="rel-text">
      <h3>${escapeHtml(sn.title || 'Untitled video')}</h3>
      <div class="meta">${escapeHtml(sn.channelTitle || '')}</div>
      <div class="meta">${escapeHtml(meta)}</div>
    </div>`;
  return a;
}

async function loadRelated(token, v) {
  const listEl = $('#relatedList');
  const cid = v.snippet.channelId, cat = v.snippet.categoryId;
  const part = 'snippet,statistics,contentDetails';

  const fromChannel = async () => {
    if (!cid || !cid.startsWith('UC')) return [];
    const pl = await api('playlistItems', { part: 'contentDetails', playlistId: 'UU' + cid.slice(2), maxResults: 15 }, { ttl: 30 * MIN });
    const ids = (pl.items || []).map(i => i.contentDetails?.videoId).filter(Boolean);
    if (!ids.length) return [];
    const d = await api('videos', { part, id: ids.join(',') }, { ttl: 30 * MIN });
    return (d.items || []).map(x => norm(x));
  };
  const fromPopular = async () => {
    try { return (await popularPage(cat)(null)).items; }
    catch (e) { if (cat && e.code === 'HTTP') return (await popularPage()(null)).items; throw e; }
  };

  const [a, b] = await Promise.allSettled([fromChannel(), fromPopular()]);
  if (token !== state.token) return;
  const out = mixLists(a.status === 'fulfilled' ? a.value : [], b.status === 'fulfilled' ? b.value : [], v.id);
  listEl.textContent = '';
  if (!out.length) {
    const err = (a.status === 'rejected' && a.reason) || (b.status === 'rejected' && b.reason);
    const p = document.createElement('p');
    p.className = 'meta';
    p.textContent = err ? 'Could not load suggestions: ' + err.message : 'No suggestions available.';
    listEl.appendChild(p);
    return;
  }
  const frag = document.createDocumentFragment();
  out.forEach(x => { state.index.set(x.id, x); frag.appendChild(relatedEl(x)); });
  listEl.appendChild(frag);
}

/* ---------- Comments (read-only) ----------
   Loaded when the section scrolls into view, so videos you only watch
   don't spend quota on comments. */
function armComments(token, v) {
  const w = state.watch;
  const count = v.statistics?.commentCount;
  $('#commentsCount').textContent = count !== undefined ? Number(count).toLocaleString() + ' Comments' : 'Comments';
  $('#comments').classList.remove('hidden');
  const start = () => { if (token === state.token && state.watch === w) loadComments(token, false); };
  if (typeof IntersectionObserver === 'undefined') { start(); return; }
  w.obs = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) { w.obs.disconnect(); start(); }
  }, { rootMargin: '300px' });
  w.obs.observe($('#comments'));
}

async function loadComments(token, append) {
  const w = state.watch;
  if (!w) return;
  const req = ++w.commentsReq;
  const list = $('#commentsList'), st = $('#commentsStatus'), btn = $('#moreComments');
  btn.disabled = true;
  st.textContent = 'Loading comments…';
  try {
    const d = await api('commentThreads', {
      part: 'snippet,replies', videoId: w.id, order: w.sort, maxResults: 20,
      textFormat: 'plainText', pageToken: append ? w.nextComments : undefined
    }, { ttl: 15 * MIN });
    if (token !== state.token || req !== w.commentsReq) return;
    const items = d.items || [];
    const frag = document.createDocumentFragment();
    items.forEach(it => frag.appendChild(threadEl(it)));
    list.appendChild(frag);
    w.nextComments = d.nextPageToken || null;
    st.textContent = (!append && !items.length) ? 'No comments yet.' : '';
    btn.classList.toggle('hidden', !w.nextComments);
  } catch (e) {
    if (token !== state.token || req !== w.commentsReq) return;
    if (e.reason === 'commentsDisabled') {
      st.textContent = 'Comments are turned off for this video.';
      $('#commentSort').classList.add('hidden');
      $('#commentsCount').textContent = 'Comments';
    } else if (e.code === 'NOKEY') {
      st.textContent = '';
    } else {
      st.textContent = 'Could not load comments: ' + e.message;
    }
  } finally {
    if (req === w.commentsReq) btn.disabled = false;
  }
}

function commentEl(c, isReply = false) {
  const s = c.snippet || {};
  const ownerId = state.watch?.video?.snippet?.channelId;
  const authorId = s.authorChannelId?.value;
  const el = document.createElement('div');
  el.className = 'comment' + (isReply ? ' reply' : '');

  const av = document.createElement('img');
  av.className = 'c-avatar'; av.alt = ''; av.loading = 'lazy'; av.referrerPolicy = 'no-referrer';
  if (s.authorProfileImageUrl) av.src = s.authorProfileImageUrl;

  const body = document.createElement('div');
  body.className = 'c-body';

  const head = document.createElement('div');
  head.className = 'c-head';
  const name = document.createElement(authorId ? 'a' : 'span');
  name.className = 'c-author' + (authorId && authorId === ownerId ? ' owner' : '');
  name.textContent = s.authorDisplayName || 'Unknown';
  if (authorId) name.href = '#/channel/' + encodeURIComponent(authorId);
  const when = document.createElement('span');
  when.className = 'meta';
  const edited = s.updatedAt && s.publishedAt && Date.parse(s.updatedAt) - Date.parse(s.publishedAt) > 60000;
  when.textContent = timeAgo(s.publishedAt) + (edited ? ' (edited)' : '');
  head.append(name, when);

  const text = document.createElement('div');
  text.className = 'c-text';
  text.appendChild(linkify(s.textDisplay || s.textOriginal || ''));

  const foot = document.createElement('div');
  foot.className = 'meta';
  foot.innerHTML = icon('thumb') + (s.likeCount ? ' ' + shortNum(s.likeCount) : '');

  body.append(head, text, foot);
  el.append(av, body);
  return el;
}

function threadEl(item) {
  const top = item.snippet.topLevelComment;
  const el = document.createElement('div');
  el.className = 'thread';
  el.appendChild(commentEl(top));

  const total = item.snippet.totalReplyCount || 0;
  if (!total) return el;

  const label = `${total} ${total === 1 ? 'reply' : 'replies'}`;
  const btn = document.createElement('button');
  btn.className = 'replies-btn';
  btn.textContent = 'Show ' + label;
  const box = document.createElement('div');
  box.className = 'replies hidden';
  let loaded = false;
  const byDate = (a, b) => Date.parse(a.snippet.publishedAt) - Date.parse(b.snippet.publishedAt);

  btn.addEventListener('click', async () => {
    const willOpen = box.classList.contains('hidden');
    box.classList.toggle('hidden', !willOpen);
    btn.textContent = (willOpen ? 'Hide ' : 'Show ') + label;
    if (!willOpen || loaded) return;
    loaded = true;
    const embedded = item.replies?.comments || [];
    if (embedded.length >= total) {
      embedded.slice().sort(byDate).forEach(c => box.appendChild(commentEl(c, true)));
      return;
    }
    box.textContent = 'Loading replies…';
    try {
      const d = await api('comments', { part: 'snippet', parentId: item.id, maxResults: 100, textFormat: 'plainText' }, { ttl: 15 * MIN });
      box.textContent = '';
      (d.items || []).slice().sort(byDate).forEach(c => box.appendChild(commentEl(c, true)));
    } catch (e) {
      loaded = false;
      box.textContent = 'Could not load replies: ' + e.message;
    }
  });

  el.append(btn, box);
  return el;
}

/* =====================================================================
   Router — hash based, so it works on any static host with no setup
     #/                  home
     #/results?q=...     search
     #/trending  #/music  #/gaming  #/live  #/saved
     #/watch?v=VIDEO_ID  watch page
     #/channel/CHANNEL_ID
   ===================================================================== */
const CHIP_ROUTE = { music: '#/music', gaming: '#/gaming', live: '#/live' };
const CATEGORIES = { music: { id: '10', q: 'music', title: 'Music' }, gaming: { id: '20', q: 'gaming', title: 'Gaming' } };

function currentRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || 'home', parts, params: new URLSearchParams(qs) };
}

/* Date ranges are rounded down so the same search gives the same request,
   which lets the cache answer it. */
const DATE_MS = { hour: HOUR, today: 24 * HOUR, week: 7 * 24 * HOUR, month: 30 * 24 * HOUR, year: 365 * 24 * HOUR };
function publishedAfter(key) {
  const step = key === 'hour' ? 10 * MIN : key === 'today' ? HOUR : 24 * HOUR;
  return new Date(Math.floor((Date.now() - DATE_MS[key]) / step) * step).toISOString();
}

function resultsHash(q, { date = 'any', dur = 'any', sort = 'relevance' } = {}) {
  let h = '#/results?q=' + encodeURIComponent(q);
  if (date !== 'any') h += '&date=' + date;
  if (dur !== 'any') h += '&dur=' + dur;
  if (sort !== 'relevance') h += '&sort=' + sort;
  return h;
}

function nav(hash) { if (location.hash === hash) router(); else location.hash = hash; }

function setActiveNav(name) { $$('.nav').forEach(n => n.classList.toggle('active', n.dataset.view === name)); }
function setActiveChip(q) {
  const want = (q || '').toLowerCase();
  $$('.chip').forEach(c => c.classList.toggle('active', c.dataset.q.toLowerCase() === want));
}

function router() {
  const token = ++state.token;
  const { name, parts, params } = currentRoute();
  state.list = null;
  clearSkeletons();
  results.classList.remove('list-layout');
  $('#filters').classList.add('hidden');
  closeWatch();
  setActiveNav(name);
  window.scrollTo(0, 0);
  if (name !== 'results') $('#query').value = '';

  switch (name) {
    case 'home':
      return startList({ title: 'Discover something good', subtitle: 'Popular videos right now.', chips: true, chipQuery: '', fetchPage: popularPage() });

    case 'results': {
      const q = (params.get('q') || '').trim();
      if (!q) return nav('#/');
      $('#query').value = q;
      const pick = (k, ok, d) => ok.includes(params.get(k)) ? params.get(k) : d;
      const date = pick('date', Object.keys(DATE_MS), 'any');
      const dur = pick('dur', ['short', 'medium', 'long'], 'any');
      const sort = pick('sort', ['date', 'views'], 'relevance');
      $('#fDate').value = date; $('#fDur').value = dur; $('#fSort').value = sort;
      return startList({
        title: 'Search results', subtitle: 'Videos for \u201c' + q + '\u201d', layout: 'list', filters: true, clientFilter: true,
        q, date, dur, sort, fetchPage: searchPage(q, date !== 'any' ? { publishedAfter: publishedAfter(date) } : {})
      });
    }

    case 'trending':
      return startList({ title: 'Trending videos', subtitle: 'Most popular on YouTube right now.', fetchPage: popularPage() });

    case 'music':
    case 'gaming': {
      const cat = CATEGORIES[name];
      return startList({ title: cat.title, subtitle: 'Popular in ' + cat.title.toLowerCase(), chips: true, chipQuery: name, fetchPage: categoryPage(cat) });
    }

    case 'live':
      return startList({ title: 'Live now', subtitle: 'Streams that are live right now.', chips: true, chipQuery: 'live', fetchPage: searchPage('', { eventType: 'live', order: 'viewCount' }) });

    case 'saved':
      showView('list');
      $('#pageTitle').textContent = 'Watch later';
      $('#subtitle').textContent = 'Videos you saved in this browser.';
      document.title = 'Watch later — MyTube';
      $('#chips').classList.add('hidden');
      return renderSaved();

    case 'watch': {
      const id = params.get('v');
      if (!id) return nav('#/');
      return showWatch(token, id);
    }

    case 'channel': {
      const id = parts[1];
      if (!id) return nav('#/');
      return startList({
        title: 'Channel', subtitle: 'Latest uploads', fetchPage: searchPage('', { channelId: id, order: 'date' }),
        afterLoad: items => { const t = items[0].snippet.channelTitle; if (t) { $('#pageTitle').textContent = t; document.title = t + ' — MyTube'; } }
      });
    }

    default:
      showView('list');
      $('#pageTitle').textContent = 'Page not found';
      $('#subtitle').textContent = '';
      $('#chips').classList.add('hidden');
      results.innerHTML = '';
      moreBtn.classList.add('hidden');
      setStatus('');
      showEmpty('Page not found', 'That page does not exist. Head back to the home page.');
  }
}

/* =====================================================================
   Events
   ===================================================================== */
/* ---------- Search box with recent-search suggestions ---------- */
function readRecent() {
  try { const a = JSON.parse(lsGet(RECENT_STORAGE, '[]')); return Array.isArray(a) ? a.filter(x => typeof x === 'string') : []; }
  catch { return []; }
}
function writeRecent(a) { lsSet(RECENT_STORAGE, JSON.stringify(a.slice(0, 30))); }
function saveRecent(q) { writeRecent([q, ...readRecent().filter(x => x.toLowerCase() !== q.toLowerCase())]); }

const suggestBox = $('#suggest');
let sugItems = [], sugIndex = -1;

function hideSuggest() { suggestBox.classList.add('hidden'); sugIndex = -1; }

function renderSuggest() {
  const typed = $('#query').value.trim().toLowerCase();
  let list = readRecent();
  if (typed) {
    list = list.filter(x => x.toLowerCase().includes(typed) && x.toLowerCase() !== typed)
      .sort((a, b) => (b.toLowerCase().startsWith(typed) ? 1 : 0) - (a.toLowerCase().startsWith(typed) ? 1 : 0));
  }
  sugItems = list.slice(0, 8);
  sugIndex = -1;
  if (!sugItems.length) { hideSuggest(); return; }
  suggestBox.innerHTML = sugItems.map((q, i) =>
    `<div class="sug" role="option" data-i="${i}"><span class="sug-main">${icon('clock')}<span class="sug-text">${escapeHtml(q)}</span></span><button type="button" class="sug-x" data-rm="${i}" aria-label="Remove ${escapeHtml(q)} from history">${icon('x')}</button></div>`
  ).join('') + (typed ? '' : '<button type="button" class="sug-clear" data-clear="1">Clear search history</button>');
  suggestBox.classList.remove('hidden');
}

function doSearch(q) {
  q = q.trim();
  hideSuggest();
  $('#query').blur();
  if (!q) { nav('#/'); return; }
  saveRecent(q);
  nav(resultsHash(q));
}

$('#searchForm').addEventListener('submit', e => { e.preventDefault(); doSearch($('#query').value); });
$('#query').addEventListener('focus', renderSuggest);
$('#query').addEventListener('input', renderSuggest);
$('#query').addEventListener('blur', () => setTimeout(hideSuggest, 200));
$('#query').addEventListener('keydown', e => {
  if (e.key === 'Escape') { hideSuggest(); return; }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && sugItems.length && !suggestBox.classList.contains('hidden')) {
    e.preventDefault();
    sugIndex = (sugIndex + (e.key === 'ArrowDown' ? 1 : -1) + sugItems.length) % sugItems.length;
    $$('#suggest .sug').forEach((el, i) => el.classList.toggle('active', i === sugIndex));
    $('#query').value = sugItems[sugIndex];
  }
});
suggestBox.addEventListener('mousedown', e => e.preventDefault());   // keep the input focused while clicking
suggestBox.addEventListener('click', e => {
  const rm = e.target.closest('[data-rm]'), row = e.target.closest('.sug');
  if (e.target.closest('[data-clear]')) { writeRecent([]); hideSuggest(); return; }
  if (rm) { const q = sugItems[Number(rm.dataset.rm)]; writeRecent(readRecent().filter(x => x !== q)); renderSuggest(); return; }
  if (row) { const q = sugItems[Number(row.dataset.i)]; $('#query').value = q; doSearch(q); }
});

/* ---------- Search filters ---------- */
$('#fDate').addEventListener('change', () => {       // a new search (100 units unless cached)
  const L = state.list, q = L ? L.q : (currentRoute().params.get('q') || '');
  nav(resultsHash(q, { date: $('#fDate').value, dur: $('#fDur').value, sort: $('#fSort').value }));
});
function onClientFilter() {                            // free: re-filters what is loaded
  const L = state.list;
  if (!L || !L.clientFilter) return;
  L.dur = $('#fDur').value; L.sort = $('#fSort').value;
  history.replaceState(null, '', resultsHash(L.q, { date: L.date, dur: L.dur, sort: L.sort }));
  if (!L.busy) renderView();
}
$('#fDur').addEventListener('change', onClientFilter);
$('#fSort').addEventListener('change', onClientFilter);

$('#chips').addEventListener('click', e => {
  const b = e.target.closest('[data-q]');
  if (!b) return;
  const q = b.dataset.q;
  nav(!q ? '#/' : (CHIP_ROUTE[q] || '#/results?q=' + encodeURIComponent(q)));
});

results.addEventListener('click', e => {
  const b = e.target.closest('.save-video');
  if (b) toggleSaved(b.dataset.id);
});
$('#watchSave').addEventListener('click', e => { toggleSaved(e.currentTarget.dataset.id); });
$('#watchLike').addEventListener('click', e => toggleLiked(e.currentTarget.dataset.id));
$('#watchShare').addEventListener('click', shareVideo);
$('#descToggle').addEventListener('click', () => setDescOpen(!$('#descBox').classList.contains('open')));
$('#descBox').addEventListener('click', e => {
  if (!$('#descBox').classList.contains('open') && !e.target.closest('a, button')) setDescOpen(true);
});
$('#watchView').addEventListener('click', e => {      // timestamps in description and comments
  const a = e.target.closest('a.ts');
  if (a) { e.preventDefault(); seekTo(Number(a.dataset.t)); }
});
$('#commentSort').addEventListener('click', e => {
  const b = e.target.closest('button[data-sort]'), w = state.watch;
  if (!b || !w || b.dataset.sort === w.sort) return;
  w.sort = b.dataset.sort;
  $$('#commentSort button').forEach(x => x.classList.toggle('active', x === b));
  $('#commentsList').textContent = '';
  w.nextComments = null;
  loadComments(state.token, false);
});
$('#moreComments').addEventListener('click', () => loadComments(state.token, true));
moreBtn.addEventListener('click', () => loadPage(true));

$('#settingsBtn').onclick = () => openSettings();
$('#emptySettings').onclick = () => openSettings();
$('#cancelSettings').onclick = () => openSettings(false);
$('#clearCache').onclick = () => { clearCache(); setStatus('Cache cleared.'); };
$('#clearKey').onclick = () => {
  state.key = '';
  lsRemove(KEY_STORAGE);
  $('#apiKey').value = '';
  openSettings(false);
  router();
};
function saveKey() {
  state.key = $('#apiKey').value.trim();
  if (state.key) lsSet(KEY_STORAGE, state.key); else lsRemove(KEY_STORAGE);
  openSettings(false);
  router();
}
$('#saveKey').onclick = saveKey;
$('#apiKey').addEventListener('keydown', e => { if (e.key === 'Enter') saveKey(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') openSettings(false); });
$('#settingsModal').addEventListener('click', e => { if (e.target.id === 'settingsModal') openSettings(false); });

/* ---------- Sidebar: full or icon-only, remembered in this browser ---------- */
function setSidebar(mini) {
  document.body.classList.toggle('side-mini', mini);
  $('#menuBtn').setAttribute('aria-expanded', String(!mini));
  lsSet(SIDEBAR_STORAGE, mini ? 'mini' : 'full');
}
$('#menuBtn').addEventListener('click', () => setSidebar(!document.body.classList.contains('side-mini')));
$$('.nav').forEach(n => n.title = n.textContent.trim());
setSidebar(lsGet(SIDEBAR_STORAGE, 'full') === 'mini');

window.addEventListener('hashchange', router);

/* ---------- Start ---------- */
pruneCache();
renderQuota();
router();
