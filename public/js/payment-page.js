/* Ticket confirmation: payment.html?ref=… (demo) or payment.html?session_id=cs_… (returning from Stripe). */
(function () {
  'use strict';
  const { api, esc, formatDate, money, ticketLabel } = CC;
  const $ = id => document.getElementById(id);
  const p = CC.params();

  function show(o) {
    $('ticketCard').innerHTML = `<div class="detail-body ticket-confirm">
      <p class="eyebrow">PAYMENT RECEIVED</p>
      <h1>🎉 You're going!</h1>
      ${o.ticket_code ? CC.ticketCard({ code: o.ticket_code, event_name: o.event_name, community_name: o.community_name, event_date: o.event_date, event_time: o.event_time,
          venue: o.venue, holder: CC.user?.name, ticket_number: o.ticket_number, ticket_type: o.ticket_type, amount_pence: o.amount_pence }) : ''}
      <p class="detail-description">${money(o.amount_pence)} paid${o.promo_code ? ` (promo ${esc(o.promo_code)})` : o.discount_pence ? ' (friend discount)' : ''}. Your e-ticket is also saved in your participant dashboard. Show the QR code at the door — the organizer scans it to check you in.</p>
      ${o.referral_code ? `<div class="friend-card"><div><p class="eyebrow">BRING A FRIEND</p><h3>Invite a friend — they get 10% off</h3><p>Share your personal link and get a notification when they book.</p></div>
        <div class="friend-link"><input readonly value="${esc(CC.referral.link(o.event_id, o.referral_code))}" aria-label="Your invite link"><button class="primary-btn" type="button" data-copy="${esc(CC.referral.link(o.event_id, o.referral_code))}">Copy</button></div>
        ${CC.shareBar(CC.referral.link(o.event_id, o.referral_code), `I'm going to ${o.event_name}! Come with me — this link gives you 10% off:`, { label: 'Send via' })}</div>` : ''}
      <div class="detail-actions">${o.ticket_code ? '<button class="primary-btn" type="button" id="dlQr">⬇ Download QR ticket</button>' : ''}<a class="outline-btn" href="index.html#dashboard">View my events</a><a class="outline-btn" href="/api/events/${o.event_id}/calendar.ics" download>📅 Add to calendar</a><a class="outline-btn" href="event.html?id=${o.event_id}">Event page</a></div>
    </div>`;
    const dl = document.getElementById('dlQr');
    if (dl) dl.onclick = () => CC.downloadQr(o.ticket_code, o.event_name);
    CC.referral.clear(o.event_id);
  }
  function fail(text) {
    $('ticketCard').innerHTML = `<div class="detail-body"><p class="eyebrow">PAYMENT</p><h1>We couldn't confirm this payment</h1><p class="detail-description">${esc(text)}</p><a class="primary-btn" href="index.html#dashboard">My dashboard</a></div>`;
  }

  (async () => {
    try { await CC.loadUser(); } catch { /* offline */ }
    Detail.renderAccount(() => location.reload());
    if (!CC.user) return fail('Please log in to see your ticket.');
    try {
      if (p.get('session_id')) show((await api('/payments/stripe/confirm', { method: 'POST', body: { session_id: p.get('session_id') } })).order);
      else {
        const { order } = await api(`/payments/${encodeURIComponent(p.get('ref') || '')}`);
        if (order.payment_status !== 'paid') { location.href = `checkout.html?ref=${encodeURIComponent(order.ref)}`; return; }
        show(order);
      }
    } catch (err) { fail(err.message); }
  })();
})();
