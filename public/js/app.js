/* Community Connect — homepage, discovery, participant dashboard and organizer dashboard. */
(function () {
  'use strict';
  const { api, esc, toast, setMessage, photo, icon, plural, formatDate, dateParts } = CC;
  const $ = id => document.getElementById(id);

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
      $('dashboardBtn').onclick = () => openView(user.role, { scrollTo: user.role === 'participant' ? 'dashboardSection' : null });
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
      const next = state.pendingAction;
      $('authModal').classList.add('hidden');
      state.pendingAction = null;
      $('authForm').reset();
      renderHeader();
      toast(mode === 'register' ? `Welcome to Community Connect, ${data.user.name.split(' ')[0]}!` : `Welcome back, ${data.user.name.split(' ')[0]}.`, 'success');
      if (next) await next(data.user);
      else await openView(data.user.role);
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
      <a class="event-card-media" href="event.html?id=${e.id}" aria-label="${esc(e.name)}">${photo(img, e.name, 'event-photo')}<span class="date-badge"><b>${esc(day)}</b><small>${esc(month)}</small></span>${e.registered ? '<span class="status-chip">Registered</span>' : ''}</a>
      <div class="event-card-body">
        <p class="event-community">${icon(e.community_category)} ${esc(e.community_name)}</p>
        <h4><a href="event.html?id=${e.id}">${esc(e.name)}</a></h4>
        <p class="event-when">📅 ${esc(formatDate(e.event_date))} · ◷ ${esc(e.event_time)}</p>
        <p class="event-where">⌖ ${esc(e.venue)}${e.community_town ? ', ' + esc(e.community_town) : ''}</p>
        <p class="event-desc">${esc(e.description || 'More details will be shared by the organizer.')}</p>
        <a class="join-btn" href="event.html?id=${e.id}">${e.registered ? 'View my registration' : 'View event'}</a>
      </div></article>`;
  }

  async function loadHomeEvents() {
    const grid = $('homeEventGrid');
    try {
      const { events } = await api('/events/public?limit=3');
      grid.innerHTML = events.length ? events.map(eventCard).join('') : '<div class="empty-inline"><strong>No public events yet</strong><p>Events published by organizers will appear here.</p></div>';
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

  function renderCommunities() {
    const list = state.communities;
    const cat = state.category === 'all' ? 'all categories' : state.category;
    $('resultsSummary').textContent = state.origin
      ? `Within ${plural(state.radius, 'mile')} of ${state.origin.label} · ${cat} · nearest first`
      : `Showing all communities (${cat}). Choose a location to filter by distance.`;
    $('communityCount').textContent = `${list.length} to explore`;
    $('communityGrid').innerHTML = list.map(communityCard).join('');
    const empty = !list.length;
    $('communityGrid').classList.toggle('hidden', empty);
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
    if (!isParticipant) return;
    $('joinedCommunities').innerHTML = '<p class="muted">Loading your communities…</p>';
    $('registeredEvents').innerHTML = '<p class="muted">Loading your events…</p>';
    try {
      const [{ communities }, { events }] = await Promise.all([api('/participant/communities'), api('/participant/events')]);
      $('joinedCommunities').innerHTML = communities.length ? communities.map(c => `<div class="joined-item">
          <div class="item-main">${photo(c.image_url, c.name, 'thumb-photo')}<div><strong>${esc(c.name)}</strong><small>${esc(c.category)} · ${esc(c.town)} · ${plural(c.upcoming_event_count, 'upcoming event')}</small></div></div>
          <div class="item-actions"><a class="event-register" href="community.html?id=${c.id}">View</a><button class="text-btn danger-link" type="button" data-leave="${c.id}" data-name="${esc(c.name)}">Leave</button></div></div>`).join('')
        : '<p class="muted">You haven\'t joined a community yet. Open a community story and choose “Join this community”.</p>';
      $('registeredEvents').innerHTML = events.length ? events.map(e => `<div class="event-item${e.is_past ? ' is-past' : ''}">
          ${photo(e.image_url || e.community_image_url, e.name, 'event-thumb')}
          <div class="event-copy"><strong>${esc(e.name)}</strong><small>${esc(e.community_name)} · ${esc(formatDate(e.event_date))} · ${esc(e.event_time)} · ${esc(e.venue)}</small>${e.is_past ? '<small class="past-label">This event has finished</small>' : '<small class="ok-label">✓ Registered</small>'}</div>
          <div class="item-actions"><a class="event-register" href="event.html?id=${e.id}">View</a>${e.is_past ? '' : `<button class="text-btn danger-link" type="button" data-cancel="${e.id}">Cancel</button>`}</div></div>`).join('')
        : '<p class="muted">You haven\'t registered for any events yet. Browse the upcoming events above.</p>';
    } catch (e) {
      $('joinedCommunities').innerHTML = `<p class="muted error-text">${esc(e.message)}</p>`;
      $('registeredEvents').innerHTML = '';
    }
  }

  $('dashboardSection').addEventListener('click', async e => {
    const leave = e.target.closest('[data-leave]');
    const cancel = e.target.closest('[data-cancel]');
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
    $('eventSubmit').textContent = preview ? 'Create an organizer account to publish' : 'Publish event';
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
    } catch (e) {
      $('organizerCommunities').innerHTML = `<p class="muted error-text">${esc(e.message)}</p>`;
    }
  }

  function renderOrganizer() {
    const { communities, events } = state.organizer;
    const members = communities.reduce((n, c) => n + c.member_count, 0);
    const upcoming = events.filter(e => !e.is_past);
    const regs = events.reduce((n, e) => n + e.registration_count, 0);
    $('organizerStats').innerHTML = `<div><b>${communities.length}</b><small>${communities.length === 1 ? 'Community' : 'Communities'}</small></div><div><b>${members}</b><small>Members</small></div><div><b>${upcoming.length}</b><small>Upcoming events</small></div><div><b>${regs}</b><small>Event registrations</small></div>`;
    $('organizerCommunities').innerHTML = communities.length ? communities.map(c => `<div class="manage-item">
        <div class="item-main">${photo(c.image_url, c.name, 'thumb-photo')}<div><strong>${esc(c.name)}</strong><small>${esc(c.category)} · ${esc(c.town)} · ${plural(c.member_count, 'member')} · ${plural(c.event_count || 0, 'event')}</small><small class="ok-label">● Published</small></div></div>
        <div class="item-actions"><a class="event-register" href="community.html?id=${c.id}">View</a><button class="event-register" type="button" data-edit="${c.id}">Edit</button><button class="event-register" type="button" data-new-event="${c.id}">Add event</button><button class="text-btn danger-link" type="button" data-delete-community="${c.id}">Delete</button></div></div>`).join('')
      : '<p class="muted">You haven\'t created a community yet. Use “Create community” to publish your first one.</p>';
    $('organizerEventList').innerHTML = events.length ? events.map(e => `<div class="manage-item${e.is_past ? ' is-past' : ''}">
        <div class="item-main">${photo(e.image_url || e.community_image_url, e.name, 'thumb-photo')}<div><strong>${esc(e.name)}</strong><small>${esc(e.community_name)} · ${esc(formatDate(e.event_date))} · ${esc(e.event_time)} · ${esc(e.venue)}</small><small class="${e.is_past ? 'past-label' : 'ok-label'}">${e.is_past ? 'Finished' : '● Published'} · ${plural(e.registration_count, 'registration')}</small></div></div>
        <div class="item-actions"><a class="event-register" href="event.html?id=${e.id}">View</a><button class="text-btn danger-link" type="button" data-delete-event="${e.id}">Delete</button></div></div>`).join('')
      : '<p class="muted">No events published yet.</p>';
    const sel = $('eventCommunity');
    const keep = sel.value;
    sel.innerHTML = communities.length
      ? '<option value="">Choose one of your communities</option>' + communities.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')
      : '<option value="">Create a community first</option>';
    if (communities.some(c => String(c.id) === keep)) sel.value = keep;
  }

  function showPanel(id) {
    document.querySelectorAll('.side-link').forEach(x => x.classList.toggle('selected', x.dataset.panel === id));
    document.querySelectorAll('.organizer-panel').forEach(x => x.classList.toggle('hidden', x.id !== id));
  }
  document.querySelectorAll('.side-link').forEach(b => { b.onclick = () => showPanel(b.dataset.panel); });

  $('organizerView').addEventListener('click', async e => {
    const edit = e.target.closest('[data-edit]');
    const newEvent = e.target.closest('[data-new-event]');
    const delC = e.target.closest('[data-delete-community]');
    const delE = e.target.closest('[data-delete-event]');
    if (edit) return startEdit(Number(edit.dataset.edit));
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
  const EVENT_FIELDS = { community_id: 'eventCommunity', name: 'eventName', event_date: 'eventDate', event_time: 'eventTime', venue: 'eventVenue', description: 'eventDescription' };

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

  $('eventForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (!isOrganizer()) return openAuth(CC.user ? 'login' : 'register', { role: 'organizer', message: 'Organizer accounts can publish communities and events.', onSuccess: u => openView(u.role) });
    const form = e.target;
    clearFieldErrors(form);
    if (eventPhoto.uploading) return setMessage($('eventMessage'), 'Please wait for the photo to finish uploading.', 'error');
    const body = Object.fromEntries(Object.entries(EVENT_FIELDS).map(([k, idName]) => [k, $(idName).value.trim()]));
    body.image_url = $('eventImage').value;
    const missing = ['community_id', 'name', 'event_date', 'event_time', 'venue'].find(k => !body[k]);
    if (missing) {
      setMessage($('eventMessage'), state.organizer.communities.length ? 'Please complete all fields marked with *. Dates must use a valid calendar date.' : 'Create a community before publishing events.', 'error');
      return markField(EVENT_FIELDS, missing);
    }
    $('eventSubmit').disabled = true;
    setMessage($('eventMessage'), 'Publishing…');
    try {
      const d = await api('/events', { method: 'POST', body });
      form.reset();
      eventPhoto.set('');
      setMessage($('eventMessage'), `${d.message} “${d.event.name}” is now listed in public events.`, 'success');
      toast(d.message, 'success');
      await loadOrganizer();
    } catch (err) {
      setMessage($('eventMessage'), err.message, 'error');
      if (err.field) markField(EVENT_FIELDS, err.field);
    } finally { $('eventSubmit').disabled = false; }
  });

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
