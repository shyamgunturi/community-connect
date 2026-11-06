/* Community Connect — shared browser helpers used by every page. */
(function () {
  'use strict';
  const API = '/api';
  const TOKEN_KEY = 'cc_token';
  const FALLBACK_IMAGE = '/images/community-fallback.svg';
  const CATEGORY_ICONS = { Technology: '💻', 'Sports & Fitness': '🏃', 'Arts & Hobbies': '🎨', Volunteering: '🤝', Social: '🍽️', Faith: '🌿' };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, val) { try { localStorage.setItem(k, val); } catch { /* storage unavailable */ } },
    remove(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } }
  };

  let token = store.get(TOKEN_KEY);
  let currentUser = null;

  class ApiError extends Error {
    constructor(message, status, data) { super(message); this.status = status; this.data = data || {}; this.code = this.data.code; this.field = this.data.field; }
  }

  async function api(path, { method = 'GET', body, signal } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new ApiError('We could not reach the Community Connect server. Check that it is running and your connection is working, then try again.', 0, { network: true });
    }
    let data = {};
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch { data = { error: 'The server sent an unexpected response.' }; } }
    if (!res.ok) {
      if (res.status === 401 && token) { clearSession(); window.dispatchEvent(new CustomEvent('cc:session-expired')); }
      throw new ApiError(data.error || `Request failed (${res.status}).`, res.status, data);
    }
    return data;
  }

  function setSession(newToken, user) { token = newToken; currentUser = user; store.set(TOKEN_KEY, newToken); }
  function clearSession() { token = null; currentUser = null; store.remove(TOKEN_KEY); }
  async function loadUser() {
    if (!token) { currentUser = null; return null; }
    try { currentUser = (await api('/auth/me')).user; }
    catch (e) { if (e.status === 401) clearSession(); else throw e; currentUser = null; }
    return currentUser;
  }

  const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function formatDate(iso, opts = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return iso || 'Date to be confirmed';
    const d = new Date(`${iso}T00:00:00`);
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: opts.short ? undefined : 'numeric' });
  }
  function dateParts(iso) {
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return { day: '–', month: '' };
    return { day: d.getDate(), month: d.toLocaleDateString('en-GB', { month: 'short' }).toUpperCase() };
  }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const icon = cat => CATEGORY_ICONS[cat] || '✦';

  /** Photo markup that always shows the whole image (no cropping) over a soft blurred backdrop. */
  function photo(url, alt, cls = '') {
    const src = url || FALLBACK_IMAGE;
    return `<div class="photo-frame ${cls}"><img class="photo-blur" src="${esc(src)}" alt="" aria-hidden="true" loading="lazy" data-fallback><img class="photo-main" src="${esc(src)}" alt="${esc(alt || '')}" loading="lazy" data-fallback></div>`;
  }

  // Graceful fallback for any image that fails to load.
  document.addEventListener('error', e => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.hasAttribute('data-fallback') || img.dataset.failed) return;
    img.dataset.failed = '1';
    img.src = FALLBACK_IMAGE;
    img.closest('.photo-frame')?.classList.add('photo-missing');
  }, true);

  function toast(message, type = 'info') {
    let t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); document.body.appendChild(t); }
    t.textContent = message;
    t.dataset.type = type;
    t.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => t.classList.remove('show'), 3800);
  }

  function setMessage(el, text, type = 'info') {
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', type === 'error');
    el.classList.toggle('is-success', type === 'success');
  }

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  /**
   * Location autocomplete for UK towns, cities and postcodes.
   * Suggestions come from /api/locations/search (server-side cached and rate-limited).
   * onSelect(result) receives { label, name, lat, lon, type, source }.
   */
  function locationAutocomplete({ input, list, status, onSelect, onClear }) {
    const cache = new Map();
    let controller = null, items = [], active = -1, lastQuery = '';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', list.id);
    input.setAttribute('autocomplete', 'off');

    const say = (text, type) => { if (status) setMessage(status, text, type); };
    function close() { list.classList.add('hidden'); list.innerHTML = ''; input.setAttribute('aria-expanded', 'false'); active = -1; }
    function render(results, note) {
      items = results;
      active = -1;
      if (!results.length && !note) return close();
      list.innerHTML = results.map((r, i) => `<li role="option" id="${list.id}-opt-${i}" data-index="${i}" class="suggestion"><span class="suggestion-label">${esc(r.label)}</span><span class="suggestion-type">${esc(r.type)}</span></li>`).join('')
        + (note ? `<li class="suggestion-note" aria-disabled="true">${esc(note)}</li>` : '');
      list.classList.remove('hidden');
      input.setAttribute('aria-expanded', 'true');
    }
    function highlight(i) {
      const opts = list.querySelectorAll('.suggestion');
      opts.forEach(o => o.classList.remove('active'));
      if (i >= 0 && opts[i]) { opts[i].classList.add('active'); input.setAttribute('aria-activedescendant', opts[i].id); opts[i].scrollIntoView({ block: 'nearest' }); }
      active = i;
    }
    function choose(r) {
      close();
      input.value = r.label;
      lastQuery = r.label;
      say(r.source === 'offline' ? `Using ${r.label} (approximate — online search unavailable).` : `Location set: ${r.label}`, 'success');
      onSelect(r);
    }
    async function fetchResults(q, mode) {
      const key = `${mode}:${q.toLowerCase()}`;
      if (cache.has(key)) return cache.get(key);
      controller?.abort();
      controller = new AbortController();
      const data = await api(`/locations/search?mode=${mode}&q=${encodeURIComponent(q)}`, { signal: controller.signal });
      cache.set(key, data);
      return data;
    }
    const suggest = debounce(async () => {
      const q = input.value.trim();
      if (q.length < 2) { close(); return; }
      if (q === lastQuery) return;
      render([], 'Searching…');
      try {
        const data = await fetchResults(q, 'suggest');
        if (input.value.trim() !== q) return;
        render(data.results, data.results.length ? (data.source === 'offline' ? 'Approximate results (offline list)' : '') : 'No matches yet — press Enter to search');
      } catch (e) {
        if (e.name === 'AbortError') return;
        render([], e.message);
      }
    }, 320);

    async function explicitSearch() {
      const q = input.value.trim();
      if (q.length < 2) { say('Enter a UK town, city or postcode first.', 'error'); return; }
      if (active >= 0 && items[active]) return choose(items[active]);
      say('Finding that location…');
      try {
        const data = await fetchResults(q, 'search');
        if (!data.results.length) { close(); say(data.message || 'We could not find that location. Try a town, city or full postcode.', 'error'); return; }
        choose(data.results[0]);
      } catch (e) {
        if (e.name === 'AbortError') return;
        close();
        say(e.message, 'error');
      }
    }

    input.addEventListener('input', () => { lastQuery = ''; onClear?.(); suggest(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); highlight(Math.min(active + 1, items.length - 1)); }
      else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); highlight(Math.max(active - 1, 0)); }
      else if (e.key === 'Enter') { e.preventDefault(); explicitSearch(); }
      else if (e.key === 'Escape') close();
    });
    list.addEventListener('mousedown', e => {
      const li = e.target.closest('.suggestion');
      if (!li) return;
      e.preventDefault();
      choose(items[Number(li.dataset.index)]);
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
    return { search: explicitSearch, close };
  }

  /** Reads an image file, scales it down in the browser and uploads it. Resolves to the stored URL. */
  async function uploadImage(file) {
    if (!file) throw new Error('Choose an image first.');
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) throw new Error('Choose a JPG, PNG, WebP or GIF image.');
    if (file.size > 15 * 1024 * 1024) throw new Error('That image is too large. Choose one under 15 MB.');
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.readAsDataURL(file);
    });
    let payload = dataUrl;
    if (file.type !== 'image/gif') {
      payload = await new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
          const max = 1600;
          const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
          if (scale === 1 && file.size < 1.5 * 1024 * 1024) return resolve(dataUrl);
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.naturalWidth * scale);
          canvas.height = Math.round(img.naturalHeight * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.86));
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
      });
    }
    const data = await api('/uploads', { method: 'POST', body: { image: payload } });
    return data.url;
  }

  function params() { return new URLSearchParams(location.search); }

  window.CC = {
    api, ApiError, esc, formatDate, dateParts, plural, icon, photo, toast, setMessage, debounce,
    locationAutocomplete, uploadImage, params, FALLBACK_IMAGE,
    get token() { return token; }, get user() { return currentUser; },
    setSession, clearSession, loadUser
  };
})();
