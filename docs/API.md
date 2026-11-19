# Community Connect — API guide

Base URL: `http://localhost:3000/api`. All requests and responses use JSON.

**Authentication:** send `Authorization: Bearer <token>`. The token comes from register or login and lasts 7 days.
**Errors:** `{ "error": "Human readable message", "field": "name-of-invalid-field" }` (`field` only for validation errors).

| Status | Meaning |
|---|---|
| 400 | Invalid input (see `field`) or invalid ID |
| 401 | Not logged in, invalid or expired token |
| 403 | Logged in but wrong role, not the owner, or not a member (`code: "MEMBERSHIP_REQUIRED"`) |
| 404 | Community / event / route not found |
| 409 | Duplicate (email, community name, event) |
| 413 | Request or image too large |
| 429 | Too many requests (rate limit) |
| 503 | Location service temporarily unavailable |

Access: 🌐 public · 🔑 any logged-in user · 🧑 participant only · 🛠 organizer only. "Optional login" means the response adds personal flags (`joined`, `registered`) when a token is sent.

## System
| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/health` | 🌐 | `{ status: "ok", database: "ok", time }` |
| GET | `/meta` | 🌐 | `{ categories: [...], maxUploadMb }` |

## Authentication
| Method | Path | Access | Body / notes |
|---|---|---|---|
| POST | `/auth/register` | 🌐 | `{ name, email, password, role: "participant" \| "organizer" }` → **201** `{ user, token }`. Password ≥ 8 chars with a letter and a number. 409 if the email exists. |
| POST | `/auth/login` | 🌐 | `{ email, password, role? }` → `{ user, token }`. 401 wrong credentials. If `role` is given and differs from the account's role → 403. |
| GET | `/auth/me` | 🔑 | `{ user: { id, name, email, role } }` |

Logout is client-side (the token is discarded).

## Location search
| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/locations/search?q=TEXT&mode=suggest\|search` | 🌐 | UK towns, cities, full postcodes (`TS1 3BX`), districts (`TS1`). `suggest` (autocomplete) uses postcodes.io only. `search` (explicit submit) may also use Nominatim, throttled to 1 req/s. → `{ results: [{ label, name, type, lat, lon, source, postcode?, area? }], source, message? }`. Unknown postcode → `results: []` and a `message`. |

## Communities
| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/communities` | 🌐 (optional login) | Query: `lat`, `lon`, `radius` (1–50 miles, default 10), `category`, `q` (text). With coordinates, results are filtered by real distance and sorted nearest first, each with `distance_miles`. → `{ communities, count, origin?, radius? }` |
| GET | `/communities/:id` | 🌐 (optional login) | `{ community, events }` (`events` = upcoming events of this community) |
| POST | `/communities` | 🛠 | `{ name, category, description, story?, town, address?, postcode?, latitude?, longitude?, image_url? }` → **201** `{ community }`. If no coordinates are sent, the server geocodes postcode / address / town. Coordinates must be in the UK. `image_url` must be `https://…` or an uploaded `/uploads/…` path. |
| PUT | `/communities/:id` | 🛠 owner | Same body as POST → `{ community }` |
| DELETE | `/communities/:id` | 🛠 owner | Deletes the community and (cascade) its events, memberships and registrations |
| POST | `/communities/:id/join` | 🧑 | **201** joined, or **200** `{ already_member: true }` |
| DELETE | `/communities/:id/join` | 🧑 | Leave; also cancels your registrations for its events |

Community object: `id, name, category, description, story, town, address, postcode, latitude, longitude, image_url, status, organizer_name, member_count, upcoming_event_count, joined, is_owner, distance_miles?, created_at, updated_at`.

Categories: `Technology`, `Sports & Fitness`, `Social`, `Faith`, `Volunteering`, `Arts & Hobbies`.

