'use strict';
/**
 * End-to-end API tests. Run with:  npm test
 * Each run uses a temporary database and a fake geocoder — your real data is never touched.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { startFakeGeocoder, startFakeStripe, startServer, client, tempDir, removeDir, isoDate, PNG_1PX } = require('./helpers');

let geo, dir, srv, api;
const S = {}; // shared state between tests (they run in order)
const MBRO = { lat: 54.5742, lon: -1.2348 };

function dbRun(sql, ...params) {
  const db = new Database(path.join(dir, 'test.sqlite'));
  try { return db.prepare(sql).run(...params); } finally { db.close(); }
}

function dbQuery(sql, ...params) {
  const db = new Database(path.join(dir, 'test.sqlite'));
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}

before(async () => {
  geo = await startFakeGeocoder();
  dir = tempDir();
  srv = await startServer({ dir, geocoderUrl: geo.url });
  api = client(srv.base);
});
after(async () => { await srv?.stop(); await geo?.close(); removeDir(dir); });

// ---------------------------------------------------------------- health & static files
test('health check reports ok with database', async () => {
  const r = await api('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
  assert.equal(r.body.database, 'ok');
});

test('frontend is served and server files are not exposed', async () => {
  const home = await api('GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Community<span class="brand-light">Connect/);
  for (const p of ['/server.js', '/src/app.js', '/.env', '/package.json', '/data/test.sqlite', '/test.sqlite']) {
    const r = await api('GET', p);
    assert.ok(!r.text.includes('require(') && !r.text.includes('SQLite format'), `${p} must not leak server files`);
  }
  assert.equal((await api('GET', '/api/nope')).status, 404);
  assert.ok((await api('GET', '/')).headers.get('content-security-policy'));
});

test('starter communities and events are real SQLite records', async () => {
  const rows = dbQuery('SELECT COUNT(*) AS n FROM communities');
  assert.ok(rows[0].n >= 6);
  const r = await api('GET', '/api/communities');
  assert.equal(r.status, 200);
  assert.equal(r.body.communities.length, rows[0].n);
});

// ---------------------------------------------------------------- registration & login (Test E errors included)
test('organizer and participants can register; passwords are hashed', async () => {
  const o = await api('POST', '/api/auth/register', { body: { name: 'Olivia Organizer', email: 'Olivia@Example.com', password: 'Organise123', role: 'organizer' } });
  assert.equal(o.status, 201, o.text);
  assert.equal(o.body.user.role, 'organizer');
  assert.equal(o.body.user.email, 'olivia@example.com');
  assert.ok(o.body.token);
  S.org = o.body.token;
  const o2 = await api('POST', '/api/auth/register', { body: { name: 'Other Organizer', email: 'other@example.com', password: 'Organise456', role: 'organizer' } });
  S.org2 = o2.body.token;
  const p = await api('POST', '/api/auth/register', { body: { name: 'Priya Participant', email: 'priya@example.com', password: 'Participate1', role: 'participant' } });
  assert.equal(p.status, 201);
  S.part = p.body.token;
  const p2 = await api('POST', '/api/auth/register', { body: { name: 'Sam Second', email: 'sam@example.com', password: 'Participate2', role: 'participant' } });
  S.part2 = p2.body.token;
  const [row] = dbQuery('SELECT password_hash FROM users WHERE email = ?', 'priya@example.com');
  assert.notEqual(row.password_hash, 'Participate1');
  assert.ok(row.password_hash.length > 30);
});

test('duplicate email registration is rejected (case-insensitive)', async () => {
  const r = await api('POST', '/api/auth/register', { body: { name: 'Copy', email: 'PRIYA@example.com', password: 'Participate1', role: 'participant' } });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already exists/);
  assert.equal(dbQuery("SELECT COUNT(*) n FROM users WHERE email='priya@example.com'")[0].n, 1);
});

test('registration validation: missing fields, bad email, weak password, bad role', async () => {
  const cases = [
    [{ email: 'a@b.co', password: 'abcdefg1', role: 'participant' }, 'name'],
    [{ name: 'A Person', email: 'not-an-email', password: 'abcdefg1', role: 'participant' }, 'email'],
    [{ name: 'A Person', email: 'a@b.co', password: 'short1', role: 'participant' }, 'password'],
    [{ name: 'A Person', email: 'a@b.co', password: 'lettersonly', role: 'participant' }, 'password'],
    [{ name: 'A Person', email: 'a@b.co', password: 'abcdefg1', role: 'admin' }, 'role'],
    [{}, 'name']
  ];
  for (const [body, field] of cases) {
    const r = await api('POST', '/api/auth/register', { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.field, field);
  }
});

test('login: success, wrong password, unknown email, missing fields, role check', async () => {
  const ok = await api('POST', '/api/auth/login', { body: { email: 'priya@example.com', password: 'Participate1' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.role, 'participant');
  assert.equal((await api('POST', '/api/auth/login', { body: { email: 'priya@example.com', password: 'WrongPass1' } })).status, 401);
  assert.equal((await api('POST', '/api/auth/login', { body: { email: 'nobody@example.com', password: 'WrongPass1' } })).status, 401);
  assert.equal((await api('POST', '/api/auth/login', { body: { email: 'priya@example.com' } })).status, 400);
  const wrongRole = await api('POST', '/api/auth/login', { body: { email: 'olivia@example.com', password: 'Organise123', role: 'participant' } });
  assert.equal(wrongRole.status, 403);
});

test('GET /api/auth/me requires a valid token', async () => {
  const me = await api('GET', '/api/auth/me', { token: S.part });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'priya@example.com');
  assert.equal(me.body.user.password_hash, undefined);
  assert.equal((await api('GET', '/api/auth/me')).status, 401);
  assert.equal((await api('GET', '/api/auth/me', { token: 'garbage' })).status, 401);
  const [h, p] = S.part.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: '1', role: 'organizer' })).toString('base64url');
  assert.equal((await api('GET', '/api/auth/me', { token: `${h}.${forged}.${S.part.split('.')[2]}` })).status, 401, 'tampered payload rejected');
  assert.ok(p);
});

// ---------------------------------------------------------------- photos
test('organizers can upload a photo; invalid files and other roles are rejected', async () => {
  const up = await api('POST', '/api/uploads', { token: S.org, body: { image: PNG_1PX } });
  assert.equal(up.status, 201, up.text);
  assert.match(up.body.url, /^\/uploads\/[a-f0-9]{32}\.png$/);
  S.photo = up.body.url;
  const img = await fetch(srv.base + S.photo);
  assert.equal(img.status, 200);
  assert.equal((await img.arrayBuffer()).byteLength, up.body.bytes);
  const fake = await api('POST', '/api/uploads', { token: S.org, body: { image: 'data:image/png;base64,' + Buffer.from('<?php echo 1; ?>').toString('base64') } });
  assert.equal(fake.status, 400);
  assert.equal((await api('POST', '/api/uploads', { token: S.part, body: { image: PNG_1PX } })).status, 403);
  assert.equal((await api('POST', '/api/uploads', { body: { image: PNG_1PX } })).status, 401);
});

// ---------------------------------------------------------------- Test A — organizer creates community
test('organizer creates a community with photo and coordinates; it is saved in SQLite', async () => {
  const r = await api('POST', '/api/communities', { token: S.org, body: {
    name: 'Linthorpe Coders', category: 'Technology', description: 'Weekly coding evenings for all levels.',
    story: 'Started in 2024 by three students.', town: 'Middlesbrough', address: 'Linthorpe Road', postcode: 'ts1 3bx',
    latitude: 54.5650, longitude: -1.2400, image_url: S.photo } });
  assert.equal(r.status, 201, r.text);
  S.communityId = r.body.community.id;
  assert.equal(r.body.community.image_url, S.photo);
  assert.equal(r.body.community.postcode, 'TS1 3BX');
  const [row] = dbQuery('SELECT * FROM communities WHERE id = ?', S.communityId);
  assert.equal(row.name, 'Linthorpe Coders');
  assert.equal(row.image_url, S.photo);
  assert.equal(row.latitude, 54.565);
  assert.equal(row.status, 'published');
});

test('community coordinates are looked up from the town when not supplied', async () => {
  const r = await api('POST', '/api/communities', { token: S.org, body: { name: 'Stockton Walkers', category: 'Sports & Fitness', description: 'Gentle walks around Stockton every Sunday.', town: 'Stockton-on-Tees', image_url: 'https://images.unsplash.com/photo-1552674605-db6ffd4facb5' } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.community.latitude, 54.5705);
  assert.equal(r.body.community.longitude, -1.3187);
  S.community2Id = r.body.community.id;
  const bad = await api('POST', '/api/communities', { token: S.org, body: { name: 'Nowhere Club', category: 'Social', description: 'This town does not exist anywhere.', town: 'Qqqqqq' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.field, 'town');
});

test('community validation: missing fields, bad category, invalid or non-UK coordinates, http image, duplicate name', async () => {
  const base = { name: 'Valid Name', category: 'Social', description: 'A perfectly valid description.', town: 'Middlesbrough', latitude: 54.57, longitude: -1.23 };
  const bad = [
    [{ ...base, name: '' }, 'name'], [{ ...base, category: 'Gaming' }, 'category'], [{ ...base, description: 'short' }, 'description'],
    [{ ...base, latitude: 120 }, 'latitude'], [{ ...base, latitude: 'abc' }, 'latitude'], [{ ...base, latitude: 48.85, longitude: 2.35 }, 'latitude'],
    [{ ...base, image_url: 'http://insecure.example.com/a.jpg' }, 'image_url'], [{ ...base, image_url: 'javascript:alert(1)' }, 'image_url'],
    [{ ...base, postcode: 'NOT A PC' }, 'postcode']
  ];
  for (const [body, field] of bad) {
    const r = await api('POST', '/api/communities', { token: S.org, body });
    assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.text}`);
    assert.equal(r.body.field, field);
  }
  const dup = await api('POST', '/api/communities', { token: S.org, body: { ...base, name: 'linthorpe coders' } });
  assert.equal(dup.status, 409);
});

test('organizer dashboard lists only their own communities', async () => {
  const r = await api('GET', '/api/organizer/communities', { token: S.org });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.communities.map(c => c.name).sort(), ['Linthorpe Coders', 'Stockton Walkers']);
  const other = await api('GET', '/api/organizer/communities', { token: S.org2 });
  assert.equal(other.body.communities.length, 0);
});

test('organizer publishes an event; it appears in the public events API without login', async () => {
  const r = await api('POST', '/api/events', { token: S.org, body: { community_id: S.communityId, name: 'Intro to JavaScript', event_date: isoDate(5), event_time: '18:30', venue: 'Room 2, Linthorpe Library', description: 'Bring a laptop.', image_url: S.photo } });
  assert.equal(r.status, 201, r.text);
  S.eventId = r.body.event.id;
  const pub = await api('GET', '/api/events/public');
  assert.equal(pub.status, 200);
  const e = pub.body.events.find(x => x.id === S.eventId);
  assert.ok(e, 'event listed publicly');
  for (const k of ['name', 'community_name', 'event_date', 'event_time', 'venue', 'description', 'image_url']) assert.ok(e[k], `public event has ${k}`);
  assert.equal(e.community_name, 'Linthorpe Coders');
  assert.equal(dbQuery('SELECT COUNT(*) n FROM events WHERE id = ?', S.eventId)[0].n, 1);
  const single = await api('GET', `/api/events/${S.eventId}`);
  assert.equal(single.status, 200);
  assert.equal(single.body.event.venue, 'Room 2, Linthorpe Library');
});

test('event validation: past date, impossible date, bad format, bad time, missing fields, duplicates', async () => {
  const base = { community_id: S.communityId, name: 'Valid Event', event_date: isoDate(3), event_time: '10:00', venue: 'Hall' };
  const bad = [
    [{ ...base, event_date: isoDate(-1) }, 'event_date'], [{ ...base, event_date: '2027-02-30' }, 'event_date'],
    [{ ...base, event_date: '14/11/2026' }, 'event_date'], [{ ...base, event_date: isoDate(1000) }, 'event_date'],
    [{ ...base, event_time: '25:00' }, 'event_time'], [{ ...base, event_time: 'noon' }, 'event_time'],
    [{ ...base, name: '' }, 'name'], [{ ...base, venue: '' }, 'venue'], [{ ...base, community_id: '' }, 'community_id'],
    [{ ...base, community_id: 'abc' }, 'id']
  ];
  for (const [body, field] of bad) {
    const r = await api('POST', '/api/events', { token: S.org, body });
    assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.text}`);
    assert.equal(r.body.field, field);
  }
  assert.equal((await api('POST', '/api/events', { token: S.org, body: { ...base, community_id: 999999 } })).status, 404);
  const dup = await api('POST', '/api/events', { token: S.org, body: { community_id: S.communityId, name: 'Intro to JavaScript', event_date: isoDate(5), event_time: '18:30', venue: 'Another hall' } });
  assert.equal(dup.status, 409);
});

// ---------------------------------------------------------------- Test B — discovery & location search
test('public discovery lists the new community with no login', async () => {
  const r = await api('GET', '/api/communities');
  const c = r.body.communities.find(x => x.id === S.communityId);
  assert.ok(c);
  assert.equal(c.image_url, S.photo);
  assert.equal(c.joined, false);
  const one = await api('GET', `/api/communities/${S.communityId}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.community.story, 'Started in 2024 by three students.');
  assert.equal(one.body.events.length, 1);
});

test('location search: town, partial postcode, full postcode, invalid postcode', async () => {
  const town = await api('GET', '/api/locations/search?q=middlesbrough');
  assert.equal(town.status, 200);
  assert.equal(town.body.results.length, 1, 'roads are filtered out, settlements kept');
  assert.equal(town.body.results[0].lat, 54.5742);
  assert.equal(town.body.results[0].type, 'Town');
  const partial = await api('GET', '/api/locations/search?q=TS1');
  assert.ok(partial.body.results.some(r => r.type === 'Postcode district'));
  const full = await api('GET', '/api/locations/search?q=ts1%203bx');
  assert.equal(full.body.results[0].postcode, 'TS1 3BX');
  const invalid = await api('GET', '/api/locations/search?q=ZZ99%209ZZ&mode=search');
  assert.equal(invalid.status, 200);
  assert.equal(invalid.body.results.length, 0);
  assert.match(invalid.body.message, /postcode/i);
  const short = await api('GET', '/api/locations/search?q=a');
  assert.equal(short.body.results.length, 0);
});

test('location search caches results and only uses Nominatim for explicit searches, at most 1 per second', async () => {
  const before = geo.calls.filter(c => c.path === '/places' && c.q === 'stockton').length;
  await api('GET', '/api/locations/search?q=stockton');
  await api('GET', '/api/locations/search?q=stockton');
  await api('GET', '/api/locations/search?q=Stockton');
  assert.equal(geo.calls.filter(c => c.path === '/places' && c.q === 'stockton').length - before <= 1, true, 'served from cache');
  const nominatimBefore = geo.calls.filter(c => c.path === '/search').length;
  const suggest = await api('GET', '/api/locations/search?q=Teesside%20University');
  assert.equal(suggest.body.results.length, 0);
  assert.equal(geo.calls.filter(c => c.path === '/search').length, nominatimBefore, 'autocomplete never calls Nominatim');
  const [a, b] = await Promise.all([
    api('GET', '/api/locations/search?mode=search&q=Teesside%20University'),
    api('GET', '/api/locations/search?mode=search&q=Paris')
  ]);
  assert.equal(a.body.results[0].source, 'nominatim');
  assert.equal(b.body.results.length, 0, 'non-UK results are discarded');
  const nominatim = geo.calls.filter(c => c.path === '/search').slice(nominatimBefore);
  assert.equal(nominatim.length, 2);
  assert.ok(nominatim[1].at - nominatim[0].at >= 1000, `Nominatim calls spaced ${nominatim[1].at - nominatim[0].at}ms`);
  assert.match(nominatim[0].ua, /CommunityConnect/);
});

test('distance filtering uses coordinates and sorts nearest first', async () => {
  const near = await api('GET', `/api/communities?lat=${MBRO.lat}&lon=${MBRO.lon}&radius=2`);
  assert.equal(near.status, 200);
  const names = near.body.communities.map(c => c.name);
  assert.ok(names.includes('Linthorpe Coders'));
  assert.ok(!names.includes('Stockton Walkers'), 'Stockton (~5 miles) excluded at 2 miles');
  const wider = await api('GET', `/api/communities?lat=${MBRO.lat}&lon=${MBRO.lon}&radius=10`);
  const wNames = wider.body.communities.map(c => c.name);
  assert.ok(wNames.includes('Stockton Walkers'));
  assert.ok(!wNames.includes('Tyneside Book & Coffee Club'), 'Newcastle excluded at 10 miles');
  const d = wider.body.communities.map(c => c.distance_miles);
  assert.deepEqual(d, [...d].sort((x, y) => x - y), 'sorted by distance');
  assert.ok(d.every(x => x <= 10));
  const widest = await api('GET', `/api/communities?lat=${MBRO.lat}&lon=${MBRO.lon}&radius=50`);
  assert.ok(widest.body.communities.some(c => c.name === 'Tyneside Book & Coffee Club'));
  const london = await api('GET', '/api/communities?lat=51.5072&lon=-0.1276&radius=50');
  assert.equal(london.body.communities.length, 0);
});

test('category filter and invalid search parameters', async () => {
  const tech = await api('GET', `/api/communities?lat=${MBRO.lat}&lon=${MBRO.lon}&radius=20&category=Technology`);
  assert.ok(tech.body.communities.length >= 1);
  assert.ok(tech.body.communities.every(c => c.category === 'Technology'));
  assert.equal((await api('GET', '/api/communities?category=Gaming')).status, 400);
  assert.equal((await api('GET', `/api/communities?lat=${MBRO.lat}&lon=${MBRO.lon}&radius=0`)).status, 400);
  assert.equal((await api('GET', `/api/communities?lat=${MBRO.lat}&lon=${MBRO.lon}&radius=51`)).status, 400);
  assert.equal((await api('GET', '/api/communities?lat=999&lon=1')).status, 400);
  assert.equal((await api('GET', '/api/communities?lat=54.5')).status, 400);
  const q = await api('GET', "/api/communities?q=' OR 1=1 --");
  assert.equal(q.status, 200);
  assert.equal(q.body.communities.length, 0, 'search text is bound safely, not executed');
});

test('invalid community and event IDs return clear errors', async () => {
  assert.equal((await api('GET', '/api/communities/abc')).status, 400);
  assert.equal((await api('GET', '/api/communities/999999')).status, 404);
  assert.equal((await api('GET', '/api/communities/1;DROP TABLE users')).status, 400);
  assert.equal((await api('GET', '/api/events/abc')).status, 400);
  assert.equal((await api('GET', '/api/events/999999')).status, 404);
  assert.equal((await api('POST', '/api/communities/999999/join', { token: S.part })).status, 404);
  assert.equal((await api('POST', '/api/events/999999/register', { token: S.part })).status, 404);
});

// ---------------------------------------------------------------- joining & registration
test('participant joins a community; duplicates are prevented; saved in SQLite', async () => {
  const j = await api('POST', `/api/communities/${S.communityId}/join`, { token: S.part });
  assert.equal(j.status, 201, j.text);
  const again = await api('POST', `/api/communities/${S.communityId}/join`, { token: S.part });
  assert.equal(again.status, 200);
  assert.equal(again.body.already_member, true);
  const rows = dbQuery('SELECT m.* FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ? AND m.community_id = ?', 'priya@example.com', S.communityId);
  assert.equal(rows.length, 1);
  const mine = await api('GET', '/api/participant/communities', { token: S.part });
  assert.deepEqual(mine.body.communities.map(c => c.id), [S.communityId]);
  const detail = await api('GET', `/api/communities/${S.communityId}`, { token: S.part });
  assert.equal(detail.body.community.joined, true);
  assert.equal(detail.body.community.member_count, 1);
});

test('event registration requires membership; duplicates prevented; appears in participant dashboard', async () => {
  const notMember = await api('POST', `/api/events/${S.eventId}/register`, { token: S.part2 });
  assert.equal(notMember.status, 403);
  assert.equal(notMember.body.code, 'MEMBERSHIP_REQUIRED');
  const r = await api('POST', `/api/events/${S.eventId}/register`, { token: S.part });
  assert.equal(r.status, 201, r.text);
  assert.match(r.body.message, /registered/);
  const dup = await api('POST', `/api/events/${S.eventId}/register`, { token: S.part });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.already_registered, true);
  assert.equal(dbQuery('SELECT COUNT(*) n FROM event_registrations WHERE event_id = ?', S.eventId)[0].n, 1);
  const dash = await api('GET', '/api/participant/events', { token: S.part });
  assert.equal(dash.status, 200);
  assert.deepEqual(dash.body.events.map(e => e.id), [S.eventId]);
  assert.equal(dash.body.events[0].registered, true);
  const org = await api('GET', '/api/organizer/events', { token: S.org });
  assert.equal(org.body.events.find(e => e.id === S.eventId).registration_count, 1);
});

// ---------------------------------------------------------------- Test D — permissions
test('permissions: role and ownership are enforced by the backend', async () => {
  const c = { name: 'Sneaky', category: 'Social', description: 'Should never be created.', town: 'Middlesbrough', latitude: 54.57, longitude: -1.23 };
  assert.equal((await api('POST', '/api/communities', { token: S.part, body: c })).status, 403, 'participant cannot create community');
  assert.equal((await api('POST', '/api/events', { token: S.part, body: { community_id: S.communityId, name: 'X event', event_date: isoDate(2), event_time: '10:00', venue: 'Y' } })).status, 403, 'participant cannot publish events');
  assert.equal((await api('POST', `/api/communities/${S.communityId}/join`, { token: S.org })).status, 403, 'organizer cannot join');
  assert.equal((await api('POST', `/api/events/${S.eventId}/register`, { token: S.org })).status, 403, 'organizer cannot register');
  assert.equal((await api('PUT', `/api/communities/${S.communityId}`, { token: S.org2, body: { ...c, name: 'Hijacked' } })).status, 403, 'other organizer cannot edit');
  assert.equal((await api('DELETE', `/api/communities/${S.communityId}`, { token: S.org2 })).status, 403, 'other organizer cannot delete');
  assert.equal((await api('POST', '/api/events', { token: S.org2, body: { community_id: S.communityId, name: 'Hijack event', event_date: isoDate(2), event_time: '10:00', venue: 'Y' } })).status, 403, 'other organizer cannot add events');
  assert.equal((await api('DELETE', `/api/events/${S.eventId}`, { token: S.org2 })).status, 403, 'other organizer cannot delete events');
  assert.equal(dbQuery('SELECT name FROM communities WHERE id = ?', S.communityId)[0].name, 'Linthorpe Coders');
  for (const [m, u] of [['POST', '/api/communities'], ['POST', `/api/communities/${S.communityId}/join`], ['POST', '/api/events'], ['POST', `/api/events/${S.eventId}/register`],
    ['GET', '/api/organizer/communities'], ['GET', '/api/organizer/events'], ['GET', '/api/participant/events'], ['GET', '/api/participant/communities'], ['POST', '/api/uploads']]) {
    const body = m === 'GET' ? undefined : {};
    assert.equal((await api(m, u, { body })).status, 401, `${m} ${u} without login`);
    assert.equal((await api(m, u, { body, token: 'bad.token.value' })).status, 401, `${m} ${u} with bad token`);
  }
  assert.equal((await api('GET', '/api/participant/events', { token: S.org })).status, 403);
  assert.equal((await api('GET', '/api/organizer/events', { token: S.part })).status, 403);
});

test('owner can edit their community', async () => {
  const r = await api('PUT', `/api/communities/${S.communityId}`, { token: S.org, body: { name: 'Linthorpe Coders', category: 'Technology', description: 'Weekly coding evenings for every level.', story: 'Updated story.', town: 'Middlesbrough', address: 'Linthorpe Road', postcode: 'TS1 3BX', latitude: 54.5650, longitude: -1.2400, image_url: S.photo } });
  assert.equal(r.status, 200, r.text);
  assert.equal(dbQuery('SELECT story FROM communities WHERE id = ?', S.communityId)[0].story, 'Updated story.');
});


// ---------------------------------------------------------------- prices, capacity, edit, run again
test('events can have a ticket price and capacity; invalid values are rejected', async () => {
  const base = { community_id: S.communityId, name: 'Paid Workshop', event_date: isoDate(10), event_time: '18:00', venue: 'Studio 3' };
  for (const [body, field] of [[{ ...base, price: 'abc' }, 'price'], [{ ...base, price: '-2' }, 'price'], [{ ...base, price: '900' }, 'price'],
    [{ ...base, capacity: '0' }, 'capacity'], [{ ...base, capacity: '2.5' }, 'capacity']]) {
    const r = await api('POST', '/api/events', { token: S.org, body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.field, field);
  }
  const r = await api('POST', '/api/events', { token: S.org, body: { ...base, price: '7.50', capacity: '1' } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.event.price_pence, 750);
  assert.equal(r.body.event.capacity, 1);
  assert.equal(r.body.event.spots_left, 1);
  S.paidEventId = r.body.event.id;
});

const CARD_OK = { name: 'Priya Participant', card_number: '4242 4242 4242 4242', expiry: '12/35', cvc: '123' };

test('paid events need online payment: checkout holds a place, demo card payment confirms it', async () => {
  const direct = await api('POST', `/api/events/${S.paidEventId}/register`, { token: S.part });
  assert.equal(direct.status, 402);
  assert.equal(direct.body.code, 'PAYMENT_REQUIRED');
  const co = await api('POST', `/api/events/${S.paidEventId}/checkout`, { token: S.part, body: {} });
  assert.equal(co.status, 201, co.text);
  assert.equal(co.body.mode, 'demo');
  assert.match(co.body.checkout_url, /^\/checkout\.html\?ref=demo_[a-f0-9]{24}$/);
  S.payRef = co.body.checkout_url.split('ref=')[1];
  const row = dbQuery('SELECT * FROM event_registrations WHERE event_id = ?', S.paidEventId)[0];
  assert.equal(row.payment_status, 'pending');
  assert.equal(row.amount_pence, 750);
  const held = (await api('GET', `/api/events/${S.paidEventId}`, { token: S.part })).body.event;
  assert.equal(held.registered, false, 'not registered until paid');
  assert.equal(held.spots_left, 0, 'but the place is held');
  assert.equal(held.my_ticket.payment_status, 'pending');
  // Capacity 1: another participant can't take the held place.
  await api('POST', `/api/communities/${S.communityId}/join`, { token: S.part2 });
  const full = await api('POST', `/api/events/${S.paidEventId}/checkout`, { token: S.part2, body: {} });
  assert.equal(full.status, 409);
  assert.equal(full.body.code, 'EVENT_FULL');
  // Order summary for the checkout page — only for its owner.
  const order = await api('GET', `/api/payments/${S.payRef}`, { token: S.part });
  assert.equal(order.status, 200);
  assert.equal(order.body.order.amount_pence, 750);
  assert.ok(order.body.order.expires_at);
  assert.equal((await api('GET', `/api/payments/${S.payRef}`, { token: S.part2 })).status, 404);
  // Card checks
  for (const [card, field] of [[{ ...CARD_OK, card_number: '4242 4242 4242 4241' }, 'card_number'], [{ ...CARD_OK, expiry: '01/20' }, 'expiry'], [{ ...CARD_OK, cvc: '1' }, 'cvc'], [{ ...CARD_OK, name: '' }, 'name']]) {
    const bad = await api('POST', `/api/payments/demo/${S.payRef}`, { token: S.part, body: card });
    assert.equal(bad.status, 400, JSON.stringify(card));
    assert.equal(bad.body.field, field);
  }
  const declined = await api('POST', `/api/payments/demo/${S.payRef}`, { token: S.part, body: { ...CARD_OK, card_number: '4000 0000 0000 0002' } });
  assert.equal(declined.status, 402);
  assert.equal(declined.body.code, 'CARD_DECLINED');
  const paid = await api('POST', `/api/payments/demo/${S.payRef}`, { token: S.part, body: CARD_OK });
  assert.equal(paid.status, 200, paid.text);
  assert.equal(paid.body.order.payment_status, 'paid');
  assert.match(paid.body.order.ticket_number, /^CC-\d{4}-\d{5}$/);
  const after = dbQuery('SELECT * FROM event_registrations WHERE event_id = ?', S.paidEventId)[0];
  assert.equal(after.payment_status, 'paid');
  assert.ok(after.paid_at);
  assert.ok(!JSON.stringify(after).includes('4242424242424242'), 'full card number is never stored');
  const pub = await api('GET', `/api/events/${S.paidEventId}`);
  assert.equal(pub.body.event.is_full, true);
  assert.equal(pub.body.event.revenue_pence, undefined, 'revenue is not shown publicly');
  const own = await api('GET', `/api/events/${S.paidEventId}`, { token: S.org });
  assert.equal(own.body.event.revenue_pence, 750);
  const again = await api('POST', `/api/events/${S.paidEventId}/checkout`, { token: S.part, body: {} });
  assert.equal(again.body.already_registered, true);
  const cancel = await api('DELETE', `/api/events/${S.paidEventId}/register`, { token: S.part });
  assert.equal(cancel.status, 400);
  assert.equal(cancel.body.code, 'PAID_TICKET');
});

test('organizer can edit their event; capacity cannot drop below bookings; others cannot edit', async () => {
  const body = { name: 'Paid Workshop', event_date: isoDate(11), event_time: '18:30', venue: 'Studio 4', price: '7.50', capacity: '5' };
  const r = await api('PUT', `/api/events/${S.paidEventId}`, { token: S.org, body });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.event.venue, 'Studio 4');
  assert.equal(r.body.event.spots_left, 4);
  const tooSmall = await api('PUT', `/api/events/${S.paidEventId}`, { token: S.org, body: { ...body, capacity: '0' } });
  assert.equal(tooSmall.status, 400);
  assert.equal((await api('PUT', `/api/events/${S.paidEventId}`, { token: S.org2, body })).status, 403);
  assert.equal((await api('PUT', `/api/events/${S.paidEventId}`, { token: S.part, body })).status, 403);
});

test('"Run again" copies an event to the next free week in one click', async () => {
  const src = (await api('GET', `/api/events/${S.paidEventId}`)).body.event;
  const r1 = await api('POST', `/api/events/${S.paidEventId}/repeat`, { token: S.org, body: {} });
  assert.equal(r1.status, 201, r1.text);
  const d = new Date(`${src.event_date}T00:00:00`); d.setDate(d.getDate() + 7);
  const p = n => String(n).padStart(2, '0');
  assert.equal(r1.body.event.event_date, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
  for (const k of ['name', 'event_time', 'venue', 'price_pence', 'capacity']) assert.equal(r1.body.event[k], src[k], k);
  assert.equal(r1.body.event.registration_count, 0, 'the copy starts with no registrations');
  const r2 = await api('POST', `/api/events/${S.paidEventId}/repeat`, { token: S.org, body: {} });
  assert.equal(r2.status, 201);
  assert.ok(r2.body.event.event_date > r1.body.event.event_date, 'second copy skips the week already taken');
  const custom = await api('POST', `/api/events/${S.paidEventId}/repeat`, { token: S.org, body: { event_date: isoDate(60) } });
  assert.equal(custom.body.event.event_date, isoDate(60));
  assert.equal((await api('POST', `/api/events/${S.paidEventId}/repeat`, { token: S.org, body: { event_date: isoDate(-3) } })).status, 400);
  assert.equal((await api('POST', `/api/events/${S.paidEventId}/repeat`, { token: S.org2, body: {} })).status, 403);
  assert.equal((await api('POST', `/api/events/${S.paidEventId}/repeat`, { token: S.part, body: {} })).status, 403);
  assert.equal((await api('POST', '/api/events/999999/repeat', { token: S.org, body: {} })).status, 404);
});

test('add-to-calendar file is a valid iCalendar event', async () => {
  const res = await fetch(`${srv.base}/api/events/${S.paidEventId}/calendar.ics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/calendar/);
  const text = await res.text();
  for (const s of ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:Paid Workshop', 'DTSTART:', 'END:VCALENDAR']) assert.ok(text.includes(s), s);
});

// ---------------------------------------------------------------- attendance, feedback, analytics
test('attendance: only after the event starts, only by the owner', async () => {
  assert.equal((await api('POST', `/api/events/${S.paidEventId}/attendees/all`, { token: S.org, body: {} })).status, 400, 'future event');
  // A past event of Olivia's community that Priya registered for (created directly, as if time had passed).
  const r = dbRun("INSERT INTO events(community_id, name, event_date, event_time, venue, price_pence, status, created_at) VALUES(?, 'Past Meetup', ?, '18:00', 'Hall', 500, 'published', datetime('now'))", S.communityId, isoDate(-7));
  S.pastEventId = Number(r.lastInsertRowid);
  const priya = dbQuery("SELECT id FROM users WHERE email='priya@example.com'")[0].id;
  S.priyaId = priya;
  dbRun("INSERT INTO event_registrations(user_id, event_id, registered_at, amount_pence, list_price_pence, ticket_type, payment_status, paid_at) VALUES(?, ?, datetime('now'), 500, 500, 'standard', 'paid', datetime('now'))", priya, S.pastEventId);
  const list = await api('GET', `/api/events/${S.pastEventId}/attendees`, { token: S.org });
  assert.equal(list.status, 200);
  assert.equal(list.body.attendees.length, 1);
  assert.equal(list.body.attendees[0].attended, false);
  assert.equal((await api('GET', `/api/events/${S.pastEventId}/attendees`, { token: S.org2 })).status, 403);
  assert.equal((await api('GET', `/api/events/${S.pastEventId}/attendees`, { token: S.part })).status, 403);
  assert.equal((await api('PUT', `/api/events/${S.pastEventId}/attendees/${priya}`, { token: S.org, body: { attended: 'yes' } })).status, 400);
  assert.equal((await api('PUT', `/api/events/${S.pastEventId}/attendees/999999`, { token: S.org, body: { attended: true } })).status, 404);
  assert.equal((await api('DELETE', `/api/events/${S.pastEventId}/register`, { token: S.part })).status, 400, 'cannot cancel after the event started');
});

test('feedback: only attendees can rate, ratings are validated and can be updated', async () => {
  const before = await api('POST', `/api/events/${S.pastEventId}/feedback`, { token: S.part, body: { rating: 5 } });
  assert.equal(before.status, 403);
  assert.equal(before.body.code, 'NOT_ATTENDED');
  const mark = await api('PUT', `/api/events/${S.pastEventId}/attendees/${S.priyaId}`, { token: S.org, body: { attended: true } });
  assert.equal(mark.status, 200, mark.text);
  assert.ok(dbQuery('SELECT checked_in_at FROM event_registrations WHERE event_id = ?', S.pastEventId)[0].checked_in_at);
  assert.equal((await api('POST', `/api/events/${S.pastEventId}/feedback`, { token: S.part, body: { rating: 6 } })).status, 400);
  assert.equal((await api('POST', `/api/events/${S.pastEventId}/feedback`, { token: S.part, body: { rating: 4, comment: 'Good fun' } })).status, 201);
  const upd = await api('POST', `/api/events/${S.pastEventId}/feedback`, { token: S.part, body: { rating: 5 } });
  assert.equal(upd.status, 201);
  assert.equal(upd.body.event.my_rating, 5);
  assert.equal(dbQuery('SELECT COUNT(*) n FROM event_feedback WHERE event_id = ?', S.pastEventId)[0].n, 1, 'one rating per person');
  assert.equal((await api('POST', `/api/events/${S.paidEventId}/feedback`, { token: S.part, body: { rating: 5 } })).status, 400, 'future event');
  const mine = await api('GET', '/api/participant/events', { token: S.part });
  const past = mine.body.events.find(e => e.id === S.pastEventId);
  assert.equal(past.attended, true);
  assert.equal(past.my_rating, 5);
});

test('organizer analytics: totals, per-event, monthly revenue, member growth', async () => {
  const r = await api('GET', '/api/organizer/analytics', { token: S.org });
  assert.equal(r.status, 200, r.text);
  const s = r.body.summary;
  assert.equal(s.events_past, 1);
  assert.equal(s.registrations_past, 1);
  assert.equal(s.attended, 1);
  assert.equal(s.attendance_rate, 100);
  assert.equal(s.revenue_past_pence, 500);
  assert.equal(s.revenue_pence, 500 + 750);
  assert.equal(s.avg_rating, 5);
  assert.equal(r.body.monthly.length, 6);
  assert.equal(r.body.monthly.reduce((n, m) => n + m.revenue_pence, 0), 500);
  assert.equal(r.body.per_event[0].attendance_rate, 100);
  assert.ok(r.body.member_growth.at(-1).total_members >= 2);
  assert.ok(r.body.upcoming.some(e => e.id === S.paidEventId && e.fill_rate === 20));
  assert.equal((await api('GET', '/api/organizer/analytics?months=12', { token: S.org })).body.monthly.length, 12);
  const empty = await api('GET', '/api/organizer/analytics', { token: S.org2 });
  assert.equal(empty.body.summary.events_total, 0);
  assert.equal(empty.body.summary.attendance_rate, null);
  assert.equal((await api('GET', '/api/organizer/analytics', { token: S.part })).status, 403);
  assert.equal((await api('GET', '/api/organizer/analytics')).status, 401);
});

test('demo organizer has realistic history for the analytics demo', async () => {
  const login = await api('POST', '/api/auth/login', { body: { email: 'demo-organizer@communityconnect.local', password: 'Demo12345' } });
  assert.equal(login.status, 200, 'demo login works outside production');
  const r = await api('GET', '/api/organizer/analytics', { token: login.body.token });
  const s = r.body.summary;
  assert.ok(s.events_past >= 10 && s.attended > 0 && s.revenue_pence > 0 && s.avg_rating >= 1);
  assert.ok(s.attended <= s.registrations_past);
  assert.ok(r.body.per_event.every(e => e.attended <= e.registered));
});

test('participants get community recommendations they have not joined', async () => {
  const r = await api('GET', '/api/participant/recommendations', { token: S.part });
  assert.equal(r.status, 200);
  assert.ok(r.body.communities.length >= 1 && r.body.communities.length <= 3);
  assert.ok(r.body.communities.every(c => !c.joined && c.id !== S.communityId));
  assert.ok(r.body.communities.every(c => c.reasons.length >= 1));
  assert.equal((await api('GET', '/api/participant/recommendations', { token: S.org })).status, 403);
});


// ---------------------------------------------------------------- v4: early bird, promo codes, payments
const localIn = days => `${isoDate(days)}T23:59`;

test('early-bird pricing: validation, current price, countdown data', async () => {
  const base = { community_id: S.communityId, name: 'Early Bird Gala', event_date: isoDate(20), event_time: '19:00', venue: 'Main Hall', price: '10' };
  for (const [extra, field] of [
    [{ early_price: '12', early_until: localIn(5) }, 'early_price'],          // not cheaper
    [{ early_price: '10', early_until: localIn(5) }, 'early_price'],          // equal
    [{ early_price: '6' }, 'early_until'],                                      // missing end
    [{ early_price: '6', early_until: localIn(-1) }, 'early_until'],          // in the past
    [{ early_price: '6', early_until: localIn(25) }, 'early_until'],          // after the event
    [{ early_price: '6', early_until: 'tomorrow' }, 'early_until'],
    [{ early_price: '6', early_until: localIn(5), early_limit: '0' }, 'early_limit'],
    [{ price: '', early_price: '6', early_until: localIn(5) }, 'price']       // free event can't have early bird
  ]) {
    const r = await api('POST', '/api/events', { token: S.org, body: { ...base, ...extra } });
    assert.equal(r.status, 400, `${JSON.stringify(extra)} → ${r.text}`);
    assert.equal(r.body.field, field);
  }
  const r = await api('POST', '/api/events', { token: S.org, body: { ...base, early_price: '6', early_until: localIn(5), early_limit: '2', capacity: '50' } });
  assert.equal(r.status, 201, r.text);
  const e = r.body.event;
  S.galaId = e.id;
  assert.equal(e.early_active, true);
  assert.equal(e.current_price_pence, 600);
  assert.equal(e.ticket_type_now, 'early_bird');
  assert.equal(e.early_left, 2);
  assert.equal(e.early_until, localIn(5));
  assert.equal(e.starts_at, `${isoDate(20)}T19:00`);
});

test('promo codes: organizer manages them; quote applies them; limits enforced', async () => {
  assert.equal((await api('POST', `/api/events/${S.galaId}/promo-codes`, { token: S.org2, body: { code: 'HACK', percent_off: 90 } })).status, 403);
  assert.equal((await api('POST', `/api/events/${S.galaId}/promo-codes`, { token: S.part, body: { code: 'HACK', percent_off: 90 } })).status, 403);
  for (const [body, field] of [[{ code: 'ab', percent_off: 10 }, 'code'], [{ code: 'BAD CODE', percent_off: 10 }, 'code'], [{ code: 'OK10', percent_off: 2 }, 'percent_off'], [{ code: 'OK10', percent_off: 120 }, 'percent_off']]) {
    const r = await api('POST', `/api/events/${S.galaId}/promo-codes`, { token: S.org, body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.field, field);
  }
  const c = await api('POST', `/api/events/${S.galaId}/promo-codes`, { token: S.org, body: { code: 'student50', percent_off: 50, max_uses: 1 } });
  assert.equal(c.status, 201, c.text);
  assert.equal(c.body.promo_code.code, 'STUDENT50');
  S.promoId = c.body.promo_code.id;
  assert.equal((await api('POST', `/api/events/${S.galaId}/promo-codes`, { token: S.org, body: { code: 'STUDENT50', percent_off: 10 } })).status, 409);
  await api('POST', `/api/events/${S.galaId}/promo-codes`, { token: S.org, body: { code: 'FREEPASS', percent_off: 100 } });
  const q = await api('GET', `/api/events/${S.galaId}/quote?promo_code=student50`);
  assert.equal(q.status, 200);
  assert.deepEqual({ t: q.body.quote.ticket_type, list: q.body.quote.list_price_pence, d: q.body.quote.discount_pence, a: q.body.quote.amount_pence }, { t: 'early_bird', list: 600, d: 300, a: 300 });
  const bad = await api('GET', `/api/events/${S.galaId}/quote?promo_code=NOPE`);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.field, 'promo_code');
  const list = await api('GET', `/api/events/${S.galaId}/promo-codes`, { token: S.org });
  assert.deepEqual(list.body.promo_codes.map(p => p.code), ['FREEPASS', 'STUDENT50']);
  assert.equal((await api('GET', `/api/events/${S.galaId}/promo-codes`, { token: S.org2 })).status, 403);
  assert.equal((await api('GET', `/api/events/${S.galaId}`)).body.event.has_promo_codes, true);
});

test('checkout with promo; max uses; 100% promo books without payment; early-bird limit switches to standard', async () => {
  const co = await api('POST', `/api/events/${S.galaId}/checkout`, { token: S.part, body: { promo_code: 'STUDENT50' } });
  assert.equal(co.status, 201, co.text);
  assert.equal(co.body.quote.amount_pence, 300);
  const ref = co.body.checkout_url.split('ref=')[1];
  // Re-opening checkout with the same code doesn't count against the user's own hold.
  const again = await api('POST', `/api/events/${S.galaId}/checkout`, { token: S.part, body: { promo_code: 'STUDENT50' } });
  assert.equal(again.status, 201, again.text);
  const ref2 = again.body.checkout_url.split('ref=')[1];
  assert.notEqual(ref2, ref);
  assert.equal((await api('GET', `/api/payments/${ref}`, { token: S.part })).status, 404, 'old reference replaced');
  const paid = await api('POST', `/api/payments/demo/${ref2}`, { token: S.part, body: CARD_OK });
  assert.equal(paid.body.order.amount_pence, 300);
  assert.equal(paid.body.order.ticket_type, 'early_bird');
  assert.equal(paid.body.order.promo_code, 'STUDENT50');
  // STUDENT50 had max_uses 1
  const used = await api('POST', `/api/events/${S.galaId}/checkout`, { token: S.part2, body: { promo_code: 'STUDENT50' } });
  assert.equal(used.status, 400);
  assert.match(used.body.error, /fully used/);
  // 100% code → free ticket, no checkout
  const free = await api('POST', `/api/events/${S.galaId}/checkout`, { token: S.part2, body: { promo_code: 'FREEPASS' } });
  assert.equal(free.status, 201, free.text);
  assert.equal(free.body.registered, true);
  assert.equal(free.body.checkout_url, undefined);
  const rows = dbQuery("SELECT ticket_type, payment_status, amount_pence FROM event_registrations WHERE event_id = ? ORDER BY amount_pence DESC", S.galaId);
  assert.deepEqual(rows.map(r => ({ ...r })), [{ ticket_type: 'early_bird', payment_status: 'paid', amount_pence: 300 }, { ticket_type: 'early_bird', payment_status: 'free', amount_pence: 0 }]);
  // early_limit was 2 → both early-bird tickets gone, price is now standard
  const e = (await api('GET', `/api/events/${S.galaId}`)).body.event;
  assert.equal(e.early_active, false);
  assert.equal(e.early_left, 0);
  assert.equal(e.current_price_pence, 1000);
  assert.equal(e.ticket_type_now, 'standard');
});

test('unpaid holds expire and free the place', async () => {
  const r = await api('POST', '/api/events', { token: S.org, body: { community_id: S.communityId, name: 'One Seat Dinner', event_date: isoDate(15), event_time: '19:00', venue: 'Bistro', price: '20', capacity: '1' } });
  const id = r.body.event.id;
  assert.equal((await api('POST', `/api/events/${id}/checkout`, { token: S.part, body: {} })).status, 201);
  assert.equal((await api('POST', `/api/events/${id}/checkout`, { token: S.part2, body: {} })).status, 409, 'held');
  dbRun("UPDATE event_registrations SET registered_at = datetime('now', '-45 minutes') WHERE event_id = ?", id);
  await new Promise(res => setTimeout(res, 21000)); // cleanup runs at most every 20 s
  const next = await api('POST', `/api/events/${id}/checkout`, { token: S.part2, body: {} });
  assert.equal(next.status, 201, 'expired hold released, place available again');
  assert.equal(dbQuery('SELECT COUNT(*) n FROM event_registrations WHERE event_id = ?', id)[0].n, 1);
  // Releasing a hold by hand
  assert.equal((await api('DELETE', `/api/events/${id}/register`, { token: S.part2 })).status, 200);
  assert.equal(dbQuery('SELECT COUNT(*) n FROM event_registrations WHERE event_id = ?', id)[0].n, 0);
});

test('"Run again" also copies early-bird timing and promo codes', async () => {
  const r = await api('POST', `/api/events/${S.galaId}/repeat`, { token: S.org, body: {} });
  assert.equal(r.status, 201, r.text);
  const e = r.body.event;
  assert.equal(e.early_price_pence, 600);
  assert.equal(e.early_until, localIn(12), 'same gap before the event (15 days before → 15 days before the new date)');
  assert.equal(e.early_left, 2, 'early-bird allocation starts fresh');
  const codes = await api('GET', `/api/events/${e.id}/promo-codes`, { token: S.org });
  assert.deepEqual(codes.body.promo_codes.map(c => [c.code, c.uses]), [['FREEPASS', 0], ['STUDENT50', 0]]);
});

test('analytics: sales by ticket type and promo code usage (paid only)', async () => {
  const r = await api('GET', '/api/organizer/analytics', { token: S.org });
  const byType = Object.fromEntries(r.body.sales_by_type.map(t => [t.ticket_type, t]));
  assert.equal(byType.early_bird.tickets, 2);
  assert.equal(byType.early_bird.revenue_pence, 300);
  assert.equal(byType.early_bird.discount_pence, 300);
  assert.ok(r.body.promo_usage.some(p => p.code === 'STUDENT50' && p.uses === 1 && p.discount_pence === 300));
  assert.equal(r.body.payment_mode, 'demo');
});

test('Stripe mode: creates a Checkout Session and confirms payment with Stripe', async () => {
  const stripe = await startFakeStripe();
  const d5 = tempDir();
  const s5 = await startServer({ dir: d5, geocoderUrl: geo.url, env: { STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_API_URL: stripe.url, PUBLIC_URL: 'https://cc.example.org', SEED_DEMO_DATA: 'false' } });
  try {
    const c = client(s5.base);
    const org = (await c('POST', '/api/auth/register', { body: { name: 'Org S', email: 'orgs@example.com', password: 'Organise123', role: 'organizer' } })).body.token;
    const par = (await c('POST', '/api/auth/register', { body: { name: 'Pat S', email: 'pats@example.com', password: 'Participate1', role: 'participant' } })).body.token;
    const com = (await c('POST', '/api/communities', { token: org, body: { name: 'Stripe Club', category: 'Social', description: 'Testing Stripe payments.', town: 'Middlesbrough', latitude: 54.57, longitude: -1.23 } })).body.community;
    const ev = (await c('POST', '/api/events', { token: org, body: { community_id: com.id, name: 'Paid Night', event_date: isoDate(9), event_time: '20:00', venue: 'Hall', price: '12.50' } })).body.event;
    await c('POST', `/api/communities/${com.id}/join`, { token: par });
    assert.equal((await c('GET', `/api/events/${ev.id}`)).body.event.payment_mode, 'stripe');
    const co = await c('POST', `/api/events/${ev.id}/checkout`, { token: par, body: {} });
    assert.equal(co.status, 201, co.text);
    assert.equal(co.body.mode, 'stripe');
    assert.match(co.body.checkout_url, /^https:\/\/checkout\.stripe\.test\/pay\/cs_test_1$/);
    const form = stripe.requests[0];
    assert.equal(form.mode, 'payment');
    assert.equal(form['line_items[0][price_data][currency]'], 'gbp');
    assert.equal(form['line_items[0][price_data][unit_amount]'], '1250');
    assert.equal(form.success_url, 'https://cc.example.org/payment.html?session_id={CHECKOUT_SESSION_ID}');
    assert.equal(form.customer_email, 'pats@example.com');
    assert.equal((await c('POST', '/api/payments/demo/whatever', { token: par, body: CARD_OK })).status, 400, 'demo payments off in Stripe mode');
    const notYet = await c('POST', '/api/payments/stripe/confirm', { token: par, body: { session_id: 'cs_test_1' } });
    assert.equal(notYet.status, 402);
    stripe.markPaid('cs_test_1');
    const ok = await c('POST', '/api/payments/stripe/confirm', { token: par, body: { session_id: 'cs_test_1' } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.order.payment_status, 'paid');
    assert.equal(ok.body.order.amount_pence, 1250);
    assert.equal((await c('GET', `/api/events/${ev.id}`, { token: par })).body.event.registered, true);
    assert.equal((await c('POST', '/api/payments/stripe/confirm', { token: par, body: { session_id: 'bad id' } })).status, 400);
  } finally { await s5.stop(); await stripe.close(); removeDir(d5); }
});

test('leaving a community keeps paid tickets', async () => {
  const before = dbQuery("SELECT COUNT(*) n FROM event_registrations r JOIN users u ON u.id = r.user_id WHERE u.email = 'priya@example.com' AND r.payment_status = 'paid'")[0].n;
  assert.ok(before >= 2);
  const left = await api('DELETE', `/api/communities/${S.communityId}/join`, { token: S.part });
  assert.equal(left.status, 200);
  assert.match(left.body.message, /paid tickets are kept/);
  assert.equal(dbQuery("SELECT COUNT(*) n FROM event_registrations r JOIN users u ON u.id = r.user_id WHERE u.email = 'priya@example.com' AND r.payment_status = 'paid'")[0].n, before);
  await api('POST', `/api/communities/${S.communityId}/join`, { token: S.part });
  assert.equal(dbQuery("SELECT COUNT(*) n FROM event_registrations WHERE event_id = ? AND user_id = ?", S.eventId, S.priyaId)[0].n, 0, 'free registration was cancelled');
  assert.equal((await api('POST', `/api/events/${S.eventId}/register`, { token: S.part })).status, 201, 're-register for later tests');
});

// ---------------------------------------------------------------- malformed requests
test('malformed and oversized requests are handled safely', async () => {
  const bad = await api('POST', '/api/auth/login', { raw: '{"email":' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /JSON/);
  const big = await api('POST', '/api/auth/login', { raw: JSON.stringify({ email: 'x'.repeat(200 * 1024) }) });
  assert.equal(big.status, 413);
  const huge = await api('POST', '/api/uploads', { token: S.org, raw: JSON.stringify({ image: 'data:image/png;base64,' + 'A'.repeat(7 * 1024 * 1024) }) });
  assert.equal(huge.status, 413);
});

// ---------------------------------------------------------------- Test C — persistence across restart
test('data persists after the server restarts and users can log in again', async () => {
  await srv.stop();
  srv = await startServer({ dir, geocoderUrl: geo.url });
  api = client(srv.base);
  const login = await api('POST', '/api/auth/login', { body: { email: 'priya@example.com', password: 'Participate1' } });
  assert.equal(login.status, 200);
  const t = login.body.token;
  assert.deepEqual((await api('GET', '/api/participant/communities', { token: t })).body.communities.map(c => c.id), [S.communityId]);
  const regs = (await api('GET', '/api/participant/events', { token: t })).body.events.map(e => e.id);
  for (const id of [S.eventId, S.paidEventId, S.pastEventId]) assert.ok(regs.includes(id), `registration ${id} kept; got ${regs} db ${JSON.stringify(dbQuery("SELECT r.event_id, r.payment_status, u.email FROM event_registrations r JOIN users u ON u.id = r.user_id WHERE u.email = 'priya@example.com'"))}`);
  assert.equal(dbQuery('SELECT rating FROM event_feedback WHERE event_id = ?', S.pastEventId)[0].rating, 5, 'rating kept');
  assert.equal(dbQuery('SELECT attended FROM event_registrations WHERE event_id = ?', S.pastEventId)[0].attended, 1, 'attendance kept');
  assert.equal((await api('GET', '/api/organizer/communities', { token: S.org })).status, 200, 'earlier token still valid after restart');
  assert.ok((await api('GET', '/api/events/public')).body.events.some(e => e.id === S.eventId));
  assert.ok(!srv.output.includes('Added starter data'), 'seed data is not re-inserted');
  const counts = dbQuery('SELECT (SELECT COUNT(*) FROM users) u, (SELECT COUNT(*) FROM communities) c');
  assert.ok(counts[0].u >= 5 && counts[0].c >= 9);
});

// ---------------------------------------------------------------- cancellation & cascades
test('cancelling, leaving and deleting keep relationships consistent', async () => {
  assert.equal((await api('DELETE', `/api/events/${S.eventId}/register`, { token: S.part })).status, 200);
  assert.equal((await api('DELETE', `/api/events/${S.eventId}/register`, { token: S.part })).status, 404);
  assert.equal((await api('POST', `/api/events/${S.eventId}/register`, { token: S.part })).status, 201);
  assert.equal((await api('DELETE', `/api/communities/${S.communityId}/join`, { token: S.part })).status, 200);
  assert.equal(dbQuery('SELECT COUNT(*) n FROM event_registrations WHERE event_id = ?', S.eventId)[0].n, 0, 'leaving cancels registrations');
  await api('POST', `/api/communities/${S.communityId}/join`, { token: S.part });
  await api('POST', `/api/events/${S.eventId}/register`, { token: S.part });
  assert.equal((await api('DELETE', `/api/communities/${S.community2Id}`, { token: S.org })).status, 200);
  assert.equal((await api('DELETE', `/api/communities/${S.communityId}`, { token: S.org })).status, 200);
  const orphans = dbQuery(`SELECT
    (SELECT COUNT(*) FROM events WHERE community_id NOT IN (SELECT id FROM communities)) e,
    (SELECT COUNT(*) FROM memberships WHERE community_id NOT IN (SELECT id FROM communities)) m,
    (SELECT COUNT(*) FROM event_registrations WHERE event_id NOT IN (SELECT id FROM events)) r`)[0];
  assert.deepEqual({ ...orphans }, { e: 0, m: 0, r: 0 });
  assert.equal((await api('GET', `/api/events/${S.eventId}`)).status, 404);
  const fk = dbQuery('PRAGMA foreign_key_check');
  assert.equal(fk.length, 0);
});

// ---------------------------------------------------------------- failure handling
test('location search falls back gracefully when the geocoding service is down', async () => {
  const d2 = tempDir();
  const down = await startServer({ dir: d2, geocoderUrl: 'http://127.0.0.1:9', env: { SEED_DEMO_DATA: 'false' } });
  try {
    const c = client(down.base);
    const leeds = await c('GET', '/api/locations/search?q=Leeds');
    assert.equal(leeds.status, 200);
    assert.equal(leeds.body.source, 'offline');
    assert.equal(leeds.body.results[0].name, 'Leeds');
    const unknown = await c('GET', '/api/locations/search?q=Qqqqqq');
    assert.equal(unknown.status, 503);
    assert.match(unknown.body.error, /unavailable/);
    assert.equal((await c('GET', '/api/communities')).body.communities.length, 0, 'SEED_DEMO_DATA=false starts empty');
  } finally { await down.stop(); removeDir(d2); }
});

test('a damaged database file is reported clearly and left untouched', async () => {
  const d3 = tempDir();
  const file = path.join(d3, 'test.sqlite');
  fs.writeFileSync(file, 'this is not a database'.repeat(100));
  const beforeBytes = fs.readFileSync(file);
  await assert.rejects(startServer({ dir: d3, geocoderUrl: geo.url }), /Could not open the database/);
  assert.ok(fs.readFileSync(file).equals(beforeBytes));
  removeDir(d3);
});

test('migrations upgrade a database from the original starter project without losing data', async () => {
  const d4 = tempDir();
  const file = path.join(d4, 'test.sqlite');
  const old = new Database(file);
  old.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE COLLATE NOCASE NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN('participant','organizer')));
    CREATE TABLE communities(id INTEGER PRIMARY KEY,owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,category TEXT NOT NULL,description TEXT NOT NULL,story TEXT DEFAULT '',town TEXT NOT NULL,address TEXT DEFAULT '',latitude REAL NOT NULL,longitude REAL NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE memberships(user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,PRIMARY KEY(user_id,community_id));
    CREATE TABLE events(id INTEGER PRIMARY KEY,community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,name TEXT NOT NULL,event_date TEXT NOT NULL,event_time TEXT NOT NULL,venue TEXT NOT NULL,description TEXT DEFAULT '');
    CREATE TABLE event_registrations(user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,PRIMARY KEY(user_id,event_id));
    INSERT INTO users VALUES(1,'Old Org','old@example.com','hash','organizer');
    INSERT INTO communities(id,owner_id,name,category,description,town,latitude,longitude) VALUES(1,1,'Legacy Group','Social','From the old version','Middlesbrough',54.57,-1.23);`);
  old.close();
  const s = await startServer({ dir: d4, geocoderUrl: geo.url });
  try {
    const r = await client(s.base)('GET', '/api/communities');
    assert.equal(r.body.communities.length, 1, 'legacy data kept and no seed added on top');
    assert.equal(r.body.communities[0].name, 'Legacy Group');
    assert.equal(r.body.communities[0].image_url, '');
  } finally { await s.stop(); }
  const check = new Database(file);
  const cols = check.prepare('PRAGMA table_info(communities)').all().map(c => c.name);
  check.close(); // Windows cannot delete a file that is still open
  assert.ok(cols.includes('image_url') && cols.includes('status'));
  removeDir(d4);
});
