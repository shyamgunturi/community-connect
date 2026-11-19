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
const { refreshDemoExtras, ensureFees } = require('./db');

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
  app.use('/api', (req, res, next) => { try { releaseExpiredHolds(); } catch (e) { console.error(e); } next(); });

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
  const signToken = u => u.role === 'admin'
    ? jwt.sign({ sub: String(-u.id), role: 'admin', adm: true }, config.jwtSecret, { expiresIn: '12h', algorithm: 'HS256' })
    : jwt.sign({ sub: String(u.id), role: u.role }, config.jwtSecret, { expiresIn: config.jwtExpiresIn, algorithm: 'HS256' });
  // Platform admins live in their own table. Their id is negative in the app so it can never match a user id.
  const adminById = db.prepare("SELECT id, name, email, 'admin' AS role FROM admins WHERE id = ?");
  const adminByEmail = db.prepare('SELECT * FROM admins WHERE email = ?');
  const adminUser = a => ({ id: -a.id, name: a.name, email: a.email, role: 'admin' });

  function userFromRequest(req) {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return null;
    let payload;
    try { payload = jwt.verify(h.slice(7), config.jwtSecret, { algorithms: ['HS256'] }); }
    catch { throw new HttpError(401, 'Your session has expired or is invalid. Please log in again.'); }
    if (payload.adm) {
      const a = adminById.get(Number(payload.sub));
      if (!a) throw new HttpError(401, 'This account no longer exists. Please log in again.');
      return adminUser(a);
    }
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
      const msg = role === 'admin' ? 'Only the platform admin can see this.' : role === 'organizer'
        ? 'Only organizer accounts can do this. Log in with an organizer account.'
        : 'Only participant accounts can join communities and register for events. Log in with a participant account.';
      return res.status(403).json({ error: msg, code: 'WRONG_ROLE' });
    }
    next();
  };

  const money = pence => `£${((pence || 0) / 100).toFixed(2).replace(/\.00$/, '')}`;
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

  // A "pending" registration is a place held while someone pays (expires after config.payments.holdMinutes).
  // Pending rows hold a place (capacity) but don't count as registered, attended or revenue until paid.
  const BOOKED = "r.payment_status IN ('free', 'paid')"; // refunded tickets (cancelled events) and unpaid holds don't count
  const EVENT_SELECT = `
    SELECT e.*, c.name AS community_name, c.town AS community_town, c.category AS community_category,
      c.image_url AS community_image_url, c.latitude AS community_latitude, c.longitude AS community_longitude,
      c.owner_id AS owner_id,
      (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.id AND ${BOOKED}) AS registration_count,
      (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.id) AS held_count,
      (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.id AND r.ticket_type = 'early_bird') AS early_sold,
      (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.id AND r.attended = 1 AND ${BOOKED}) AS attended_count,
      (SELECT COALESCE(SUM(r.amount_pence), 0) FROM event_registrations r WHERE r.event_id = e.id AND r.payment_status = 'paid') AS revenue_pence,
      (SELECT ROUND(AVG(f.rating), 1) FROM event_feedback f WHERE f.event_id = e.id) AS avg_rating,
      (SELECT COUNT(*) FROM event_feedback f WHERE f.event_id = e.id) AS rating_count,
      (SELECT COUNT(*) FROM event_promo_codes p WHERE p.event_id = e.id) AS promo_count,
      (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.id AND ${BOOKED} AND r.registered_at > datetime('now', '-2 days')) AS recent_bookings,
      (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.id AND r.checked_in_by IS NOT NULL) AS checked_in_count,
      (SELECT COUNT(*) FROM event_waitlist w WHERE w.event_id = e.id AND w.status = 'waiting') AS waitlist_count,
      (SELECT COUNT(*) FROM event_waitlist w WHERE w.event_id = e.id AND w.status = 'offered') AS offered_count,
      EXISTS(SELECT 1 FROM event_registrations r WHERE r.event_id = e.id AND r.user_id = ? AND r.payment_status != 'pending') AS registered,
      EXISTS(SELECT 1 FROM memberships m WHERE m.community_id = e.community_id AND m.user_id = ?) AS is_member,
      (SELECT r.attended FROM event_registrations r WHERE r.event_id = e.id AND r.user_id = ?) AS my_attended,
      (SELECT f.rating FROM event_feedback f WHERE f.event_id = e.id AND f.user_id = ?) AS my_rating,
      (SELECT r.payment_status || '|' || COALESCE(r.ticket_type, '') || '|' || r.amount_pence || '|' || COALESCE(r.payment_ref, '') || '|' ||
         COALESCE(r.ticket_code, '') || '|' || COALESCE(r.referral_code, '') || '|' || COALESCE(r.checked_in_by, '') || '|' || COALESCE(r.checked_in_at, '')
         FROM event_registrations r WHERE r.event_id = e.id AND r.user_id = ?) AS my_ticket,
      (SELECT w.status || '|' || COALESCE(w.offered_at, '') || '|' ||
         (SELECT COUNT(*) FROM event_waitlist w2 WHERE w2.event_id = w.event_id AND w2.status = 'waiting' AND w2.created_at <= w.created_at)
         FROM event_waitlist w WHERE w.event_id = e.id AND w.user_id = ?) AS my_waitlist
    FROM events e JOIN communities c ON c.id = e.community_id`;
  const eventParams = uid => [uid ?? -1, uid ?? -1, uid ?? -1, uid ?? -1, uid ?? -1, uid ?? -1];
  const WAITLIST_OFFER_HOURS = 2;
  const CHECKIN_OPENS_HOURS = 36; // QR check-in and attendance open this long before the start ("doors open")
  const REFERRAL_PERCENT = 10;

  /** Removes unpaid holds older than the payment window. Runs at most every 20 seconds. */
  let lastCleanup = 0;
  function releaseExpiredHolds() {
    if (Date.now() - lastCleanup < 20000) return;
    lastCleanup = Date.now();
    const cutoff = `-${config.payments.holdMinutes} minutes`;
    const freed = db.prepare(`SELECT DISTINCT event_id FROM event_registrations WHERE payment_status = 'pending' AND registered_at < datetime('now', ?)`).all(cutoff).map(r => r.event_id);
    db.prepare(`DELETE FROM event_registrations WHERE payment_status = 'pending' AND registered_at < datetime('now', ?)`).run(cutoff);
    const lapsed = db.prepare(`SELECT DISTINCT event_id FROM event_waitlist WHERE status = 'offered' AND offered_at < datetime('now', ?)`).all(`-${WAITLIST_OFFER_HOURS} hours`).map(r => r.event_id);
    new Set([...freed, ...lapsed]).forEach(processWaitlist);
    if (config.seedDemoData) refreshDemoExtras(db, config.platformFeePercent);
  }

  // ---------- notifications ----------
  const insertNotification = db.prepare("INSERT INTO notifications(user_id, type, title, body, link, created_at) VALUES(?, ?, ?, ?, ?, datetime('now'))");
  function notify(userId, type, title, body = '', link = '') {
    try { insertNotification.run(userId, type, String(title).slice(0, 140), String(body).slice(0, 400), link); } catch (err) { console.error('[notify]', err.message); }
  }
  function notifyMembers(communityId, type, title, body, link, exceptUserId) {
    const ids = db.prepare('SELECT user_id FROM memberships WHERE community_id = ? AND user_id != ? LIMIT 1000').all(communityId, exceptUserId ?? -1);
    db.transaction(() => ids.forEach(r => notify(r.user_id, type, title, body, link)))();
    return ids.length;
  }

  // ---------- waitlist ----------
  /**
   * When places free up on a full event, offer them to the people at the front of the waitlist (first come, first served).
   * An offer holds the place for WAITLIST_OFFER_HOURS; if it is not taken it passes to the next person.
   */
  function processWaitlist(eventId) {
    db.transaction(() => {
      db.prepare(`DELETE FROM event_waitlist WHERE event_id = ? AND status = 'offered' AND offered_at < datetime('now', ?)`).run(eventId, `-${WAITLIST_OFFER_HOURS} hours`);
      const e = db.prepare('SELECT id, name, capacity, event_date, event_time FROM events WHERE id = ?').get(eventId);
      if (!e || `${e.event_date}T${e.event_time}` <= `${today()}T${now()}`) return;
      const taken = db.prepare('SELECT COUNT(*) AS n FROM event_registrations WHERE event_id = ?').get(eventId).n +
        db.prepare("SELECT COUNT(*) AS n FROM event_waitlist WHERE event_id = ? AND status = 'offered'").get(eventId).n;
      let free = e.capacity ? e.capacity - taken : Infinity;
      const next = db.prepare("SELECT user_id FROM event_waitlist WHERE event_id = ? AND status = 'waiting' ORDER BY created_at, rowid LIMIT ?")
        .all(eventId, Number.isFinite(free) ? Math.max(0, free) : 1000);
      for (const w of next) {
        if (free <= 0) break;
        db.prepare("UPDATE event_waitlist SET status = 'offered', offered_at = datetime('now') WHERE user_id = ? AND event_id = ?").run(w.user_id, eventId);
        notify(w.user_id, 'waitlist_offer', `A place opened up: ${e.name}`, `You're next on the waitlist. Book within ${WAITLIST_OFFER_HOURS} hours to keep it.`, `/event.html?id=${eventId}`);
        free--;
      }
    })();
  }

  /**
   * Ticket price right now for an event row (from EVENT_SELECT): early bird while the offer is open and
   * early-bird tickets remain, otherwise standard. An optional promo code takes a percentage off.
   */
  const flashActive = e => !!e.flash_percent && !!e.flash_until && `${today()}T${now()}` < e.flash_until && `${today()}T${now()}` < `${e.event_date}T${e.event_time}`;

  function pricing(e, promoInput, userId, referralInput) {
    const standard = e.price_pence || 0;
    const nowLocal = `${today()}T${now()}`;
    const earlyOn = e.early_price_pence != null && !!e.early_until && nowLocal < e.early_until &&
      (!e.early_limit || (e.early_sold || 0) < e.early_limit);
    // Cheapest live offer wins: flash sale, early bird or standard.
    const offers = [['standard', standard]];
    if (standard && earlyOn) offers.push(['early_bird', e.early_price_pence]);
    if (standard && flashActive(e)) offers.push(['flash_sale', Math.round(standard * (100 - e.flash_percent) / 100)]);
    offers.sort((a, b) => a[1] - b[1]);
    const ticketType = !standard ? 'free' : offers[0][0];
    const list = offers[0][1];
    let discount = 0, promo = null, referral = null;
    const code = String(promoInput || '').trim();
    if (code) {
      if (!standard) throw new v.ValidationError('This event is free, so no promo code is needed.', 'promo_code');
      const row = db.prepare('SELECT * FROM event_promo_codes WHERE event_id = ? AND code = ?').get(e.id, code.toUpperCase());
      if (!row) throw new v.ValidationError("That promo code isn't valid for this event.", 'promo_code');
      const used = db.prepare('SELECT COUNT(*) AS n FROM event_registrations WHERE event_id = ? AND promo_code = ? AND user_id != ?').get(e.id, row.code, userId ?? -1).n;
      if (row.max_uses && used >= row.max_uses) throw new v.ValidationError('This promo code has been fully used.', 'promo_code');
      discount = Math.round(list * row.percent_off / 100);
      promo = { code: row.code, percent_off: row.percent_off };
    }
    // "Bring a friend": a ticket holder's referral link gives 10% off (not combined with promo codes).
    const refCode = String(referralInput || '').trim().toLowerCase();
    if (!promo && standard && /^[a-f0-9]{8}$/.test(refCode)) {
      const ref = db.prepare(`SELECT r.user_id, u.name FROM event_registrations r JOIN users u ON u.id = r.user_id
        WHERE r.event_id = ? AND r.referral_code = ? AND r.payment_status IN ('free', 'paid')`).get(e.id, refCode);
      if (ref && ref.user_id !== userId) {
        discount = Math.round(list * REFERRAL_PERCENT / 100);
        referral = { code: refCode, percent_off: REFERRAL_PERCENT, by_user_id: ref.user_id, by_name: ref.name.split(' ')[0] };
      }
    }
    return { ticket_type: ticketType, standard_price_pence: standard, list_price_pence: list, discount_pence: discount, amount_pence: list - discount, promo, referral };
  }

  /** Status badges used for promotion on cards and the event page. */
  function badgesFor(e, x) {
    const b = [];
    if (x.is_past || x.is_cancelled) return b;
    if (e.featured) b.push('featured');
    if (x.flash_active) b.push('flash_sale');
    if (x.is_full) b.push('sold_out');
    else if (x.spots_left != null && x.spots_left <= 5) b.push('few_left');
    if (!x.is_full && ((e.recent_bookings || 0) >= 5 || (e.capacity && (e.held_count || 0) / e.capacity >= 0.7))) b.push('selling_fast');
    if (e.created_at && (Date.now() - new Date(`${String(e.created_at).replace(' ', 'T')}Z`).getTime()) < 3 * 86400e3) b.push('new');
    return b;
  }

  function shapeEventBase(e, userId) {
    const isPast = e.event_date < today() || (e.event_date === today() && e.event_time < now());
    const held = (e.held_count ?? e.registration_count ?? 0) + (e.offered_count || 0);
    const price = pricing(e);
    const [myStatus, myType, myAmount, myRef, myCode, myReferral, myCheckedBy, myCheckedAt] = String(e.my_ticket || '').split('|');
    const [wStatus, wOfferedAt, wPos] = String(e.my_waitlist || '').split('|');
    const earlyLeft = e.early_limit ? Math.max(0, e.early_limit - (e.early_sold || 0)) : null;
    return {
      id: e.id, community_id: e.community_id, name: e.name, event_date: e.event_date, event_time: e.event_time,
      starts_at: `${e.event_date}T${e.event_time}`,
      venue: e.venue, description: e.description || '', image_url: e.image_url || '', status: e.status, created_at: e.created_at,
      community_name: e.community_name, community_town: e.community_town, community_category: e.community_category,
      community_image_url: e.community_image_url || '',
      community_latitude: e.community_latitude, community_longitude: e.community_longitude,
      registration_count: e.registration_count ?? 0,
      price_pence: e.price_pence ?? 0, capacity: e.capacity ?? null,
      spots_left: e.capacity ? Math.max(0, e.capacity - held) : null,
      is_full: !!e.capacity && held >= e.capacity,
      // Ticket tiers
      early_price_pence: e.early_price_pence ?? null, early_until: e.early_until || null, early_limit: e.early_limit ?? null,
      early_left: earlyLeft, early_active: price.ticket_type === 'early_bird',
      current_price_pence: price.list_price_pence, ticket_type_now: price.ticket_type, has_promo_codes: (e.promo_count || 0) > 0,
      payment_mode: config.payments.mode,
      is_cancelled: e.status === 'cancelled', cancel_reason: e.cancel_reason || '', cancelled_at: e.cancelled_at || null,
      featured: !!e.featured, flash_percent: e.flash_percent ?? null, flash_until: e.flash_until || null, flash_active: flashActive(e),
      waitlist_count: e.waitlist_count || 0,
      my_waitlist: wStatus ? { status: wStatus, position: Number(wPos) || null,
        offer_expires_at: wStatus === 'offered' && wOfferedAt ? new Date(new Date(`${wOfferedAt.replace(' ', 'T')}Z`).getTime() + WAITLIST_OFFER_HOURS * 3600e3).toISOString() : null } : null,
      checkin_open: Date.now() >= new Date(`${e.event_date}T${e.event_time}:00`).getTime() - CHECKIN_OPENS_HOURS * 3600e3,
      avg_rating: e.avg_rating ?? null, rating_count: e.rating_count ?? 0,
      registered: !!e.registered, is_member: !!e.is_member, is_owner: userId != null && e.owner_id === userId, is_past: isPast,
      has_started: e.event_date < today() || (e.event_date === today() && e.event_time <= now()),
      attended: e.my_attended === 1, my_rating: e.my_rating ?? null,
      my_ticket: myStatus ? { payment_status: myStatus, ticket_type: myType || null, amount_pence: Number(myAmount) || 0, payment_ref: myStatus === 'pending' ? myRef : undefined,
        ticket_code: ['free', 'paid'].includes(myStatus) ? myCode || null : undefined, referral_code: ['free', 'paid'].includes(myStatus) ? myReferral || null : undefined,
        checked_in: !!myCheckedBy || e.my_attended === 1, checked_in_at: myCheckedAt || null } : null,
      // Organizer-only figures
      ...(userId != null && e.owner_id === userId ? { attended_count: e.attended_count ?? 0, revenue_pence: e.revenue_pence ?? 0, early_sold: e.early_sold ?? 0, promo_count: e.promo_count ?? 0, checked_in_count: e.checked_in_count ?? 0 } : {})
    };
  }
  const shapeEvent = (e, userId) => shapeEventWithBadges(e, userId);
  function shapeEventWithBadges(e, userId) {
    const x = shapeEventBase(e, userId);
    x.badges = badgesFor(e, x);
    return x;
  }

  function loadCommunity(id, uid) {
    const c = db.prepare(`${COMMUNITY_SELECT} WHERE c.id = ?`).get(...communityParams(uid), id);
    if (!c) throw new HttpError(404, 'Community not found.');
    return c;
  }
  function loadEvent(id, uid) {
    const e = db.prepare(`${EVENT_SELECT} WHERE e.id = ?`).get(...eventParams(uid), id);
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
    if (q.userByEmail.get(email) || adminByEmail.get(email)) throw new HttpError(409, 'An account with this email already exists. Please log in instead.', { field: 'email' });
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
    const emailIn = String(b.email).trim().toLowerCase();
    const row = q.userByEmail.get(emailIn);
    const admin = row ? null : adminByEmail.get(emailIn);
    // Always run a bcrypt comparison so response time does not reveal whether the email exists.
    const ok = await bcrypt.compare(String(b.password), row ? row.password_hash : admin ? admin.password_hash : DUMMY_HASH);
    if (admin && ok) { const user = adminUser(admin); return res.json({ user, token: signToken(user) }); }
    if (!row || !ok) throw new HttpError(401, 'Email or password is incorrect.');
    if (b.role && v.ROLES.includes(b.role) && b.role !== row.role) {
      throw new HttpError(403, `This is ${row.role === 'organizer' ? 'an organizer' : 'a participant'} account. Please use a ${b.role} account here.`, { code: 'WRONG_ROLE' });
    }
    const user = publicUser(row);
    res.json({ user, token: signToken(user) });
  }));

  app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

  // ---------- Continue with Google ----------
  /** Public settings the browser needs (only the Google *client* id — never a secret). */
  app.get('/api/auth/config', (req, res) => res.json({ google_client_id: config.googleClientId || null, platform_fee_percent: config.platformFeePercent }));

  /**
   * Google Identity Services sends us an ID token (a signed JWT). We ask Google's tokeninfo endpoint to verify it,
   * then check it was issued for OUR client id and that the email is verified. New emails get an account
   * (participant unless the person chose organizer); existing accounts are logged in and linked to Google.
   */
  app.post('/api/auth/google', authLimiter, wrap(async (req, res) => {
    if (!config.googleClientId) throw new HttpError(400, 'Google sign-in is not set up on this server.', { code: 'GOOGLE_DISABLED' });
    const credential = String((req.body || {}).credential || '');
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(credential) || credential.length > 4096) throw new v.ValidationError('Invalid Google sign-in response.', 'credential');
    let info;
    try {
      const r = await fetch(`${config.googleTokenInfoUrl}?id_token=${encodeURIComponent(credential)}`, { signal: AbortSignal.timeout(8000) });
      info = r.ok ? await r.json() : null;
    } catch { throw new HttpError(502, 'Google could not be reached. Please try again or use your email and password.'); }
    const verified = info && (info.email_verified === true || info.email_verified === 'true');
    const issuerOk = info && ['accounts.google.com', 'https://accounts.google.com'].includes(info.iss);
    if (!info || info.aud !== config.googleClientId || !issuerOk || !verified || !info.sub || Number(info.exp) * 1000 < Date.now()) {
      throw new HttpError(401, 'Google sign-in could not be verified. Please try again.', { code: 'GOOGLE_INVALID' });
    }
    const email = v.email(info.email);
    if (adminByEmail.get(email)) throw new HttpError(403, 'Please log in to the admin account with its password.');
    let row = db.prepare('SELECT * FROM users WHERE google_sub = ?').get(String(info.sub)) || q.userByEmail.get(email);
    let created = false;
    if (!row) {
      const role = v.ROLES.includes((req.body || {}).role) ? req.body.role : 'participant';
      const name = String(info.name || email.split('@')[0]).trim().slice(0, 80) || 'Google user';
      const hash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), config.bcryptRounds);
      const r = q.insertUser.run(name.length >= 2 ? name : `${name} user`, email, hash, role);
      row = q.userByEmail.get(email);
      created = !!r.changes;
    }
    if (!row.google_sub) db.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(String(info.sub), row.id);
    const user = publicUser(row);
    res.status(created ? 201 : 200).json({ user, token: signToken(user), created });
  }));

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
      .all(...eventParams(uid), id, today(), today(), now());
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
      db.prepare("DELETE FROM event_registrations WHERE user_id = ? AND payment_status != 'paid' AND event_id IN (SELECT id FROM events WHERE community_id = ?)").run(req.user.id, id);
      return db.prepare('DELETE FROM memberships WHERE user_id = ? AND community_id = ?').run(req.user.id, id).changes;
    });
    const changes = leave();
    if (!changes) throw new HttpError(404, 'You are not a member of this community.');
    res.json({ joined: false, message: 'You left the community. Free registrations for its events were cancelled; paid tickets are kept.' });
  });

  // ---------- events ----------
  function publicEvents(req, res) {
    const uid = req.user?.id;
    const where = [`e.status = 'published'`, `c.status = 'published'`, UPCOMING];
    const params = [today(), today(), now()];
    if (req.query.community_id) { where.push('e.community_id = ?'); params.push(v.id(req.query.community_id, 'community ID')); }
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
    const rows = db.prepare(`${EVENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY e.event_date, e.event_time, e.id LIMIT ${limit}`)
      .all(...eventParams(uid), ...params);
    res.json({ events: rows.map(e => shapeEvent(e, uid)), count: rows.length });
  }
  app.get('/api/events/public', optionalAuth, publicEvents);
  app.get('/api/events', optionalAuth, publicEvents); // kept for backwards compatibility

  /** Homepage promotion strip: featured events, trending (most booked recently / filling up), and live deals. */
  app.get('/api/events/trending', optionalAuth, (req, res) => {
    const uid = req.user?.id;
    const rows = db.prepare(`${EVENT_SELECT} WHERE e.status = 'published' AND c.status = 'published' AND ${UPCOMING} ORDER BY e.event_date, e.event_time LIMIT 300`)
      .all(...eventParams(uid), today(), today(), now()).map(e => ({ raw: e, x: shapeEvent(e, uid) }));
    const score = ({ raw, x }) => (raw.recent_bookings || 0) * 3 + (x.capacity ? (raw.held_count || 0) / x.capacity * 10 : Math.min(raw.held_count || 0, 30) / 3) + (x.badges.includes('selling_fast') ? 5 : 0);
    const pick = list => list.slice(0, 6).map(r => r.x);
    res.json({
      featured: pick(rows.filter(r => r.x.featured)),
      trending: pick(rows.filter(r => !r.x.is_full && (r.raw.held_count || 0) > 0).sort((a, b) => score(b) - score(a))),
      deals: pick(rows.filter(r => r.x.flash_active || r.x.early_active).sort((a, b) => (b.x.flash_active - a.x.flash_active) || a.x.starts_at.localeCompare(b.x.starts_at)))
    });
  });

  app.get('/api/events/:id', optionalAuth, (req, res) => {
    const id = v.id(req.params.id, 'event ID');
    const uid = req.user?.id;
    const e = loadEvent(id, uid);
    if (!['published', 'cancelled'].includes(e.status) && e.owner_id !== uid) throw new HttpError(404, 'Event not found.');
    res.json({ event: shapeEvent(e, uid) });
  });

  /** Validates the editable fields of an event. `existing` is passed when editing. */
  function eventInput(body, existing) {
    const b = body || {};
    const name = v.text(b.name, { field: 'name', label: 'Event name', min: 3, max: 100, required: true });
    const date = v.eventDate(b.event_date);
    const time = v.eventTime(b.event_time, date);
    const venue = v.text(b.venue, { field: 'venue', label: 'Venue', min: 2, max: 150, required: true });
    const description = v.text(b.description, { field: 'description', label: 'Event details', max: 2000 });
    const image = v.imageUrl(b.image_url);
    const price = v.pricePence(b.price);
    const cap = v.capacity(b.capacity);
    const early = v.earlyBird(b, price, date, time);
    if (existing && cap != null) {
      const booked = db.prepare('SELECT COUNT(*) AS n FROM event_registrations WHERE event_id = ?').get(existing.id).n;
      if (cap < booked) throw new v.ValidationError(`Capacity cannot be lower than the ${booked} people already registered.`, 'capacity');
    }
    return { name, date, time, venue, description, image, price, cap, ...early };
  }

  function requireOwnedEvent(id, user) {
    const e = q.eventById.get(id);
    if (!e) throw new HttpError(404, 'Event not found.');
    requireOwnedCommunity(e.community_id, user);
    return e;
  }

  const insertEventStmt = db.prepare(`INSERT INTO events(community_id, name, event_date, event_time, venue, description, image_url, price_pence, capacity,
      early_price_pence, early_until, early_limit, repeated_from, status, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', datetime('now'))`);

  app.post('/api/events', requireAuth, requireRole('organizer'), (req, res) => {
    const b = req.body || {};
    if (b.community_id === undefined || b.community_id === null || b.community_id === '') throw new v.ValidationError('Choose one of your communities.', 'community_id');
    const communityId = v.id(b.community_id, 'community ID');
    const c = requireOwnedCommunity(communityId, req.user);
    const x = eventInput(b);
    const dup = db.prepare('SELECT id FROM events WHERE community_id = ? AND name = ? COLLATE NOCASE AND event_date = ? AND event_time = ?').get(c.id, x.name, x.date, x.time);
    if (dup) throw new HttpError(409, 'This event has already been published.', { field: 'name' });
    const r = insertEventStmt.run(c.id, x.name, x.date, x.time, x.venue, x.description, x.image, x.price, x.cap, x.early_price, x.early_until, x.early_limit, null);
    notifyMembers(c.id, 'new_event', `New event in ${c.name}`, `${x.name} · ${x.date} at ${x.time}`, `/event.html?id=${Number(r.lastInsertRowid)}`, req.user.id);
    res.status(201).json({ event: shapeEvent(loadEvent(Number(r.lastInsertRowid), req.user.id), req.user.id), message: 'Event published.' });
  });

  app.put('/api/events/:id', requireAuth, requireRole('organizer'), (req, res) => {
    const id = v.id(req.params.id, 'event ID');
    const existing = requireOwnedEvent(id, req.user);
    const x = eventInput(req.body, existing);
    const dup = db.prepare('SELECT id FROM events WHERE community_id = ? AND name = ? COLLATE NOCASE AND event_date = ? AND event_time = ? AND id != ?').get(existing.community_id, x.name, x.date, x.time, id);
    if (dup) throw new HttpError(409, 'Another event with this name already runs at that date and time.', { field: 'name' });
    db.prepare(`UPDATE events SET name = ?, event_date = ?, event_time = ?, venue = ?, description = ?, image_url = ?, price_pence = ?, capacity = ?,
      early_price_pence = ?, early_until = ?, early_limit = ? WHERE id = ?`)
      .run(x.name, x.date, x.time, x.venue, x.description, x.image, x.price, x.cap, x.early_price, x.early_until, x.early_limit, id);
    processWaitlist(id);
    res.json({ event: shapeEvent(loadEvent(id, req.user.id), req.user.id), message: 'Event updated.' });
  });

  /**
   * "Run again": copies an event (name, time, venue, description, photo, price, capacity) to a new date.
   * Default date = the next same weekday after today (one week after the original if that is still ahead).
   */
  app.post('/api/events/:id/repeat', requireAuth, requireRole('organizer'), (req, res) => {
    const id = v.id(req.params.id, 'event ID');
    const src = requireOwnedEvent(id, req.user);
    const b = req.body || {};
    let date;
    if (b.event_date) date = v.eventDate(b.event_date);
    else {
      const d = new Date(`${src.event_date}T00:00:00`);
      do { d.setDate(d.getDate() + 7); } while (v.todayIso(d) < today() || (v.todayIso(d) === today() && src.event_time <= now()));
      // Skip dates that already have this event
      while (db.prepare('SELECT 1 FROM events WHERE community_id = ? AND name = ? COLLATE NOCASE AND event_date = ? AND event_time = ?').get(src.community_id, src.name, v.todayIso(d), src.event_time)) d.setDate(d.getDate() + 7);
      date = v.eventDate(v.todayIso(d));
    }
    const time = v.eventTime(b.event_time || src.event_time, date);
    const dup = db.prepare('SELECT id FROM events WHERE community_id = ? AND name = ? COLLATE NOCASE AND event_date = ? AND event_time = ?').get(src.community_id, src.name, date, time);
    if (dup) throw new HttpError(409, 'This event is already scheduled on that date.', { field: 'event_date' });
    // Early bird keeps the same gap before the event (e.g. "ends 3 days before"), if that is still in the future.
    let earlyUntil = null;
    if (src.early_price_pence != null && src.early_until) {
      const gap = new Date(`${src.event_date}T${src.event_time}:00`) - new Date(`${src.early_until}:00`);
      const until = new Date(new Date(`${date}T${time}:00`).getTime() - gap);
      const p2 = n => String(n).padStart(2, '0');
      const local = `${v.todayIso(until)}T${p2(until.getHours())}:${p2(until.getMinutes())}`;
      if (local > `${today()}T${now()}`) earlyUntil = local;
    }
    const newId = db.transaction(() => {
      const r = insertEventStmt.run(src.community_id, src.name, date, time, src.venue, src.description, src.image_url, src.price_pence, src.capacity,
        earlyUntil ? src.early_price_pence : null, earlyUntil, earlyUntil ? src.early_limit : null, src.id);
      const id2 = Number(r.lastInsertRowid);
      db.prepare(`INSERT INTO event_promo_codes(event_id, code, percent_off, max_uses, created_at)
        SELECT ?, code, percent_off, max_uses, datetime('now') FROM event_promo_codes WHERE event_id = ?`).run(id2, src.id);
      return id2;
    })();
    const event = shapeEvent(loadEvent(newId, req.user.id), req.user.id);
    res.status(201).json({ event, message: `“${src.name}” is scheduled again for ${date} at ${time}.` });
  });

  app.delete('/api/events/:id', requireAuth, requireRole('organizer'), (req, res) => {
    const id = v.id(req.params.id, 'event ID');
    requireOwnedEvent(id, req.user);
    db.prepare('DELETE FROM events WHERE id = ?').run(id);
    res.json({ message: 'Event deleted.' });
  });

  // ---------- booking: free registration, paid checkout, payments ----------
  /** Common checks before booking. Returns the raw event row. */
  function bookable(id, user) {
    releaseExpiredHolds();
    const e = loadEvent(id, user.id);
    if (e.status === 'cancelled') throw new HttpError(410, 'This event has been cancelled by the organizer.', { code: 'EVENT_CANCELLED' });
    if (e.status !== 'published') throw new HttpError(404, 'Event not found.');
    if (shapeEvent(e, user.id).is_past) throw new HttpError(400, 'This event has already taken place.');
    if (!q.isMember.get(user.id, e.community_id)) {
      throw new HttpError(403, `Join ${e.community_name} before registering for its events.`, { code: 'MEMBERSHIP_REQUIRED', community_id: e.community_id });
    }
    return e;
  }
  const myRegistration = (userId, eventId) => db.prepare('SELECT * FROM event_registrations WHERE user_id = ? AND event_id = ?').get(userId, eventId);

  /** Inserts or updates the user's row inside a transaction that also enforces capacity. */
  function holdPlace(e, userId, price, status, ref) {
    return db.transaction(() => {
      const mine = myRegistration(userId, e.id);
      if (mine && mine.payment_status !== 'pending') return { created: false };
      const others = db.prepare('SELECT COUNT(*) AS n FROM event_registrations WHERE event_id = ? AND user_id != ?').get(e.id, userId).n +
        db.prepare("SELECT COUNT(*) AS n FROM event_waitlist WHERE event_id = ? AND user_id != ? AND status = 'offered'").get(e.id, userId).n;
      if (e.capacity && others >= e.capacity) throw new HttpError(409, 'Sorry, this event is full. Join the waitlist and we will offer you a place if one frees up.', { code: 'EVENT_FULL' });
      if (price.ticket_type === 'early_bird' && e.early_limit) {
        const earlyOthers = db.prepare("SELECT COUNT(*) AS n FROM event_registrations WHERE event_id = ? AND user_id != ? AND ticket_type = 'early_bird'").get(e.id, userId).n;
        if (earlyOthers >= e.early_limit) throw new HttpError(409, 'The last early-bird ticket has just gone. Please check the new price.', { code: 'PRICE_CHANGED' });
      }
      const paidAt = status === 'paid' ? "datetime('now')" : 'NULL';
      db.prepare('DELETE FROM event_registrations WHERE user_id = ? AND event_id = ?').run(userId, e.id);
      db.prepare(`INSERT INTO event_registrations(user_id, event_id, registered_at, amount_pence, ticket_type, list_price_pence, promo_code, payment_status, payment_ref, paid_at, referred_by)
        VALUES(?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ${paidAt}, ?)`)
        .run(userId, e.id, price.amount_pence, price.ticket_type, price.list_price_pence, price.promo ? price.promo.code : null, status, ref || null,
          price.referral ? price.referral.by_user_id : null);
      if (status !== 'pending') afterBooked(userId, e.id);
      return { created: true };
    })();
  }

  /** Runs once a place is confirmed (free registration or payment received). */
  function afterBooked(userId, eventId) {
    ensureFees(db, config.platformFeePercent);
    db.prepare('DELETE FROM event_waitlist WHERE user_id = ? AND event_id = ?').run(userId, eventId);
    const r = db.prepare(`SELECT r.referred_by, r.payment_status, r.amount_pence, e.name, u.name AS buyer FROM event_registrations r
      JOIN events e ON e.id = r.event_id JOIN users u ON u.id = r.user_id WHERE r.user_id = ? AND r.event_id = ?`).get(userId, eventId);
    if (!r) return;
    notify(userId, 'ticket', `You're going to ${r.name}`, r.payment_status === 'paid' ? 'Payment received. Your e-ticket and QR code are ready.' : 'Your place is confirmed. Your e-ticket and QR code are ready.', `/event.html?id=${eventId}`);
    if (r.referred_by) notify(r.referred_by, 'referral', `${r.buyer.split(' ')[0]} booked with your link`, `Thanks for bringing a friend to ${r.name}!`, `/event.html?id=${eventId}`);
  }
  const referralInput = req => String((req.body && req.body.referral_code) || req.query.ref || '').slice(0, 16);

  // Free events: register straight away. Paid events must go through /checkout.
  app.post('/api/events/:id/register', requireAuth, requireRole('participant'), (req, res) => {
    const id = v.id(req.params.id, 'event ID');
    const e = bookable(id, req.user);
    const price = pricing(e);
    if (price.amount_pence > 0) {
      throw new HttpError(402, 'This is a paid event. Choose your ticket and pay online to book your place.', { code: 'PAYMENT_REQUIRED', price_pence: price.amount_pence });
    }
    const { created } = holdPlace(e, req.user.id, price, 'free');
    res.status(created ? 201 : 200).json({
      registered: true, already_registered: !created,
      message: created ? `You're registered for ${e.name}.` : 'You are already registered for this event.',
      event: shapeEvent(loadEvent(id, req.user.id), req.user.id)
    });
  });

  /** Price check for the ticket panel (works without logging in). */
  app.get('/api/events/:id/quote', optionalAuth, (req, res) => {
    const id = v.id(req.params.id, 'event ID');
    releaseExpiredHolds();
    const e = loadEvent(id, req.user?.id);
    res.json({ quote: pricing(e, req.query.promo_code, req.user?.id, req.query.ref), event: shapeEvent(e, req.user?.id) });
  });

  function siteUrl(req) {
    if (config.publicUrl) return config.publicUrl;
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
    return `${proto}://${req.headers.host}`;
  }

  async function stripeRequest(method, path, form) {
    let res;
    try {
      res = await fetch(`${config.payments.stripeApiUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${config.payments.stripeSecretKey}`, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        body: form ? new URLSearchParams(form).toString() : undefined,
        signal: AbortSignal.timeout(10000)
      });
    } catch {
      throw new HttpError(502, 'The payment service could not be reached. Please try again.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[stripe]', res.status, data.error && data.error.message);
      throw new HttpError(502, 'The payment service returned an error. Please try again later.');
    }
    return data;
  }

  /**
   * Paid booking: holds a place (30 min), then returns a checkout_url.
   * Stripe mode → a Stripe Checkout page. Demo mode → our built-in test checkout (no real money).
   */
  app.post('/api/events/:id/checkout', requireAuth, requireRole('participant'), wrap(async (req, res) => {
    const id = v.id(req.params.id, 'event ID');
    const e = bookable(id, req.user);
    const mine = myRegistration(req.user.id, id);
    if (mine && mine.payment_status !== 'pending') {
      return res.json({ registered: true, already_registered: true, message: 'You already have a ticket for this event.' });
    }
    const price = pricing(e, (req.body || {}).promo_code, req.user.id, referralInput(req));
    if (price.amount_pence === 0) {
      holdPlace(e, req.user.id, price, 'free');
      return res.status(201).json({ registered: true, message: `You're registered for ${e.name}.${price.promo ? ` (${price.promo.code} applied)` : ''}`, quote: price });
    }
    const demoRef = `demo_${crypto.randomBytes(12).toString('hex')}`;
    holdPlace(e, req.user.id, price, 'pending', demoRef);
    if (config.payments.mode === 'demo') {
      return res.status(201).json({ checkout_url: `/checkout.html?ref=${demoRef}`, mode: 'demo', quote: price });
    }
    try {
      const base = siteUrl(req);
      const label = { early_bird: 'Early-bird ticket', flash_sale: `Flash sale ticket (${e.flash_percent}% off)` }[price.ticket_type] || 'Standard ticket';
      const session = await stripeRequest('POST', '/v1/checkout/sessions', {
        mode: 'payment',
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': config.payments.currency,
        'line_items[0][price_data][unit_amount]': String(price.amount_pence),
        'line_items[0][price_data][product_data][name]': `${e.name} — ${label}${price.promo ? ` (${price.promo.code})` : ''}${price.referral ? ' (friend discount)' : ''}`,
        'line_items[0][price_data][product_data][description]': `${e.community_name} · ${e.event_date} ${e.event_time} · ${e.venue}`.slice(0, 300),
        customer_email: req.user.email,
        client_reference_id: `${req.user.id}:${id}`,
        'metadata[event_id]': String(id),
        'metadata[user_id]': String(req.user.id),
        expires_at: String(Math.floor(Date.now() / 1000) + Math.max(30, config.payments.holdMinutes) * 60),
        success_url: `${base}/payment.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}/event.html?id=${id}&payment=cancelled`
      });
      db.prepare('UPDATE event_registrations SET payment_ref = ? WHERE user_id = ? AND event_id = ? AND payment_status = ?').run(session.id, req.user.id, id, 'pending');
      res.status(201).json({ checkout_url: session.url, mode: 'stripe', quote: price });
    } catch (err) {
      db.prepare("DELETE FROM event_registrations WHERE user_id = ? AND event_id = ? AND payment_status = 'pending'").run(req.user.id, id);
      throw err;
    }
  }));

  function pendingByRef(ref, user) {
    releaseExpiredHolds();
    const row = db.prepare(`SELECT r.*, e.name AS event_name, e.event_date, e.event_time, e.venue, c.name AS community_name
      FROM event_registrations r JOIN events e ON e.id = r.event_id JOIN communities c ON c.id = e.community_id
      WHERE r.payment_ref = ? AND r.user_id = ?`).get(String(ref || ''), user.id);
    if (!row) throw new HttpError(404, 'This payment was not found or has expired. Please start again from the event page.', { code: 'PAYMENT_NOT_FOUND' });
    return row;
  }
  const orderSummary = r => ({
    ref: r.payment_ref, event_id: r.event_id, event_name: r.event_name, event_date: r.event_date, event_time: r.event_time,
    venue: r.venue, community_name: r.community_name, ticket_type: r.ticket_type, list_price_pence: r.list_price_pence,
    discount_pence: r.list_price_pence - r.amount_pence, amount_pence: r.amount_pence, promo_code: r.promo_code,
    payment_status: r.payment_status, paid_at: r.paid_at,
    expires_at: r.payment_status === 'pending' ? new Date(new Date(`${r.registered_at.replace(' ', 'T')}Z`).getTime() + config.payments.holdMinutes * 60000).toISOString() : null,
    ticket_number: `CC-${String(r.event_id).padStart(4, '0')}-${String(r.user_id).padStart(5, '0')}`,
    ticket_code: r.payment_status === 'paid' ? r.ticket_code : null, referral_code: r.payment_status === 'paid' ? r.referral_code : null
  });

  app.get('/api/payments/:ref', requireAuth, requireRole('participant'), (req, res) => {
    res.json({ order: orderSummary(pendingByRef(req.params.ref, req.user)), mode: config.payments.mode });
  });

  /** Demo checkout: validates a test card (no card data is stored) and marks the ticket as paid. */
  app.post('/api/payments/demo/:ref', requireAuth, requireRole('participant'), (req, res) => {
    if (config.payments.mode !== 'demo') throw new HttpError(400, 'Demo payments are switched off because real payments are configured.');
    const row = pendingByRef(req.params.ref, req.user);
    if (row.payment_status === 'paid') return res.json({ paid: true, order: orderSummary(row), message: 'This ticket is already paid.' });
    const card = v.testCard(req.body || {});
    if (card.declined) throw new HttpError(402, 'Your card was declined. Try another card.', { code: 'CARD_DECLINED', field: 'card_number' });
    db.prepare("UPDATE event_registrations SET payment_status = 'paid', paid_at = datetime('now'), payment_ref = ? WHERE user_id = ? AND event_id = ?")
      .run(`${row.payment_ref}_card${card.last4}`, req.user.id, row.event_id);
    afterBooked(req.user.id, row.event_id);
    const paid = db.prepare(`SELECT r.*, e.name AS event_name, e.event_date, e.event_time, e.venue, c.name AS community_name
      FROM event_registrations r JOIN events e ON e.id = r.event_id JOIN communities c ON c.id = e.community_id WHERE r.user_id = ? AND r.event_id = ?`).get(req.user.id, row.event_id);
    res.json({ paid: true, order: orderSummary(paid), message: `Payment received. You're going to ${row.event_name}!` });
  });

  /** Stripe: after the customer returns from Stripe Checkout, confirm with Stripe that the session is paid. */
  app.post('/api/payments/stripe/confirm', requireAuth, requireRole('participant'), wrap(async (req, res) => {
    if (config.payments.mode !== 'stripe') throw new HttpError(400, 'Stripe payments are not configured.');
    const sessionId = String((req.body || {}).session_id || '');
    if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw new v.ValidationError('Invalid payment session.', 'session_id');
    const row = pendingByRef(sessionId, req.user);
    if (row.payment_status !== 'paid') {
      const session = await stripeRequest('GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
      const matches = session.payment_status === 'paid' && Number(session.amount_total) === row.amount_pence &&
        String(session.metadata && session.metadata.user_id) === String(req.user.id) && String(session.metadata && session.metadata.event_id) === String(row.event_id);
      if (!matches) throw new HttpError(402, 'The payment has not been completed yet.', { code: 'NOT_PAID' });
      db.prepare("UPDATE event_registrations SET payment_status = 'paid', paid_at = datetime('now') WHERE user_id = ? AND event_id = ?").run(req.user.id, row.event_id);
      afterBooked(req.user.id, row.event_id);
    }
    res.json({ paid: true, order: orderSummary(pendingByRef(sessionId, req.user)), message: `Payment received. You're going to ${row.event_name}!` });
  }));

  app.delete('/api/events/:id/register', requireAuth, requireRole('participant'), (req, res) => {
    const id = v.id(req.params.id, 'event ID');
    const e = loadEvent(id, req.user.id);
    const mine = myRegistration(req.user.id, id);
    if (!mine) throw new HttpError(404, 'You are not registered for this event.');
    if (mine.payment_status === 'pending') {
      db.prepare('DELETE FROM event_registrations WHERE user_id = ? AND event_id = ?').run(req.user.id, id);
      processWaitlist(id);
      return res.json({ registered: false, message: 'Your reserved place was released.' });
    }
    if (shapeEvent(e, req.user.id).has_started) throw new HttpError(400, 'This event has already started, so the registration can no longer be cancelled.');
    if (mine.payment_status === 'paid') throw new HttpError(400, "Paid tickets can't be cancelled online. Please contact the organizer about a refund.", { code: 'PAID_TICKET' });
    db.prepare('DELETE FROM event_registrations WHERE user_id = ? AND event_id = ?').run(req.user.id, id);
    processWaitlist(id);
    res.json({ registered: false, message: 'Your registration was cancelled.' });
  });

  // ---------- waitlist (participants) ----------
  app.post('/api/events/:id/waitlist', requireAuth, requireRole('participant'), (req, res) => {
    const id = v.id(req.params.id, 'event ID');
    const e = bookable(id, req.user);
    if (myRegistration(req.user.id, id)) throw new HttpError(409, 'You already have a place at this event.');
    const x = shapeEvent(e, req.user.id);
    if (!x.is_full) throw new HttpError(409, 'There are still places left — you can book now.', { code: 'NOT_FULL' });
    db.prepare("INSERT OR IGNORE INTO event_waitlist(user_id, event_id, status, created_at) VALUES(?, ?, 'waiting', datetime('now'))").run(req.user.id, id);
    const ev = shapeEvent(loadEvent(id, req.user.id), req.user.id);
    res.status(201).json({ waitlist: ev.my_waitlist, event: ev, message: `You're on the waitlist (number ${ev.my_waitlist.position}). We'll notify you if a place opens up.` });
  });
  app.delete('/api/events/:id/waitlist', requireAuth, requireRole('participant'), (req, res) => {
    const id = v.id(req.params.id, 'event ID');
    const r = db.prepare('DELETE FROM event_waitlist WHERE user_id = ? AND event_id = ?').run(req.user.id, id);
    if (!r.changes) throw new HttpError(404, 'You are not on the waitlist for this event.');
    processWaitlist(id);
    res.json({ message: 'You left the waitlist.' });
  });

  // ---------- promo codes (organizer) ----------
  app.get('/api/events/:id/promo-codes', requireAuth, requireRole('organizer'), (req, res) => {
    const id = v.id(req.params.id, 'event ID');
    requireOwnedEvent(id, req.user);
    const codes = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = p.event_id AND r.promo_code = p.code AND r.payment_status IN ('free', 'paid')) AS uses,
        (SELECT COALESCE(SUM(r.list_price_pence - r.amount_pence), 0) FROM event_registrations r WHERE r.event_id = p.event_id AND r.promo_code = p.code AND r.payment_status = 'paid') AS discount_given_pence
      FROM event_promo_codes p WHERE p.event_id = ? ORDER BY p.code`).all(id);
    res.json({ promo_codes: codes });
  });
  app.post('/api/events/:id/promo-codes', requireAuth, requireRole('organizer'), (req, res) => {
    const id = v.id(req.params.id, 'event ID');
    const e = requireOwnedEvent(id, req.user);
    if (!e.price_pence) throw new v.ValidationError('Promo codes are only for paid events. Set a ticket price first.', 'code');
    const b = req.body || {};
    const code = v.promoCode(b.code);
    const pct = v.percentOff(b.percent_off);
    const max = v.capacity(b.max_uses);
    if (db.prepare('SELECT 1 FROM event_promo_codes WHERE event_id = ? AND code = ?').get(id, code)) throw new HttpError(409, 'That code already exists for this event.', { field: 'code' });
    const r = db.prepare("INSERT INTO event_promo_codes(event_id, code, percent_off, max_uses, created_at) VALUES(?, ?, ?, ?, datetime('now'))").run(id, code, pct, max);
    res.status(201).json({ promo_code: { id: Number(r.lastInsertRowid), event_id: id, code, percent_off: pct, max_uses: max, uses: 0 }, message: `Promo code ${code} created (${pct}% off).` });
  });
  app.delete('/api/events/:id/promo-codes/:codeId', requireAuth, requireRole('organizer'), (req, res) => {
    const id = v.id(req.params.id, 'event ID');
    requireOwnedEvent(id, req.user);
    const r = db.prepare('DELETE FROM event_promo_codes WHERE id = ? AND event_id = ?').run(v.id(req.params.codeId, 'promo code ID'), id);
    if (!r.changes) throw new HttpError(404, 'Promo code not found.');
    res.json({ message: 'Promo code deleted. Tickets already sold keep their discount.' });
  });

  // ---------- attendance (organizer check-in) ----------
  app.get('/api/events/:id/attendees', requireAuth, requireRole('organizer'), (req, res) => {
    const id = v.id(req.params.id, 'event ID');
    requireOwnedEvent(id, req.user);
    const event = shapeEvent(loadEvent(id, req.user.id), req.user.id);
    const attendees = db.prepare(`SELECT u.id AS user_id, u.name, u.email, r.registered_at, r.attended, r.checked_in_at, r.amount_pence,
        r.ticket_type, r.promo_code, r.payment_status, r.checked_in_by, r.referred_by, f.rating, f.comment
      FROM event_registrations r JOIN users u ON u.id = r.user_id
      LEFT JOIN event_feedback f ON f.user_id = r.user_id AND f.event_id = r.event_id
      WHERE r.event_id = ? AND r.payment_status IN ('free', 'paid') ORDER BY u.name COLLATE NOCASE`).all(id)
      .map(a => ({ ...a, attended: a.attended === 1 }));
    res.json({ event, attendees });
  });

  function setAttendance(eventId, userIds, attended) {
    const stmt = db.prepare(`UPDATE event_registrations SET attended = ?, checked_in_at = CASE WHEN ? = 1 THEN COALESCE(checked_in_at, datetime('now')) ELSE NULL END
      WHERE event_id = ? AND user_id = ?`);
    return db.transaction(() => userIds.reduce((n, uid) => n + stmt.run(attended, attended, eventId, uid).changes, 0))();
  }

  app.put('/api/events/:id/attendees/:userId', requireAuth, requireRole('organizer'), (req, res) => {
    const id = v.id(req.params.id, 'event ID');
    const userId = v.id(req.params.userId, 'participant ID');
    requireOwnedEvent(id, req.user);
    if (!shapeEvent(loadEvent(id, req.user.id), req.user.id).checkin_open) throw new HttpError(400, `Check-in opens ${CHECKIN_OPENS_HOURS} hours before the event starts.`);
    if (typeof (req.body || {}).attended !== 'boolean') throw new v.ValidationError('Send attended: true or false.', 'attended');
    if (!setAttendance(id, [userId], req.body.attended ? 1 : 0)) throw new HttpError(404, 'That person is not registered for this event.');
    res.json({ attended: req.body.attended, message: req.body.attended ? 'Marked as attended.' : 'Marked as not attended.' });
  });

  app.post('/api/events/:id/attendees/all', requireAuth, requireRole('organizer'), (req, res) => {
    const id = v.id(req.params.id, 'event ID');
    requireOwnedEvent(id, req.user);
    if (!shapeEvent(loadEvent(id, req.user.id), req.user.id).checkin_open) throw new HttpError(400, `Check-in opens ${CHECKIN_OPENS_HOURS} hours before the event starts.`);
    const ids = db.prepare("SELECT user_id FROM event_registrations WHERE event_id = ? AND payment_status IN ('free', 'paid')").all(id).map(r => r.user_id);
    const n = setAttendance(id, ids, 1);
    res.json({ updated: n, message: `Marked ${n} ${n === 1 ? 'person' : 'people'} as attended.` });
  });

  // ---------- feedback (participants who attended) ----------
  app.post('/api/events/:id/feedback', requireAuth, requireRole('participant'), (req, res) => {
    const id = v.id(req.params.id, 'event ID');
    const e = loadEvent(id, req.user.id);
    if (!shapeEvent(e, req.user.id).has_started) throw new HttpError(400, 'You can rate an event after it has taken place.');
    if (e.my_attended !== 1) throw new HttpError(403, 'Only people the organizer marked as attended can rate this event.', { code: 'NOT_ATTENDED' });
    const rating = v.rating((req.body || {}).rating);
    const comment = v.text((req.body || {}).comment, { field: 'comment', label: 'Comment', max: 500 });
    db.prepare(`INSERT INTO event_feedback(user_id, event_id, rating, comment, created_at) VALUES(?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, event_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment, created_at = excluded.created_at`)
      .run(req.user.id, id, rating, comment);
    res.status(201).json({ message: 'Thanks for your feedback!', event: shapeEvent(loadEvent(id, req.user.id), req.user.id) });
  });

  // ---------- add to calendar (.ics) ----------
  app.get('/api/events/:id/calendar.ics', (req, res) => {
    const id = v.id(req.params.id, 'event ID');
    const e = loadEvent(id, null);
    if (e.status !== 'published') throw new HttpError(404, 'Event not found.');
    const icsText = t => String(t || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
    const start = `${e.event_date.replace(/-/g, '')}T${e.event_time.replace(':', '')}00`;
    const endDate = new Date(`${e.event_date}T${e.event_time}:00`);
    endDate.setHours(endDate.getHours() + 2);
    const pad = n => String(n).padStart(2, '0');
    const end = `${endDate.getFullYear()}${pad(endDate.getMonth() + 1)}${pad(endDate.getDate())}T${pad(endDate.getHours())}${pad(endDate.getMinutes())}00`;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Community Connect//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
      `UID:event-${e.id}@communityconnect`, `DTSTAMP:${stamp}`, `DTSTART:${start}`, `DTEND:${end}`,
      `SUMMARY:${icsText(e.name)}`, `LOCATION:${icsText(`${e.venue}${e.community_town ? ', ' + e.community_town : ''}`)}`,
      `DESCRIPTION:${icsText(`${e.community_name} — ${e.description || ''}`)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="event-${e.id}.ics"`);
    res.send(body + '\r\n');
  });

  // ---------- QR ticket check-in (organizer scans the code on the participant's e-ticket) ----------
  function ticketByCode(code, user) {
    const c = String(code || '').trim().toLowerCase();
    if (!/^[a-f0-9]{24}$/.test(c)) throw new HttpError(404, 'This QR code is not a Community Connect ticket.', { code: 'INVALID_TICKET' });
    const t = db.prepare(`SELECT r.*, u.name AS holder_name, e.name AS event_name, e.event_date, e.event_time, e.venue, c.owner_id, c.name AS community_name,
        cb.name AS checked_in_by_name
      FROM event_registrations r JOIN users u ON u.id = r.user_id JOIN events e ON e.id = r.event_id JOIN communities c ON c.id = e.community_id
      LEFT JOIN users cb ON cb.id = r.checked_in_by WHERE r.ticket_code = ?`).get(c);
    if (!t || !['free', 'paid'].includes(t.payment_status)) throw new HttpError(404, t && t.payment_status === 'refunded' ? 'This ticket was refunded because the event was cancelled.' : 'Ticket not found. It may have been cancelled or not paid yet.', { code: 'INVALID_TICKET' });
    if (t.owner_id !== user.id) throw new HttpError(403, 'This ticket is for an event run by another organizer.', { code: 'NOT_YOUR_EVENT' });
    const ev = shapeEvent(loadEvent(t.event_id, user.id), user.id);
    return {
      t, ticket: {
        holder_name: t.holder_name, event_id: t.event_id, event_name: t.event_name, community_name: t.community_name,
        event_date: t.event_date, event_time: t.event_time, venue: t.venue, ticket_type: t.ticket_type, amount_pence: t.amount_pence,
        payment_status: t.payment_status, ticket_number: `CC-${String(t.event_id).padStart(4, '0')}-${String(t.user_id).padStart(5, '0')}`,
        checked_in: t.attended === 1, checked_in_at: t.checked_in_at, checked_in_by: t.checked_in_by_name || null,
        checkin_open: ev.checkin_open, event_is_past: ev.is_past
      },
      stats: { checked_in: db.prepare("SELECT COUNT(*) AS n FROM event_registrations WHERE event_id = ? AND attended = 1 AND payment_status IN ('free', 'paid')").get(t.event_id).n,
        registered: ev.registration_count }
    };
  }
  app.get('/api/checkin/:code', requireAuth, requireRole('organizer'), (req, res) => {
    const { ticket, stats } = ticketByCode(req.params.code, req.user);
    res.json({ ticket, stats });
  });
  app.post('/api/checkin/:code', requireAuth, requireRole('organizer'), (req, res) => {
    const { t, ticket } = ticketByCode(req.params.code, req.user);
    if (ticket.checked_in) {
      const { stats } = ticketByCode(req.params.code, req.user);
      return res.json({ already: true, ticket, stats, message: `${ticket.holder_name} is already checked in.` });
    }
    if (!ticket.checkin_open) throw new HttpError(400, `Check-in opens ${CHECKIN_OPENS_HOURS} hours before the event starts.`, { code: 'CHECKIN_NOT_OPEN' });
    db.prepare("UPDATE event_registrations SET attended = 1, checked_in_at = datetime('now'), checked_in_by = ? WHERE user_id = ? AND event_id = ?").run(req.user.id, t.user_id, t.event_id);
    notify(t.user_id, 'checked_in', `Checked in to ${t.event_name}`, 'Enjoy the event! You can rate it afterwards.', `/event.html?id=${t.event_id}`);
    const after = ticketByCode(req.params.code, req.user);
    res.json({ already: false, ticket: after.ticket, stats: after.stats, message: `Welcome, ${ticket.holder_name}! Checked in.` });
  });

  // ---------- promotion: flash sales and featured events (organizer) ----------
  app.post('/api/events/:id/flash-sale', requireAuth, requireRole('organizer'), (req, res) => {
    const id = v.id(req.params.id, 'event ID');
    const raw = requireOwnedEvent(id, req.user);
    const e = shapeEvent(loadEvent(id, req.user.id), req.user.id);
    if (e.has_started) throw new HttpError(400, 'This event has already started.');
    if (!raw.price_pence) throw new v.ValidationError('Flash sales are for paid events. Set a ticket price first.', 'percent');
    const b = req.body || {};
    const pct = Number(b.percent);
    if (!Number.isInteger(pct) || pct < 5 || pct > 90) throw new v.ValidationError('Choose a discount between 5% and 90%.', 'percent');
    const hours = Number(b.hours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 168) throw new v.ValidationError('The sale can last between 1 hour and 7 days.', 'hours');
    let end = new Date(Date.now() + Math.round(hours * 60) * 60000);
    const start = new Date(`${raw.event_date}T${raw.event_time}:00`);
    if (end > start) end = start;
    const p2 = n => String(n).padStart(2, '0');
    const until = `${v.todayIso(end)}T${p2(end.getHours())}:${p2(end.getMinutes())}`;
    db.prepare('UPDATE events SET flash_percent = ?, flash_until = ? WHERE id = ?').run(pct, until, id);
    const told = b.notify === false ? 0 : notifyMembers(raw.community_id, 'flash_sale', `⚡ ${pct}% off ${raw.name}`, `Flash sale — ends ${until.replace('T', ' at ')}. Grab a ticket before it's gone.`, `/event.html?id=${id}`, req.user.id);
    res.status(201).json({ event: shapeEvent(loadEvent(id, req.user.id), req.user.id), notified: told,
      message: `Flash sale live: ${pct}% off until ${until.replace('T', ' at ')}.${told ? ` ${told} member${told === 1 ? '' : 's'} notified.` : ''}` });
  });
  app.delete('/api/events/:id/flash-sale', requireAuth, requireRole('organizer'), (req, res) => {
    const id = v.id(req.params.id, 'event ID');
    requireOwnedEvent(id, req.user);
    db.prepare('UPDATE events SET flash_percent = NULL, flash_until = NULL WHERE id = ?').run(id);
    res.json({ event: shapeEvent(loadEvent(id, req.user.id), req.user.id), message: 'Flash sale ended.' });
  });
  app.post('/api/events/:id/featured', requireAuth, requireRole('organizer'), (req, res) => {
    const id = v.id(req.params.id, 'event ID');
    requireOwnedEvent(id, req.user);
    if (typeof (req.body || {}).featured !== 'boolean') throw new v.ValidationError('Send featured: true or false.', 'featured');
    db.prepare('UPDATE events SET featured = ? WHERE id = ?').run(req.body.featured ? 1 : 0, id);
    res.json({ event: shapeEvent(loadEvent(id, req.user.id), req.user.id), message: req.body.featured ? 'Event featured on the homepage.' : 'Event removed from the featured list.' });
  });

  // ---------- notifications (bell) ----------
  /** Adds a one-off reminder for each of the user's events starting in the next 24 hours. */
  function addReminders(user) {
    if (user.role !== 'participant') return;
    const soon = db.prepare(`SELECT e.id, e.name, e.event_time, e.event_date, e.venue FROM event_registrations r JOIN events e ON e.id = r.event_id
      WHERE r.user_id = ? AND r.payment_status IN ('free', 'paid') AND (e.event_date || 'T' || e.event_time) > ? AND (e.event_date || 'T' || e.event_time) <= ?`)
      .all(user.id, `${today()}T${now()}`, (() => { const d = new Date(Date.now() + 864e5); const p2 = n => String(n).padStart(2, '0'); return `${v.todayIso(d)}T${p2(d.getHours())}:${p2(d.getMinutes())}`; })());
    for (const e of soon) {
      const link = `/event.html?id=${e.id}`;
      if (!db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'reminder' AND link = ?").get(user.id, link)) {
        notify(user.id, 'reminder', `Starting soon: ${e.name}`, `${e.event_date === today() ? 'Today' : 'Tomorrow'} at ${e.event_time} · ${e.venue}. Have your QR ticket ready.`, link);
      }
    }
  }
  app.get('/api/notifications', requireAuth, (req, res) => {
    addReminders(req.user);
    const list = db.prepare('SELECT id, type, title, body, link, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 30').all(req.user.id);
    const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id).n;
    res.json({ notifications: list.map(n => ({ ...n, read: !!n.read_at })), unread });
  });
  app.post('/api/notifications/read-all', requireAuth, (req, res) => {
    const r = db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").run(req.user.id);
    res.json({ updated: r.changes, unread: 0 });
  });
  app.post('/api/notifications/:id/read', requireAuth, (req, res) => {
    const r = db.prepare("UPDATE notifications SET read_at = COALESCE(read_at, datetime('now')) WHERE id = ? AND user_id = ?").run(v.id(req.params.id, 'notification ID'), req.user.id);
    if (!r.changes) throw new HttpError(404, 'Notification not found.');
    res.json({ read: true });
  });

  // ---------- commission & payouts ----------
  /**
   * The platform collects every ticket payment. After an event has taken place its takings become a payout:
   * gross − platform fee (commission) = net owed to the organizer. Status: pending (event not yet held, computed)
   * → ready (event finished) → paid (admin has sent the money and recorded a reference).
   */
  function syncPayouts() {
    ensureFees(db, config.platformFeePercent);
    const finished = db.prepare(`SELECT e.id, c.owner_id, COUNT(*) AS tickets, COALESCE(SUM(r.amount_pence), 0) AS gross,
        COALESCE(SUM(r.platform_fee_pence), 0) AS fee, COALESCE(SUM(r.organizer_net_pence), 0) AS net
      FROM events e JOIN communities c ON c.id = e.community_id JOIN event_registrations r ON r.event_id = e.id AND r.payment_status = 'paid'
      WHERE e.status = 'published' AND (e.event_date < ? OR (e.event_date = ? AND e.event_time <= ?)) GROUP BY e.id`).all(today(), today(), now());
    const up = db.prepare(`INSERT INTO payouts(event_id, organizer_id, tickets, gross_pence, fee_pence, net_pence, status, created_at)
      VALUES(?, ?, ?, ?, ?, ?, 'ready', datetime('now'))
      ON CONFLICT(event_id) DO UPDATE SET tickets = excluded.tickets, gross_pence = excluded.gross_pence, fee_pence = excluded.fee_pence, net_pence = excluded.net_pence
      WHERE payouts.status = 'ready'`);
    db.transaction(() => finished.forEach(f => up.run(f.id, f.owner_id, f.tickets, f.gross, f.fee, f.net)))();
  }
  /** Payout rows (ready/paid) plus pending amounts for upcoming events. ownerId limits it to one organizer. */
  function payoutList(ownerId) {
    syncPayouts();
    const where = ownerId != null ? 'WHERE p.organizer_id = ?' : '';
    const done = db.prepare(`SELECT p.id, p.event_id, e.name AS event_name, e.event_date, c.name AS community_name, u.name AS organizer_name, u.email AS organizer_email,
        p.tickets, p.gross_pence, p.fee_pence, p.net_pence, p.status, p.reference, p.paid_at
      FROM payouts p JOIN events e ON e.id = p.event_id JOIN communities c ON c.id = e.community_id JOIN users u ON u.id = p.organizer_id ${where}
      ORDER BY CASE p.status WHEN 'ready' THEN 0 ELSE 1 END, e.event_date DESC`).all(...(ownerId != null ? [ownerId] : []));
    const pending = db.prepare(`SELECT NULL AS id, e.id AS event_id, e.name AS event_name, e.event_date, c.name AS community_name, u.name AS organizer_name, u.email AS organizer_email,
        COUNT(*) AS tickets, COALESCE(SUM(r.amount_pence), 0) AS gross_pence, COALESCE(SUM(r.platform_fee_pence), 0) AS fee_pence, COALESCE(SUM(r.organizer_net_pence), 0) AS net_pence,
        'pending' AS status, NULL AS reference, NULL AS paid_at
      FROM events e JOIN communities c ON c.id = e.community_id JOIN users u ON u.id = c.owner_id
      JOIN event_registrations r ON r.event_id = e.id AND r.payment_status = 'paid'
      WHERE e.status = 'published' AND ${UPCOMING} ${ownerId != null ? 'AND c.owner_id = ?' : ''}
      GROUP BY e.id ORDER BY e.event_date`).all(today(), today(), now(), ...(ownerId != null ? [ownerId] : []));
    return [...done.filter(p => p.status === 'ready'), ...pending, ...done.filter(p => p.status === 'paid')];
  }
  const payoutTotals = list => ['pending', 'ready', 'paid'].reduce((o, st) => {
    const l = list.filter(p => p.status === st);
    o[st] = { count: l.length, net_pence: l.reduce((n, p) => n + p.net_pence, 0), fee_pence: l.reduce((n, p) => n + p.fee_pence, 0), gross_pence: l.reduce((n, p) => n + p.gross_pence, 0) };
    return o;
  }, {});

  // ---------- event cancellation with automatic refunds (organizer) ----------
  app.post('/api/events/:id/cancel', requireAuth, requireRole('organizer'), wrap(async (req, res) => {
    const id = v.id(req.params.id, 'event ID');
    const raw = requireOwnedEvent(id, req.user);
    if (raw.status === 'cancelled') throw new HttpError(409, 'This event is already cancelled.');
    const e = shapeEvent(loadEvent(id, req.user.id), req.user.id);
    if (e.has_started) throw new HttpError(400, 'This event has already started, so it can no longer be cancelled.');
    const reason = v.text((req.body || {}).reason, { field: 'reason', label: 'Reason', max: 300 });
    const regs = db.prepare('SELECT user_id, payment_status, amount_pence, payment_ref FROM event_registrations WHERE event_id = ?').all(id);
    const waiting = db.prepare('SELECT user_id FROM event_waitlist WHERE event_id = ?').all(id);
    const paid = regs.filter(r => r.payment_status === 'paid');
    db.transaction(() => {
      db.prepare("UPDATE events SET status = 'cancelled', cancelled_at = datetime('now'), cancel_reason = ?, featured = 0, flash_percent = NULL, flash_until = NULL WHERE id = ?").run(reason || null, id);
      db.prepare("DELETE FROM event_registrations WHERE event_id = ? AND payment_status = 'pending'").run(id);
      db.prepare(`UPDATE event_registrations SET payment_status = 'refunded', refunded_at = datetime('now'), platform_fee_pence = 0, organizer_net_pence = 0
        WHERE event_id = ? AND payment_status = 'paid'`).run(id);
      db.prepare("UPDATE event_registrations SET payment_status = 'cancelled' WHERE event_id = ? AND payment_status = 'free'").run(id);
      db.prepare('DELETE FROM event_waitlist WHERE event_id = ?').run(id);
      for (const r of regs.filter(x => x.payment_status !== 'pending')) {
        notify(r.user_id, 'cancelled', `Cancelled: ${raw.name}`, r.payment_status === 'paid'
          ? `The organizer cancelled this event. Your ${money(r.amount_pence)} has been refunded.${reason ? ` Reason: ${reason}` : ''}`
          : `The organizer cancelled this event.${reason ? ` Reason: ${reason}` : ''}`, `/event.html?id=${id}`);
      }
      waiting.forEach(w => notify(w.user_id, 'cancelled', `Cancelled: ${raw.name}`, 'The event you were waiting for has been cancelled.', `/event.html?id=${id}`));
    })();
    // Real payments: ask Stripe to refund each card payment (demo mode needs nothing — no real money was taken).
    let refundErrors = 0;
    if (config.payments.mode === 'stripe') {
      for (const r of paid.filter(x => /^cs_/.test(x.payment_ref || ''))) {
        try {
          const session = await stripeRequest('GET', `/v1/checkout/sessions/${encodeURIComponent(r.payment_ref)}`);
          if (session.payment_intent) await stripeRequest('POST', '/v1/refunds', { payment_intent: session.payment_intent });
        } catch (err) { refundErrors++; console.error('[stripe refund]', r.payment_ref, err.message); }
      }
    }
    const refunded = paid.reduce((n, r) => n + r.amount_pence, 0);
    res.json({ event: shapeEvent(loadEvent(id, req.user.id), req.user.id), refunded_tickets: paid.length, refunded_pence: refunded, refund_errors: refundErrors,
      message: `Event cancelled. ${paid.length ? `${paid.length} ticket${paid.length === 1 ? '' : 's'} refunded (${money(refunded)}). ` : ''}Everyone registered has been notified.` });
  }));

  // ---------- platform admin ----------
  app.get('/api/admin/overview', requireAuth, requireRole('admin'), (req, res) => {
    const months = Math.min(Math.max(Number(req.query.months) || 6, 3), 12);
    const payouts = payoutList(null);
    const totals = payoutTotals(payouts);
    const one = (sql, ...p) => db.prepare(sql).get(...p);
    const users = one(`SELECT SUM(role = 'participant') AS participants, SUM(role = 'organizer') AS organizers,
      SUM(created_at >= date('now', 'start of month')) AS new_this_month FROM users`);
    const events = one(`SELECT SUM(status = 'published') AS published, SUM(status = 'cancelled') AS cancelled,
      SUM(status = 'published' AND (event_date > ? OR (event_date = ? AND event_time >= ?))) AS upcoming FROM events`, today(), today(), now());
    const money_ = one(`SELECT COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN amount_pence END), 0) AS gross,
        COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN platform_fee_pence END), 0) AS fee,
        COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN organizer_net_pence END), 0) AS net,
        COALESCE(SUM(CASE WHEN payment_status = 'refunded' THEN amount_pence END), 0) AS refunded,
        SUM(payment_status = 'paid') AS paid_tickets, SUM(payment_status = 'free') AS free_tickets, SUM(payment_status = 'refunded') AS refunded_tickets
      FROM event_registrations`);
    const att = one(`SELECT COUNT(*) AS regs, COALESCE(SUM(r.attended), 0) AS came FROM event_registrations r JOIN events e ON e.id = r.event_id
      WHERE r.payment_status IN ('free', 'paid') AND e.status = 'published' AND (e.event_date < ? OR (e.event_date = ? AND e.event_time <= ?))`, today(), today(), now());

    const keys = [];
    const d = new Date(); d.setDate(1);
    for (let i = months - 1; i >= 0; i--) { const m = new Date(d.getFullYear(), d.getMonth() - i, 1); keys.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`); }
    const signups = db.prepare("SELECT substr(created_at, 1, 7) AS month, role, COUNT(*) AS n FROM users GROUP BY month, role").all();
    const sales = db.prepare(`SELECT substr(COALESCE(paid_at, registered_at), 1, 7) AS month, COUNT(*) AS tickets, COALESCE(SUM(amount_pence), 0) AS gross, COALESCE(SUM(platform_fee_pence), 0) AS fee
      FROM event_registrations WHERE payment_status = 'paid' GROUP BY month`).all();
    const before = role => signups.filter(x => x.role === role && x.month && x.month < keys[0]).reduce((n, x) => n + x.n, 0);
    let runP = before('participant'), runO = before('organizer');
    const monthly = keys.map(k => {
      const p = signups.find(x => x.month === k && x.role === 'participant')?.n || 0;
      const o = signups.find(x => x.month === k && x.role === 'organizer')?.n || 0;
      runP += p; runO += o;
      const sl = sales.find(x => x.month === k) || {};
      return { month: k, new_participants: p, new_organizers: o, total_participants: runP, total_organizers: runO, tickets: sl.tickets || 0, gross_pence: sl.gross || 0, fee_pence: sl.fee || 0 };
    });
    const organizers = db.prepare(`SELECT u.id, u.name, u.email, u.created_at,
        (SELECT COUNT(*) FROM communities c WHERE c.owner_id = u.id) AS communities,
        (SELECT COUNT(*) FROM events e JOIN communities c ON c.id = e.community_id WHERE c.owner_id = u.id AND e.status = 'published') AS events,
        (SELECT COUNT(*) FROM event_registrations r JOIN events e ON e.id = r.event_id JOIN communities c ON c.id = e.community_id WHERE c.owner_id = u.id AND r.payment_status IN ('free', 'paid')) AS tickets,
        (SELECT COALESCE(SUM(r.amount_pence), 0) FROM event_registrations r JOIN events e ON e.id = r.event_id JOIN communities c ON c.id = e.community_id WHERE c.owner_id = u.id AND r.payment_status = 'paid') AS gross_pence,
        (SELECT COALESCE(SUM(r.platform_fee_pence), 0) FROM event_registrations r JOIN events e ON e.id = r.event_id JOIN communities c ON c.id = e.community_id WHERE c.owner_id = u.id AND r.payment_status = 'paid') AS fee_pence,
        (SELECT COALESCE(SUM(p.net_pence), 0) FROM payouts p WHERE p.organizer_id = u.id AND p.status = 'paid') AS paid_out_pence
      FROM users u WHERE u.role = 'organizer' ORDER BY gross_pence DESC, events DESC, u.name LIMIT 10`).all();
    const communities = db.prepare(`SELECT c.id, c.name, c.category, c.town, u.name AS organizer_name,
        (SELECT COUNT(*) FROM memberships m WHERE m.community_id = c.id) AS members,
        (SELECT COUNT(*) FROM events e WHERE e.community_id = c.id AND e.status = 'published') AS events,
        (SELECT COALESCE(SUM(r.amount_pence), 0) FROM event_registrations r JOIN events e ON e.id = r.event_id WHERE e.community_id = c.id AND r.payment_status = 'paid') AS gross_pence
      FROM communities c JOIN users u ON u.id = c.owner_id ORDER BY members DESC, gross_pence DESC LIMIT 8`).all();
    const recent = db.prepare("SELECT name, email, role, created_at FROM users ORDER BY created_at DESC, id DESC LIMIT 8").all();
    res.json({
      generated_at: new Date().toISOString(), fee_percent: config.platformFeePercent, payment_mode: config.payments.mode,
      summary: {
        participants: users.participants || 0, organizers: users.organizers || 0, new_users_this_month: users.new_this_month || 0,
        communities: one('SELECT COUNT(*) AS n FROM communities').n, events: events.published || 0, events_upcoming: events.upcoming || 0, events_cancelled: events.cancelled || 0,
        paid_tickets: money_.paid_tickets || 0, free_tickets: money_.free_tickets || 0, refunded_tickets: money_.refunded_tickets || 0,
        attendance_rate: att.regs ? Math.round(att.came / att.regs * 100) : null,
        gross_pence: money_.gross, platform_revenue_pence: money_.fee, organizer_share_pence: money_.net, refunded_pence: money_.refunded,
        payouts_pending_pence: totals.pending.net_pence, payouts_ready_pence: totals.ready.net_pence, payouts_paid_pence: totals.paid.net_pence
      },
      monthly, top_organizers: organizers, top_communities: communities, recent_users: recent, payouts, payout_totals: totals
    });
  });
  app.post('/api/admin/payouts/:id/pay', requireAuth, requireRole('admin'), (req, res) => {
    const id = v.id(req.params.id, 'payout ID');
    const p = db.prepare('SELECT p.*, e.name AS event_name FROM payouts p JOIN events e ON e.id = p.event_id WHERE p.id = ?').get(id);
    if (!p) throw new HttpError(404, 'Payout not found.');
    if (p.status === 'paid') throw new HttpError(409, 'This payout has already been marked as paid.');
    const ref = v.text((req.body || {}).reference, { field: 'reference', label: 'Reference', max: 60 }) || `PO-${String(id).padStart(5, '0')}-${today().replace(/-/g, '')}`;
    db.prepare("UPDATE payouts SET status = 'paid', paid_at = datetime('now'), reference = ? WHERE id = ?").run(ref, id);
    notify(p.organizer_id, 'payout', `Payout sent: ${money(p.net_pence)}`, `For ${p.event_name}: ${money(p.gross_pence)} ticket sales − ${money(p.fee_pence)} platform fee. Reference ${ref}.`, '/index.html#organizer');
    res.json({ payout: { ...p, status: 'paid', reference: ref }, message: `Payout of ${money(p.net_pence)} marked as paid (${ref}). The organizer has been notified.` });
  });

  // ---------- dashboards ----------
  app.get('/api/organizer/communities', requireAuth, requireRole('organizer'), (req, res) => {
    const rows = db.prepare(`SELECT x.*, (SELECT COUNT(*) FROM events e WHERE e.community_id = x.id) AS event_count FROM (${COMMUNITY_SELECT} WHERE c.owner_id = ?) x ORDER BY x.created_at DESC, x.id DESC`)
      .all(...communityParams(req.user.id), req.user.id);
    res.json({ communities: rows.map(c => shapeCommunity(c, req.user.id)) });
  });

  app.get('/api/organizer/events', requireAuth, requireRole('organizer'), (req, res) => {
    const rows = db.prepare(`${EVENT_SELECT} WHERE c.owner_id = ? ORDER BY e.event_date, e.event_time`).all(...eventParams(req.user.id), req.user.id);
    res.json({ events: rows.map(e => shapeEvent(e, req.user.id)) });
  });

  app.get('/api/participant/communities', requireAuth, requireRole('participant'), (req, res) => {
    const rows = db.prepare(`${COMMUNITY_SELECT} JOIN memberships mm ON mm.community_id = c.id AND mm.user_id = ? ORDER BY mm.joined_at DESC`)
      .all(...communityParams(req.user.id), req.user.id);
    res.json({ communities: rows.map(c => shapeCommunity(c, req.user.id)) });
  });

  app.get('/api/participant/events', requireAuth, requireRole('participant'), (req, res) => {
    const rows = db.prepare(`${EVENT_SELECT} JOIN event_registrations rr ON rr.event_id = e.id AND rr.user_id = ? ORDER BY e.event_date, e.event_time`)
      .all(...eventParams(req.user.id), req.user.id);
    const events = rows.map(e => shapeEvent(e, req.user.id)).filter(e => e.registered);
    // Upcoming first (soonest first), then past events (most recent first).
    events.sort((a, b) => (a.is_past - b.is_past) || (a.is_past ? (b.event_date + b.event_time).localeCompare(a.event_date + a.event_time) : 0));
    res.json({ events });
  });

  // ---------- organizer analytics ----------
  /**
   * All figures for the organizer's own communities:
   *  summary KPIs, per-event registrations / attendance / revenue / rating,
   *  monthly trend, revenue by community, member growth and upcoming fill rate.
   * Revenue = ticket price recorded at registration (payments are not processed online).
   */
  app.get('/api/organizer/analytics', requireAuth, requireRole('organizer'), (req, res) => {
    const months = Math.min(Math.max(Number(req.query.months) || 6, 3), 12);
    const events = db.prepare(`${EVENT_SELECT} WHERE c.owner_id = ? ORDER BY e.event_date, e.event_time`)
      .all(...eventParams(req.user.id), req.user.id).map(e => shapeEvent(e, req.user.id));
    const communities = db.prepare(`SELECT c.id, c.name, c.category,
        (SELECT COUNT(*) FROM memberships m WHERE m.community_id = c.id) AS members
      FROM communities c WHERE c.owner_id = ? ORDER BY c.name`).all(req.user.id);
    const past = events.filter(e => e.has_started);
    const upcoming = events.filter(e => !e.has_started);
    const sum = (list, k) => list.reduce((n, x) => n + (x[k] || 0), 0);
    const pastRegs = sum(past, 'registration_count');
    const pastAttended = sum(past, 'attended_count');
    const ratingTotal = past.reduce((n, e) => n + (e.avg_rating || 0) * e.rating_count, 0);
    const ratingCount = sum(past, 'rating_count');

    // Month buckets: oldest → current
    const monthKeys = [];
    const d = new Date(); d.setDate(1);
    for (let i = months - 1; i >= 0; i--) {
      const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
      monthKeys.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`);
    }
    const monthly = monthKeys.map(key => {
      const inMonth = past.filter(e => e.event_date.startsWith(key));
      return {
        month: key, events: inMonth.length,
        registrations: sum(inMonth, 'registration_count'), attended: sum(inMonth, 'attended_count'),
        revenue_pence: sum(inMonth, 'revenue_pence')
      };
    });

    const joins = db.prepare(`SELECT substr(m.joined_at, 1, 7) AS month, COUNT(*) AS n FROM memberships m
      JOIN communities c ON c.id = m.community_id WHERE c.owner_id = ? GROUP BY month`).all(req.user.id);
    const before = joins.filter(j => j.month && j.month < monthKeys[0]).reduce((n, j) => n + j.n, 0);
    let running = before;
    const memberGrowth = monthKeys.map(key => {
      const added = joins.find(j => j.month === key)?.n || 0;
      running += added;
      return { month: key, new_members: added, total_members: running };
    });

    const byCommunity = communities.map(c => {
      const list = events.filter(e => e.community_id === c.id);
      const p = list.filter(e => e.has_started);
      const regs = sum(p, 'registration_count');
      return {
        id: c.id, name: c.name, category: c.category, members: c.members, events: list.length,
        registrations: sum(list, 'registration_count'), attended: sum(p, 'attended_count'),
        attendance_rate: regs ? Math.round(sum(p, 'attended_count') / regs * 100) : null,
        revenue_pence: sum(list, 'revenue_pence')
      };
    });

    const perEvent = past.map(e => ({
      id: e.id, name: e.name, community_name: e.community_name, event_date: e.event_date,
      registered: e.registration_count, attended: e.attended_count,
      attendance_rate: e.registration_count ? Math.round(e.attended_count / e.registration_count * 100) : null,
      revenue_pence: e.revenue_pence, price_pence: e.price_pence, capacity: e.capacity,
      avg_rating: e.avg_rating, rating_count: e.rating_count
    }));

    // Ticket sales by type (early bird / standard / free) and promo code use, across this organizer's events.
    const salesByType = db.prepare(`SELECT COALESCE(r.ticket_type, 'standard') AS ticket_type, COUNT(*) AS tickets,
        COALESCE(SUM(CASE WHEN r.payment_status = 'paid' THEN r.amount_pence END), 0) AS revenue_pence,
        COALESCE(SUM(CASE WHEN r.payment_status = 'paid' THEN r.list_price_pence - r.amount_pence END), 0) AS discount_pence
      FROM event_registrations r JOIN events e ON e.id = r.event_id JOIN communities c ON c.id = e.community_id
      WHERE c.owner_id = ? AND r.payment_status IN ('free', 'paid') GROUP BY 1`).all(req.user.id);
    const promoUsage = db.prepare(`SELECT r.promo_code AS code, e.name AS event_name, e.event_date, COUNT(*) AS uses,
        COALESCE(SUM(r.list_price_pence - r.amount_pence), 0) AS discount_pence, COALESCE(SUM(r.amount_pence), 0) AS revenue_pence
      FROM event_registrations r JOIN events e ON e.id = r.event_id JOIN communities c ON c.id = e.community_id
      WHERE c.owner_id = ? AND r.promo_code IS NOT NULL AND r.payment_status = 'paid'
      GROUP BY r.promo_code, e.id ORDER BY uses DESC, e.event_date DESC LIMIT 20`).all(req.user.id);
    const referrals = db.prepare(`SELECT ru.name AS referrer, e.name AS event_name, COUNT(*) AS friends, COALESCE(SUM(CASE WHEN r.payment_status = 'paid' THEN r.amount_pence END), 0) AS revenue_pence
      FROM event_registrations r JOIN users ru ON ru.id = r.referred_by JOIN events e ON e.id = r.event_id JOIN communities c ON c.id = e.community_id
      WHERE c.owner_id = ? AND r.payment_status IN ('free', 'paid') GROUP BY r.referred_by, e.id ORDER BY friends DESC LIMIT 10`).all(req.user.id);
    const qrCheckins = db.prepare(`SELECT COUNT(*) AS n FROM event_registrations r JOIN events e ON e.id = r.event_id JOIN communities c ON c.id = e.community_id
      WHERE c.owner_id = ? AND r.checked_in_by IS NOT NULL`).get(req.user.id).n;
    const waiting = db.prepare(`SELECT COUNT(*) AS n FROM event_waitlist w JOIN events e ON e.id = w.event_id JOIN communities c ON c.id = e.community_id WHERE c.owner_id = ?`).get(req.user.id).n;
    const order = ['early_bird', 'flash_sale', 'standard', 'free'];
    salesByType.sort((a, b) => order.indexOf(a.ticket_type) - order.indexOf(b.ticket_type));

    res.json({
      generated_at: new Date().toISOString(),
      sales_by_type: salesByType, promo_usage: promoUsage, payment_mode: config.payments.mode,
      referrals, referral_total: referrals.reduce((n, r) => n + r.friends, 0), referral_revenue_pence: referrals.reduce((n, r) => n + r.revenue_pence, 0),
      qr_checkins: qrCheckins, waitlist_total: waiting,
      earnings: (() => {
        const list = payoutList(req.user.id);
        const t = payoutTotals(list);
        const fee = db.prepare(`SELECT COALESCE(SUM(r.amount_pence), 0) AS gross, COALESCE(SUM(r.platform_fee_pence), 0) AS fee, COALESCE(SUM(r.organizer_net_pence), 0) AS net
          FROM event_registrations r JOIN events e ON e.id = r.event_id JOIN communities c ON c.id = e.community_id WHERE c.owner_id = ? AND r.payment_status = 'paid'`).get(req.user.id);
        return { fee_percent: config.platformFeePercent, gross_pence: fee.gross, fee_pence: fee.fee, net_pence: fee.net,
          pending_pence: t.pending.net_pence, ready_pence: t.ready.net_pence, paid_pence: t.paid.net_pence, payouts: list };
      })(),
      summary: {
        communities: communities.length, members: sum(communities, 'members'),
        events_total: events.length, events_past: past.length, events_upcoming: upcoming.length,
        registrations_total: sum(events, 'registration_count'), registrations_past: pastRegs,
        attended: pastAttended, attendance_rate: pastRegs ? Math.round(pastAttended / pastRegs * 100) : null,
        revenue_pence: sum(events, 'revenue_pence'), revenue_past_pence: sum(past, 'revenue_pence'),
        revenue_upcoming_pence: sum(upcoming, 'revenue_pence'),
        avg_rating: ratingCount ? Math.round(ratingTotal / ratingCount * 10) / 10 : null, ratings: ratingCount
      },
      monthly, member_growth: memberGrowth, by_community: byCommunity, per_event: perEvent,
      upcoming: upcoming.map(e => ({
        id: e.id, name: e.name, community_name: e.community_name, event_date: e.event_date, event_time: e.event_time,
        registered: e.registration_count, capacity: e.capacity, revenue_pence: e.revenue_pence,
        fill_rate: e.capacity ? Math.round(e.registration_count / e.capacity * 100) : null
      }))
    });
  });

  // ---------- recommendations for participants ----------
  app.get('/api/participant/recommendations', requireAuth, requireRole('participant'), (req, res) => {
    const uid = req.user.id;
    const joined = db.prepare('SELECT c.category, c.latitude, c.longitude FROM memberships m JOIN communities c ON c.id = m.community_id WHERE m.user_id = ?').all(uid);
    const rows = db.prepare(`${COMMUNITY_SELECT} WHERE c.status = 'published' AND c.id NOT IN (SELECT community_id FROM memberships WHERE user_id = ?)`)
      .all(...communityParams(uid), uid);
    const cats = new Map();
    joined.forEach(j => cats.set(j.category, (cats.get(j.category) || 0) + 1));
    const centre = joined.length ? { lat: joined.reduce((n, j) => n + j.latitude, 0) / joined.length, lon: joined.reduce((n, j) => n + j.longitude, 0) / joined.length } : null;
    const scored = rows.map(c => {
      const dist = centre ? haversineMiles(centre.lat, centre.lon, c.latitude, c.longitude) : null;
      const reasons = [];
      let score = c.member_count * 0.2 + c.upcoming_event_count * 1.5;
      if (cats.has(c.category)) { score += 10 * cats.get(c.category); reasons.push(`You like ${c.category}`); }
      if (dist != null) { score += Math.max(0, 8 - dist / 3); if (dist <= 10) reasons.push('Near your communities'); }
      if (c.upcoming_event_count) reasons.push(`${c.upcoming_event_count} upcoming event${c.upcoming_event_count === 1 ? '' : 's'}`);
      if (!reasons.length) reasons.push('Popular with members');
      return { c: { ...c, distance_miles: dist }, score, reasons };
    }).sort((a, b) => b.score - a.score).slice(0, 3);
    res.json({ communities: scored.map(s => ({ ...shapeCommunity(s.c, uid), reasons: s.reasons.slice(0, 2) })) });
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