## Events
| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/events/public` | 🌐 (optional login) | Upcoming published events, soonest first. Query: `community_id`, `limit` (≤200). `/events` is an alias. |
| GET | `/events/:id` | 🌐 (optional login) | `{ event }` (also returns past events, with `is_past: true`) |
| POST | `/events` | 🛠 owner of community | `{ community_id, name, event_date: "YYYY-MM-DD", event_time: "HH:MM", venue, description?, image_url?, price? (standard, pounds), capacity?, early_price?, early_until? ("YYYY-MM-DDTHH:MM"), early_limit? }` → **201** `{ event }`. The date must be real, today or later (up to 2 years); a time today must not have passed. |
| PUT | `/events/:id` | 🛠 owner | Edit an event (same body as POST, without `community_id`). Capacity can't go below current bookings. |
| POST | `/events/:id/repeat` | 🛠 owner | **Run again**: copies the event to the next free week (or `{ event_date }`) → **201** `{ event }` |
| DELETE | `/events/:id` | 🛠 owner | Deletes the event and its registrations |
| GET | `/events/:id/calendar.ics` | 🌐 | Add-to-calendar file (iCalendar) |
| GET | `/events/:id/attendees` | 🛠 owner | `{ event, attendees: [{ user_id, name, email, attended, amount_pence, rating }] }` |
| PUT | `/events/:id/attendees/:userId` | 🛠 owner | `{ attended: true\|false }` — only after the event has started |
| POST | `/events/:id/attendees/all` | 🛠 owner | Mark every registered person as attended |
| POST | `/events/:id/feedback` | 🧑 attended | `{ rating: 1-5, comment? }` — one rating per person, can be updated |
| GET | `/events/:id/quote?promo_code=` | 🌐 | Current price: `{ quote: { ticket_type, list_price_pence, discount_pence, amount_pence, promo } }`; invalid code → 400 |
| POST | `/events/:id/checkout` | 🧑 member | `{ promo_code? }` → paid: holds a place 30 min, **201** `{ checkout_url, mode: "demo"\|"stripe", quote }`; total £0 (free or 100% code): registers straight away |
| GET | `/payments/:ref` | 🧑 owner | Order summary for the checkout/ticket page (`expires_at` while pending, `ticket_number` when paid) |
| POST | `/payments/demo/:ref` | 🧑 owner | Demo mode: `{ name, card_number, expiry: "MM/YY", cvc }` → paid; `4000 0000 0000 0002` → 402 `CARD_DECLINED` |
| POST | `/payments/stripe/confirm` | 🧑 owner | Stripe mode: `{ session_id }` → checks with Stripe that the Checkout Session is paid and the amount matches |
| GET / POST | `/events/:id/promo-codes` | 🛠 owner | List (with uses and discount given) / create `{ code, percent_off: 5-100, max_uses? }` |
| DELETE | `/events/:id/promo-codes/:codeId` | 🛠 owner | Delete a promo code |
| POST | `/events/:id/register` | 🧑 member | Free events only (paid events → **402** `PAYMENT_REQUIRED`, use checkout). **201** registered, **200** `{ already_registered: true }`, **403** `MEMBERSHIP_REQUIRED`, **409** `EVENT_FULL`, **400** past event |
| DELETE | `/events/:id/register` | 🧑 | Cancel a free registration or release an unpaid hold (paid tickets → 400 `PAID_TICKET`; not after the event has started) |

Event object: `id, community_id, name, event_date, event_time, starts_at, early_price_pence, early_until, early_limit, early_left, early_active, current_price_pence, ticket_type_now, has_promo_codes, payment_mode, my_ticket, venue, description, image_url, price_pence, capacity, spots_left, is_full, avg_rating, rating_count, community_name, community_town, community_category, community_image_url, registration_count, registered, is_member, is_owner, is_past, has_started, attended, my_rating` — plus `attended_count, revenue_pence` for the event's organizer only.

## Dashboards
| Method | Path | Access | Returns |
|---|---|---|---|
| GET | `/organizer/communities` | 🛠 | Your communities with `member_count`, `event_count` |
| GET | `/organizer/events` | 🛠 | Events of your communities with `registration_count` |
| GET | `/participant/communities` | 🧑 | Communities you joined |
| GET | `/participant/events` | 🧑 | Events you registered for (upcoming first, then past) |
| GET | `/participant/recommendations` | 🧑 | Up to 3 communities you haven't joined, with `reasons` |
| GET | `/organizer/analytics?months=6\|12` | 🛠 | `summary` (revenue, registrations, attendance rate, rating, members…), `sales_by_type`, `promo_usage`, `per_event`, `monthly` (registrations, attended, revenue), `member_growth`, `by_community`, `upcoming` (fill rate) |

## Uploads
| Method | Path | Access | Notes |
|---|---|---|---|
| POST | `/uploads` | 🛠 | `{ image: "data:image/jpeg;base64,…" }` → **201** `{ url: "/uploads/<random>.jpg", bytes }`. JPG/PNG/WebP/GIF, ≤ 4 MB, verified by file signature. Use the returned `url` as `image_url`. |

## Example (curl)

```bash
# Register an organizer and keep the token
curl -s -X POST localhost:3000/api/auth/register -H "Content-Type: application/json" \
  -d '{"name":"Olivia","email":"olivia@example.com","password":"Organise123","role":"organizer"}'

