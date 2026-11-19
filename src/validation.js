'use strict';
/** Input validation helpers. Each validator returns { value } or { error }. */

const CATEGORIES = ['Technology', 'Sports & Fitness', 'Social', 'Faith', 'Volunteering', 'Arts & Hobbies'];
const ROLES = ['participant', 'organizer'];

// Generous bounding box around the UK, Channel Islands and Isle of Man.
const UK_BOUNDS = { minLat: 49.0, maxLat: 61.5, minLon: -9.0, maxLon: 2.5 };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const UPLOAD_URL_RE = /^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp|gif)$/;
const UK_POSTCODE_RE = /^([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})$/i;

class ValidationError extends Error {
  constructor(message, field) { super(message); this.status = 400; this.field = field; }
}

function text(value, { field, label, min = 0, max = 1000, required = false }) {
  const v = typeof value === 'string' ? value.trim() : (value == null ? '' : String(value).trim());
  if (!v) {
    if (required) throw new ValidationError(`${label} is required.`, field);
    return '';
  }
  if (v.length < min) throw new ValidationError(`${label} must be at least ${min} characters.`, field);
  if (v.length > max) throw new ValidationError(`${label} must be ${max} characters or fewer.`, field);
  return v;
}

function email(value) {
  const v = text(value, { field: 'email', label: 'Email address', max: 254, required: true }).toLowerCase();
  if (!EMAIL_RE.test(v)) throw new ValidationError('Enter a valid email address.', 'email');
  return v;
}

function password(value) {
  if (typeof value !== 'string' || !value) throw new ValidationError('Password is required.', 'password');
  if (value.length < 8) throw new ValidationError('Password must be at least 8 characters.', 'password');
  if (value.length > 128) throw new ValidationError('Password must be 128 characters or fewer.', 'password');
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) throw new ValidationError('Password must include at least one letter and one number.', 'password');
  return value;
}

function role(value) {
  if (!ROLES.includes(value)) throw new ValidationError('Choose an account type: participant or organizer.', 'role');
  return value;
}

function category(value) {
  if (!CATEGORIES.includes(value)) throw new ValidationError(`Choose a category: ${CATEGORIES.join(', ')}.`, 'category');
  return value;
}

