/* Public event page: event.html?id=123 — preview for everyone, registration for participants. */
(function () {
  'use strict';
  const { api, esc, photo, plural, icon, formatDate, toast } = CC;
  const $ = id => document.getElementById(id);
  const id = CC.params().get('id');
  let event = null;

  function note(text, type = 'success') {
    const n = $('eventNote');
    n.textContent = text;
    n.classList.toggle('hidden', !text);
    n.classList.toggle('detail-error', type === 'error');
  }

  function renderEvent(e) {
    $('eventContent').innerHTML = `${photo(e.image_url || e.community_image_url, e.name, 'detail-hero')}
      <div class="detail-body">
        <p class="eyebrow">${e.is_past ? 'PAST EVENT' : 'COMMUNITY EVENT'} · PUBLIC PREVIEW</p>
        <h1>${esc(e.name)}</h1>
        <div class="detail-meta event-facts">
          <span><b>Community</b><a href="community.html?id=${e.community_id}">${icon(e.community_category)} ${esc(e.community_name)}</a></span>
          <span><b>Date</b>📅 ${esc(formatDate(e.event_date))}</span>
          <span><b>Time</b>◷ ${esc(e.event_time)}</span>
          <span><b>Venue</b>⌖ ${esc(e.venue)}${e.community_town ? ', ' + esc(e.community_town) : ''}</span>
          <span><b>Going</b>👥 ${plural(e.registration_count, 'person', 'people')} registered</span>
        </div>
        <section class="detail-section"><h2>About this event</h2><p class="detail-description">${esc(e.description || 'More information about this event will be shared by the organizer.')}</p></section>
      </div>`;
    document.title = `${e.name} | Community Connect`;
  }

  function setAccess(eyebrow, heading, text, html) {
    $('eventAccess').classList.remove('hidden');
    $('accessEyebrow').textContent = eyebrow;
    $('accessHeading').textContent = heading;
    $('accessText').textContent = text;
    $('accessActions').innerHTML = html;
  }

  function renderAccess() {
    const e = event, u = CC.user;
    if (e.is_past) return setAccess('EVENT FINISHED', 'This event has already taken place', 'Explore upcoming events from this and other communities.', '<a class="primary-btn" href="index.html#events">See upcoming events</a>');
    if (e.is_owner) return setAccess('YOUR EVENT', 'You are organising this event', `${plural(e.registration_count, 'person', 'people')} registered so far.`, '<a class="primary-btn" href="index.html#organizer">Open organizer dashboard</a>');
    if (!u) {
      setAccess('TAKE PART', 'Register for this event', `Log in or create a free participant account. You will join ${e.community_name} and then register.`, '<button class="primary-btn" type="button" id="startRegister">Log in / Register to take part</button>');
      $('startRegister').onclick = () => Detail.auth.show('register');
      return;
    }
    if (u.role === 'organizer') return setAccess('ORGANIZER ACCOUNT', 'Event registration is for participants', 'You are signed in as an organizer. Log out and use a participant account to register for events.', '<a class="outline-btn" href="index.html#organizer">Organizer dashboard</a>');
    if (!e.is_member) {
      setAccess('STEP 1 OF 2', `Join ${e.community_name}`, 'Events are run by communities. Join this community first, then register for the event.', `<button class="primary-btn" type="button" id="joinThenRegister">Join ${esc(e.community_name)}</button><a class="outline-btn" href="community.html?id=${e.community_id}">Read its story</a>`);
      $('joinThenRegister').onclick = joinCommunity;
      return;
    }
    if (!e.registered) {
      setAccess('STEP 2 OF 2', 'Register for this event', `You are a member of ${e.community_name}. Reserve your place below.`, '<button class="primary-btn" type="button" id="registerForEvent">Register for event</button>');
      $('registerForEvent').onclick = register;
      return;
    }
    setAccess('YOU\'RE GOING', '✓ You are registered', 'Your place is saved to your account. You can see it in your participant dashboard.', '<a class="primary-btn" href="index.html#dashboard">View my events</a><button class="outline-btn" type="button" id="cancelRegistration">Cancel registration</button>');
    $('cancelRegistration').onclick = cancel;
  }

  async function load() {
    if (!/^\d+$/.test(id || '')) { Detail.notFound('eventContent', 'Event not found', 'This link is missing a valid event. Return to the events list and choose an event.'); return; }
    try {
      event = (await api(`/events/${id}`)).event;
      renderEvent(event);
      renderAccess();
    } catch (e) {
      $('eventAccess').classList.add('hidden');
      if (e.status === 404 || e.status === 400) Detail.notFound('eventContent', 'Event not found', 'This event may have been removed by its organizer.');
      else $('eventContent').innerHTML = `<div class="detail-body"><h1>Something went wrong</h1><p class="detail-description">${esc(e.message)}</p><button class="primary-btn" type="button" id="retryLoad">Try again</button></div>`;
      $('retryLoad')?.addEventListener('click', load);
    }
  }

  async function act(fn, btnId) {
    const btn = $(btnId);
    if (btn) btn.disabled = true;
    try { await fn(); } catch (e) {
      note(e.message, 'error');
      if (e.code === 'MEMBERSHIP_REQUIRED') await load();
      if (btn) btn.disabled = false;
    }
  }
  const joinCommunity = () => act(async () => {
    const d = await api(`/communities/${event.community_id}/join`, { method: 'POST' });
    note(`${d.message} Now complete step 2 to register for the event.`);
    await load();
  }, 'joinThenRegister');
  const register = () => act(async () => {
    const d = await api(`/events/${event.id}/register`, { method: 'POST' });
    note(`🎉 ${d.message} on ${formatDate(event.event_date)} at ${event.event_time}. It now appears in your participant dashboard.`);
    toast(d.message, 'success');
    await load();
  }, 'registerForEvent');
  const cancel = () => act(async () => {
    if (!confirm('Cancel your registration for this event?')) { $('cancelRegistration').disabled = false; return; }
    const d = await api(`/events/${event.id}/register`, { method: 'DELETE' });
    note(d.message);
    await load();
  }, 'cancelRegistration');

  Detail.auth = Detail.authForm({
    section: 'eventAuth',
    labels: { login: 'Log in', register: 'Create account' },
    intro: 'You need a participant account to register for events.',
    onAuthed: async () => { Detail.renderAccount(load); await load(); }
  });

  window.addEventListener('cc:session-expired', () => { Detail.renderAccount(load); load(); });

  (async () => {
    try { await CC.loadUser(); } catch { /* continue as visitor */ }
    Detail.renderAccount(load);
    await load();
  })();
})();