# Create a community (coordinates looked up from the town)
curl -s -X POST localhost:3000/api/communities -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Linthorpe Coders","category":"Technology","description":"Weekly coding evenings.","town":"Middlesbrough"}'

# Communities within 5 miles of Middlesbrough
curl -s "localhost:3000/api/communities?lat=54.5742&lon=-1.2348&radius=5"
```


## v5 endpoints

| Method & path | Who | What |
|---|---|---|
| `GET /api/events/trending` | anyone | `{ featured, trending, deals }` — up to 6 upcoming events each |
| `POST /api/events/:id/featured` `{ featured: true\|false }` | owner organizer | Show on the homepage |
| `POST /api/events/:id/flash-sale` `{ percent: 5–90, hours: 1–168, notify? }` | owner organizer | Start/restart a flash sale; members are notified |
| `DELETE /api/events/:id/flash-sale` | owner organizer | End it now |
| `GET /api/events/:id/quote?ref=CODE` / `POST /checkout { referral_code }` | participant | "Bring a friend" 10% discount |
| `POST /api/events/:id/waitlist` / `DELETE` | participant (member) | Join / leave the waitlist of a full event |
| `GET /api/checkin/:code` | owner organizer | Look up a ticket from its QR code |
| `POST /api/checkin/:code` | owner organizer | Check the holder in (`already: true` if scanned before; 400 `CHECKIN_NOT_OPEN` more than 36 h before) |
| `GET /api/notifications` | logged in | Latest 30 + `unread` count (adds 24-hour reminders) |
| `POST /api/notifications/read-all`, `POST /api/notifications/:id/read` | logged in | Mark read |

Event objects now also include `badges`, `featured`, `flash_percent`, `flash_until`, `flash_active`, `waitlist_count`, `my_waitlist`, `checkin_open`, and `my_ticket.ticket_code / referral_code / checked_in`. Analytics adds `qr_checkins`, `referrals`, `referral_total`, `referral_revenue_pence`, `waitlist_total`.


## v6 endpoints

| Method & path | Who | What |
|---|---|---|
| `POST /api/auth/login` | anyone | Also logs in the platform admin (`role: "admin"`, negative id) |
| `GET /api/auth/config` | anyone | `{ google_client_id, platform_fee_percent }` |
| `POST /api/auth/google` `{ credential, role? }` | anyone | Continue with Google: verifies the Google ID token; creates (201, `created: true`) or logs in an account |
| `GET /api/admin/overview?months=6` | admin | Summary (people, events, tickets, gross, platform revenue, refunds, payouts pending/ready/paid), `monthly`, `top_organizers`, `top_communities`, `recent_users`, `payouts`, `payout_totals` |
| `POST /api/admin/payouts/:id/pay` `{ reference? }` | admin | Mark a ready payout as paid (409 if already paid); notifies the organizer |
| `POST /api/events/:id/cancel` `{ reason? }` | owner organizer | Cancel an upcoming event: refunds paid tickets, cancels free places, notifies everyone; booking it afterwards returns 410 `EVENT_CANCELLED` |

Organizer analytics adds `earnings: { fee_percent, gross_pence, fee_pence, net_pence, pending_pence, ready_pence, paid_pence, payouts[] }`. Events add `is_cancelled`, `cancel_reason`, `cancelled_at`; `my_ticket.payment_status` can be `refunded` / `cancelled`.
