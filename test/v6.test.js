'use strict';
/**
 * v6 tests: platform admin, commission (platform fee), organizer payouts, event cancellation with refunds,
 * Continue with Google (against a fake Google tokeninfo service) and the extra demo content. Run with:  npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');
const { startFakeGeocoder, startServer, client, tempDir, removeDir, isoDate } = require('./helpers');

let geo, google, dir, srv, api;
const S = {};
const CARD = { name: 'Test Person', card_number: '4242 4242 4242 4242', expiry: '12/35', cvc: '123' };
const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const db = fn => { const d = new Database(path.join(dir, 'test.sqlite')); try { return fn(d); } finally { d.close(); } };

/** Fake Google tokeninfo: the "token" a.b.c is looked up in a table of test identities. */
function startFakeGoogle() {
  const tokens = {
    'good.new.user': { aud: CLIENT_ID, iss: 'https://accounts.google.com', sub: 'g-1001', email: 'gina.google@gmail.com', email_verified: 'true', name: 'Gina Google' },
    'good.org.user': { aud: CLIENT_ID, iss: 'accounts.google.com', sub: 'g-1002', email: 'oscar.org@gmail.com', email_verified: true, name: 'Oscar Org' },
    'good.existing.user': { aud: CLIENT_ID, iss: 'accounts.google.com', sub: 'g-1003', email: 'olivia@example.com', email_verified: 'true', name: 'Olivia' },
    'wrong.audience.x': { aud: 'someone-else', iss: 'accounts.google.com', sub: 'g-9', email: 'x@gmail.com', email_verified: 'true' },
    'not.verified.x': { aud: CLIENT_ID, iss: 'accounts.google.com', sub: 'g-8', email: 'y@gmail.com', email_verified: 'false' }
  };
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const t = new URL(req.url, 'http://x').searchParams.get('id_token');
      const info = tokens[t];
      res.writeHead(info ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(info ? { ...info, exp: String(Math.floor(Date.now() / 1000) + 3600) } : { error: 'invalid_token' }));
    }).listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/tokeninfo`, close: () => new Promise(r => server.close(r)) }));
  });
}

async function user(name, email, role = 'participant') {
  const r = await api('POST', '/api/auth/register', { body: { name, email, password: 'Passw0rd99', role } });
  assert.equal(r.status, 201, r.text);
  return r.body.token;
}
async function buy(token, eventId) {
  const c = await api('POST', `/api/events/${eventId}/checkout`, { token, body: {} });
  assert.equal(c.status, 201, c.text);
  const ref = new URL(c.body.checkout_url, 'http://x').searchParams.get('ref');
  const p = await api('POST', `/api/payments/demo/${ref}`, { token, body: CARD });
  assert.equal(p.status, 200, p.text);
  return p.body.order;
}

before(async () => {
  geo = await startFakeGeocoder();
  google = await startFakeGoogle();
  dir = tempDir();
  srv = await startServer({ dir, geocoderUrl: geo.url, env: { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_TOKENINFO_URL: google.url, PLATFORM_FEE_PERCENT: '10' } });
  api = client(srv.base);
  S.org = await user('Olivia Organizer', 'olivia@example.com', 'organizer');
  S.ana = await user('Ana Able', 'ana@example.com');
  S.ben = await user('Ben Baker', 'ben@example.com');
  const c = await api('POST', '/api/communities', { token: S.org, body: { name: 'Acklam Makers', category: 'Arts & Hobbies', description: 'Making things together every week.', town: 'Middlesbrough', latitude: 54.55, longitude: -1.25 } });
  S.community = c.body.community.id;
  for (const t of [S.ana, S.ben]) await api('POST', `/api/communities/${S.community}/join`, { token: t });
  const e = await api('POST', '/api/events', { token: S.org, body: { community_id: S.community, name: 'Pottery Night', event_date: isoDate(10), event_time: '18:00', venue: 'Studio 1', price: 25, capacity: 10 } });
  S.event = e.body.event.id;
  const e2 = await api('POST', '/api/events', { token: S.org, body: { community_id: S.community, name: 'Glaze Day', event_date: isoDate(14), event_time: '10:00', venue: 'Studio 2', price: 12 } });
  S.event2 = e2.body.event.id;
});
after(async () => { await srv?.stop(); await geo?.close(); await google?.close(); removeDir(dir); });

test('admin logs in with the admin account; the admin area is closed to everyone else', async () => {
  const bad = await api('POST', '/api/auth/login', { body: { email: 'admin@communityconnect.local', password: 'wrong-pass1' } });
  assert.equal(bad.status, 401);
  const r = await api('POST', '/api/auth/login', { body: { email: 'admin@communityconnect.local', password: 'Admin12345' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.user.role, 'admin');
  assert.ok(r.body.user.id < 0, 'admin ids never collide with user ids');
  S.admin = r.body.token;
  assert.equal((await api('GET', '/api/auth/me', { token: S.admin })).body.user.role, 'admin');
  assert.equal((await api('GET', '/api/admin/overview', { token: S.org })).status, 403);
  assert.equal((await api('GET', '/api/admin/overview', { token: S.ana })).status, 403);
  assert.equal((await api('GET', '/api/admin/overview')).status, 401);
  // the admin cannot act as an organizer or participant
  assert.equal((await api('POST', '/api/communities', { token: S.admin, body: {} })).status, 403);
  assert.equal((await api('POST', `/api/communities/${S.community}/join`, { token: S.admin })).status, 403);
  // nobody can register with the admin email
  assert.equal((await api('POST', '/api/auth/register', { body: { name: 'Fake Admin', email: 'ADMIN@communityconnect.local', password: 'Passw0rd99', role: 'organizer' } })).status, 409);
});

test('every paid ticket records the 10% platform fee and the organizer share', async () => {
  const o = await buy(S.ana, S.event);
  assert.equal(o.amount_pence, 2500);
  const row = db(d => d.prepare("SELECT platform_fee_pence, organizer_net_pence, fee_percent FROM event_registrations WHERE event_id = ? AND payment_status = 'paid'").get(S.event));
  assert.deepEqual(row, { platform_fee_pence: 250, organizer_net_pence: 2250, fee_percent: 10 });
  await buy(S.ben, S.event);
  await buy(S.ana, S.event2);
  const a = (await api('GET', '/api/organizer/analytics', { token: S.org })).body.earnings;
  assert.equal(a.fee_percent, 10);
  assert.equal(a.gross_pence, 6200);
  assert.equal(a.fee_pence, 620);
  assert.equal(a.net_pence, 5580);
  assert.equal(a.pending_pence, 5580, 'held until the events take place');
  assert.equal(a.paid_pence, 0);
});

test('after the event, the payout becomes ready; the admin marks it paid and the organizer is notified', async () => {
  db(d => d.prepare('UPDATE events SET event_date = ? WHERE id = ?').run(isoDate(-1), S.event));
  const ov = (await api('GET', '/api/admin/overview', { token: S.admin })).body;
  const p = ov.payouts.find(x => x.event_id === S.event);
  assert.equal(p.status, 'ready');
  assert.deepEqual([p.tickets, p.gross_pence, p.fee_pence, p.net_pence], [2, 5000, 500, 4500]);
  assert.equal(ov.payouts.find(x => x.event_id === S.event2).status, 'pending');
  assert.equal(ov.fee_percent, 10);
  assert.ok(ov.summary.platform_revenue_pence >= 620);
  assert.equal((await api('POST', `/api/admin/payouts/${p.id}/pay`, { token: S.org, body: {} })).status, 403);
  const pay = await api('POST', `/api/admin/payouts/${p.id}/pay`, { token: S.admin, body: { reference: 'BACS-123' } });
  assert.equal(pay.status, 200, pay.text);
  assert.equal(pay.body.payout.reference, 'BACS-123');
  assert.equal((await api('POST', `/api/admin/payouts/${p.id}/pay`, { token: S.admin, body: {} })).status, 409, 'cannot pay twice');
  assert.equal((await api('POST', '/api/admin/payouts/999999/pay', { token: S.admin, body: {} })).status, 404);
  const n = (await api('GET', '/api/notifications', { token: S.org })).body.notifications;
  assert.ok(n.some(x => x.type === 'payout' && x.title.includes('£45')));
  const e = (await api('GET', '/api/organizer/analytics', { token: S.org })).body.earnings;
  assert.equal(e.paid_pence, 4500);
  assert.equal(e.payouts.find(x => x.event_id === S.event).status, 'paid');
  // a paid payout is frozen even if data changes later
  db(d => d.prepare('UPDATE event_registrations SET organizer_net_pence = 1 WHERE event_id = ?').run(S.event));
  const again = (await api('GET', '/api/admin/overview', { token: S.admin })).body.payouts.find(x => x.event_id === S.event);
  assert.equal(again.net_pence, 4500);
});

test('cancelling an event refunds every ticket, notifies people, and creates no payout', async () => {
  assert.equal((await api('POST', `/api/events/${S.event2}/cancel`, { token: S.ana, body: {} })).status, 403);
  const r = await api('POST', `/api/events/${S.event2}/cancel`, { token: S.org, body: { reason: 'Studio flooded' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.refunded_tickets, 1);
  assert.equal(r.body.refunded_pence, 1200);
  assert.equal(r.body.event.is_cancelled, true);
  assert.equal((await api('POST', `/api/events/${S.event2}/cancel`, { token: S.org, body: {} })).status, 409);
  const ev = (await api('GET', `/api/events/${S.event2}`, { token: S.ana })).body.event;
  assert.equal(ev.is_cancelled, true);
  assert.equal(ev.cancel_reason, 'Studio flooded');
  assert.equal(ev.my_ticket.payment_status, 'refunded');
  assert.equal(ev.my_ticket.ticket_code, undefined, 'refunded tickets have no usable QR');
  assert.ok((await api('GET', '/api/notifications', { token: S.ana })).body.notifications.some(x => x.type === 'cancelled' && x.body.includes('refunded')));
  assert.ok(!(await api('GET', '/api/events/public')).body.events.some(e => e.id === S.event2), 'hidden from listings');
  const c = await api('POST', `/api/events/${S.event2}/checkout`, { token: S.ben, body: {} });
  assert.equal(c.status, 410);
  const ov = (await api('GET', '/api/admin/overview', { token: S.admin })).body;
  assert.ok(!ov.payouts.some(x => x.event_id === S.event2));
  assert.ok(ov.summary.refunded_pence >= 1200);
  assert.ok(ov.summary.events_cancelled >= 1);
  // past events cannot be cancelled
  assert.equal((await api('POST', `/api/events/${S.event}/cancel`, { token: S.org, body: {} })).status, 400);
});

test('Continue with Google: new accounts, organizer choice, linking existing accounts, forged tokens refused', async () => {
  assert.equal((await api('GET', '/api/auth/config')).body.google_client_id, CLIENT_ID);
  const n = await api('POST', '/api/auth/google', { body: { credential: 'good.new.user' } });
  assert.equal(n.status, 201, n.text);
  assert.equal(n.body.created, true);
  assert.equal(n.body.user.role, 'participant');
  assert.equal(n.body.user.email, 'gina.google@gmail.com');
  assert.equal((await api('GET', '/api/auth/me', { token: n.body.token })).body.user.name, 'Gina Google');
  const again = await api('POST', '/api/auth/google', { body: { credential: 'good.new.user', role: 'organizer' } });
  assert.equal(again.status, 200);
  assert.equal(again.body.user.role, 'participant', 'an existing account keeps its role');
  const org = await api('POST', '/api/auth/google', { body: { credential: 'good.org.user', role: 'organizer' } });
  assert.equal(org.body.user.role, 'organizer');
  const linked = await api('POST', '/api/auth/google', { body: { credential: 'good.existing.user' } });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.user.email, 'olivia@example.com');
  assert.equal(linked.body.user.role, 'organizer');
  for (const bad of ['wrong.audience.x', 'not.verified.x', 'forged.token.value']) {
    assert.equal((await api('POST', '/api/auth/google', { body: { credential: bad } })).status, 401, bad);
  }
  assert.equal((await api('POST', '/api/auth/google', { body: { credential: 'not a jwt' } })).status, 400);
  // password login still works for a Google-linked account
  assert.equal((await api('POST', '/api/auth/login', { body: { email: 'olivia@example.com', password: 'Passw0rd99' } })).status, 200);
});

test('extra demo content: more upcoming events, three organizers and payout history', async () => {
  const { events } = (await api('GET', '/api/events/public')).body;
  for (const n of ['AI for Beginners Workshop', 'Street Food Night', 'Beginners Games Evening', 'Phone Photography Basics']) assert.ok(events.some(e => e.name === n), n);
  assert.ok(events.length >= 18);
  const ov = (await api('GET', '/api/admin/overview', { token: S.admin })).body;
  for (const n of ['Alex Morgan', 'Sara Khan', 'Tom Reed']) assert.ok(ov.top_organizers.some(o => o.name === n && o.gross_pence > 0), n);
  assert.ok(ov.payout_totals.paid.count >= 3);
  assert.ok(ov.payout_totals.ready.count >= 2);
  assert.ok(ov.payout_totals.pending.count >= 5);
  assert.equal(ov.monthly.length, 6);
  assert.ok(ov.monthly.some(m => m.fee_pence > 0));
  assert.equal((await api('GET', '/admin.html')).status, 200);
});

test('Google sign-in is switched off cleanly when no client id is configured', async () => {
  const d2 = tempDir();
  const s2 = await startServer({ dir: d2, geocoderUrl: geo.url, env: { GOOGLE_CLIENT_ID: '', SEED_DEMO_DATA: 'false' } });
  try {
    const c = client(s2.base);
    assert.equal((await c('GET', '/api/auth/config')).body.google_client_id, null);
    const r = await c('POST', '/api/auth/google', { body: { credential: 'a.b.c' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'GOOGLE_DISABLED');
  } finally { await s2.stop(); removeDir(d2); }
});
