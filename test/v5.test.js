'use strict';
/**
 * v5 feature tests: QR tickets & door check-in, bring-a-friend referrals, flash sales, featured/trending,
 * waitlist, notifications and the presentation-ready demo data. Run with:  npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { startFakeGeocoder, startServer, client, tempDir, removeDir, isoDate } = require('./helpers');

let geo, dir, srv, api;
const S = {};
const CARD = { name: 'Test Person', card_number: '4242 4242 4242 4242', expiry: '12/35', cvc: '123' };
const db = fn => { const d = new Database(path.join(dir, 'test.sqlite')); try { return fn(d); } finally { d.close(); } };

async function user(name, email, role = 'participant') {
  const r = await api('POST', '/api/auth/register', { body: { name, email, password: 'Passw0rd99', role } });
  assert.equal(r.status, 201, r.text);
  return r.body.token;
}
async function buy(token, eventId, extra = {}) {
  const c = await api('POST', `/api/events/${eventId}/checkout`, { token, body: extra });
  assert.equal(c.status, 201, c.text);
  const ref = new URL(c.body.checkout_url, 'http://x').searchParams.get('ref');
  const p = await api('POST', `/api/payments/demo/${ref}`, { token, body: CARD });
  assert.equal(p.status, 200, p.text);
  return { checkout: c.body, order: p.body.order };
}
const ev = async (id, token) => (await api('GET', `/api/events/${id}`, { token })).body.event;
const notes = async token => (await api('GET', '/api/notifications', { token })).body;

before(async () => {
  geo = await startFakeGeocoder();
  dir = tempDir();
  srv = await startServer({ dir, geocoderUrl: geo.url });
  api = client(srv.base);
  S.org = await user('Olivia Organizer', 'olivia@example.com', 'organizer');
  S.org2 = await user('Other Organizer', 'other@example.com', 'organizer');
  S.ana = await user('Ana Able', 'ana@example.com');
  S.ben = await user('Ben Baker', 'ben@example.com');
  S.cat = await user('Cat Cole', 'cat@example.com');
  S.dan = await user('Dan Dee', 'dan@example.com');
  const c = await api('POST', '/api/communities', { token: S.org, body: { name: 'Acklam Makers', category: 'Arts & Hobbies', description: 'Making things together every week.', town: 'Middlesbrough', latitude: 54.55, longitude: -1.25 } });
  assert.equal(c.status, 201, c.text);
  S.community = c.body.community.id;
  for (const t of [S.ana, S.ben, S.cat, S.dan]) assert.equal((await api('POST', `/api/communities/${S.community}/join`, { token: t })).status, 201);
  const paid = await api('POST', '/api/events', { token: S.org, body: { community_id: S.community, name: 'Pottery Night', event_date: isoDate(10), event_time: '18:00', venue: 'Studio 1', price: 10, capacity: 2 } });
  assert.equal(paid.status, 201, paid.text);
  S.paid = paid.body.event.id;
  const free = await api('POST', '/api/events', { token: S.org, body: { community_id: S.community, name: 'Free Sketch Club', event_date: isoDate(12), event_time: '18:00', venue: 'Library', capacity: 1 } });
  S.free = free.body.event.id;
});
after(async () => { await srv?.stop(); await geo?.close(); removeDir(dir); });

test('demo data is presentation-ready: next-day event with tickets, featured event and a live flash sale', async () => {
  const { events } = (await api('GET', '/api/events/public')).body;
  const open = events.find(e => e.name === 'Open Evening & Networking');
  assert.ok(open, 'demo open evening exists');
  const hours = (new Date(`${open.starts_at}:00`) - Date.now()) / 3600e3;
  assert.ok(hours > 0 && hours < 36, `starts within 36h (was ${hours.toFixed(1)}h)`);
  assert.equal(open.checkin_open, true);
  assert.equal(open.registration_count, 9);
  const book = events.find(e => e.name === 'November Book Night');
  assert.equal(book.flash_active, true);
  assert.equal(book.ticket_type_now, 'flash_sale');
  assert.equal(book.current_price_pence, 180);
  assert.ok(book.badges.includes('flash_sale'));
  const codes = db(d => d.prepare('SELECT COUNT(*) n, COUNT(DISTINCT ticket_code) t FROM event_registrations WHERE ticket_code IS NOT NULL').get());
  assert.equal(codes.n, codes.t, 'every ticket code is unique');
  const tr = (await api('GET', '/api/events/trending')).body;
  assert.ok(tr.featured.some(e => e.name === 'Build Something Weekend'));
  assert.ok(tr.deals.some(e => e.name === 'November Book Night'));
  assert.ok(tr.trending.length > 0);
});

test('a paid ticket gets a secret QR code and a referral code; buyer is notified', async () => {
  const { order } = await buy(S.ana, S.paid);
  assert.match(order.ticket_code, /^[a-f0-9]{24}$/);
  assert.match(order.referral_code, /^[a-f0-9]{8}$/);
  S.anaCode = order.ticket_code; S.anaRef = order.referral_code;
  const e = await ev(S.paid, S.ana);
  assert.equal(e.my_ticket.ticket_code, S.anaCode);
  assert.equal(e.my_ticket.checked_in, false);
  const n = await notes(S.ana);
  assert.ok(n.notifications.some(x => x.type === 'ticket' && x.title.includes('Pottery Night')));
  assert.ok(n.unread >= 1);
  // other people never see someone else's code
  assert.equal((await ev(S.paid, S.ben)).my_ticket, null);
  assert.ok(!JSON.stringify((await api('GET', `/api/events/${S.paid}`)).body).includes(S.anaCode));
});

test('bring-a-friend: the referral link gives 10% off, notifies the referrer and shows in analytics', async () => {
  const q = (await api('GET', `/api/events/${S.paid}/quote?ref=${S.anaRef}`, { token: S.ben })).body.quote;
  assert.equal(q.discount_pence, 100);
  assert.equal(q.amount_pence, 900);
  assert.equal(q.referral.by_name, 'Ana');
  const self = (await api('GET', `/api/events/${S.paid}/quote?ref=${S.anaRef}`, { token: S.ana })).body.quote;
  assert.equal(self.referral, null, 'you cannot refer yourself');
  const bad = (await api('GET', `/api/events/${S.paid}/quote?ref=deadbeef`, { token: S.ben })).body.quote;
  assert.equal(bad.discount_pence, 0);
  const { order } = await buy(S.ben, S.paid, { referral_code: S.anaRef });
  assert.equal(order.amount_pence, 900);
  assert.ok((await notes(S.ana)).notifications.some(x => x.type === 'referral' && x.title.startsWith('Ben')));
  const a = (await api('GET', '/api/organizer/analytics', { token: S.org })).body;
  assert.equal(a.referral_total, 1);
  assert.equal(a.referral_revenue_pence, 900);
  assert.equal(a.referrals[0].referrer, 'Ana Able');
});

test('full event: sold-out badge, booking refused, waitlist with position', async () => {
  const e = await ev(S.paid, S.cat);
  assert.equal(e.is_full, true);
  assert.ok(e.badges.includes('sold_out'));
  const c = await api('POST', `/api/events/${S.paid}/checkout`, { token: S.cat, body: {} });
  assert.equal(c.status, 409);
  assert.equal(c.body.code, 'EVENT_FULL');
  const w = await api('POST', `/api/events/${S.paid}/waitlist`, { token: S.cat });
  assert.equal(w.status, 201, w.text);
  assert.equal(w.body.waitlist.position, 1);
  const w2 = await api('POST', `/api/events/${S.paid}/waitlist`, { token: S.dan });
  assert.equal(w2.body.waitlist.position, 2);
  assert.equal((await ev(S.paid, S.org)).waitlist_count, 2);
  assert.equal((await api('POST', `/api/events/${S.paid}/waitlist`, { token: S.ana })).status, 409, 'ticket holders cannot join');
  assert.equal((await api('POST', `/api/events/${S.free}/waitlist`, { token: S.ana })).status, 409, 'not full yet');
  assert.equal((await api('DELETE', `/api/events/${S.paid}/waitlist`, { token: S.dan })).status, 200);
  assert.equal((await api('DELETE', `/api/events/${S.paid}/waitlist`, { token: S.dan })).status, 404);
});

test('waitlist: a freed place is offered to the next person, held for them, then booked', async () => {
  assert.equal((await api('POST', `/api/events/${S.free}/register`, { token: S.ana })).status, 201);
  assert.equal((await api('POST', `/api/events/${S.free}/waitlist`, { token: S.cat })).status, 201);
  assert.equal((await api('POST', `/api/events/${S.free}/waitlist`, { token: S.dan })).status, 201);
  assert.equal((await api('DELETE', `/api/events/${S.free}/register`, { token: S.ana })).status, 200);
  const c = await ev(S.free, S.cat);
  assert.equal(c.my_waitlist.status, 'offered');
  assert.ok(new Date(c.my_waitlist.offer_expires_at) > new Date());
  assert.ok((await notes(S.cat)).notifications.some(x => x.type === 'waitlist_offer'));
  // the held place is not available to anyone else
  const ben = await api('POST', `/api/events/${S.free}/register`, { token: S.ben });
  assert.equal(ben.status, 409);
  assert.equal((await ev(S.free, S.dan)).my_waitlist.status, 'waiting');
  const r = await api('POST', `/api/events/${S.free}/register`, { token: S.cat });
  assert.equal(r.status, 201, r.text);
  assert.equal((await ev(S.free, S.cat)).my_waitlist, null, 'removed from waitlist after booking');
  // raising capacity offers the next place automatically
  const put = await api('PUT', `/api/events/${S.free}`, { token: S.org, body: { name: 'Free Sketch Club', event_date: isoDate(12), event_time: '18:00', venue: 'Library', capacity: 2 } });
  assert.equal(put.status, 200, put.text);
  assert.equal((await ev(S.free, S.dan)).my_waitlist.status, 'offered');
});

test('QR check-in: only the event organizer, only when doors are open, no double entry', async () => {
  assert.equal((await api('GET', `/api/checkin/${S.anaCode}`, { token: S.org })).body.ticket.holder_name, 'Ana Able');
  assert.equal((await api('POST', `/api/checkin/${S.anaCode}`, { token: S.org2 })).status, 403);
  assert.equal((await api('POST', `/api/checkin/${S.anaCode}`, { token: S.ana })).status, 403);
  assert.equal((await api('POST', `/api/checkin/${S.anaCode}`)).status, 401);
  assert.equal((await api('POST', '/api/checkin/0123456789abcdef01234567', { token: S.org })).status, 404);
  assert.equal((await api('POST', '/api/checkin/not-a-code', { token: S.org })).status, 404);
  const early = await api('POST', `/api/checkin/${S.anaCode}`, { token: S.org });
  assert.equal(early.status, 400);
  assert.equal(early.body.code, 'CHECKIN_NOT_OPEN');
  const soon = new Date(Date.now() + 3 * 3600e3);
  const p2 = n => String(n).padStart(2, '0');
  db(d => d.prepare('UPDATE events SET event_date = ?, event_time = ? WHERE id = ?')
    .run(`${soon.getFullYear()}-${p2(soon.getMonth() + 1)}-${p2(soon.getDate())}`, `${p2(soon.getHours())}:${p2(soon.getMinutes())}`, S.paid));
  const ok = await api('POST', `/api/checkin/${S.anaCode}`, { token: S.org });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.already, false);
  assert.equal(ok.body.ticket.checked_in, true);
  assert.deepEqual(ok.body.stats, { checked_in: 1, registered: 2 });
  const again = await api('POST', `/api/checkin/${S.anaCode}`, { token: S.org });
  assert.equal(again.body.already, true);
  assert.equal((await ev(S.paid, S.ana)).my_ticket.checked_in, true);
  assert.ok((await notes(S.ana)).notifications.some(x => x.type === 'checked_in'));
  const list = (await api('GET', `/api/events/${S.paid}/attendees`, { token: S.org })).body.attendees;
  assert.equal(list.find(a => a.name === 'Ana Able').attended, true);
  assert.equal((await api('GET', '/api/organizer/analytics', { token: S.org })).body.qr_checkins, 1);
  // a pending (unpaid) hold has no usable code
  const pend = db(d => d.prepare("SELECT ticket_code FROM event_registrations WHERE event_id = ? AND user_id = (SELECT id FROM users WHERE email='ben@example.com')").get(S.paid));
  db(d => d.prepare("UPDATE event_registrations SET payment_status = 'pending' WHERE ticket_code = ?").run(pend.ticket_code));
  assert.equal((await api('POST', `/api/checkin/${pend.ticket_code}`, { token: S.org })).status, 404);
  db(d => d.prepare("UPDATE event_registrations SET payment_status = 'paid' WHERE ticket_code = ?").run(pend.ticket_code));
});

test('event reminders appear in the bell for events in the next 24 hours; read-all clears the count', async () => {
  const n = await notes(S.ben);
  assert.ok(n.notifications.some(x => x.type === 'reminder' && x.title.includes('Pottery Night')));
  const n2 = await notes(S.ben);
  assert.equal(n2.notifications.filter(x => x.type === 'reminder').length, 1, 'reminder is only added once');
  const one = n2.notifications[0];
  assert.equal((await api('POST', `/api/notifications/${one.id}/read`, { token: S.ana })).status, 404, "can't touch others' notifications");
  assert.equal((await api('POST', `/api/notifications/${one.id}/read`, { token: S.ben })).status, 200);
  assert.equal((await api('POST', '/api/notifications/read-all', { token: S.ben })).status, 200);
  assert.equal((await notes(S.ben)).unread, 0);
  assert.equal((await api('GET', '/api/notifications')).status, 401);
});

test('flash sale: validated, owner-only, cheapest price wins, members notified, can be ended', async () => {
  const e2 = await api('POST', '/api/events', { token: S.org, body: { community_id: S.community, name: 'Glaze Workshop', event_date: isoDate(20), event_time: '14:00', venue: 'Studio 2', price: 20, early_price: 15, early_until: `${isoDate(15)}T12:00` } });
  assert.equal(e2.status, 201, e2.text);
  const id = e2.body.event.id;
  assert.equal(e2.body.event.ticket_type_now, 'early_bird');
  assert.equal((await api('POST', `/api/events/${id}/flash-sale`, { token: S.org, body: { percent: 3, hours: 2 } })).status, 400);
  assert.equal((await api('POST', `/api/events/${id}/flash-sale`, { token: S.org, body: { percent: 20, hours: 0 } })).status, 400);
  assert.equal((await api('POST', `/api/events/${S.free}/flash-sale`, { token: S.org, body: { percent: 20, hours: 2 } })).status, 400, 'free events');
  assert.equal((await api('POST', `/api/events/${id}/flash-sale`, { token: S.org2, body: { percent: 20, hours: 2 } })).status, 403);
  // 20% off £20 = £16 is dearer than the £15 early bird, so early bird still applies
  let r = await api('POST', `/api/events/${id}/flash-sale`, { token: S.org, body: { percent: 20, hours: 2 } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.event.ticket_type_now, 'early_bird');
  r = await api('POST', `/api/events/${id}/flash-sale`, { token: S.org, body: { percent: 50, hours: 6 } });
  assert.equal(r.body.event.ticket_type_now, 'flash_sale');
  assert.equal(r.body.event.current_price_pence, 1000);
  assert.ok(r.body.event.badges.includes('flash_sale'));
  assert.equal(r.body.notified, 4);
  assert.ok((await notes(S.dan)).notifications.some(x => x.type === 'flash_sale' && x.title.includes('50% off')));
  assert.ok((await api('GET', '/api/events/trending')).body.deals.some(e => e.id === id));
  const { order } = await buy(S.dan, id);
  assert.equal(order.ticket_type, 'flash_sale');
  assert.equal(order.amount_pence, 1000);
  const end = await api('DELETE', `/api/events/${id}/flash-sale`, { token: S.org });
  assert.equal(end.body.event.flash_active, false);
  assert.equal(end.body.event.ticket_type_now, 'early_bird');
});

test('featured toggle puts an event on the homepage and new events notify members', async () => {
  assert.equal((await api('POST', `/api/events/${S.free}/featured`, { token: S.org, body: { featured: 'yes' } })).status, 400);
  assert.equal((await api('POST', `/api/events/${S.free}/featured`, { token: S.org2, body: { featured: true } })).status, 403);
  const r = await api('POST', `/api/events/${S.free}/featured`, { token: S.org, body: { featured: true } });
  assert.equal(r.body.event.featured, true);
  assert.ok((await api('GET', '/api/events/trending')).body.featured.some(e => e.id === S.free));
  assert.ok((await notes(S.cat)).notifications.some(x => x.type === 'new_event' && x.body.includes('Glaze Workshop')));
  await api('POST', `/api/events/${S.free}/featured`, { token: S.org, body: { featured: false } });
  assert.ok(!(await api('GET', '/api/events/trending')).body.featured.some(e => e.id === S.free));
});

test('check-in page and v5 scripts are served; camera is allowed for the scanner', async () => {
  for (const p of ['/checkin.html', '/js/qr.js', '/js/extras.js', '/js/checkin-page.js', '/v5.css']) assert.equal((await api('GET', p)).status, 200, p);
  assert.match((await api('GET', '/')).headers.get('permissions-policy'), /camera=\(self\)/);
});

test('the QR encoder produces valid QR matrices for ticket links', () => {
  const qr = require('../public/js/qr.js');
  for (const [text, size] of [['HELLO', 21], [`https://example.org/checkin.html?code=${'a'.repeat(24)}`, 33]]) {
    const m = qr.matrix(text);
    assert.equal(m.length, size);
    // finder patterns in three corners
    for (const [x, y] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
      assert.equal(m[y][x], true); assert.equal(m[y + 3][x + 3], true); assert.equal(m[y + 1][x + 1], false);
    }
  }
  assert.match(qr.svg('x'), /^<svg[^>]+viewBox/);
});