function isValidCoordinate(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function inUk(lat, lon) {
  return lat >= UK_BOUNDS.minLat && lat <= UK_BOUNDS.maxLat && lon >= UK_BOUNDS.minLon && lon <= UK_BOUNDS.maxLon;
}

/** Returns {lat, lon} or null when both values are empty. Throws on invalid input. */
function coordinates(latValue, lonValue, { requireUk = true } = {}) {
  const empty = v => v === undefined || v === null || v === '';
  if (empty(latValue) && empty(lonValue)) return null;
  const lat = Number(latValue), lon = Number(lonValue);
  if (empty(latValue) || empty(lonValue) || !isValidCoordinate(lat, lon)) {
    throw new ValidationError('Latitude must be between -90 and 90 and longitude between -180 and 180.', 'latitude');
  }
  if (requireUk && !inUk(lat, lon)) throw new ValidationError('The location must be within the United Kingdom.', 'latitude');
  return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
}

function imageUrl(value) {
  const v = text(value, { field: 'image_url', label: 'Photograph link', max: 600 });
  if (!v) return '';
  if (UPLOAD_URL_RE.test(v)) return v;
  let u;
  try { u = new URL(v); } catch { throw new ValidationError('Photograph link must be a valid https:// address or an uploaded image.', 'image_url'); }
  if (u.protocol !== 'https:') throw new ValidationError('Photograph links must start with https://', 'image_url');
  return u.toString();
}

function pad(n) { return String(n).padStart(2, '0'); }
function todayIso(now = new Date()) { return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`; }
function nowTime(now = new Date()) { return `${pad(now.getHours())}:${pad(now.getMinutes())}`; }

function eventDate(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  const m = DATE_RE.exec(v);
  if (!m) throw new ValidationError('Enter the event date in the format YYYY-MM-DD.', 'event_date');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new ValidationError('That event date does not exist.', 'event_date');
  }
  const today = todayIso();
  if (v < today) throw new ValidationError('The event date cannot be in the past.', 'event_date');
  const max = new Date(); max.setFullYear(max.getFullYear() + 2);
  if (v > todayIso(max)) throw new ValidationError('Events can be scheduled up to two years ahead.', 'event_date');
  return v;
}

function eventTime(value, date) {
  const v = typeof value === 'string' ? value.trim().slice(0, 5) : '';
  if (!TIME_RE.test(v)) throw new ValidationError('Enter a valid start time (HH:MM, 24-hour).', 'event_time');
  if (date === todayIso() && v <= nowTime()) throw new ValidationError('That start time has already passed today.', 'event_time');
  return v;
}

/** Parses a route id. Throws a 400 for anything other than a positive integer. */
function id(value, label = 'ID') {
  const s = String(value ?? '');
  if (!/^\d{1,12}$/.test(s) || Number(s) < 1) throw new ValidationError(`Invalid ${label}.`, 'id');
  return Number(s);
}

/** Ticket price in pounds (e.g. "5", "4.50", 0) → whole pence. Empty = free. */
function pricePence(value) {
  if (value === undefined || value === null || value === '') return 0;
  const s = String(value).trim().replace(/^£/, '');
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(s)) throw new ValidationError('Enter the ticket price in pounds, e.g. 0, 5 or 7.50.', 'price');
  const pence = Math.round(Number(s) * 100);
  if (pence > 50000) throw new ValidationError('Ticket price must be £500 or less.', 'price');
  return pence;
}

/** Maximum number of places. Empty = unlimited (null). */
function capacity(value) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  if (!/^\d{1,5}$/.test(s) || Number(s) < 1 || Number(s) > 10000) throw new ValidationError('Capacity must be a whole number between 1 and 10000, or left empty for unlimited.', 'capacity');
  return Number(s);
}

/** 'YYYY-MM-DDTHH:MM' (from <input type="datetime-local">). Returns the normalised string. */
function localDateTime(value, field, label) {
  const v = typeof value === 'string' ? value.trim().slice(0, 16) : '';
  const m = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
  if (!m) throw new ValidationError(`${label} must be a date and time.`, field);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  if (d.getMonth() !== Number(m[2]) - 1) throw new ValidationError(`${label} is not a real date.`, field);
  return v;
}

/**
 * Early-bird pricing. Returns { early_price, early_until, early_limit } (all null when not used).
 * Rules: cheaper than the standard price, ends in the future and no later than the event start.
 */
function earlyBird(b, standardPence, eventDate, eventTime) {
  const empty = x => x === undefined || x === null || x === '';
  if (empty(b.early_price) && empty(b.early_until) && empty(b.early_limit)) return { early_price: null, early_until: null, early_limit: null };
  if (empty(b.early_price)) throw new ValidationError('Enter the early-bird price, or clear the early-bird fields.', 'early_price');
  if (!standardPence) throw new ValidationError('Set a standard ticket price before adding an early-bird price.', 'price');
  const early = pricePence(b.early_price);
  if (early >= standardPence) throw new ValidationError('The early-bird price must be lower than the standard price.', 'early_price');
  if (empty(b.early_until)) throw new ValidationError('Choose when the early-bird offer ends.', 'early_until');
  const until = localDateTime(b.early_until, 'early_until', 'Early-bird end');
  const nowLocal = `${todayIso()}T${nowTime()}`;
  if (until <= nowLocal) throw new ValidationError('The early-bird end must be in the future.', 'early_until');
  if (until > `${eventDate}T${eventTime}`) throw new ValidationError('The early-bird offer must end before the event starts.', 'early_until');
  let limit = null;
  if (!empty(b.early_limit)) {
    const s = String(b.early_limit).trim();
    if (!/^\d{1,5}$/.test(s) || Number(s) < 1) throw new ValidationError('Early-bird ticket limit must be a whole number of 1 or more, or empty.', 'early_limit');
    limit = Number(s);
  }
  return { early_price: early, early_until: until, early_limit: limit };
}

function promoCode(value) {
  const v = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,20}$/.test(v)) throw new ValidationError('Promo codes are 3–20 letters or numbers, e.g. STUDENT20.', 'code');
  return v;
}

function percentOff(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 5 || n > 100) throw new ValidationError('Discount must be a whole number from 5 to 100 (%).', 'percent_off');
  return n;
}

/** Card checks for the built-in demo checkout (format + Luhn). No card data is stored. */
function testCard(b) {
  const number = String(b.card_number || '').replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(number)) throw new ValidationError('Enter a valid card number.', 'card_number');
  let sum = 0;
  for (let i = 0; i < number.length; i++) {
    let d = Number(number[number.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  if (sum % 10) throw new ValidationError('That card number is not valid.', 'card_number');
  const m = /^(0[1-9]|1[0-2])\s*\/\s*(\d{2})$/.exec(String(b.expiry || '').trim());
  if (!m) throw new ValidationError('Enter the expiry date as MM/YY.', 'expiry');
  const exp = new Date(2000 + Number(m[2]), Number(m[1]), 1); // first day of the month after expiry
  if (exp <= new Date()) throw new ValidationError('That card has expired.', 'expiry');
  if (!/^\d{3,4}$/.test(String(b.cvc || '').trim())) throw new ValidationError('Enter the 3 or 4 digit security code.', 'cvc');
  text(b.name, { field: 'name', label: 'Name on card', min: 2, max: 80, required: true });
  return { last4: number.slice(-4), declined: number === '4000000000000002' };
}

function rating(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new ValidationError('Choose a rating from 1 to 5 stars.', 'rating');
  return n;
}

function normalisePostcode(value) {
  const m = UK_POSTCODE_RE.exec(String(value || '').trim());
  return m ? `${m[1].toUpperCase()} ${m[2].toUpperCase()}` : '';
}

module.exports = {
  CATEGORIES, ROLES, UK_BOUNDS, ValidationError,
  text, email, password, role, category, coordinates, imageUrl, eventDate, eventTime, id, pricePence, capacity, rating, localDateTime, earlyBird, promoCode, percentOff, testCard,
  isValidCoordinate, inUk, todayIso, nowTime, normalisePostcode, UK_POSTCODE_RE
};
