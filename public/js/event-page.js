/* Public event page: event.html?id=123 — preview for everyone, registration for participants. */
(function () {
  'use strict';
  const { api, esc, photo, plural, icon, formatDate, toast } = CC;
  const { money, ticketLabel } = CC;
  const $ = id => document.getElementById(id);
  const id = CC.params().get('id');
  const refCode = /^\d+$/.test(id || '') ? CC.referral.capture(id) : '';
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
        ${CC.badges(e, 4)}
        <h1>${esc(e.name)}</h1>
        ${e.is_cancelled ? `<div class="cancelled-banner" role="status"><strong>This event has been cancelled</strong>${e.cancel_reason ? `Reason: ${esc(e.cancel_reason)}. ` : ''}Everyone who paid has been refunded automatically.</div>` : ''}
        ${!e.is_past && !e.is_cancelled ? `<div class="countdown-banner${e.early_active || e.flash_active ? ' is-early' : ''}${e.flash_active ? ' is-flash' : ''}">
          ${e.flash_active ? `<div class="cd-block cd-flash"><span class="cd-label">⚡ Flash sale — ${e.flash_percent}% off ends in</span><span class="cd-clock" data-countdown="${esc(e.flash_until)}" data-countdown-style="blocks" data-countdown-ended="Flash sale has ended"></span><span class="cd-sub">${money(e.current_price_pence)} instead of ${money(e.price_pence)} — limited time only</span></div>` : ''}
          ${e.early_active ? `<div class="cd-block"><span class="cd-label">⏰ Early-bird price ends in</span><span class="cd-clock" data-countdown="${esc(e.early_until)}" data-countdown-style="blocks" data-countdown-ended="Early bird has ended"></span><span class="cd-sub">Save ${money(e.price_pence - e.early_price_pence)} — ${money(e.early_price_pence)} instead of ${money(e.price_pence)}${e.early_left != null ? ` · only ${e.early_left} early-bird ${e.early_left === 1 ? 'ticket' : 'tickets'} left` : ''}</span></div>` : ''}
          <div class="cd-block"><span class="cd-label">🗓 Event starts in</span><span class="cd-clock" data-countdown="${esc(e.starts_at)}" data-countdown-style="blocks" data-countdown-ended="Happening now"></span>${e.capacity ? `<span class="cd-sub">${e.is_full ? 'Fully booked' : `${e.spots_left} of ${e.capacity} places left`}</span>` : ''}</div>
        </div>` : ''}
        <div class="detail-meta event-facts">
          <span><b>Community</b><a href="community.html?id=${e.community_id}">${icon(e.community_category)} ${esc(e.community_name)}</a></span>
          <span><b>Date</b>📅 ${esc(formatDate(e.event_date))}</span>
          <span><b>Time</b>◷ ${esc(e.event_time)}</span>
          <span><b>Venue</b>⌖ ${esc(e.venue)}${e.community_town ? ', ' + esc(e.community_town) : ''}</span>
          <span><b>Ticket</b>🎟 ${!e.price_pence ? 'Free' : e.current_price_pence < e.price_pence ? `<s class="was">${money(e.price_pence)}</s> <strong class="now-price">${money(e.current_price_pence)}</strong> ${CC.ticketLabel(e.ticket_type_now).toLowerCase()}` : money(e.price_pence)}</span>
          <span><b>${e.is_past ? 'Registered' : 'Places'}</b>👥 ${e.capacity && !e.is_past ? (e.is_full ? `Full — ${e.capacity} booked` : `${e.spots_left} of ${e.capacity} left`) : `${plural(e.registration_count, 'person', 'people')} registered`}</span>
          ${e.avg_rating ? `<span><b>Rating</b>★ ${e.avg_rating} <small>(${plural(e.rating_count, 'review')})</small></span>` : ''}
        </div>
        ${e.is_owner ? `<div class="owner-strip"><span><b>${e.registration_count}</b> registered</span>${e.has_started ? `<span><b>${e.attended_count}</b> attended</span>` : ''}<span><b>${money(e.revenue_pence)}</b> ticket revenue</span>${e.early_price_pence != null ? `<span><b>${e.early_sold}</b> early-bird sold</span>` : ''}${e.checkin_open ? `<span><b>${e.attended_count ?? 0}</b> checked in</span>` : ''}${e.waitlist_count ? `<span><b>${e.waitlist_count}</b> on waitlist</span>` : ''}<a href="checkin.html?event=${e.id}">📷 Scan tickets</a><a href="index.html#organizer">Organizer dashboard →</a></div>` : ''}
        ${!e.is_past && !e.is_cancelled ? `<p><a class="outline-btn calendar-btn" href="/api/events/${e.id}/calendar.ics" download>📅 Add to calendar</a></p>
        ${CC.shareBar(`${location.origin}/event.html?id=${e.id}`, `Join me at ${e.name} — ${formatDate(e.event_date)} ${e.event_time} on Community Connect`)}` : ''}
        ${refCode && !e.is_past && e.price_pence && !e.registered ? '<p class="ref-banner">🤝 A friend invited you — you get <strong>10% off</strong> your ticket. The discount is applied at checkout.</p>' : ''}
        <section class="detail-section"><h2>About this event</h2><p class="detail-description">${esc(e.description || 'More information about this event will be shared by the organizer.')}</p></section>
      </div>`;
    document.title = `${e.name} | Community Connect`;
  }

  function setAccess(eyebrow, heading, text, html) {
    document.querySelectorAll('.access-extra').forEach(n => n.remove());
    $('eventAccess').classList.remove('hidden');
    $('accessEyebrow').textContent = eyebrow;
    $('accessHeading').textContent = heading;
    $('accessText').textContent = text;
    $('accessActions').innerHTML = html;
  }

  function renderAccess() {
    const e = event, u = CC.user;
    if (e.is_cancelled) {
      const t = e.my_ticket;
      return setAccess('EVENT CANCELLED', 'This event will not take place', t && t.payment_status === 'refunded' ? `Your ${money(t.amount_pence)} has been refunded to your card.` : `Explore other events from ${e.community_name}.`, `<a class="primary-btn" href="community.html?id=${e.community_id}">More from ${esc(e.community_name)}</a><a class="outline-btn" href="index.html#events">See upcoming events</a>`);
    }
    if (e.is_past && u && u.role === 'participant' && e.attended) return renderFeedback();
    if (e.is_past) return setAccess('EVENT FINISHED', 'This event has already taken place', e.registered ? 'Thanks for registering. Ratings open once the organizer records attendance.' : 'Explore upcoming events from this and other communities.', '<a class="primary-btn" href="index.html#events">See upcoming events</a>');
    if (e.is_owner) return setAccess('YOUR EVENT', 'You are organising this event', `${plural(e.registration_count, 'person', 'people')} registered so far.`, '<a class="primary-btn" href="index.html#organizer">Open organizer dashboard</a>');
    if (!u) {
      setAccess('TAKE PART', e.price_pence ? 'Get your ticket' : 'Register for this event', `${e.price_pence ? `Tickets from ${money(e.current_price_pence)}. ` : ''}Log in or create a free participant account. You will join ${e.community_name} and then ${e.price_pence ? 'buy your ticket' : 'register'}.`, `<button class="primary-btn" type="button" id="startRegister">Log in / Register to ${e.price_pence ? 'buy a ticket' : 'take part'}</button>`);
      $('startRegister').onclick = () => Detail.auth.show('register');
      return;
    }
    if (u.role === 'organizer') return setAccess('ORGANIZER ACCOUNT', 'Event registration is for participants', 'You are signed in as an organizer. Log out and use a participant account to register for events.', '<a class="outline-btn" href="index.html#organizer">Organizer dashboard</a>');
    if (!e.is_member) {
      setAccess('STEP 1 OF 2', `Join ${e.community_name}`, 'Events are run by communities. Join this community first, then register for the event.', `<button class="primary-btn" type="button" id="joinThenRegister">Join ${esc(e.community_name)}</button><a class="outline-btn" href="community.html?id=${e.community_id}">Read its story</a>`);
      $('joinThenRegister').onclick = joinCommunity;
      return;
    }
    const t = e.my_ticket;
    if (t && t.payment_status === 'pending') {
      setAccess('PLACE RESERVED', 'Complete your payment', `Your ${ticketLabel(t.ticket_type).toLowerCase()} ticket (${money(t.amount_pence)}) is held for a short time. Finish paying to confirm your place.`,
        '<button class="primary-btn" type="button" id="continuePayment">Continue to payment</button><button class="outline-btn" type="button" id="releasePlace">Release my place</button>');
      $('continuePayment').onclick = () => buy(null, 'continuePayment');
      $('releasePlace').onclick = cancel;
      return;
    }
    const w = e.my_waitlist;
    if (!e.registered && w && w.status === 'offered') {
      note(`🎉 Good news — a place opened up and it's held for you until ${new Date(w.offer_expires_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}. Book now to keep it.`);
      if (e.price_pence) return renderTickets();
      setAccess('A PLACE IS WAITING', 'Your waitlist place is ready', 'Book within the time limit or it passes to the next person.', '<button class="primary-btn" type="button" id="registerForEvent">Take my place</button>');
      $('registerForEvent').onclick = register;
      return;
    }
    if (e.is_full && !e.registered) {
      if (w) {
        setAccess('ON THE WAITLIST', `You're number ${w.position} in line`, `We'll notify you (🔔) the moment a place frees up. You'll then have 2 hours to book. ${plural(e.waitlist_count, 'person', 'people')} waiting.`, '<button class="outline-btn" type="button" id="leaveWaitlist">Leave the waitlist</button>');
        $('leaveWaitlist').onclick = () => act(async () => { const d = await api(`/events/${e.id}/waitlist`, { method: 'DELETE' }); note(d.message); await load(); }, 'leaveWaitlist');
        return;
      }
      setAccess('FULLY BOOKED', 'This event is full — join the waitlist', `All ${e.capacity} places have been taken${e.waitlist_count ? ` and ${plural(e.waitlist_count, 'person is', 'people are')} waiting` : ''}. Join the waitlist and we'll offer you a place if someone cancels.`,
        `<button class="primary-btn" type="button" id="joinWaitlist">Join the waitlist</button><a class="outline-btn" href="community.html?id=${e.community_id}">More from ${esc(e.community_name)}</a>`);
      $('joinWaitlist').onclick = () => act(async () => { const d = await api(`/events/${e.id}/waitlist`, { method: 'POST' }); note(`✓ ${d.message}`); toast(d.message, 'success'); await load(); }, 'joinWaitlist');
      return;
    }
    if (!e.registered && e.price_pence) return renderTickets();
    if (!e.registered) {
      setAccess('STEP 2 OF 2', 'Register for this event', `You are a member of ${e.community_name}. Reserve your place below.`, '<button class="primary-btn" type="button" id="registerForEvent">Register for event</button>');
      $('registerForEvent').onclick = register;
      return;
    }
    const paid = t && t.payment_status === 'paid';
    setAccess('YOU\'RE GOING', t && t.checked_in ? '✓ You are checked in — enjoy!' : paid ? '✓ You have a ticket' : '✓ You are registered',
      paid ? `${ticketLabel(t.ticket_type)} ticket · ${money(t.amount_pence)} paid. Show the QR code below at the door. For refunds, contact the organizer.` : 'Your place is saved. Show the QR code below at the door to check in.',
      `<a class="primary-btn" href="index.html#dashboard">View my events</a><a class="outline-btn" href="/api/events/${e.id}/calendar.ics" download>📅 Add to calendar</a>${paid ? '' : '<button class="outline-btn" type="button" id="cancelRegistration">Cancel registration</button>'}`);
    $('cancelRegistration')?.addEventListener('click', cancel);
    const tk = CC.ticketFromEvent(e);
    if (tk) {
      const box = document.createElement('div');
      box.className = 'access-extra detail-card';
      const link = t.referral_code ? CC.referral.link(e.id, t.referral_code) : '';
      box.innerHTML = `${CC.ticketCard(tk)}<div class="detail-actions"><button class="outline-btn" type="button" id="openTicket">⛶ Show full-screen ticket</button><button class="outline-btn" type="button" id="dlTicket">⬇ Download QR</button></div>
        ${link ? `<div class="friend-card"><div><p class="eyebrow">BRING A FRIEND</p><h3>Invite a friend${e.price_pence ? ' — they get 10% off' : ''}</h3><p>Share your personal link. ${e.price_pence ? 'Your friend saves 10% on their ticket, and you' : 'You'}'ll get a notification when they book.</p></div>
          <div class="friend-link"><input readonly value="${esc(link)}" aria-label="Your invite link" id="friendLink"><button class="primary-btn" type="button" data-copy="${esc(link)}">Copy</button></div>
          ${CC.shareBar(link, `I'm going to ${e.name}! Come with me${e.price_pence ? ' — this link gives you 10% off' : ''}:`, { label: 'Send via' })}</div>` : ''}`;
      $('eventAccess').after(box);
      $('openTicket').onclick = () => CC.openTicket(tk);
      $('dlTicket').onclick = () => CC.downloadQr(tk.code, e.name);
    }
  }

  /** Ticket options for a paid event: early bird / standard, promo code, total and Buy button. */
  function renderTickets() {
    const e = event;
    const earlyOption = e.early_price_pence != null ? `<div class="ticket-option${e.ticket_type_now === 'early_bird' ? ' is-current' : e.early_active ? '' : ' is-off'}">
        <div><strong>Early bird</strong><small>${e.early_active ? `Ends in <span data-countdown="${esc(e.early_until)}" data-countdown-style="short" data-countdown-ended="ended"></span>${e.early_left != null ? ` · ${e.early_left} left` : ''}` : e.flash_active && e.early_until && new Date(e.early_until) > new Date() && e.early_left !== 0 ? 'The flash sale price is lower right now' : 'Sold out or ended'}</small></div>
        <span class="ticket-price">${money(e.early_price_pence)}</span></div>` : '';
    const flashOption = e.flash_active ? `<div class="ticket-option is-current is-flash"><div><strong>⚡ Flash sale · ${e.flash_percent}% off</strong><small>Ends in <span data-countdown="${esc(e.flash_until)}" data-countdown-style="short" data-countdown-ended="ended"></span></small></div><span class="ticket-price">${money(Math.round(e.price_pence * (100 - e.flash_percent) / 100))}</span></div>` : '';
    const standardOption = `<div class="ticket-option${e.ticket_type_now === 'standard' ? ' is-current' : ''}"><div><strong>Standard</strong><small>${e.early_active ? 'After the early-bird offer' : 'Available now'}</small></div><span class="ticket-price">${money(e.price_pence)}</span></div>`;
    setAccess('STEP 2 OF 2', 'Choose your ticket', `You are a member of ${e.community_name}. ${e.early_active ? 'Book now to get the early-bird price.' : 'Pay securely online to confirm your place.'}`,
      `<div class="ticket-panel">
        <div class="ticket-options">${flashOption}${earlyOption}${standardOption}</div>
        ${e.has_promo_codes ? `<form class="promo-row" id="promoForm"><input id="promoInput" placeholder="Promo code" maxlength="20" autocomplete="off" aria-label="Promo code"><button class="outline-btn" type="submit">Apply</button></form><p class="promo-msg" id="promoMsg"></p>` : ''}
        <div class="ticket-total" id="ticketTotal"></div>
        <button class="primary-btn buy-btn" type="button" id="buyTicket">Buy ticket</button>
        <p class="pay-note">🔒 ${e.payment_mode === 'stripe' ? 'Secure card payment by Stripe.' : 'Test checkout — demo mode, no real money is taken.'} Your place is held for 30 minutes while you pay.</p>
      </div>`);
    let promo = '';
    const showTotal = q => {
      const why = q.promo ? `Promo ${esc(q.promo.code)} (−${q.promo.percent_off}%)` : q.referral ? `🤝 Friend discount from ${esc(q.referral.by_name)} (−${q.referral.percent_off}%)` : 'Discount';
      $('ticketTotal').innerHTML = `${q.discount_pence ? `<div><span>${ticketLabel(q.ticket_type)} ticket</span><span>${money(q.list_price_pence)}</span></div><div class="discount"><span>${why}</span><span>−${money(q.discount_pence)}</span></div>` : ''}<div class="total"><span>Total</span><strong>${money(q.amount_pence)}</strong></div>`;
      $('buyTicket').textContent = q.amount_pence ? `Buy ${ticketLabel(q.ticket_type).toLowerCase()} ticket — ${money(q.amount_pence)}` : 'Get free ticket';
    };
    const base = { ticket_type: e.ticket_type_now, list_price_pence: e.current_price_pence, discount_pence: 0, amount_pence: e.current_price_pence };
    showTotal(base);
    if (refCode) api(`/events/${e.id}/quote?ref=${encodeURIComponent(refCode)}`).then(({ quote }) => { if (!promo && quote.referral) showTotal(quote); }).catch(() => {});
    $('promoForm')?.addEventListener('submit', async ev => {
      ev.preventDefault();
      const code = $('promoInput').value.trim();
      const msg = $('promoMsg');
      if (!code) { promo = ''; msg.textContent = ''; return showTotal(base); }
      try {
        const { quote } = await api(`/events/${e.id}/quote?promo_code=${encodeURIComponent(code)}`);
        promo = quote.promo.code;
        msg.textContent = `✓ ${quote.promo.code} applied — ${quote.promo.percent_off}% off`;
        msg.className = 'promo-msg is-success';
        showTotal(quote);
      } catch (err) { promo = ''; msg.textContent = err.message; msg.className = 'promo-msg is-error'; }
    });
    $('buyTicket').onclick = () => buy(promo, 'buyTicket');
  }

  async function buy(promo, btnId) {
    const btn = $(btnId);
    if (btn) { btn.disabled = true; btn.textContent = 'Opening secure checkout…'; }
    try {
      const body = promo ? { promo_code: promo } : {};
      if (refCode) body.referral_code = refCode;
      const d = await api(`/events/${event.id}/checkout`, { method: 'POST', body });
      if (d.checkout_url) { location.href = d.checkout_url; return; }
      note(`🎉 ${d.message}`);
      toast(d.message, 'success');
      await load();
    } catch (err) {
      note(err.message, 'error');
      if (['PRICE_CHANGED', 'EVENT_FULL', 'MEMBERSHIP_REQUIRED'].includes(err.code)) await load();
      else if (btn) { btn.disabled = false; btn.textContent = 'Try again'; }
    }
  }

  function renderFeedback() {
    const e = event;
    const stars = [1, 2, 3, 4, 5].map(n => `<button type="button" class="star${e.my_rating >= n ? ' on' : ''}" data-star="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('');
    setAccess('YOU WENT', e.my_rating ? 'Thanks for your rating' : 'How was it?', e.my_rating ? 'You can change your rating at any time.' : 'Rate this event to help the organizer improve future events.',
      `<form class="feedback-form" id="feedbackForm"><div class="stars" role="radiogroup" aria-label="Rating">${stars}</div><textarea id="feedbackComment" rows="2" maxlength="500" placeholder="Optional comment"></textarea><button class="primary-btn" type="submit">${e.my_rating ? 'Update rating' : 'Send rating'}</button></form>`);
    let chosen = e.my_rating || 0;
    const paint = () => document.querySelectorAll('[data-star]').forEach(b => b.classList.toggle('on', Number(b.dataset.star) <= chosen));
    document.querySelectorAll('[data-star]').forEach(b => { b.onclick = () => { chosen = Number(b.dataset.star); paint(); }; });
    $('feedbackForm').onsubmit = async ev => {
      ev.preventDefault();
      if (!chosen) return note('Choose 1 to 5 stars first.', 'error');
      try {
        const d = await api(`/events/${e.id}/feedback`, { method: 'POST', body: { rating: chosen, comment: $('feedbackComment').value } });
        note(`⭐ ${d.message}`);
        await load();
      } catch (err) { note(err.message, 'error'); }
    };
    if (location.hash === '#feedback') $('eventAccess').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function load() {
    if (!/^\d+$/.test(id || '')) { Detail.notFound('eventContent', 'Event not found', 'This link is missing a valid event. Return to the events list and choose an event.'); return; }
    try {
      event = (await api(`/events/${id}`)).event;
      renderEvent(event);
      renderAccess();
      CC.countdownNow();
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
      if (['MEMBERSHIP_REQUIRED', 'EVENT_FULL', 'PAYMENT_REQUIRED'].includes(e.code)) await load();
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
  // When the early-bird timer reaches zero, reload so the new price shows.
  window.addEventListener('cc:countdown-ended', () => { clearTimeout(window._ccReload); window._ccReload = setTimeout(load, 1500); });
  if (CC.params().get('payment') === 'cancelled') setTimeout(() => note('Payment cancelled. Your place is held for a short time — choose "Continue to payment" to finish.', 'error'), 600);

  (async () => {
    try { await CC.loadUser(); } catch { /* continue as visitor */ }
    Detail.renderAccount(load);
    await load();
  })();
})();
