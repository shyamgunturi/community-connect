/* Built-in demo checkout: checkout.html?ref=demo_… (used when no Stripe key is configured). */
(function () {
  'use strict';
  const { api, esc, formatDate, money, ticketLabel, setMessage } = CC;
  const $ = id => document.getElementById(id);
  const ref = CC.params().get('ref') || '';
  let order = null;

  function fail(title, text) {
    $('orderSummary').innerHTML = `<div class="detail-body"><p class="eyebrow">CHECKOUT</p><h1>${esc(title)}</h1><p class="detail-description">${esc(text)}</p><a class="primary-btn" href="index.html#events">Back to events</a></div>`;
    document.querySelector('.checkout-pay').classList.add('hidden');
  }

  function renderSummary(o) {
    $('orderSummary').innerHTML = `<div class="detail-body">
      <p class="eyebrow">YOUR ORDER</p><h1>${esc(o.event_name)}</h1>
      <p class="detail-lead">${esc(o.community_name)}</p>
      <ul class="order-facts"><li>📅 ${esc(formatDate(o.event_date))} · ◷ ${esc(o.event_time)}</li><li>⌖ ${esc(o.venue)}</li></ul>
      <div class="ticket-total">
        <div><span>${ticketLabel(o.ticket_type)} ticket × 1</span><span>${money(o.list_price_pence)}</span></div>
        ${o.discount_pence ? `<div class="discount"><span>Promo ${esc(o.promo_code)}</span><span>−${money(o.discount_pence)}</span></div>` : ''}
        <div class="total"><span>Total to pay</span><strong>${money(o.amount_pence)}</strong></div>
      </div></div>`;
    $('payBtn').textContent = `Pay ${money(o.amount_pence)}`;
    if (o.expires_at) {
      $('holdTimer').innerHTML = `⏳ Your place is held for <b data-countdown="${o.expires_at}" data-countdown-ended="0:00"></b>`;
      CC.countdownNow();
    }
  }

  // Card input formatting
  $('cardNumber').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 19).replace(/(\d{4})(?=\d)/g, '$1 '); });
  $('cardExpiry').addEventListener('input', e => { const d = e.target.value.replace(/\D/g, '').slice(0, 4); e.target.value = d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d; });
  $('cardCvc').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); });

  $('cardForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('payBtn');
    btn.disabled = true;
    btn.textContent = 'Processing payment…';
    setMessage($('payMessage'), '');
    try {
      const d = await api(`/payments/demo/${encodeURIComponent(ref)}`, { method: 'POST', body: {
        name: $('cardName').value, card_number: $('cardNumber').value, expiry: $('cardExpiry').value, cvc: $('cardCvc').value } });
      location.href = `payment.html?ref=${encodeURIComponent(d.order.ref)}`;
    } catch (err) {
      setMessage($('payMessage'), err.message, 'error');
      btn.disabled = false;
      btn.textContent = `Pay ${money(order.amount_pence)}`;
      if (err.code === 'PAYMENT_NOT_FOUND') fail('Your reservation has expired', 'Places are held for 30 minutes. Please go back to the event and start again.');
    }
  });

  $('cancelOrder').addEventListener('click', async e => {
    e.preventDefault();
    if (!order) return;
    try { await api(`/events/${order.event_id}/register`, { method: 'DELETE' }); } catch { /* already released */ }
    location.href = `event.html?id=${order.event_id}`;
  });

  window.addEventListener('cc:countdown-ended', () => fail('Your reservation has expired', 'Places are held for 30 minutes. Please go back to the event and start again.'));

  (async () => {
    try { await CC.loadUser(); } catch { /* offline */ }
    Detail.renderAccount(() => location.reload());
    if (!CC.user) return fail('Please log in', 'Log in from the event page to buy a ticket.');
    try {
      const d = await api(`/payments/${encodeURIComponent(ref)}`);
      order = d.order;
      if (d.mode !== 'demo') $('demoBanner').classList.add('hidden');
      if (order.payment_status === 'paid') { location.href = `payment.html?ref=${encodeURIComponent(order.ref)}`; return; }
      renderSummary(order);
      $('cardName').value = CC.user.name;
    } catch (err) {
      fail(err.status === 404 ? 'Reservation not found' : 'Something went wrong', err.message);
    }
  })();
})();
