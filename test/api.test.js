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
const { startFakeGeocoder, startServer, client, tempDir, isoDate, PNG_1PX } = require('./helpers');

let geo, dir, srv, api;
const S = {}; // shared state between tests (they run in order)
const MBRO = { lat: 54.5742, lon: -1.2348 };

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
after(async () => { await srv?.stop(); await geo?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

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
  assert.deepEqual((await api('GET', '/api/participant/events', { token: t })).body.events.map(e => e.id), [S.eventId]);
  assert.equal((await api('GET', '/api/organizer/communities', { token: S.org })).status, 200, 'earlier token still valid after restart');
  assert.ok((await api('GET', '/api/events/public')).body.events.some(e => e.id === S.eventId));
  assert.ok(!srv.output.includes('Added 7 starter'), 'seed data is not re-inserted');
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
  } finally { await down.stop(); fs.rmSync(d2, { recursive: true, force: true }); }
});

test('a damaged database file is reported clearly and left untouched', async () => {
  const d3 = tempDir();
  const file = path.join(d3, 'test.sqlite');
  fs.writeFileSync(file, 'this is not a database'.repeat(100));
  const beforeBytes = fs.readFileSync(file);
  await assert.rejects(startServer({ dir: d3, geocoderUrl: geo.url }), /Could not open the database/);
  assert.ok(fs.readFileSync(file).equals(beforeBytes));
  fs.rmSync(d3, { recursive: true, force: true });
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
  const cols = new Database(file).prepare('PRAGMA table_info(communities)').all().map(c => c.name);
  assert.ok(cols.includes('image_url') && cols.includes('status'));
  fs.rmSync(d4, { recursive: true, force: true });
});
