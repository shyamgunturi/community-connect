'use strict';
/**
 * Express application: REST API + static frontend.
 * All SQL uses prepared statements with bound parameters.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const v = require('./validation');
const { createGeocoder, GeocodeUnavailableError } = require('./geocode');
const { securityHeaders, rateLimit } = require('./security');

const MILES_PER_DEGREE_LAT = 69.0;

function haversineMiles(aLat, aLon, bLat, bLon) {
  const r = d => d * Math.PI / 180;
  const dLat = r(bLat - aLat), dLon = r(bLon - aLon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.min(1, Math.sqrt(x)));
}

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function createApp({ db, config }) {
  const app = express();
  const geocoder = createGeocoder(config.geocoder);
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(securityHeaders);

  // Larger body limit only for image uploads; everything else is small JSON.
  const uploadJsonLimit = Math.ceil(config.maxUploadBytes * 1.37) + 16 * 1024;
  app.use('/api/uploads', express.json({ limit: uploadJsonLimit }));
  app.use(express.json({ limit: '100kb' }));

  // ---------- helpers ----------
  const q = {
    userById: db.prepare('SELECT id, name, email, role, created_at FROM users WHERE id = ?'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    insertUser: db.prepare("INSERT INTO users(name, email, password_hash, role, created_at) VALUES(?, ?, ?, ?, datetime('now'))"),
    communityById: db.prepare('SELECT * FROM communities WHERE id = ?'),
    eventById: db.prepare('SELECT * FROM events WHERE id = ?'),
    isMember: db.prepare('SELECT 1 FROM memberships WHERE user_id = ? AND community_id = ?'),
    isRegistered: db.prepare('SELECT 1 FROM event_registrations WHERE user_id = ? AND event_id = ?')
  };

  // Real bcrypt hash used when an email is unknown, so login timing is the same either way.
  const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(12).toString('hex'), config.bcryptRounds);
  const publicUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role });
  const signToken = u => jwt.sign({ sub: String(u.id), role: u.role }, config.jwtSecret, { expiresIn: config.jwtExpiresIn, algorithm: 'HS256' });

  function userFromRequest(req) {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return null;
    let payload;
    try { payload = jwt.verify(h.slice(7), config.jwtSecret, { algorithms: ['HS256'] }); }
    catch { throw new HttpError(401, 'Your session has expired or is invalid. Please log in again.'); }
    const user = q.userById.get(Number(payload.sub));
    if (!user) throw new HttpError(401, 'This account no longer exists. Please log in again.');
    return publicUser(user);
  }

  const requireAuth = (req, res, next) => {
    try {
      const user = userFromRequest(req);
      if (!user) return res.status(401).json({ error: 'Please log in to continue.' });
      req.user = user;
      next();
    } catch (e) { next(e); }
  };
  const optionalAuth = (req, res, next) => {
    try { req.user = userFromRequest(req); } catch { req.user = null; }
    next();
  };
  const requireRole = role => (req, res, next) => {
    if (req.user.role !== role) {
      const msg = role === 'organizer'
        ? 'Only organizer accounts can do this. Log in with an organizer account.'
        : 'Only participant accounts can join communities and register for events. Log in with a participant account.';
      return res.status(403).json({ error: msg, code: 'WRONG_ROLE' });
    }
    next();
  };

  const today = () => v.todayIso();
  const now = () => v.nowTime();
  const UPCOMING = '(e.event_date > ? OR (e.event_date = ? AND e.event_time >= ?))';

  const COMMUNITY_SELECT = `
    SELECT c.*, u.name AS organizer_name,
      (SELECT COUNT(*) FROM memberships m WHERE m.community_id = c.id) AS member_count,
      (SELECT COUNT(*) FROM events e WHERE e.community_id = c.id AND e.status = 'published' AND ${UPCOMING}) AS upcoming_event_count,
      EXISTS(SELECT 1 FROM memberships m WHERE m.community_id = c.id AND m.user_id = ?) AS joined
    FROM communities c JOIN users u ON u.id = c.owner_id`;

  function shapeCommunity(c, userId) {
    return {
      id: c.id, name: c.name, category: c.category, description: c.description, story: c.story || '',
      town: c.town, address: c.address || '', postcode: c.postcode || '',
      latitude: c.latitude, longitude: c.longitude, image_url: c.image_url || '',
      status: c.status, created_at: c.created_at, updated_at: c.updated_at,
      organizer_name: c.organizer_name, member_count: c.member_count ?? 0,
      upcoming_event_count: c.upcoming_event_count ?? 0, event_count: c.event_count,
      joined: !!c.joined, is_owner: userId != null && c.owner_id === userId,
      ...(c.distance_miles != null ? { distance_miles: Math.round(c.distance_miles * 10) / 10 } : {})
    };
  }
  const communityParams = uid => [today(), today(), now(), uid ?? -1];

  const EVENT_SELECT = `
    SELECT e.*, c.name AS community_name, c.town AS community_town, c.category AS community_category,
      c.image_url AS community_image_url, c.latitude AS community_latitude, c.longitude AS community_longitude,
      c.owner_id AS owner_id,
      (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.id) AS registration_count,
      EXISTS(SELECT 1 FROM event_registrations r WHERE r.event_id = e.id AND r.user_id = ?) AS registered,
      EXISTS(SELECT 1 FROM memberships m WHERE m.community_id = e.community_id AND m.user_id = ?) AS is_member
    FROM events e JOIN communities c ON c.id = e.community_id`;

  function shapeEvent(e, userId) {
    const isPast = e.event_date < today() || (e.event_date === today() && e.event_time < now());
    return {
      id: e.id, community_id: e.community_id, name: e.name, event_date: e.event_date, event_time: e.event_time,
      venue: e.venue, description: e.description || '', image_url: e.image_url || '', status: e.status, created_at: e.created_at,
      community_name: e.community_name, community_town: e.community_town, community_category: e.community_category,
      community_image_url: e.community_image_url || '',
      community_latitude: e.community_latitude, community_longitude: e.community_longitude,
      registration_count: e.registration_count ?? 0,
      registered: !!e.registered, is_member: !!e.is_member, is_owner: userId != null && e.owner_id === userId, is_past: isPast
    };
  }

  function loadCommunity(id, uid) {
    const c = db.prepare(`${COMMUNITY_SELECT} WHERE c.id = ?`).get(...communityParams(uid), id);
    if (!c) throw new HttpError(404, 'Community not found.');
    return c;
  }
  function loadEvent(id, uid) {
    const e = db.prepare(`${EVENT_SELECT} WHERE e.id = ?`).get(uid ?? -1, uid ?? -1, id);
    if (!e) throw new HttpError(404, 'Event not found.');
    return e;
  }

  async function resolveCommunityLocation(b, existing) {
    const coords = v.coordinates(b.latitude, b.longitude);
    if (coords) return coords;
    if (existing && existing.town === b.town && existing.postcode === b.postcode && existing.address === b.address) {
      return { lat: existing.latitude, lon: existing.longitude };
    }
    const attempts = [b.postcode, b.address && `${b.address}, ${b.town}`, b.town].filter(Boolean);
    for (const text of attempts) {
      try {
        const { results } = await geocoder.search(text, { mode: 'search' });
        if (results.length) return { lat: results[0].lat, lon: results[0].lon };
      } catch (e) {
        if (e instanceof GeocodeUnavailableError) throw new HttpError(503, 'We could not look up that location right now. Choose a suggestion or enter latitude and longitude.', { field: 'town' });
        throw e;
      }
    }
    throw new HttpError(400, 'We could not find that town or postcode in the UK. Choose a suggestion from the list or enter latitude and longitude.', { field: 'town' });
  }

  function communityInput(body) {
    const b = body || {};
    const out = {
      name: v.text(b.name, { field: 'name', label: 'Community name', min: 3, max: 100, required: true }),
      category: v.category(b.category),
      description: v.text(b.description, { field: 'description', label: 'Short description', min: 10, max: 500, required: true }),
      story: v.text(b.story, { field: 'story', label: 'Community story', max: 5000 }),
      town: v.text(b.town, { field: 'town', label: 'Town / area', min: 2, max: 100, required: true }),
      address: v.text(b.address, { field: 'address', label: 'Meeting location', max: 200 }),
      postcode: '',
      image_url: v.imageUrl(b.image_url),
      latitude: b.latitude, longitude: b.longitude
    };
    if (b.postcode) {
      out.postcode = v.normalisePostcode(b.postcode);
      if (!out.postcode) throw new v.ValidationError('Enter a valid UK postcode, or leave it blank.', 'postcode');
    }
    return out;
  }

  // ---------- health & meta ----------
  app.get('/api/health', (req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ status: 'ok', database: 'ok', time: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'error', database: 'unavailable' });
    }
  });
  app.get('/api/meta', (req, res) => res.json({ categories: v.CATEGORIES, maxUploadMb: config.maxUploadBytes / 1048576 }));

  // ---------- authentication ----------
  const authLimiter = rateLimit({ windowMs: 15 * 60e3, max: Number(process.env.AUTH_RATE_LIMIT) || 50, message: 'Too many sign-in attempts. Please wait a few minutes and try again.' });

  app.post('/api/auth/register', authLimiter, wrap(async (req, res) => {
    const b = req.body || {};
    const name = v.text(b.name, { field: 'name', label: 'Full name', min: 2, max: 80, required: true });
    const email = v.email(b.email);
    const password = v.password(b.password);
    const role = v.role(b.role);
    if (q.userByEmail.get(email)) throw new HttpError(409, 'An account with this email already exists. Please log in instead.', { field: 'email' });
    const hash = await bcrypt.hash(password, config.bcryptRounds);
    let result;
    try { result = q.insertUser.run(name, email, hash, role); }
    catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'An account with this email already exists. Please log in instead.', { field: 'email' });
      throw e;
    }
    const user = publicUser(q.userById.get(Number(result.lastInsertRowid)));
    res.status(201).json({ user, token: signToken(user) });
  }));

  app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.email || !b.password) throw new v.ValidationError('Enter your email address and password.', 'email');
    const row = q.userByEmail.get(String(b.email).trim().toLowerCase());
    // Always run a bcrypt comparison so response time does not reveal whether the email exists.
    const ok = await bcrypt.compare(String(b.password), row ? row.password_hash : DUMMY_HASH);
    if (!row || !ok) throw new HttpError(401, 'Email or password is incorrect.');
    if (b.role && v.ROLES.includes(b.role) && b.role !== row.role) {
      throw new HttpError(403, `This is ${row.role === 'organizer' ? 'an organizer' : 'a participant'} account. Please use a ${b.role} account here.`, { code: 'WRONG_ROLE' });
    }
    const user = publicUser(row);
    res.json({ user, token: signToken(user) });
  }));

  app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

  // ---------- location search ----------
  const geoLimiter = rateLimit({ windowMs: 60e3, max: 90, message: 'Too many location searches. Please slow down.' });
  app.get('/api/locations/search', geoLimiter, wrap(async (req, res) => {
    const mode = req.query.mode === 'search' ? 'search' : 'suggest';
    const text = String(req.query.q || '');
    if (text.trim().length > 80) throw new v.ValidationError('Search text is too long.', 'q');
    const data = await geocoder.search(text, { mode });
    res.set('Cache-Control', 'private, max-age=300');
    res.json(data);
  }));

  // ---------- communities (public discovery) ----------
  app.get('/api/communities', optionalAuth, (req, res) => {
    const uid = req.user?.id;
    const where = ["c.status = 'published'"];
    const params = [];
    const cat = req.query.category;
    if (cat && cat !== 'all') { v.category(cat); where.push('c.category = ?'); params.push(cat); }
    const search = String(req.query.q || '').trim();
    if (search) {
      if (search.length > 80) throw new v.ValidationError('Search text is too long.', 'q');
      where.push("(c.name LIKE ? ESCAPE '\\' OR c.town LIKE ? ESCAPE '\\' OR c.description LIKE ? ESCAPE '\\')");
      const like = `%${search.replace(/[\\%_]/g, m => '\\' + m)}%`;
      params.push(like, like, like);
    }
    const origin = v.coordinates(req.query.lat, req.query.lon, { requireUk: false });
    let radius = null;
    if (origin) {
      radius = req.query.radius === undefined || req.query.radius === '' ? 10 : Number(req.query.radius);
      if (!Number.isFinite(radius) || radius < 1 || radius > 50) throw new v.ValidationError('Distance must be between 1 and 50 miles.', 'radius');
      const dLat = radius / MILES_PER_DEGREE_LAT;
      const dLon = radius / (MILES_PER_DEGREE_LAT * Math.max(Math.cos(origin.lat * Math.PI / 180), 0.01));
      where.push('c.latitude BETWEEN ? AND ? AND c.longitude BETWEEN ? AND ?');
      params.push(origin.lat - dLat, origin.lat + dLat, origin.lon - dLon, origin.lon + dLon);
    }
    let rows = db.prepare(`${COMMUNITY_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC, c.id DESC LIMIT 500`)
      .all(...communityParams(uid), ...params);
    if (origin) {
      rows = rows
        .map(c => ({ ...c, distance_miles: haversineMiles(origin.lat, origin.lon, c.latitude, c.longitude) }))
        .filter(c => c.distance_miles <= radius)
        .sort((a, b) => a.distance_miles - b.distance_miles || a.name.localeCompare(b.name));
    }
    res.json({
      communities: rows.map(c => shapeCommunity(c, uid)),
      count: rows.length,
      ...(origin ? { origin, radius } : {})
    });
  });

  app.get('/api/communities/:id', optionalAuth, (req, res) => {
    const id = v.id(req.params.id, 'community ID');
    const uid = req.user?.id;
    const c = loadCommunity(id, uid);
    if (c.status !== 'published' && c.owner_id !== uid) throw new HttpError(404, 'Community not found.');
    const events = db.prepare(`${EVENT_SELECT} WHERE e.community_id = ? AND e.status = 'published' AND ${UPCOMING} ORDER BY e.event_date, e.event_time`)
      .all(uid ?? -1, uid ?? -1, id, today(), today(), now());
    res.json({ community: shapeCommunity(c, uid), events: events.map(e => shapeEvent(e, uid)) });
  });

  // ---------- communities (organizer management) ----------
  app.post('/api/communities', requireAuth, requireRole('organizer'), wrap(async (req, res) => {
    const b = communityInput(req.body);
    const dup = db.prepare('SELECT id FROM communities WHERE owner_id = ? AND name = ? COLLATE NOCASE').get(req.user.id, b.name);
    if (dup) throw new HttpError(409, 'You already have a community with this name.', { field: 'name' });
    const loc = await resolveCommunityLocation(b);
    const r = db.prepare(`INSERT INTO communities(owner_id, name, category, description, story, town, address, postcode, latitude, longitude, image_url, status, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', datetime('now'), datetime('now'))`)
      .run(req.user.id, b.name, b.category, b.description, b.story, b.town, b.address, b.postcode, loc.lat, loc.lon, b.image_url);
    res.status(201).json({ community: shapeCommunity(loadCommunity(Number(r.lastInsertRowid), req.user.id), req.user.id), message: 'Community published.' });
  }));

  function requireOwnedCommunity(id, user) {
    const c = q.communityById.get(id);
    if (!c) throw new HttpError(404, 'Community not found.');
    if (c.owner_id !== user.id) throw new HttpError(403, 'You can only manage communities you created.');
    return c;
  }

  app.put('/api/communities/:id', requireAuth, requireRole('organizer'), wrap(async (req, res) => {
    const id = v.id(req.params.id, 'community ID');
    const existing = requireOwnedCommunity(id, req.user);
    const b = communityInput(req.body);
    const dup = db.prepare('SELECT id FROM communities WHERE owner_id = ? AND name = ? COLLATE NOCASE AND id != ?').get(req.user.id, b.name, id);
    if (dup) throw new HttpError(409, 'You already have a community with this name.', { field: 'name' });
    const loc = await resolveCommunityLocation(b, existing);
    db.prepare(`UPDATE communities SET name = ?, category = ?, description = ?, story = ?, town = ?, address = ?, postcode = ?,
      latitude = ?, longitude = ?, image_url = ?, updated_at = datetime('now') WHERE id = ? AND owner_id = ?`)
      .run(b.name, b.category, b.description, b.story, b.town, b.address, b.postcode, loc.lat, loc.lon, b.image_url, id, req.user.id);
    res.json({ community: shapeCommunity(loadCommunity(id, req.user.id), req.user.id), message: 'Community updated.' });
  }));

  app.delete('/api/communities/:id', requireAuth, requireRole('organizer'), (req, res) => {
    const id = v.id(req.params.id, 'community ID');
    requireOwnedCommunity(id, req.user);
    // Foreign keys with ON DELETE CASCADE remove its events, memberships and registrations.
    db.prepare('DELETE FROM communities WHERE id = ? AND owner_id = ?').run(id, req.user.id);
    res.json({ message: 'Community deleted.' });
  });

  // ---------- membership ----------
  app.post('/api/communities/:id/join', requireAuth, requireRole('participant'), (req, res) => {
    const id = v.id(req.params.id, 'community ID');
    const c = q.communityById.get(id);
    if (!c || c.status !== 'published') throw new HttpError(404, 'Community not found.');
    const r = db.prepare("INSERT OR IGNORE INTO memberships(user_id, community_id, joined_at) VALUES(?, ?, datetime('now'))").run(req.user.id, id);
    const already = r.changes === 0;
    res.status(already ? 200 : 201).json({ joined: true, already_member: already, message: already ? 'You are already a member of this community.' : `You joined ${c.name}.` });
  });

  app.delete('/api/communities/:id/join', requireAuth, requireRole('participant'), (req, res) => {
    const id = v.id(req.params.id, 'community ID');
    if (!q.communityById.get(id)) throw new HttpError(404, 'Community not found.');
    const leave = db.transaction(() => {
      db.prepare('DELETE FROM event_registrations WHERE user_id = ? AND event_id IN (SELECT id FROM events WHERE community_id = ?)').run(req.user.id, id);
      return db.prepare('DELETE FROM memberships WHERE user_id = ? AND community_id = ?').run(req.user.id, id).changes;
    });
    const changes = leave();
    if (!changes) throw new HttpError(404, 'You are not a member of this community.');
    res.json({ joined: false, message: 'You left the community. Your registrations for its events were cancelled.' });
  });

  // ---------- events ----------
  function publicEvents(req, res) {
    const uid = req.user?.id;
    const where = [`e.status = 'published'`, `c.status = 'published'`, UPCOMING];
    const params = [today(), today(), now()];
    if (req.query.community_id) { where.push('e.community_id = ?'); params.push(v.id(req.query.community_id, 'community ID')); }
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
    const rows = db.prepare(`${EVENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY e.event_date, e.event_time, e.id LIMIT ${limit}`)
      .all(uid ?? -1, uid ?? -1, ...params);
    res.json({ events: rows.map(e => shapeEvent(e, uid)), count: rows.length });
  }
  app.get('/api/events/public', optionalAuth, publicEvents);
  app.get('/api/events', optionalAuth, publicEvents); // kept for backwards compatibility

  app.get('/api/events/:id', optionalAuth, (req, res) => {
    const id = v.id(req.params.id, 'event ID');
    const uid = req.user?.id;
    const e = loadEvent(id, uid);
    if (e.status !== 'published' && e.owner_id !== uid) throw new HttpError(404, 'Event not found.');
    res.json({ event: shapeEvent(e, uid) });
  });

  app.post('/api/events', requireAuth, requireRole('organizer'), (req, res) => {
    const b = req.body || {};
    if (b.community_id === undefined || b.community_id === null || b.community_id === '') throw new v.ValidationError('Choose one of your communities.', 'community_id');
    const communityId = v.id(b.community_id, 'community ID');
    const c = requireOwnedCommunity(communityId, req.user);
    const name = v.text(b.name, { field: 'name', label: 'Event name', min: 3, max: 100, required: true });
    const date = v.eventDate(b.event_date);
    const time = v.eventTime(b.event_time, date);
    const venue = v.text(b.venue, { field: 'venue', label: 'Venue', min: 2, max: 150, required: true });
    const description = v.text(b.description, { field: 'description', label: 'Event details', max: 2000 });
    const image = v.imageUrl(b.image_url);
    const dup = db.prepare('SELECT id FROM events WHERE community_id = ? AND name = ? COLLATE NOCASE AND event_date = ? AND event_time = ?').get(c.id, name, date, time);
    if (dup) throw new HttpError(409, 'This event has already been published.', { field: 'name' });
    const r = db.prepare(`INSERT INTO events(community_id, name, event_date, event_time, venue, description, image_url, status, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, 'published', datetime('now'))`).run(c.id, name, date, time, venue, description, image);
    res.status(201).json({ event: shapeEvent(loadEvent(Number(r.lastInsertRowid), req.user.id), req.user.id), message: 'Event published.' });
  });

  app.delete('/api/events/:id', requireAuth, requireRole('organizer'), (req, res) => {
    const id = v.id(req.params.id, 'event ID');
    const e = q.eventById.get(id);
    if (!e) throw new HttpError(404, 'Event not found.');
    requireOwnedCommunity(e.community_id, req.user);
    db.prepare('DELETE FROM events WHERE id = ?').run(id);
    res.json({ message: 'Event deleted.' });
  });

  app.post('/api/events/:id/register', requireAuth, requireRole('participant'), (req, res) => {
    const id = v.id(req.params.id, 'event ID');
    const e = loadEvent(id, req.user.id);
    const shaped = shapeEvent(e, req.user.id);
    if (e.status !== 'published') throw new HttpError(404, 'Event not found.');
    if (shaped.is_past) throw new HttpError(400, 'This event has already taken place.');
    if (!q.isMember.get(req.user.id, e.community_id)) {
      throw new HttpError(403, `Join ${e.community_name} before registering for its events.`, { code: 'MEMBERSHIP_REQUIRED', community_id: e.community_id });
    }
    const r = db.prepare("INSERT OR IGNORE INTO event_registrations(user_id, event_id, registered_at) VALUES(?, ?, datetime('now'))").run(req.user.id, id);
    const already = r.changes === 0;
    res.status(already ? 200 : 201).json({
      registered: true, already_registered: already,
      message: already ? 'You are already registered for this event.' : `You're registered for ${e.name}.`,
      event: shapeEvent(loadEvent(id, req.user.id), req.user.id)
    });
  });

  app.delete('/api/events/:id/register', requireAuth, requireRole('participant'), (req, res) => {
    const id = v.id(req.params.id, 'event ID');
    if (!q.eventById.get(id)) throw new HttpError(404, 'Event not found.');
    const r = db.prepare('DELETE FROM event_registrations WHERE user_id = ? AND event_id = ?').run(req.user.id, id);
    if (!r.changes) throw new HttpError(404, 'You are not registered for this event.');
    res.json({ registered: false, message: 'Your registration was cancelled.' });
  });

  // ---------- dashboards ----------
  app.get('/api/organizer/communities', requireAuth, requireRole('organizer'), (req, res) => {
    const rows = db.prepare(`SELECT x.*, (SELECT COUNT(*) FROM events e WHERE e.community_id = x.id) AS event_count FROM (${COMMUNITY_SELECT} WHERE c.owner_id = ?) x ORDER BY x.created_at DESC, x.id DESC`)
      .all(...communityParams(req.user.id), req.user.id);
    res.json({ communities: rows.map(c => shapeCommunity(c, req.user.id)) });
  });

  app.get('/api/organizer/events', requireAuth, requireRole('organizer'), (req, res) => {
    const rows = db.prepare(`${EVENT_SELECT} WHERE c.owner_id = ? ORDER BY e.event_date, e.event_time`).all(-1, -1, req.user.id);
    res.json({ events: rows.map(e => shapeEvent(e, req.user.id)) });
  });

  app.get('/api/participant/communities', requireAuth, requireRole('participant'), (req, res) => {
    const rows = db.prepare(`${COMMUNITY_SELECT} JOIN memberships mm ON mm.community_id = c.id AND mm.user_id = ? ORDER BY mm.joined_at DESC`)
      .all(...communityParams(req.user.id), req.user.id);
    res.json({ communities: rows.map(c => shapeCommunity(c, req.user.id)) });
  });

  app.get('/api/participant/events', requireAuth, requireRole('participant'), (req, res) => {
    const rows = db.prepare(`${EVENT_SELECT} JOIN event_registrations rr ON rr.event_id = e.id AND rr.user_id = ? ORDER BY e.event_date, e.event_time`)
      .all(req.user.id, req.user.id, req.user.id);
    const events = rows.map(e => shapeEvent(e, req.user.id));
    // Upcoming first (soonest first), then past events (most recent first).
    events.sort((a, b) => (a.is_past - b.is_past) || (a.is_past ? (b.event_date + b.event_time).localeCompare(a.event_date + a.event_time) : 0));
    res.json({ events });
  });

  // ---------- image uploads ----------
  const SIGNATURES = {
    jpg: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    png: b => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    gif: b => b.slice(0, 4).toString('ascii') === 'GIF8',
    webp: b => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP'
  };
  app.post('/api/uploads', requireAuth, requireRole('organizer'), (req, res) => {
    const data = String((req.body || {}).image || '');
    const m = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/.exec(data);
    if (!m) throw new v.ValidationError('Upload a JPG, PNG, WebP or GIF image.', 'image');
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length) throw new v.ValidationError('The image file is empty.', 'image');
    if (buf.length > config.maxUploadBytes) throw new HttpError(413, `Images must be ${config.maxUploadBytes / 1048576} MB or smaller.`);
    const ext = Object.keys(SIGNATURES).find(k => SIGNATURES[k](buf));
    if (!ext) throw new v.ValidationError('That file is not a valid JPG, PNG, WebP or GIF image.', 'image');
    const file = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(config.uploadDir, file), buf);
    res.status(201).json({ url: `/uploads/${file}`, bytes: buf.length });
  });

  // ---------- static files ----------
  app.use('/uploads', express.static(config.uploadDir, { maxAge: '7d', index: false }));
  app.use(express.static(config.publicDir, { extensions: ['html'] }));

  // Unknown API routes return JSON; other paths fall back to the homepage.
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API route not found.' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(404).json({ error: 'Not found.' });
    res.sendFile(path.join(config.publicDir, 'index.html'));
  });

  // ---------- error handler ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof v.ValidationError) return res.status(400).json({ error: err.message, field: err.field });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err instanceof GeocodeUnavailableError) return res.status(503).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large. Images must be 4 MB or smaller.' });
    if (String(err.code || '').startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ error: 'That change conflicts with existing data.' });
    }
    console.error('[error]', req.method, req.path, err);
    res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
  });

  return app;
}

module.exports = { createApp, haversineMiles };
