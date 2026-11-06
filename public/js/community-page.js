/* Community story page: community.html?id=123 */
(function () {
  'use strict';
  const { api, esc, photo, plural, icon, formatDate, toast } = CC;
  const $ = id => document.getElementById(id);
  const id = CC.params().get('id');
  let community = null;
  let joinAfterLogin = false;

  function note(text, type = 'success') {
    const n = $('joinNote');
    n.textContent = text;
    n.classList.toggle('hidden', !text);
    n.classList.toggle('detail-error', type === 'error');
  }

  function renderCommunity(c) {
    const mapUrl = `https://www.openstreetmap.org/?mlat=${c.latitude}&mlon=${c.longitude}#map=14/${c.latitude}/${c.longitude}`;
    const where = [c.address, c.town, c.postcode].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
    $('communityContent').innerHTML = `${photo(c.image_url, c.name, 'detail-hero')}
      <div class="detail-body">
        <p class="eyebrow">${icon(c.category)} ${esc(c.category.toUpperCase())}</p>
        <h1>${esc(c.name)}</h1>
        <div class="detail-meta"><span>⌖ ${esc(c.town)}</span><span>👥 ${plural(c.member_count, 'member')}</span><span>📅 ${plural(c.upcoming_event_count, 'upcoming event')}</span>${c.organizer_name ? `<span>Organised by ${esc(c.organizer_name)}</span>` : ''}</div>
        <p class="detail-lead">${esc(c.description)}</p>
        <section class="detail-section"><h2>Our story</h2><p class="detail-description">${esc(c.story || 'This community hasn\'t written its full story yet. Join to meet the members and find out more.')}</p></section>
        <section class="detail-section"><h2>Where to find us</h2><p>${esc(where || c.town)}</p><p><a class="map-link" href="${esc(mapUrl)}" target="_blank" rel="noopener">View on OpenStreetMap ↗</a></p></section>
      </div>`;
    document.title = `${c.name} | Community Connect`;
  }

  function renderEvents(events) {
    $('communityEventsCard').classList.remove('hidden');
    $('communityEvents').innerHTML = events.length ? events.map(e => `<div class="event-item">
        ${photo(e.image_url || e.community_image_url, e.name, 'event-thumb')}
        <div class="event-copy"><strong>${esc(e.name)}</strong><small>${esc(formatDate(e.event_date))} · ${esc(e.event_time)} · ${esc(e.venue)}</small>${e.registered ? '<small class="ok-label">✓ You are registered</small>' : ''}</div>
        <a class="event-register" href="event.html?id=${e.id}">View event</a></div>`).join('')
      : '<p class="muted">No upcoming events yet. Check back soon.</p>';
  }

  function renderJoinPanel() {
    const c = community, u = CC.user;
    $('joinPanel').classList.remove('hidden');
    const actions = $('joinActions');
    const set = (eyebrow, heading, text, html) => { $('joinEyebrow').textContent = eyebrow; $('joinHeading').textContent = heading; $('joinText').textContent = text; actions.innerHTML = html; };
    if (c.is_owner) {
      set('YOUR COMMUNITY', 'You manage this community', `${plural(c.member_count, 'member')} so far. Publish events from your organizer dashboard.`, '<a class="primary-btn" href="index.html#organizer">Open organizer dashboard</a>');
    } else if (u && u.role === 'organizer') {
      set('ORGANIZER ACCOUNT', 'Joining is for participant accounts', 'You are signed in as an organizer. Log out and use a participant account to join communities.', '<a class="outline-btn" href="index.html#organizer">Organizer dashboard</a>');
    } else if (c.joined) {
      set('YOU\'RE A MEMBER', 'You are part of this community', 'You can now register for its events. You will find it in your participant dashboard.', '<a class="primary-btn" href="index.html#dashboard">My dashboard</a><button class="outline-btn" type="button" id="leaveCommunity">Leave community</button>');
      $('leaveCommunity').onclick = leave;
    } else {
      set('FIND YOUR PEOPLE', 'Become part of the story', u ? 'Join this community to connect with members and take part in its activities and events.' : 'Exploring is free. Log in or create a participant account to join.', '<button id="joinCommunity" class="primary-btn" type="button">Join this community</button>');
      $('joinCommunity').onclick = () => { if (!CC.user) { joinAfterLogin = true; Detail.auth.show('register'); } else join(); };
    }
  }

  async function load() {
    if (!/^\d+$/.test(id || '')) { Detail.notFound('communityContent', 'Community not found', 'This link is missing a valid community. Return to discovery and choose a community to view its story.'); return; }
    try {
      const d = await api(`/communities/${id}`);
      community = d.community;
      renderCommunity(community);
      renderEvents(d.events);
      renderJoinPanel();
    } catch (e) {
      if (e.status === 404 || e.status === 400) Detail.notFound('communityContent', 'Community not found', 'This community may have been removed by its organizer.');
      else $('communityContent').innerHTML = `<div class="detail-body"><h1>Something went wrong</h1><p class="detail-description">${esc(e.message)}</p><button class="primary-btn" type="button" id="retryLoad">Try again</button></div>`;
      $('retryLoad')?.addEventListener('click', load);
    }
  }

  async function join() {
    const btn = $('joinCommunity');
    if (btn) btn.disabled = true;
    try {
      const d = await api(`/communities/${community.id}/join`, { method: 'POST' });
      note(d.already_member ? d.message : `🎉 ${d.message} It now appears in your participant dashboard, and you can register for its events.`);
      toast(d.message, 'success');
      await load();
    } catch (e) {
      note(e.message, 'error');
      if (btn) btn.disabled = false;
    }
  }

  async function leave() {
    if (!confirm(`Leave ${community.name}? Your registrations for its events will also be cancelled.`)) return;
    try {
      const d = await api(`/communities/${community.id}/join`, { method: 'DELETE' });
      note(d.message);
      await load();
    } catch (e) { note(e.message, 'error'); }
  }

  Detail.auth = Detail.authForm({
    section: 'communityAuth',
    labels: { login: 'Log in and join', register: 'Create account and join' },
    intro: 'Sign in or create a free participant account to join this community.',
    onAuthed: async () => {
      Detail.renderAccount(load);
      await load();
      if (joinAfterLogin) { joinAfterLogin = false; if (community && !community.joined && !community.is_owner && CC.user.role === 'participant') await join(); }
    }
  });

  window.addEventListener('cc:session-expired', () => { Detail.renderAccount(load); load(); });

  (async () => {
    try { await CC.loadUser(); } catch { /* continue as visitor */ }
    Detail.renderAccount(load);
    await load();
  })();
})();
