/* Community Connect — homepage, discovery, participant dashboard and organizer dashboard. */
(function () {
  'use strict';
  const { api, esc, toast, setMessage, photo, icon, plural, formatDate, dateParts } = CC;
  const $ = id => document.getElementById(id);
  const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
  const money = pence => gbp.format((pence || 0) / 100).replace(/\.00$/, '');
  const priceLabel = pence => (pence ? money(pence) : 'Free');

  const state = {
    view: 'home',
    origin: null,            // { lat, lon, label }
    radius: 10,
    category: 'all',
    communities: [],
    events: [],
    organizer: { communities: [], events: [] },
    editingCommunityId: null,
    pendingAction: null      // function to run after a successful login
  };

  try {
    const saved = JSON.parse(sessionStorage.getItem('cc_search') || 'null');
    if (saved) {
      if (saved.origin && Number.isFinite(saved.origin.lat)) state.origin = saved.origin;
      if (saved.radius >= 1 && saved.radius <= 50) state.radius = saved.radius;
      if (saved.category) state.category = saved.category;
    }
  } catch { /* ignore */ }
  const saveSearch = () => { try { sessionStorage.setItem('cc_search', JSON.stringify({ origin: state.origin, radius: state.radius, category: state.category })); } catch { /* ignore */ } };

  // ------------------------------------------------------------------ header & auth
  function renderHeader() {
    const user = CC.user;
    const slot = $('accountSlot');
    if (user) {
      slot.innerHTML = `<span class="account-label">Hi, ${esc(user.name.split(' ')[0])} <small class="role-badge">${esc(user.role)}</small></span><button class="outline-btn" id="dashboardBtn" type="button">My dashboard</button><button class="outline-btn" id="logoutBtn" type="button">Log out</button>`;
      $('logoutBtn').onclick = logout;
      $('dashboardBtn').onclick = () => user.role === 'admin' ? (location.href = 'admin.html') : openView(user.role, { scrollTo: user.role === 'participant' ? 'dashboardSection' : null });
      if (user.role === 'admin') $('dashboardBtn').textContent = 'Admin dashboard';
      $('getStartedBtn').classList.add('hidden');
    } else {
      slot.innerHTML = '<button class="outline-btn" id="loginBtn" type="button">Log in</button>';
      $('loginBtn').onclick = () => openAuth('login');
      $('getStartedBtn').classList.remove('hidden');
    }
  }

  function openAuth(mode = 'login', { role = null, message = '', onSuccess = null } = {}) {
    state.pendingAction = onSuccess;
    const isRegister = mode === 'register';
    $('authModal').classList.remove('hidden');
    $('authForm').dataset.mode = mode;
    $('authTitle').textContent = isRegister ? 'Create your account' : 'Welcome back';
    $('authIntro').textContent = message || (isRegister ? 'Choose how you want to use Community Connect.' : 'Sign in to access your Community Connect space.');
    $('authSubmit').textContent = isRegister ? 'Create account' : 'Log in';
    $('authNameWrap').classList.toggle('hidden', !isRegister);
    $('authRoleWrap').classList.toggle('hidden', !isRegister);
    $('authPasswordHint').classList.toggle('hidden', !isRegister);
    $('authPassword').autocomplete = isRegister ? 'new-password' : 'current-password';
    if (role) document.querySelector(`input[name=authRole][value=${role}]`).checked = true;
    setMessage($('authMessage'), '');
    $('authSwitch').innerHTML = isRegister
      ? 'Already registered? <button type="button" id="switchAuth">Log in</button>'
      : 'New here? <button type="button" id="switchAuth">Create an account</button>';
    $('switchAuth').onclick = () => openAuth(isRegister ? 'login' : 'register', { role, message, onSuccess });
    (isRegister ? $('authName') : $('authEmail')).focus();
    CC.mountGoogle($('googleSlot'), {
      getRole: () => ($('authForm').dataset.mode === 'register' ? document.querySelector('input[name=authRole]:checked').value : 'participant'),
      onAuthed: data => afterAuth(data, data.created ? 'register' : 'login'),
      onError: msg => setMessage($('authMessage'), msg, 'error')
    });
  }

  /** Shared by email/password and Google sign-in. */
  async function afterAuth(data, mode) {
    const next = state.pendingAction;
    $('authModal').classList.add('hidden');
    state.pendingAction = null;
    $('authForm').reset();
    renderHeader();
    toast(mode === 'register' ? `Welcome to Community Connect, ${data.user.name.split(' ')[0]}!` : `Welcome back, ${data.user.name.split(' ')[0]}.`, 'success');
    if (data.user.role === 'admin') { location.href = 'admin.html'; return; }
    if (next) await next(data.user);
    else await openView(data.user.role);
  }
  function closeAuth() { $('authModal').classList.add('hidden'); state.pendingAction = null; }

  async function submitAuth(e) {
    e.preventDefault();
    const mode = $('authForm').dataset.mode;
    const body = { email: $('authEmail').value.trim(), password: $('authPassword').value };
    if (!body.email || !body.password) return setMessage($('authMessage'), 'Enter your email address and password.', 'error');
    if (mode === 'register') {
      body.name = $('authName').value.trim();
      body.role = document.querySelector('input[name=authRole]:checked').value;
      if (!body.name) return setMessage($('authMessage'), 'Enter your full name.', 'error');
    }
    const btn = $('authSubmit');
    btn.disabled = true;
    setMessage($('authMessage'), mode === 'register' ? 'Creating your account…' : 'Signing in…');
    try {
      const data = await api('/auth/' + mode, { method: 'POST', body });
      CC.setSession(data.token, data.user);
      await afterAuth(data, mode);
    } catch (err) {
      setMessage($('authMessage'), err.message, 'error');
    } finally { btn.disabled = false; }
  }

  function logout() {
    CC.clearSession();
    renderHeader();
    toast('You have logged out.');
    goHome();
  }

  // ------------------------------------------------------------------ views
  let lastRoutedHash = null;
  function setHash(h) { lastRoutedHash = h || ''; try { history.replaceState(null, '', h ? '#' + h : location.pathname + location.search); } catch { /* ignore */ } }

  function showSections(view) {
    state.view = view;
    document.querySelectorAll('.home-section').forEach(s => s.classList.toggle('hidden', view !== 'home'));
    $('participantView').classList.toggle('hidden', view !== 'participant');
    $('organizerView').classList.toggle('hidden', view !== 'organizer');
    document.querySelectorAll('.top-nav .active').forEach(a => a.classList.remove('active'));
    ({ home: $('homeNav'), participant: $('participantNav'), organizer: $('organizerNav') })[view]?.classList.add('active');
  }

  function goHome() {
    showSections('home');
    setHash('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    loadHomeEvents();
  }

  async function openView(role, { scrollTo = null } = {}) {
    const user = CC.user;
    if (user && user.role === 'admin') { location.href = 'admin.html'; return; }
    if (user && user.role !== role) {
      toast(`You're signed in as ${user.role === 'organizer' ? 'an organizer' : 'a participant'}. Log out to use the ${role} space.`);
      role = user.role;
    }
    showSections(role);
    if (role === 'participant') {
      setHash(scrollTo === 'eventsSection' ? 'events' : scrollTo === 'dashboardSection' ? 'dashboard' : 'discover');
      await Promise.all([loadCommunities(), loadPublicEvents(), loadParticipantDashboard()]);
    } else {
      setHash('organizer');
      await loadOrganizer();
    }
    if (scrollTo) $(scrollTo)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ------------------------------------------------------------------ homepage events
  function eventCard(e) {
    const { day, month } = dateParts(e.event_date);
    const img = e.image_url || e.community_image_url;
    return `<article class="event-card">
      <a class="event-card-media" href="event.html?id=${e.id}" aria-label="${esc(e.name)}">${photo(img, e.name, 'event-photo')}<span class="date-badge"><b>${esc(day)}</b><small>${esc(month)}</small></span>${e.registered ? '<span class="status-chip">Registered</span>' : ''}${CC.badges(e, 2)}</a>
      <div class="event-card-body">
        <p class="event-community">${icon(e.community_category)} ${esc(e.community_name)}</p>
        <h4><a href="event.html?id=${e.id}">${esc(e.name)}</a></h4>
        <p class="event-when">📅 ${esc(formatDate(e.event_date))} · ◷ ${esc(e.event_time)}</p>
        <p class="event-where">⌖ ${esc(e.venue)}${e.community_town ? ', ' + esc(e.community_town) : ''}</p>
        <p class="event-chips">${e.flash_active ? `<span class="chip chip-flash">⚡ ${money(e.current_price_pence)} <s>${money(e.price_pence)}</s></span><span class="chip chip-timer">⏳ <span data-countdown="${esc(e.flash_until)}" data-countdown-style="short" data-countdown-ended="ended"></span></span>` : e.early_active ? `<span class="chip chip-early">Early bird ${money(e.early_price_pence)} <s>${money(e.price_pence)}</s></span><span class="chip chip-timer">⏳ <span data-countdown="${esc(e.early_until)}" data-countdown-style="short" data-countdown-ended="ended"></span></span>` : `<span class="chip">${priceLabel(e.price_pence)}</span>`}${e.is_full ? '<span class="chip chip-full">Full</span>' : e.spots_left != null && e.spots_left <= 5 ? `<span class="chip chip-low">${e.spots_left} ${e.spots_left === 1 ? 'place' : 'places'} left</span>` : e.capacity ? `<span class="chip">${e.spots_left} places left</span>` : ''}</p>
        <p class="event-desc">${esc(e.description || 'More details will be shared by the organizer.')}</p>
        <a class="join-btn" href="event.html?id=${e.id}">${e.registered ? 'View my registration' : 'View event'}</a>
      </div></article>`;
  }

  // Featured / trending / deals strip on the homepage
  let promoData = null, promoTab = 'trending';
  function renderPromo() {
    const grid = $('promoGrid');
    if (!grid || !promoData) return;
    const list = promoData[promoTab] || [];
    document.querySelectorAll('[data-promo-tab]').forEach(b => { const on = b.dataset.promoTab === promoTab; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
    grid.innerHTML = list.length ? list.slice(0, 3).map(eventCard).join('') : `<div class="empty-inline"><strong>${promoTab === 'deals' ? 'No live deals right now' : 'Nothing here yet'}</strong><p>Check back soon — organizers add new events and offers all the time.</p></div>`;
    CC.countdownNow();
  }
  async function loadHomePromo() {
    const sec = $('homePromo');
    if (!sec) return;
    try {
      promoData = await api('/events/trending');
      if (!promoData.trending.length && promoData.featured.length) promoTab = 'featured';
      sec.classList.toggle('hidden', !promoData.trending.length && !promoData.featured.length && !promoData.deals.length);
      $('dealCount').textContent = promoData.deals.length ? String(promoData.deals.length) : '';
      renderPromo();
    } catch { sec.classList.add('hidden'); }
  }
  document.querySelectorAll('[data-promo-tab]').forEach(b => { b.onclick = () => { promoTab = b.dataset.promoTab; renderPromo(); }; });

  async function loadHomeEvents() {
    loadHomePromo();
    const grid = $('homeEventGrid');
    try {
      const { events } = await api('/events/public?limit=3');
      grid.innerHTML = events.length ? events.map(eventCard).join('') : '<div class="empty-inline"><strong>No public events yet</strong><p>Events published by organizers will appear here.</p></div>';
      CC.countdownNow();
    } catch (e) {
      grid.innerHTML = `<div class="empty-inline error-inline"><strong>Events could not be loaded</strong><p>${esc(e.message)}</p></div>`;
    }
  }

  // ------------------------------------------------------------------ discovery
  function updateSearchUi() {
    $('distanceRange').value = state.radius;
    $('distanceValue').textContent = plural(state.radius, 'mile');
    $('distanceRange').disabled = !state.origin;
    $('distanceRange').closest('.distance-field').classList.toggle('is-disabled', !state.origin);
    $('categoryFilter').value = state.category;
    $('clearLocationBtn').classList.toggle('hidden', !state.origin);
    if (state.origin && !$('locationSearch').value) $('locationSearch').value = state.origin.label;
  }

  let communityRequest = 0;
  async function loadCommunities() {
    updateSearchUi();
    const ticket = ++communityRequest;
    const grid = $('communityGrid');
    grid.classList.remove('hidden');
    $('emptyState').classList.add('hidden');
    grid.setAttribute('aria-busy', 'true');
    grid.innerHTML = Array.from({ length: 3 }, () => '<div class="community-card skeleton"><div class="skeleton-cover"></div><div class="community-info"><span></span><span></span><span></span></div></div>').join('');
    $('communityCount').textContent = 'Loading…';
    const qs = new URLSearchParams();
    if (state.category !== 'all') qs.set('category', state.category);
    if (state.origin) { qs.set('lat', state.origin.lat); qs.set('lon', state.origin.lon); qs.set('radius', state.radius); }
    try {
      const data = await api('/communities?' + qs.toString());
      if (ticket !== communityRequest) return; // a newer search has started
      state.communities = data.communities;
      renderCommunities();
    } catch (e) {
      if (ticket !== communityRequest) return;
      grid.classList.add('hidden');
      $('emptyState').classList.remove('hidden');
      $('emptyTitle').textContent = 'Communities could not be loaded';
      $('emptyText').textContent = e.message;
      $('retryCommunities').classList.remove('hidden');
      $('communityCount').textContent = '';
    } finally { grid.removeAttribute('aria-busy'); }
  }

  function communityCard(c) {
    const dist = c.distance_miles != null ? `<strong>${c.distance_miles < 0.1 ? 'Under 0.1' : c.distance_miles.toFixed(1)} miles away</strong>` : '';
    return `<article class="community-card">
      <a class="community-cover" href="community.html?id=${c.id}" aria-label="${esc(c.name)}">${photo(c.image_url, c.name)}<span class="cover-icon">${icon(c.category)}</span><span class="category-tag">${esc(c.category)}</span>${c.joined ? '<span class="status-chip">Member</span>' : ''}</a>
      <div class="community-info"><h4>${esc(c.name)}</h4><p>${esc(c.description)}</p>
        <div class="community-meta"><span>⌖ ${esc(c.town)}</span>${dist}</div>
        <div class="community-sub"><span>${plural(c.member_count, 'member')}</span><span>${plural(c.upcoming_event_count, 'upcoming event')}</span></div>
        <a class="join-btn" href="community.html?id=${c.id}">Discover its story</a></div></article>`;
  }

  // ---- map view (OpenStreetMap tiles drawn with plain images; no external script needed) ----
  let viewMode = 'list', mapView = null;
  const TILE = 256;
  const lon2x = (lon, z) => (lon + 180) / 360 * TILE * 2 ** z;
  const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * TILE * 2 ** z; };
  function fitMap(points, w, h) {
    if (!points.length) return { z: 6, cx: lon2x(-1.8, 6), cy: lat2y(54.0, 6) };
    for (let z = 15; z >= 4; z--) {
      const xs = points.map(p => lon2x(p.lon, z)), ys = points.map(p => lat2y(p.lat, z));
      const spanX = Math.max(...xs) - Math.min(...xs), spanY = Math.max(...ys) - Math.min(...ys);
      if (spanX <= w - 90 && spanY <= h - 110) return { z, cx: (Math.max(...xs) + Math.min(...xs)) / 2, cy: (Math.max(...ys) + Math.min(...ys)) / 2 };
    }
    return { z: 4, cx: lon2x(-2, 4), cy: lat2y(54, 4) };
  }
  function drawMap() {
    const box = $('communityMap');
    if (!box || viewMode !== 'map') return;
    const list = state.communities.filter(c => Number.isFinite(c.latitude) && Number.isFinite(c.longitude));
    const w = box.clientWidth || 800, h = box.clientHeight || 460;
    if (!mapView) {
      const pts = list.map(c => ({ lat: c.latitude, lon: c.longitude }));
      if (state.origin) pts.push({ lat: state.origin.lat, lon: state.origin.lon });
      mapView = fitMap(pts, w, h);
    }
    const { z, cx, cy } = mapView;
    const left = cx - w / 2, top = cy - h / 2;
    const n = 2 ** z;
    let tiles = '';
    for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + w) / TILE); tx++) {
      for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + h) / TILE); ty++) {
        if (ty < 0 || ty >= n) continue;
        const wx = ((tx % n) + n) % n;
        tiles += `<img class="map-tile" alt="" draggable="false" src="https://tile.openstreetmap.org/${z}/${wx}/${ty}.png" style="left:${Math.round(tx * TILE - left)}px;top:${Math.round(ty * TILE - top)}px">`;
      }
    }
    const pins = list.map((c, i) => `<button type="button" class="map-pin${c.joined ? ' is-member' : ''}" data-pin="${i}" style="left:${Math.round(lon2x(c.longitude, z) - left)}px;top:${Math.round(lat2y(c.latitude, z) - top)}px" aria-label="${esc(c.name)}, ${esc(c.town)}"><span><i>${icon(c.category)}</i></span></button>`).join('');
    const me = state.origin ? `<span class="map-me" style="left:${Math.round(lon2x(state.origin.lon, z) - left)}px;top:${Math.round(lat2y(state.origin.lat, z) - top)}px" title="Your search location"></span>` : '';
    box.querySelector('.map-layer').innerHTML = tiles + me + pins;
    box.dataset.count = String(list.length);
  }
  function mapPopup(i) {
    const c = state.communities.filter(x => Number.isFinite(x.latitude) && Number.isFinite(x.longitude))[i];
    const pop = $('mapPopup');
    if (!c) { pop.classList.add('hidden'); return; }
    pop.innerHTML = `<button type="button" class="map-pop-close" aria-label="Close">×</button>${photo(c.image_url, c.name, 'map-pop-photo')}<div><small>${icon(c.category)} ${esc(c.category)} · ${esc(c.town)}${c.distance_miles != null ? ` · ${c.distance_miles.toFixed(1)} mi` : ''}</small><strong>${esc(c.name)}</strong><span>${plural(c.member_count, 'member')} · ${plural(c.upcoming_event_count, 'upcoming event')}</span><a class="join-btn" href="community.html?id=${c.id}">Discover its story</a></div>`;
    pop.classList.remove('hidden');
  }
  function setViewMode(mode) {
    viewMode = mode;
    document.querySelectorAll('[data-view-mode]').forEach(b => { const on = b.dataset.viewMode === mode; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
    $('communityMap').classList.toggle('hidden', mode !== 'map');
    renderCommunities();
  }
  (function initMap() {
    const box = $('communityMap');
    if (!box) return;
    document.querySelectorAll('[data-view-mode]').forEach(b => { b.onclick = () => setViewMode(b.dataset.viewMode); });
    const zoom = d => { if (!mapView) return; const nz = Math.min(17, Math.max(3, mapView.z + d)); const f = 2 ** (nz - mapView.z); mapView = { z: nz, cx: mapView.cx * f, cy: mapView.cy * f }; drawMap(); };
    box.querySelector('[data-zoom-in]').onclick = () => zoom(1);
    box.querySelector('[data-zoom-out]').onclick = () => zoom(-1);
    box.querySelector('[data-zoom-fit]').onclick = () => { mapView = null; drawMap(); };
    let drag = null;
    const layer = box.querySelector('.map-layer');
    layer.addEventListener('pointerdown', e => { if (!mapView || e.target.closest('.map-pin')) return; drag = { x: e.clientX, y: e.clientY, cx: mapView.cx, cy: mapView.cy, moved: false }; layer.setPointerCapture(e.pointerId); });
    layer.addEventListener('pointermove', e => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true; mapView = { ...mapView, cx: drag.cx - dx, cy: drag.cy - dy }; drawMap(); });
    layer.addEventListener('pointerup', () => { drag = null; });
    layer.addEventListener('wheel', e => { e.preventDefault(); zoom(e.deltaY < 0 ? 1 : -1); }, { passive: false });
    layer.addEventListener('click', e => { const pin = e.target.closest('[data-pin]'); if (pin) mapPopup(Number(pin.dataset.pin)); });
    $('mapPopup').addEventListener('click', e => { if (e.target.closest('.map-pop-close')) $('mapPopup').classList.add('hidden'); });
    window.addEventListener('resize', CC.debounce(drawMap, 200));
    box.addEventListener('error', e => { if (e.target.classList && e.target.classList.contains('map-tile')) e.target.classList.add('tile-missing'); }, true);
  })();

  function renderCommunities() {
    const list = state.communities;
    mapView = null;
    if ($('mapPopup')) $('mapPopup').classList.add('hidden');
    const cat = state.category === 'all' ? 'all categories' : state.category;
    $('resultsSummary').textContent = state.origin
      ? `Within ${plural(state.radius, 'mile')} of ${state.origin.label} · ${cat} · nearest first`
      : `Showing all communities (${cat}). Choose a location to filter by distance.`;
    $('communityCount').textContent = `${list.length} to explore`;
    $('communityGrid').innerHTML = list.map(communityCard).join('');
    const empty = !list.length;
    $('communityGrid').classList.toggle('hidden', empty || viewMode === 'map');
    $('communityMap')?.classList.toggle('hidden', empty || viewMode !== 'map');
    if (viewMode === 'map' && !empty) requestAnimationFrame(drawMap);
    $('emptyState').classList.toggle('hidden', !empty);
    $('retryCommunities').classList.add('hidden');
    if (empty) {
      $('emptyTitle').textContent = 'No communities in this search';
      $('emptyText').textContent = state.origin ? 'Try increasing the distance, choosing another category or searching a different town.' : 'Try another category.';
    }
  }

  function setOrigin(origin) {
    state.origin = origin;
    saveSearch();
    loadCommunities();
  }

  const locationSearch = CC.locationAutocomplete({
    input: $('locationSearch'), list: $('locationSuggestions'), status: $('locationStatus'),
    onSelect: r => setOrigin({ lat: r.lat, lon: r.lon, label: r.label })
  });
  $('searchLocationBtn').onclick = () => locationSearch.search();
  $('clearLocationBtn').onclick = () => { $('locationSearch').value = ''; setMessage($('locationStatus'), ''); setOrigin(null); };
  const reloadDebounced = CC.debounce(loadCommunities, 250);
  $('distanceRange').addEventListener('input', () => {
    state.radius = Number($('distanceRange').value);
    $('distanceValue').textContent = plural(state.radius, 'mile');
    saveSearch();
    reloadDebounced();
  });
  $('categoryFilter').onchange = () => { state.category = $('categoryFilter').value; saveSearch(); loadCommunities(); };
  $('retryCommunities').onclick = loadCommunities;
  $('useLocationBtn').onclick = () => {
    if (!navigator.geolocation) return setMessage($('locationStatus'), 'Your browser does not support location access.', 'error');
    setMessage($('locationStatus'), 'Requesting your location…');
    navigator.geolocation.getCurrentPosition(
      p => { $('locationSearch').value = 'My current location'; setMessage($('locationStatus'), 'Location set: your current location', 'success'); setOrigin({ lat: p.coords.latitude, lon: p.coords.longitude, label: 'your current location' }); },
      () => setMessage($('locationStatus'), 'Location permission was not granted. Search for a town or postcode instead.', 'error'),
      { timeout: 10000, maximumAge: 600000 }
    );
  };

  // ------------------------------------------------------------------ public events
  async function loadPublicEvents() {
    const box = $('publicEvents');
    try {
      const { events } = await api('/events/public');
      state.events = events;
      $('eventCount').textContent = events.length ? `${events.length} upcoming` : '';
      box.innerHTML = events.length ? events.map(eventCard).join('') : '<div class="empty-inline"><strong>No upcoming events yet</strong><p>When organizers publish events they will appear here for everyone to see.</p></div>';
      CC.countdownNow();
    } catch (e) {
      box.innerHTML = `<div class="empty-inline error-inline"><strong>Events could not be loaded</strong><p>${esc(e.message)}</p></div>`;
    }
  }

  // ------------------------------------------------------------------ participant dashboard
  async function loadParticipantDashboard() {
    const user = CC.user;
    const isParticipant = user && user.role === 'participant';
    $('dashboardLocked').classList.toggle('hidden', !!isParticipant);
    $('dashboardContent').classList.toggle('hidden', !isParticipant);
    $('participantPill').textContent = isParticipant ? 'Participant' : 'Explore';
    if (!isParticipant) { $('recommendBlock').classList.add('hidden'); return; }
    $('joinedCommunities').innerHTML = '<p class="muted">Loading your communities…</p>';
    $('registeredEvents').innerHTML = '<p class="muted">Loading your events…</p>';
    try {
      const [{ communities }, { events }] = await Promise.all([api('/participant/communities'), api('/participant/events')]);
      $('joinedCommunities').innerHTML = communities.length ? communities.map(c => `<div class="joined-item">
          <div class="item-main">${photo(c.image_url, c.name, 'thumb-photo')}<div><strong>${esc(c.name)}</strong><small>${esc(c.category)} · ${esc(c.town)} · ${plural(c.upcoming_event_count, 'upcoming event')}</small></div></div>
          <div class="item-actions"><a class="event-register" href="community.html?id=${c.id}">View</a><button class="text-btn danger-link" type="button" data-leave="${c.id}" data-name="${esc(c.name)}">Leave</button></div></div>`).join('')
        : '<p class="muted">You haven\'t joined a community yet. Open a community story and choose “Join this community”.</p>';
      state.myEvents = events;
      $('registeredEvents').innerHTML = events.length ? events.map(e => `<div class="event-item${e.is_past ? ' is-past' : ''}">
          ${photo(e.image_url || e.community_image_url, e.name, 'event-thumb')}
          <div class="event-copy"><strong>${esc(e.name)}</strong><small>${esc(e.community_name)} · ${esc(formatDate(e.event_date))} · ${esc(e.event_time)} · ${esc(e.venue)}</small>${!e.is_past ? `${e.is_cancelled ? `<small class="past-label">✕ Cancelled by the organizer${e.my_ticket && e.my_ticket.payment_status === 'refunded' ? ` · ${money(e.my_ticket.amount_pence)} refunded` : ''}</small>` : ''}<small class="ok-label${e.is_cancelled ? ' hidden' : ''}">✓ ${e.my_ticket && e.my_ticket.payment_status === 'paid' ? `${CC.ticketLabel(e.my_ticket.ticket_type)} ticket · ${money(e.my_ticket.amount_pence)} paid` : 'Registered'}</small>` : e.attended ? `<small class="ok-label">✓ Attended${e.my_rating ? ' · you rated it ' + '★'.repeat(e.my_rating) : ''}</small>` : '<small class="past-label">This event has finished</small>'}</div>
          <div class="item-actions">${!e.is_past && e.my_ticket && e.my_ticket.ticket_code ? `<button class="event-register ticket-btn" type="button" data-ticket="${e.id}">🎟 ${e.my_ticket.checked_in ? 'Ticket ✓' : 'QR ticket'}</button>` : ''}${e.is_past && e.attended && !e.my_rating ? `<a class="event-register rate-link" href="event.html?id=${e.id}#feedback">Rate it</a>` : ''}<a class="event-register" href="event.html?id=${e.id}">View</a>${e.has_started || e.is_cancelled || (e.my_ticket && e.my_ticket.payment_status === 'paid') ? '' : `<button class="text-btn danger-link" type="button" data-cancel="${e.id}">Cancel</button>`}</div></div>`).join('')
        : '<p class="muted">You haven\'t registered for any events yet. Browse the upcoming events above.</p>';
      loadRecommendations();
    } catch (e) {
      $('joinedCommunities').innerHTML = `<p class="muted error-text">${esc(e.message)}</p>`;
      $('registeredEvents').innerHTML = '';
    }
  }

  async function loadRecommendations() {
    try {
      const { communities } = await api('/participant/recommendations');
      $('recommendBlock').classList.toggle('hidden', !communities.length);
      $('recommendations').innerHTML = communities.map(c => `<a class="recommend-card" href="community.html?id=${c.id}">
          ${photo(c.image_url, c.name, 'recommend-photo')}
          <span class="recommend-body"><strong>${esc(c.name)}</strong><small>${icon(c.category)} ${esc(c.category)} · ${esc(c.town)}</small>
          <span class="reason-chips">${c.reasons.map(r => `<em>${esc(r)}</em>`).join('')}</span></span></a>`).join('');
    } catch { $('recommendBlock').classList.add('hidden'); }
  }

  $('dashboardSection').addEventListener('click', async e => {
    const leave = e.target.closest('[data-leave]');
    const cancel = e.target.closest('[data-cancel]');
    const tbtn = e.target.closest('[data-ticket]');
    if (tbtn) { const ev = (state.myEvents || []).find(x => x.id === Number(tbtn.dataset.ticket)); const t = ev && CC.ticketFromEvent(ev); if (t) CC.openTicket(t); return; }
    try {
      if (leave) {
        if (!confirm(`Leave ${leave.dataset.name}? Your registrations for its events will also be cancelled.`)) return;
        const d = await api(`/communities/${leave.dataset.leave}/join`, { method: 'DELETE' });
        toast(d.message);
      } else if (cancel) {
        if (!confirm('Cancel your registration for this event?')) return;
        const d = await api(`/events/${cancel.dataset.cancel}/register`, { method: 'DELETE' });
        toast(d.message);
      } else return;
      await Promise.all([loadParticipantDashboard(), loadCommunities(), loadPublicEvents()]);
    } catch (err) { toast(err.message, 'error'); }
  });
  $('dashboardRegister').onclick = () => openAuth('register', { role: 'participant', onSuccess: () => openView('participant', { scrollTo: 'dashboardSection' }) });
  $('dashboardLogin').onclick = () => openAuth('login', { onSuccess: u => openView(u.role, { scrollTo: u.role === 'participant' ? 'dashboardSection' : null }) });

  // ------------------------------------------------------------------ organizer
  const isOrganizer = () => CC.user && CC.user.role === 'organizer';

  function setOrganizerPreview(preview) {
    $('organizerPreviewBanner').classList.toggle('hidden', !preview);
    $('organizerStats').classList.toggle('hidden', preview);
    $('organizerIntro').textContent = preview
      ? 'Take a look around. Create an organizer account when you\'re ready to publish and manage a community.'
      : `Welcome, ${CC.user.name.split(' ')[0]}. Publish communities and events — they appear in public discovery straight away.`;
    document.querySelectorAll('#organizerView form input, #organizerView form textarea, #organizerView form select, #organizerView .file-btn input').forEach(el => { el.disabled = preview; });
    $('communitySubmit').textContent = preview ? 'Create an organizer account to publish' : (state.editingCommunityId ? 'Save changes' : 'Publish community');
    $('eventSubmit').textContent = preview ? 'Create an organizer account to publish' : (state.editingEventId ? 'Save event changes' : 'Publish event');
  }

  async function loadOrganizer() {
    if (!isOrganizer()) {
      setOrganizerPreview(true);
      $('organizerCommunities').innerHTML = '<div class="preview-stats"><div><b>01</b><small>Create your community</small></div><div><b>02</b><small>Share its story &amp; photo</small></div><div><b>03</b><small>Publish events</small></div></div>';
      $('organizerEventList').innerHTML = '<p class="muted">Your upcoming events and registrations will appear here once you publish them.</p>';
      return;
    }
    setOrganizerPreview(false);
    $('eventDate').min = CC_today();
    $('organizerCommunities').innerHTML = '<p class="muted">Loading your communities…</p>';
    try {
      const [{ communities }, { events }] = await Promise.all([api('/organizer/communities'), api('/organizer/events')]);
      state.organizer = { communities, events };
      renderOrganizer();
      if (!state.organizerPanelChosen) {
        state.organizerPanelChosen = true;
        showPanel(events.length ? 'analyticsPanel' : 'createCommunityPanel');
      } else if (!$('analyticsPanel').classList.contains('hidden')) loadAnalytics();
    } catch (e) {
      $('organizerCommunities').innerHTML = `<p class="muted error-text">${esc(e.message)}</p>`;
    }
  }

  function renderOrganizer() {
    const { communities, events } = state.organizer;
    const members = communities.reduce((n, c) => n + c.member_count, 0);
    const upcoming = events.filter(e => !e.is_past);
    const regs = events.reduce((n, e) => n + e.registration_count, 0);
    const revenue = events.reduce((n, e) => n + (e.revenue_pence || 0), 0);
    $('organizerStats').innerHTML = `<div><b>${communities.length}</b><small>${communities.length === 1 ? 'Community' : 'Communities'}</small></div><div><b>${members}</b><small>Members</small></div><div><b>${upcoming.length}</b><small>Upcoming events</small></div><div><b>${regs}</b><small>Event registrations</small></div><div><b>${money(revenue)}</b><small>Ticket revenue</small></div>`;
    $('organizerCommunities').innerHTML = communities.length ? communities.map(c => `<div class="manage-item">
        <div class="item-main">${photo(c.image_url, c.name, 'thumb-photo')}<div><strong>${esc(c.name)}</strong><small>${esc(c.category)} · ${esc(c.town)} · ${plural(c.member_count, 'member')} · ${plural(c.event_count || 0, 'event')}</small><small class="ok-label">● Published</small></div></div>
        <div class="item-actions"><a class="event-register" href="community.html?id=${c.id}">View</a><button class="event-register" type="button" data-edit="${c.id}">Edit</button><button class="event-register" type="button" data-new-event="${c.id}">Add event</button><button class="text-btn danger-link" type="button" data-delete-community="${c.id}">Delete</button></div></div>`).join('')
      : '<p class="muted">You haven\'t created a community yet. Use “Create community” to publish your first one.</p>';
    const sorted = [...events.filter(e => !e.has_started), ...events.filter(e => e.has_started).reverse()];
    $('organizerEventList').innerHTML = sorted.length ? sorted.map(e => {
      const booked = e.capacity ? `${e.registration_count}/${e.capacity} booked` : plural(e.registration_count, 'registration');
      const status = e.is_cancelled ? `<small class="past-label">✕ Cancelled${e.cancel_reason ? ` — ${esc(e.cancel_reason)}` : ''} · everyone refunded and notified</small>` : e.has_started
        ? `<small class="past-label">Finished · ${e.attended_count}/${e.registration_count} attended · ${money(e.revenue_pence)}${e.avg_rating ? ` · ★ ${e.avg_rating}` : ''}</small>`
        : `<small class="ok-label">● Published · ${booked} · ${e.early_active ? `early bird ${money(e.early_price_pence)} → ${priceLabel(e.price_pence)} (${e.early_sold} sold)` : priceLabel(e.price_pence)} · ${money(e.revenue_pence)} taken${e.is_full ? ' · FULL' : ''}</small>`;
      return `<div class="manage-item${e.has_started ? ' is-past' : ''}">
        <div class="item-main">${photo(e.image_url || e.community_image_url, e.name, 'thumb-photo')}<div><strong>${esc(e.name)}</strong><small>${esc(e.community_name)} · ${esc(formatDate(e.event_date))} · ${esc(e.event_time)} · ${esc(e.venue)}</small>${status}${CC.badges(e, 4)}${e.waitlist_count ? `<small class="muted">⏳ ${plural(e.waitlist_count, 'person', 'people')} on the waitlist</small>` : ''}</div></div>
        <div class="item-actions"><a class="event-register" href="event.html?id=${e.id}">View</a>${e.has_started || e.checkin_open ? `<button class="event-register" type="button" data-attendance="${e.id}">Attendance${e.has_started ? '' : ` (${e.checked_in_count || 0} in)`}</button>` : ''}${!e.has_started ? `<button class="event-register" type="button" data-edit-event="${e.id}">Edit</button><a class="event-register" href="checkin.html?event=${e.id}">📷 Scan tickets</a><button class="event-register${e.featured ? ' is-on' : ''}" type="button" data-feature="${e.id}" data-on="${e.featured ? 1 : 0}" title="Show on the homepage">${e.featured ? '★ Featured' : '☆ Feature'}</button>${e.price_pence ? `<button class="event-register${e.flash_active ? ' is-on' : ''}" type="button" data-flash="${e.id}">${e.flash_active ? `⚡ ${e.flash_percent}% sale live` : '⚡ Flash sale'}</button>` : ''}` : ''}${e.price_pence && !e.has_started ? `<button class="event-register" type="button" data-promo="${e.id}">% Promo codes${e.promo_count ? ` (${e.promo_count})` : ''}</button>` : ''}<button class="event-register repeat-btn" type="button" data-repeat="${e.id}" title="Create the same event again, one week later">↻ Run again</button>${!e.has_started && !e.is_cancelled ? `<button class="text-btn danger-link" type="button" data-cancel-event="${e.id}" data-name="${esc(e.name)}" data-count="${e.registration_count}">Cancel event</button>` : ''}<button class="text-btn danger-link" type="button" data-delete-event="${e.id}">Delete</button></div>
        ${e.price_pence && !e.has_started ? `<form class="flash-form hidden" data-flash-form="${e.id}"><strong>⚡ Flash sale</strong><label>Discount <select name="percent">${[10, 15, 20, 25, 30, 40, 50].map(p => `<option value="${p}"${p === (e.flash_percent || 20) ? ' selected' : ''}>${p}% off</option>`).join('')}</select></label><label>Runs for <select name="hours"><option value="2">2 hours</option><option value="6">6 hours</option><option value="24" selected>24 hours</option><option value="48">48 hours</option><option value="72">3 days</option></select></label><button class="primary-btn" type="submit">${e.flash_active ? 'Restart sale' : 'Start sale & notify members'}</button>${e.flash_active ? `<button class="outline-btn" type="button" data-end-flash="${e.id}">End sale</button><small>Ends in <span data-countdown="${esc(e.flash_until)}" data-countdown-style="short" data-countdown-ended="ended"></span></small>` : ''}</form>` : ''}</div>`;
    }).join('')
      : '<p class="muted">No events published yet.</p>';
    const sel = $('eventCommunity');
    const keep = sel.value;
    sel.innerHTML = communities.length
      ? '<option value="">Choose one of your communities</option>' + communities.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')
      : '<option value="">Create a community first</option>';
    if (communities.some(c => String(c.id) === keep)) sel.value = keep;
  }

  function showPanel(id) {
    const menuId = id === 'attendancePanel' || id === 'promoPanel' ? 'organizerEventsPanel' : id;
    document.querySelectorAll('.side-link').forEach(x => x.classList.toggle('selected', x.dataset.panel === menuId));
    document.querySelectorAll('.organizer-panel').forEach(x => x.classList.toggle('hidden', x.id !== id));
    CCCharts.hideTip();
    if (id === 'analyticsPanel' && isOrganizer()) loadAnalytics();
  }
  document.querySelectorAll('.side-link').forEach(b => { b.onclick = () => showPanel(b.dataset.panel); });

  $('organizerView').addEventListener('click', async e => {
    const edit = e.target.closest('[data-edit]');
    const newEvent = e.target.closest('[data-new-event]');
    const delC = e.target.closest('[data-delete-community]');
    const delE = e.target.closest('[data-delete-event]');
    if (edit) return startEdit(Number(edit.dataset.edit));
    const editEvent = e.target.closest('[data-edit-event]');
    const repeat = e.target.closest('[data-repeat]');
    const attendance = e.target.closest('[data-attendance]');
    const panelLink = e.target.closest('[data-panel-link]');
    const promoBtn = e.target.closest('[data-promo]');
    const delPromo = e.target.closest('[data-delete-promo]');
    if (promoBtn) return openPromo(Number(promoBtn.dataset.promo));
    const cancelEv = e.target.closest('[data-cancel-event]');
    if (cancelEv) {
      const n = Number(cancelEv.dataset.count);
      if (!confirm(`Cancel “${cancelEv.dataset.name}”?${n ? ` All ${n} ${n === 1 ? 'person' : 'people'} registered will be refunded and notified.` : ''} This cannot be undone.`)) return;
      const reason = prompt('Reason for cancelling (optional, shown to attendees):', '') ?? '';
      try { const d = await api(`/events/${cancelEv.dataset.cancelEvent}/cancel`, { method: 'POST', body: { reason } }); toast(d.message, 'success'); await loadOrganizer(); showPanel('organizerEventsPanel'); }
      catch (err) { toast(err.message, 'error'); }
      return;
    }
    const featureBtn = e.target.closest('[data-feature]');
    const flashBtn = e.target.closest('[data-flash]');
    const endFlash = e.target.closest('[data-end-flash]');
    if (flashBtn) { const f = document.querySelector(`[data-flash-form="${flashBtn.dataset.flash}"]`); f?.classList.toggle('hidden'); f?.querySelector('select')?.focus(); return; }
    if (featureBtn || endFlash) {
      try {
        const d = featureBtn ? await api(`/events/${featureBtn.dataset.feature}/featured`, { method: 'POST', body: { featured: featureBtn.dataset.on !== '1' } })
          : await api(`/events/${endFlash.dataset.endFlash}/flash-sale`, { method: 'DELETE' });
        toast(d.message, 'success');
        await loadOrganizer(); showPanel('organizerEventsPanel'); loadHomePromo(); loadPublicEvents();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    if (delPromo) {
      try { toast((await api(`/events/${delPromo.dataset.event}/promo-codes/${delPromo.dataset.deletePromo}`, { method: 'DELETE' })).message); await openPromo(Number(delPromo.dataset.event)); }
      catch (err) { toast(err.message, 'error'); }
      return;
    }
    if (editEvent) return startEventEdit(Number(editEvent.dataset.editEvent));
    if (attendance) return openAttendance(Number(attendance.dataset.attendance));
    if (panelLink) return showPanel(panelLink.dataset.panelLink);
    if (repeat) {
      repeat.disabled = true;
      try {
        const d = await api(`/events/${repeat.dataset.repeat}/repeat`, { method: 'POST', body: {} });
        toast(`${d.message} You can edit it if needed.`, 'success');
        await loadOrganizer();
        showPanel('organizerEventsPanel');
        document.querySelector(`[data-edit-event="${d.event.id}"]`)?.closest('.manage-item')?.classList.add('just-added');
      } catch (err) { toast(err.message, 'error'); repeat.disabled = false; }
      return;
    }
    if (newEvent) { showPanel('createEventPanel'); $('eventCommunity').value = newEvent.dataset.newEvent; $('eventName').focus(); return; }
    try {
      if (delC) {
        const c = state.organizer.communities.find(x => x.id === Number(delC.dataset.deleteCommunity));
        if (!confirm(`Delete “${c?.name}”? Its events, memberships and registrations will also be removed. This cannot be undone.`)) return;
        toast((await api(`/communities/${delC.dataset.deleteCommunity}`, { method: 'DELETE' })).message);
        if (state.editingCommunityId === c?.id) resetCommunityForm();
      } else if (delE) {
        if (!confirm('Delete this event? Registrations for it will also be removed.')) return;
        toast((await api(`/events/${delE.dataset.deleteEvent}`, { method: 'DELETE' })).message);
      } else return;
      await loadOrganizer();
    } catch (err) { toast(err.message, 'error'); }
  });

  $('organizerView').addEventListener('submit', async e => {
    const form = e.target.closest('[data-flash-form]');
    if (!form) return;
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const d = await api(`/events/${form.dataset.flashForm}/flash-sale`, { method: 'POST', body: { percent: Number(form.percent.value), hours: Number(form.hours.value) } });
      toast(`⚡ ${d.message}`, 'success');
      await loadOrganizer(); showPanel('organizerEventsPanel'); loadHomePromo(); loadPublicEvents();
    } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
  });

  // --- photo picker (community and event forms)
  function photoField(root) {
    const preview = root.querySelector('[data-photo-preview]');
    const file = root.querySelector('[data-photo-file]');
    const url = root.querySelector('[data-photo-url]');
    const value = root.querySelector('[data-photo-value]');
    const remove = root.querySelector('[data-photo-remove]');
    const status = root.querySelector('[data-photo-status]');
    const defaultStatus = status.textContent;
    const field = { uploading: false };
    function show(src) {
      value.value = src || '';
      remove.classList.toggle('hidden', !src);
      preview.classList.toggle('empty', !src);
      preview.innerHTML = src ? photo(src, 'Selected photograph', 'preview-photo') : '<span>No photo selected</span>';
    }
    field.set = src => { url.value = src && !src.startsWith('/uploads/') ? src : ''; file.value = ''; status.textContent = defaultStatus; status.classList.remove('is-error'); show(src); };
    file.addEventListener('change', async () => {
      const f = file.files[0];
      if (!f) return;
      field.uploading = true;
      status.textContent = 'Uploading photo…';
      status.classList.remove('is-error');
      try {
        const stored = await CC.uploadImage(f);
        url.value = '';
        show(stored);
        status.textContent = 'Photo uploaded. It will be saved when you publish.';
      } catch (err) {
        status.textContent = err.message;
        status.classList.add('is-error');
      } finally { field.uploading = false; file.value = ''; }
    });
    url.addEventListener('change', () => {
      const v = url.value.trim();
      if (v && !/^https:\/\//i.test(v)) { status.textContent = 'Image links must start with https://'; status.classList.add('is-error'); return; }
      status.textContent = defaultStatus; status.classList.remove('is-error');
      show(v);
    });
    remove.addEventListener('click', () => field.set(''));
    return field;
  }
  const communityPhoto = photoField(document.querySelector('[data-photo-field=community]'));
  const eventPhoto = photoField(document.querySelector('[data-photo-field=event]'));

  // --- community form
  CC.locationAutocomplete({
    input: $('communityTown'), list: $('communityTownSuggestions'), status: $('communityLocationStatus'),
    onSelect: r => {
      $('communityTown').value = r.type === 'Postcode' || r.type === 'Postcode district' ? (r.area || r.name) : r.name;
      if (r.postcode) $('communityPostcode').value = r.postcode;
      $('communityLatitude').value = r.lat;
      $('communityLongitude').value = r.lon;
      setMessage($('communityLocationStatus'), `Map position set from ${r.label} (${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}).`, 'success');
    },
    onClear: () => {
      $('communityLatitude').value = '';
      $('communityLongitude').value = '';
      setMessage($('communityLocationStatus'), 'Pick a suggestion to set the exact map position (or we will look up the town when you publish).');
    }
  });

  const COMMUNITY_FIELDS = { name: 'communityName', category: 'communityCategory', description: 'communityDescription', story: 'communityStory', town: 'communityTown', address: 'communityAddress', postcode: 'communityPostcode', latitude: 'communityLatitude', longitude: 'communityLongitude' };
  const EVENT_FIELDS = { community_id: 'eventCommunity', name: 'eventName', event_date: 'eventDate', event_time: 'eventTime', venue: 'eventVenue', description: 'eventDescription', price: 'eventPrice', capacity: 'eventCapacity', early_price: 'eventEarlyPrice', early_until: 'eventEarlyUntil', early_limit: 'eventEarlyLimit' };


  function clearFieldErrors(form) { form.querySelectorAll('.field-error').forEach(el => el.classList.remove('field-error')); }
  function markField(map, field) {
    const el = map[field] && $(map[field]);
    if (el) { el.classList.add('field-error'); el.focus(); }
  }

  function startEdit(id) {
    const c = state.organizer.communities.find(x => x.id === id);
    if (!c) return;
    state.editingCommunityId = id;
    showPanel('createCommunityPanel');
    $('communityFormTitle').textContent = `Edit “${c.name}”`;
    $('communitySubmit').textContent = 'Save changes';
    $('cancelEditBtn').classList.remove('hidden');
    for (const [k, idName] of Object.entries(COMMUNITY_FIELDS)) $(idName).value = c[k] ?? '';
    communityPhoto.set(c.image_url);
    setMessage($('communityLocationStatus'), `Map position: ${Number(c.latitude).toFixed(4)}, ${Number(c.longitude).toFixed(4)}`);
    setMessage($('communityMessage'), '');
    $('communityName').focus();
  }
  function resetCommunityForm() {
    state.editingCommunityId = null;
    $('communityForm').reset();
    communityPhoto.set('');
    clearFieldErrors($('communityForm'));
    $('communityFormTitle').textContent = 'Create a community';
    $('communitySubmit').textContent = 'Publish community';
    $('cancelEditBtn').classList.add('hidden');
    setMessage($('communityLocationStatus'), 'Pick a suggestion to set the exact map position.');
  }
  $('cancelEditBtn').onclick = () => { resetCommunityForm(); setMessage($('communityMessage'), ''); };

  $('communityForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (!isOrganizer()) return openAuth(CC.user ? 'login' : 'register', { role: 'organizer', message: 'Organizer accounts can publish communities and events.', onSuccess: u => openView(u.role) });
    const form = e.target;
    clearFieldErrors(form);
    if (communityPhoto.uploading) return setMessage($('communityMessage'), 'Please wait for the photo to finish uploading.', 'error');
    const body = Object.fromEntries(Object.entries(COMMUNITY_FIELDS).map(([k, idName]) => [k, $(idName).value.trim()]));
    body.image_url = $('communityImage').value;
    const missing = ['name', 'category', 'description', 'town'].find(k => !body[k]);
    if (missing) { setMessage($('communityMessage'), 'Please complete all fields marked with *.', 'error'); return markField(COMMUNITY_FIELDS, missing); }
    const editing = state.editingCommunityId;
    $('communitySubmit').disabled = true;
    setMessage($('communityMessage'), editing ? 'Saving changes…' : 'Publishing…');
    try {
      const d = await api(editing ? `/communities/${editing}` : '/communities', { method: editing ? 'PUT' : 'POST', body });
      resetCommunityForm();
      setMessage($('communityMessage'), `${d.message} “${d.community.name}” is now visible in public discovery.`, 'success');
      toast(d.message, 'success');
      await loadOrganizer();
    } catch (err) {
      setMessage($('communityMessage'), err.message, 'error');
      if (err.field) markField(COMMUNITY_FIELDS, err.field);
    } finally { $('communitySubmit').disabled = false; }
  });

  function startEventEdit(id) {
    const ev = state.organizer.events.find(x => x.id === id);
    if (!ev) return;
    state.editingEventId = id;
    showPanel('createEventPanel');
    $('eventFormTitle').textContent = `Edit “${ev.name}”`;
    $('eventSubmit').textContent = 'Save event changes';
    $('cancelEventEditBtn').classList.remove('hidden');
    $('eventCommunity').value = ev.community_id;
    $('eventCommunity').disabled = true;
    $('eventName').value = ev.name;
    $('eventDate').value = ev.event_date;
    $('eventTime').value = ev.event_time;
    $('eventVenue').value = ev.venue;
    $('eventDescription').value = ev.description || '';
    $('eventPrice').value = ev.price_pence ? (ev.price_pence / 100).toFixed(2) : '';
    $('eventCapacity').value = ev.capacity ?? '';
    $('eventEarlyPrice').value = ev.early_price_pence != null ? (ev.early_price_pence / 100).toFixed(2) : '';
    $('eventEarlyUntil').value = ev.early_until || '';
    $('eventEarlyLimit').value = ev.early_limit ?? '';
    eventPhoto.set(ev.image_url);
    setMessage($('eventMessage'), '');
    $('eventName').focus();
  }
  function resetEventForm() {
    state.editingEventId = null;
    $('eventForm').reset();
    $('eventCommunity').disabled = false;
    eventPhoto.set('');
    clearFieldErrors($('eventForm'));
    $('eventFormTitle').textContent = 'Publish an event';
    $('eventSubmit').textContent = 'Publish event';
    $('cancelEventEditBtn').classList.add('hidden');
  }
  $('cancelEventEditBtn').onclick = () => { resetEventForm(); setMessage($('eventMessage'), ''); showPanel('organizerEventsPanel'); };

  $('eventForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (!isOrganizer()) return openAuth(CC.user ? 'login' : 'register', { role: 'organizer', message: 'Organizer accounts can publish communities and events.', onSuccess: u => openView(u.role) });
    const form = e.target;
    clearFieldErrors(form);
    if (eventPhoto.uploading) return setMessage($('eventMessage'), 'Please wait for the photo to finish uploading.', 'error');
    const body = Object.fromEntries(Object.entries(EVENT_FIELDS).map(([k, idName]) => [k, $(idName).value.trim()]));
    body.image_url = $('eventImage').value;
    const editing = state.editingEventId;
    const missing = ['community_id', 'name', 'event_date', 'event_time', 'venue'].find(k => !body[k]);
    if (missing) {
      setMessage($('eventMessage'), state.organizer.communities.length ? 'Please complete all fields marked with *. Dates must use a valid calendar date.' : 'Create a community before publishing events.', 'error');
      return markField(EVENT_FIELDS, missing);
    }
    $('eventSubmit').disabled = true;
    setMessage($('eventMessage'), editing ? 'Saving…' : 'Publishing…');
    try {
      const d = await api(editing ? `/events/${editing}` : '/events', { method: editing ? 'PUT' : 'POST', body });
      resetEventForm();
      setMessage($('eventMessage'), editing ? `${d.message} “${d.event.name}” has been updated.` : `${d.message} “${d.event.name}” is now listed in public events.`, 'success');
      toast(d.message, 'success');
      await loadOrganizer();
    } catch (err) {
      setMessage($('eventMessage'), err.message, 'error');
      if (err.field) markField(EVENT_FIELDS, err.field);
    } finally { $('eventSubmit').disabled = false; }
  });

  // --- attendance check-in
  async function openAttendance(id) {
    showPanel('attendancePanel');
    const box = $('attendanceContent');
    box.innerHTML = '<p class="muted">Loading registrations…</p>';
    try {
      const { event, attendees } = await api(`/events/${id}/attendees`);
      const came = attendees.filter(a => a.attended).length;
      $('attendanceTitle').textContent = `Attendance — ${event.name}`;
      $('attendanceIntro').textContent = `${event.community_name} · ${formatDate(event.event_date)} · ${event.event_time}. ${event.has_started ? 'Tick the people who came; this feeds your analytics.' : 'Check-in is open — scan QR tickets at the door or tick people here.'}`;
      box.innerHTML = `<div class="attendance-summary"><div><b id="attCount">${came}</b><small>of ${attendees.length} attended</small></div><div><b>${money(event.revenue_pence)}</b><small>ticket revenue</small></div><div><b>${event.avg_rating ? '★ ' + event.avg_rating : '–'}</b><small>${plural(event.rating_count, 'rating')}</small></div>
          <div><b>${attendees.filter(a => a.checked_in_by).length}</b><small>checked in by QR</small></div>
          <a class="outline-btn" href="checkin.html?event=${event.id}">📷 Open QR scanner</a>
          ${attendees.length ? '<button class="outline-btn" type="button" id="markAllBtn">✓ Mark everyone as attended</button>' : ''}</div>
        ${attendees.length ? `<div class="attendance-list">${attendees.map(a => `<label class="attendee${a.attended ? ' is-in' : ''}">
            <input type="checkbox" data-user="${a.user_id}" ${a.attended ? 'checked' : ''}>
            <span class="attendee-name"><strong>${esc(a.name)}</strong><small>${esc(a.email)} · ${a.amount_pence ? `${CC.ticketLabel(a.ticket_type)} · paid ${money(a.amount_pence)}${a.promo_code ? ` (${esc(a.promo_code)})` : ''}` : 'Free'}</small></span>
            <span class="attendee-rating">${a.checked_in_by ? '<em class="qr-tag">QR ✓</em>' : ''}${a.rating ? '★'.repeat(a.rating) : ''}</span></label>`).join('')}</div>`
          : '<p class="muted">Nobody registered for this event.</p>'}`;
      const update = () => { $('attCount').textContent = box.querySelectorAll('input[data-user]:checked').length; };
      box.querySelectorAll('input[data-user]').forEach(cb => cb.addEventListener('change', async () => {
        cb.disabled = true;
        try {
          await api(`/events/${id}/attendees/${cb.dataset.user}`, { method: 'PUT', body: { attended: cb.checked } });
          cb.closest('.attendee').classList.toggle('is-in', cb.checked);
        } catch (err) { cb.checked = !cb.checked; toast(err.message, 'error'); }
        finally { cb.disabled = false; update(); }
      }));
      $('markAllBtn')?.addEventListener('click', async () => {
        try { toast((await api(`/events/${id}/attendees/all`, { method: 'POST', body: {} })).message, 'success'); await openAttendance(id); }
        catch (err) { toast(err.message, 'error'); }
      });
    } catch (err) { box.innerHTML = `<p class="muted error-text">${esc(err.message)}</p>`; }
  }

  // --- promo codes
  async function openPromo(id) {
    showPanel('promoPanel');
    const box = $('promoContent');
    box.innerHTML = '<p class="muted">Loading promo codes…</p>';
    try {
      const ev = state.organizer.events.find(x => x.id === id);
      const { promo_codes: codes } = await api(`/events/${id}/promo-codes`);
      $('promoTitle').textContent = `Promo codes — ${ev ? ev.name : 'event'}`;
      $('promoIntro').textContent = ev ? `${ev.community_name} · ${formatDate(ev.event_date)} · standard ${money(ev.price_pence)}${ev.early_price_pence != null ? ` · early bird ${money(ev.early_price_pence)}` : ''}. Codes take a percentage off the current price.` : '';
      box.innerHTML = `
        <form class="promo-create" id="promoCreate" novalidate>
          <label>Code <input id="promoCode" maxlength="20" placeholder="e.g. STUDENT20" autocomplete="off"></label>
          <label>% off <input id="promoPercent" type="number" min="5" max="100" step="1" placeholder="20"></label>
          <label>Max uses <span class="optional">(optional)</span><input id="promoMax" type="number" min="1" step="1" placeholder="Unlimited"></label>
          <button class="primary-btn" type="submit">Create code</button>
        </form>
        <p class="form-message" id="promoMessage" role="status"></p>
        ${codes.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Code</th><th class="num">Discount</th><th class="num">Used</th><th class="num">Discount given</th><th></th></tr></thead><tbody>
          ${codes.map(c => `<tr><td><b>${esc(c.code)}</b></td><td class="num">${c.percent_off}%</td><td class="num">${c.uses}${c.max_uses ? ` / ${c.max_uses}` : ''}</td><td class="num">${money(c.discount_given_pence)}</td><td><button class="text-btn danger-link" type="button" data-delete-promo="${c.id}" data-event="${id}">Delete</button></td></tr>`).join('')}
        </tbody></table></div>` : '<p class="muted">No promo codes yet. Create one above and share it, e.g. on social media or with students.</p>'}`;
      $('promoCreate').onsubmit = async e => {
        e.preventDefault();
        try {
          const d = await api(`/events/${id}/promo-codes`, { method: 'POST', body: { code: $('promoCode').value, percent_off: $('promoPercent').value, max_uses: $('promoMax').value } });
          toast(d.message, 'success');
          await loadOrganizer();
          await openPromo(id);
        } catch (err) { setMessage($('promoMessage'), err.message, 'error'); }
      };
    } catch (err) { box.innerHTML = `<p class="muted error-text">${esc(err.message)}</p>`; }
  }

  // --- analytics
  const monthName = key => new Date(`${key}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'short' });
  const moneyTick = (p, axis) => axis && p >= 100000 ? `£${(p / 100000).toFixed(p % 100000 ? 1 : 0)}k` : money(p);
  let analyticsTicket = 0;

  async function loadAnalytics() {
    const box = $('analyticsContent');
    const ticket = ++analyticsTicket;
    if (!box.dataset.loaded) box.innerHTML = '<p class="muted">Loading analytics…</p>';
    try {
      const data = await api(`/organizer/analytics?months=${$('analyticsMonths').value}`);
      if (ticket !== analyticsTicket) return;
      box.dataset.loaded = '1';
      renderAnalytics(data);
    } catch (err) { box.innerHTML = `<p class="muted error-text">${esc(err.message)}</p>`; }
  }
  $('analyticsMonths').onchange = loadAnalytics;

  function renderAnalytics(d) {
    const s = d.summary;
    const box = $('analyticsContent');
    const firstMonth = d.monthly[0].month;
    const recent = d.per_event.filter(e => e.event_date.slice(0, 7) >= firstMonth);
    const thisMonth = d.member_growth[d.member_growth.length - 1];
    const upcomingBooked = d.upcoming.reduce((n, e) => n + e.registered, 0);
    const kpi = (label, value, sub) => `<div class="kpi"><small>${label}</small><b>${value}</b><span>${sub}</span></div>`;
    box.innerHTML = `
      <div class="kpi-row">
        ${kpi('Ticket revenue', money(s.revenue_pence), `${money(s.revenue_upcoming_pence)} booked for upcoming events`)}
        ${kpi('Registrations', s.registrations_total, `across ${plural(s.events_total, 'event')}`)}
        ${kpi('Attendance rate', s.attendance_rate == null ? '–' : s.attendance_rate + '%', `${s.attended} of ${s.registrations_past} registered came`)}
        ${kpi('Average rating', s.avg_rating == null ? '–' : '★ ' + s.avg_rating, `from ${plural(s.ratings, 'rating')}`)}
        ${kpi('Memberships', s.members, `+${thisMonth.new_members} this month`)}
        ${kpi('Upcoming events', s.events_upcoming, `${upcomingBooked} places booked`)}
      </div>
      ${d.earnings ? `<section class="viz-card viz-wide earnings-card"><header class="table-head"><div><h4>Your earnings &amp; payouts</h4><p>Community Connect collects ticket payments and keeps a ${d.earnings.fee_percent}% platform fee. After each event, the rest is paid out to you.</p></div></header>
        <div class="kpi-row">
          ${kpi('Ticket sales', money(d.earnings.gross_pence), `− ${money(d.earnings.fee_pence)} platform fee (${d.earnings.fee_percent}%)`)}
          ${kpi('Your earnings', money(d.earnings.net_pence), 'after the platform fee')}
          ${kpi('Paid to you', money(d.earnings.paid_pence), `${money(d.earnings.ready_pence)} ready · ${money(d.earnings.pending_pence)} after upcoming events`)}
        </div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>Event</th><th class="num">Tickets</th><th class="num">Sales</th><th class="num">Platform fee</th><th class="num">You receive</th><th>Status</th></tr></thead>
        <tbody>${d.earnings.payouts.map(p => `<tr><td>${esc(p.event_name)}<br><small class="muted">${esc(formatDate(p.event_date, { short: true }))}</small></td><td class="num">${p.tickets}</td><td class="num">${money(p.gross_pence)}</td><td class="num">−${money(p.fee_pence)}</td><td class="num"><strong>${money(p.net_pence)}</strong></td><td><span class="status-pill st-${p.status}">${{ pending: 'After the event', ready: 'Being paid', paid: 'Paid' }[p.status]}</span>${p.status === 'paid' && p.reference ? `<br><small class="muted">${esc(p.reference)}</small>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No paid ticket sales yet.</td></tr>'}</tbody></table></div></section>` : ''}
      <div class="kpi-row kpi-row-v5">
        ${kpi('QR check-ins', d.qr_checkins || 0, 'tickets scanned at the door')}
        ${kpi('Friend referrals', d.referral_total || 0, `${money(d.referral_revenue_pence || 0)} from referred friends`)}
        ${kpi('On waitlists', d.waitlist_total || 0, 'people waiting for a place')}
      </div>
      ${(d.referrals || []).length ? `<section class="viz-card viz-wide"><header><h4>Top referrers — “bring a friend”</h4><p>Ticket holders whose invite links brought new bookings.</p></header><div class="table-wrap"><table class="data-table"><thead><tr><th>Referrer</th><th>Event</th><th class="num">Friends booked</th><th class="num">Revenue</th></tr></thead><tbody>${d.referrals.map(r => `<tr><td>${esc(r.referrer)}</td><td>${esc(r.event_name)}</td><td class="num">${r.friends}</td><td class="num">${money(r.revenue_pence)}</td></tr>`).join('')}</tbody></table></div></section>` : ''}
      ${recent.length ? '' : '<div class="empty-inline analytics-empty"><strong>No past events in this period yet</strong><p>Charts fill in once your events have taken place. After an event, open <b>My events → Attendance</b> to record who came.</p></div>'}
      <section class="viz-card viz-wide"><header><h4>Registered vs attended — past events</h4><p>Each pair of bars is one event. The gap shows people who registered but didn't come.</p></header><div id="chartPerEvent"></div></section>
      <div class="viz-grid">
        <section class="viz-card"><header><h4>Ticket revenue by month</h4><p>Money from tickets for events held each month.</p></header><div id="chartRevenue"></div></section>
        <section class="viz-card"><header><h4>Attendance by month</h4><p>Registrations and actual attendance, by event month.</p></header><div id="chartMonthly"></div></section>
        <section class="viz-card"><header><h4>Member growth</h4><p>Total memberships across your communities.</p></header><div id="chartMembers"></div></section>
        <section class="viz-card"><header><h4>Revenue by community</h4><p>All ticket revenue, with each community's attendance rate.</p></header><div id="chartCommunity"></div></section>
      </div>
      <div class="viz-grid">
        <section class="viz-card"><header><h4>Ticket sales by type</h4><p>Revenue from early-bird and standard tickets, with tickets sold.</p></header><div id="chartTicketTypes"></div></section>
        <section class="viz-card"><header><h4>Promo codes used</h4><p>Which codes brought in sales, and the discount given.</p></header><div id="chartPromos"></div></section>
      </div>
      <section class="viz-card viz-wide"><header><h4>Upcoming events — places booked</h4><p>How full each upcoming event is.</p></header><div id="chartUpcoming"></div></section>
      <section class="viz-card viz-wide"><header class="table-head"><div><h4>All past events</h4><p>The data behind the charts.</p></div><button class="outline-btn" type="button" id="exportCsv">⬇ Download CSV</button></header>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>Event</th><th>Date</th><th>Community</th><th class="num">Registered</th><th class="num">Attended</th><th class="num">Rate</th><th class="num">Revenue</th><th class="num">Rating</th><th></th></tr></thead>
        <tbody>${d.per_event.slice().reverse().map(e => `<tr><td>${esc(e.name)}</td><td>${esc(formatDate(e.event_date, { short: true }))}</td><td>${esc(e.community_name)}</td><td class="num">${e.registered}</td><td class="num">${e.attended}</td><td class="num">${e.attendance_rate == null ? '–' : e.attendance_rate + '%'}</td><td class="num">${money(e.revenue_pence)}</td><td class="num">${e.avg_rating ? '★ ' + e.avg_rating : '–'}</td><td><button class="text-btn" type="button" data-repeat="${e.id}">↻ Run again</button></td></tr>`).join('') || '<tr><td colspan="9" class="muted">No past events yet.</td></tr>'}</tbody></table></div></section>`;

    const last = recent.slice($('chartPerEvent').clientWidth < 560 ? -6 : -10);
    if (last.length) {
      CCCharts.bars($('chartPerEvent'), {
        categories: last.map(e => e.name),
        series: [{ name: 'Registered', color: '--series-1', values: last.map(e => e.registered) }, { name: 'Attended', color: '--series-2', values: last.map(e => e.attended) }],
        format: v => String(Math.round(v)), height: 290,
        ariaLabel: `Registered versus attended for ${last.length} past events`,
        tooltipTitle: i => `${last[i].name} · ${formatDate(last[i].event_date, { short: true })}`,
        tooltipExtra: i => `<div class="tip-sub">${last[i].attendance_rate ?? '–'}% attended · ${money(last[i].revenue_pence)}${last[i].avg_rating ? ' · ★ ' + last[i].avg_rating : ''}</div>`
      });
    } else $('chartPerEvent').innerHTML = '<p class="muted viz-empty">No past events in this period.</p>';
    const months = d.monthly.map(m => monthName(m.month));
    CCCharts.bars($('chartRevenue'), {
      categories: months, series: [{ name: 'Revenue', color: '--series-1', values: d.monthly.map(m => m.revenue_pence) }],
      format: moneyTick, ariaLabel: 'Ticket revenue by month',
      tooltipTitle: i => new Date(`${d.monthly[i].month}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
      tooltipExtra: i => `<div class="tip-sub">${plural(d.monthly[i].events, 'event')}</div>`
    });
    CCCharts.line($('chartMonthly'), {
      categories: months,
      series: [{ name: 'Registered', color: '--series-1', values: d.monthly.map(m => m.registrations) }, { name: 'Attended', color: '--series-2', values: d.monthly.map(m => m.attended) }],
      format: v => String(Math.round(v)), ariaLabel: 'Registrations and attendance by month',
      tooltipTitle: i => new Date(`${d.monthly[i].month}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    });
    CCCharts.line($('chartMembers'), {
      categories: months, area: true,
      series: [{ name: 'Members', color: '--series-1', values: d.member_growth.map(m => m.total_members) }],
      format: v => String(Math.round(v)), ariaLabel: 'Total memberships by month',
      tooltipTitle: i => `${new Date(`${d.member_growth[i].month}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })} · +${d.member_growth[i].new_members} new`
    });
    const comm = d.by_community.slice().sort((a, b) => b.revenue_pence - a.revenue_pence);
    if (comm.length) CCCharts.hbars($('chartCommunity'), {
      labels: comm.map(c => c.name), values: comm.map(c => c.revenue_pence), format: p => money(p),
      sub: i => comm[i].attendance_rate == null ? 'no past events' : `${comm[i].attendance_rate}% attend`,
      tooltip: i => `${money(comm[i].revenue_pence)} · ${plural(comm[i].members, 'member')} · ${comm[i].registrations} registrations`,
      ariaLabel: 'Revenue by community'
    }); else $('chartCommunity').innerHTML = '<p class="muted viz-empty">No communities yet.</p>';
    if (d.upcoming.length) CCCharts.hbars($('chartUpcoming'), {
      labels: d.upcoming.map(e => `${e.name} · ${formatDate(e.event_date, { short: true })}`),
      values: d.upcoming.map(e => e.capacity ? e.fill_rate : 0), max: 100,
      format: (v, i) => '', sub: i => d.upcoming[i].capacity ? `${d.upcoming[i].registered}/${d.upcoming[i].capacity} · ${d.upcoming[i].fill_rate}%` : `${d.upcoming[i].registered} booked · no limit`,
      tooltip: i => `${d.upcoming[i].registered} booked${d.upcoming[i].capacity ? ` of ${d.upcoming[i].capacity}` : ''} · ${money(d.upcoming[i].revenue_pence)} booked revenue`,
      ariaLabel: 'Places booked for upcoming events'
    }); else $('chartUpcoming').innerHTML = '<p class="muted viz-empty">No upcoming events. Use “Run again” on a past event to schedule one in one click.</p>';

    const types = (d.sales_by_type || []).filter(t => t.ticket_type !== 'free' || t.tickets);
    if (types.length) CCCharts.hbars($('chartTicketTypes'), {
      labels: types.map(t => CC.ticketLabel(t.ticket_type)), values: types.map(t => t.revenue_pence),
      max: Math.max(1, ...types.map(t => t.revenue_pence)), format: p => money(p),
      sub: i => `${types[i].tickets} tickets${types[i].discount_pence ? ` · ${money(types[i].discount_pence)} promo discount` : ''}`,
      tooltip: i => `${types[i].tickets} tickets · ${money(types[i].revenue_pence)} revenue`, ariaLabel: 'Revenue by ticket type'
    }); else $('chartTicketTypes').innerHTML = '<p class="muted viz-empty">No ticket sales yet.</p>';
    const promos = (d.promo_usage || []).slice(0, 6);
    if (promos.length) CCCharts.hbars($('chartPromos'), {
      labels: promos.map(p => `${p.code} · ${p.event_name}`), values: promos.map(p => p.uses), color: '--series-2',
      format: v => `${v} used`, sub: i => `${money(promos[i].revenue_pence)} sales · −${money(promos[i].discount_pence)}`,
      tooltip: i => `${promos[i].uses} tickets with ${promos[i].code} · ${money(promos[i].revenue_pence)} revenue · ${money(promos[i].discount_pence)} discount`, ariaLabel: 'Promo code usage'
    }); else $('chartPromos').innerHTML = '<p class="muted viz-empty">No promo codes used yet. Create one from My events → Promo codes.</p>';

    $('exportCsv').onclick = () => {
      const rows = [['Event', 'Date', 'Community', 'Registered', 'Attended', 'Attendance %', 'Revenue (GBP)', 'Average rating']]
        .concat(d.per_event.map(e => [e.name, e.event_date, e.community_name, e.registered, e.attended, e.attendance_rate ?? '', (e.revenue_pence / 100).toFixed(2), e.avg_rating ?? '']));
      const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = 'community-connect-events.csv';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
  }

  function CC_today() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // ------------------------------------------------------------------ wiring
  $('authForm').addEventListener('submit', submitAuth);
  $('authClose').onclick = closeAuth;
  $('authModal').addEventListener('click', e => { if (e.target === $('authModal')) closeAuth(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('authModal').classList.contains('hidden')) closeAuth(); });

  $('homeNav').onclick = e => { e.preventDefault(); goHome(); };
  document.querySelectorAll('a.brand[href="#home"]').forEach(a => { a.onclick = e => { e.preventDefault(); goHome(); }; });
  $('eventsNav').onclick = () => openView('participant', { scrollTo: 'eventsSection' });
  $('participantNav').onclick = () => openView('participant');
  $('organizerNav').onclick = () => openView('organizer');
  $('getStartedBtn').onclick = () => openAuth('register');
  const explore = () => openView('participant');
  ['exploreBtn', 'participantCardBtn', 'closingExploreBtn', 'seeAllCommunities'].forEach(id => { $(id).onclick = explore; });
  $('seeAllEvents').onclick = () => openView('participant', { scrollTo: 'eventsSection' });
  $('organizerCardBtn').onclick = () => openView('organizer');
  $('organizerHeroBtn').onclick = () => openView('organizer');
  document.querySelectorAll('[data-preview]').forEach(b => { b.onclick = () => openView(b.dataset.preview); });
  document.querySelectorAll('[data-interest]').forEach(b => {
    b.onclick = () => { state.category = b.dataset.interest; saveSearch(); openView('participant'); };
  });

  window.addEventListener('cc:session-expired', () => { renderHeader(); toast('Your session has ended. Please log in again.'); });

  // ------------------------------------------------------------------ routing & start
  // Hash routes let other pages link straight to a section: #discover, #events, #dashboard, #organizer, #login
  async function route() {
    const hash = location.hash.replace('#', '');
    if (hash === lastRoutedHash) return;
    lastRoutedHash = hash;
    if (hash === 'discover' || hash === 'participantView') await openView('participant');
    else if (hash === 'events') await openView('participant', { scrollTo: 'eventsSection' });
    else if (hash === 'dashboard') await openView(CC.user?.role || 'participant', { scrollTo: CC.user?.role === 'organizer' ? null : 'dashboardSection' });
    else if (hash === 'organizer') await openView('organizer');
    else if (hash === 'login') { showSections('home'); loadHomeEvents(); openAuth('login'); }
    else { showSections('home'); loadHomeEvents(); }
    lastRoutedHash = location.hash.replace('#', '');
  }
  window.addEventListener('hashchange', route);

  (async () => {
    renderHeader();
    try { await CC.loadUser(); } catch { /* server unreachable — continue as visitor */ }
    renderHeader();
    await route();
  })();
})();
