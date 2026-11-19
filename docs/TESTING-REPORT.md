# Community Connect — Testing report

Date: 19 November 2026 · Version 6.0.0 (admin, commission & payouts) — first issued 6 November 2026

## Summary

| Suite | Result |
|---|---|
| Syntax and file check (`npm run check`) | ✅ all JS files parse |
| Automated API tests (`npm test`) | ✅ **67 / 67 passed** (49 + 11 v5 + 7 v6 tests) |
| Browser end-to-end tests (`node test/e2e.browser.js`, Chromium) | ✅ **53 / 53 passed** (incl. admin dashboard on tablet and mobile) |
| QR codes decoded by an independent reader (OpenCV) | ✅ 6 / 6 texts (5–300 characters) decoded exactly |
| Failed tests remaining | **0** |

### ⚠️ Test environment — please read

The build environment had **no access to the npm registry**, so `npm install` could not run there. To still execute the real server code, the four npm packages were replaced *during testing only* with small stand-ins that behave the same way:

- `better-sqlite3` → Node's built-in `node:sqlite` (the same SQLite engine)
- `bcryptjs` → scrypt hashing
- `jsonwebtoken` → standard HS256 JWTs
- `express` → a minimal Express-compatible router

The stand-ins are **not** part of the project. Every line of project code, every SQL statement and the whole frontend ran for real. The geocoding services were replaced by a local fake (the tests do this on purpose so they are repeatable and never hit the real services).

**Run these on your own computer to confirm with the real packages and live services:**

```bash
npm install
npm test                    # expect: # pass 67, # fail 0
npm start                   # then open http://localhost:3000 and http://localhost:3000/api/health
```

Then check live location search by hand: type `Middles`, `TS1 3BX` and `Leeds` in the discovery search box.

---

## Version 6 — admin dashboard, commission & payouts, cancellation, Google sign-in

| Feature | API tests (`test/v6.test.js`) | Browser test |
|---|---|---|
| Admin login & access | ✅ correct/incorrect password, negative id, admin area 403 for organizers/participants and 401 logged out, admin cannot act as organizer/participant, admin email cannot be registered | ✅ login from the homepage redirects to the admin dashboard; tablet & mobile without overflow |
| Platform fee | ✅ 10% of £25 = £2.50 fee, £22.50 organizer share, rate stored per ticket; organizer earnings totals | ✅ organizer *Your earnings & payouts* |
| Payouts | ✅ pending before the event, ready after, admin marks paid (reference kept, 403 for others, 409 twice, 404 unknown), organizer notified, paid payouts frozen | ✅ *Mark as paid* moves the row to Paid |
| Cancellation & refunds | ✅ owner only, refunds paid tickets, refunded tickets lose their QR code, notifications, hidden from listings, booking returns 410, no payout, past events refused | ✅ cancel from *My events*; participant sees the cancelled banner and refund |
| Continue with Google | ✅ new participant, new organizer, existing account linked (keeps its role), wrong audience / unverified email / forged token refused, malformed 400, disabled cleanly without a client id | (needs a real Google client id) |
| Show / hide password | — | ✅ eye button toggles and labels change |
| Extra demo content | ✅ new events, 3 organizers with sales, paid/ready/pending payouts, monthly figures | ✅ used throughout |

## Version 5 — QR tickets, door check-in, promotion, waitlist, notifications, map

| Feature | API tests (`test/v5.test.js`) | Browser test |
|---|---|---|
| QR e-ticket (secret 24-hex code, unique, hidden from others) | ✅ code + referral code issued on payment; not visible to other users | ✅ QR on payment page, event page and dashboard modal |
| QR encoder | ✅ matrix size and finder patterns | ✅ OpenCV decoded every generated code exactly |
| Door check-in | ✅ owner only (other organizer / participant 403, logged out 401), invalid code 404, unpaid hold 404, not open >36 h before (400), second scan → `already` | ✅ scan link → green “Welcome, Priya · 1 of 10”, re-scan → amber, nonsense → red |
| Bring a friend | ✅ 10% off, no self-referral, bad code ignored, referrer notified, analytics totals | ✅ invite link shown after purchase |
| Flash sale | ✅ validation, owner only, free events refused, cheapest of flash / early bird wins, members notified, ends on demand | ✅ started from *My events*; price switches to flash sale |
| Featured & trending | ✅ toggle validated + owner only, appears/disappears on homepage lists | ✅ Trending / Featured / Deals tabs with badges |
| Waitlist | ✅ positions, full-event refusal, freed place offered and held (others refused), booking clears the entry, capacity increase offers next | (API) |
| Notifications | ✅ ticket, referral, waitlist offer, flash sale, new event, check-in, one-off 24 h reminder, read / read-all, privacy | ✅ bell badge, list, mark all read |
| Map view | — | ✅ pins, popup, zoom (map tiles need internet) |
| Demo data | ✅ next-day event with 9 tickets, featured event, live flash sale | ✅ used throughout |

## Version 4 — payments, early bird, promo codes, countdown

| Feature | API tests | Browser test |
|---|---|---|
| Paid events can't be booked without paying (402); checkout holds a place; others can't take it (409) | ✅ | ✅ |
| Demo card checks: invalid number (Luhn), expired, bad CVC, missing name → 400; declined test card → 402; good card → paid | ✅ | ✅ declined then paid, e-ticket shown |
| Full card number never stored | ✅ | — |
| Paid tickets can't be cancelled online; unpaid holds can be released | ✅ | — |
| Unpaid holds expire after 30 minutes and free the place | ✅ | — |
| Early-bird validation (cheaper than standard, has an end, ends in future and before the event, limit ≥ 1, needs a standard price) | ✅ | ✅ form error then success |
| Early bird switches to standard when its ticket limit is reached | ✅ | — |
| Promo codes: only owner can manage; format and % checked; duplicate 409; max uses enforced; 100% code books without payment | ✅ | ✅ wrong code rejected, STUDENT20 → £4.80 |
| Run again copies early-bird timing (same gap) and promo codes | ✅ | — |
| Analytics: sales by ticket type and promo usage (paid only) | ✅ | ✅ |
| **Stripe mode** against a fake Stripe server: correct Checkout Session (GBP, amount in pence, return URLs, customer email), demo payments disabled, unpaid session → 402, paid session confirmed | ✅ | — |
| Countdown timers tick on event page and cards | — | ✅ |
| Leaving a community keeps paid tickets | ✅ | — |

**Bugs found while testing version 4 and fixed:** horizontal bar charts had different track lengths (bars weren't comparable); the card form's security-code box overflowed; charts tried to draw at near-zero width (negative SVG sizes) when hidden; a re-opened checkout with a single-use promo code counted the buyer's own hold.

**Not tested live:** real Stripe (no internet here). The Stripe code was tested against a fake Stripe server that checks the exact request; try it yourself with a free Stripe *test* key.

## Version 3 — analytics, run again, prices and attendance

| Feature | API tests | Browser test |
|---|---|---|
| Ticket price and capacity stored; invalid price (text, negative, over £500) and capacity (0, decimals) rejected | ✅ | ✅ price and places shown on cards and event page |
| Registration records the price paid; revenue visible only to the organizer | ✅ | ✅ |
| Capacity enforced — the next person gets 409 "event is full" | ✅ | — |
| Edit event; capacity can't go below bookings; other organizers/participants blocked (403) | ✅ | ✅ |
| **Run again** copies name, time, venue, price, capacity to the next free week; repeats skip weeks already taken; custom date; past date rejected; non-owners blocked | ✅ | ✅ one click from My events |
| Add-to-calendar `.ics` file valid (VCALENDAR, VEVENT, SUMMARY, DTSTART) | ✅ | ✅ |
| Attendance only after the event starts, only by the owner; check-in time saved | ✅ | ✅ tick a person, count updates |
| Cancelling after an event has started is refused | ✅ | — |
| Ratings only by people marked attended; 1–5 enforced; one rating per person, updatable | ✅ | ✅ "Rate it" → 4 stars → thanks |
| **Analytics** totals checked exactly against known data (attendance 100%, revenue £5 past + £7.50 booked, rating 5, fill rate 20%), 6 and 12-month periods, empty organizer, role checks | ✅ | ✅ 4 SVG graphs + 2 bar lists render, tooltip shows registered/attended/revenue/rating, period switch, CSV download |
| Demo organizer has realistic history (attended ≤ registered for every event) | ✅ | ✅ |
| Recommendations exclude joined communities and give reasons | ✅ | ✅ shown in participant dashboard |
| Data (attendance, ratings, payments) survives a server restart | ✅ | — |
| Old databases upgrade through migration 3 without data loss | ✅ | — |
| Analytics on tablet and phone — no horizontal overflow | — | ✅ |

**Chart colours** were checked with a colour-blindness validator: green `#1f8a70` and orange `#d0662c` pass all checks (lightness, chroma, colour-blind separation ΔE 8.4, normal-vision ΔE 23.4, contrast ≥ 3:1). Every chart also has a legend, hover tooltip and a data table, so nothing relies on colour alone.

**Bugs found while testing version 3 and fixed:** the community form's submit code was accidentally removed during the edit-event change (caught by the browser test, restored and verified against the original); the wide analytics table stretched the tablet layout by 375 px; tooltip colour keys were missing; the per-event chart was crowded on phones (now shows the last 6 events there); a past event was labelled "Went" while showing registrations.

**Payments:** ticket revenue is *recorded*, not charged. No payment provider is connected, so no real money moves.

## Test A — Organizer

| # | Step | API test | Browser test |
|---|---|---|---|
| 1 | Register a new organizer | ✅ | ✅ (with a too-short password rejected first) |
| 2 | Log in | ✅ | ✅ |
| 3 | Create a community | ✅ | ✅ |
| 4 | Add a photograph (upload, saved in `data/uploads`) | ✅ | ✅ |
| 5 | Location from autocomplete / looked up from the town | ✅ | ✅ (lat/lon filled from suggestion) |
| 6 | Community saved in SQLite (row checked directly) | ✅ | — |
| 7 | Publish an event | ✅ | ✅ |
| 8 | Event appears in `GET /api/events/public` with all fields, no login | ✅ | ✅ |
| 9 | Community appears in public discovery after logout | ✅ | ✅ |

## Test B — Participant

| # | Step | Result |
|---|---|---|
| 1–2 | Register / log in as a different participant | ✅ |
| 3 | Search a UK town (`Middles` → Middlesbrough suggestion) | ✅ |
| 4 | Search a postcode (`TS1 3BX`), keyboard selection of suggestion | ✅ |
| 5 | Select an autocomplete suggestion → results really filtered by its coordinates | ✅ |
| 6–7 | Distance filter 10 → 50 → 1 miles changes results; sorted nearest first; all within radius | ✅ |
| 8 | Open community story; uploaded photo shown whole (`object-fit: contain`; red-border test image visible on all four sides) | ✅ |
| 9 | Join → asked to register → account created → joined automatically | ✅ |
| 10 | Membership saved in SQLite; duplicate join does not create a second row | ✅ |
| 11 | View public events (no login) | ✅ |
| 12 | Register for the event | ✅ |
| 13 | Registration saved in SQLite; duplicate prevented | ✅ |
| 14 | Event appears in the participant dashboard | ✅ |
| — | Visitor flow from an event page: register → step 1 join → step 2 register | ✅ |
| — | Persistent login (page reload keeps the user signed in) | ✅ |

## Test C — Persistence

| Step | Result |
|---|---|
| Stop server, restart on the same database | ✅ |
| Log in again; accounts, communities, memberships, events and registrations all present | ✅ (API and browser) |
| A token issued before the restart is still valid | ✅ |
| Starter data is not inserted a second time | ✅ |
| Database from the **original starter project** is upgraded by the migrations without data loss | ✅ |

## Test D — Permissions (all enforced by the backend)

| Check | Result |
|---|---|
| Participant cannot create communities (403) | ✅ |
| Participant cannot publish events (403) | ✅ |
| Organizer cannot join communities or register for events (403) | ✅ |
| Organizer cannot edit, delete or add events to another organizer's community (403) | ✅ |
| Organizer cannot delete another organizer's event (403) | ✅ |
| Logged-out visitors get 401 on all 9 protected endpoints | ✅ |
| Invalid or garbage tokens rejected (401) | ✅ |
| Tampered token payload (forged role) rejected (401) | ✅ |
| Participant/organizer dashboards reject the wrong role (403) | ✅ |
| UI: each role is kept out of the other role's space | ✅ |

## Test E — Errors

| Case | Result |
|---|---|
| Duplicate email (case-insensitive) → 409 + message (API and UI) | ✅ |
| Incorrect password / unknown email → 401 "Email or password is incorrect" (UI) | ✅ |
| Missing form fields, bad email, weak password, bad role → 400 with the field named | ✅ |
| Invalid postcode (`ZZ99 9ZZ`) → friendly message in the UI | ✅ |
| Invalid event date: past, 30 Feb, wrong format, >2 years ahead, bad time → 400 (UI highlights field) | ✅ |
| Invalid community ID (`abc`, `1;DROP TABLE users`) → 400; unknown → 404; not-found page in UI | ✅ |
| Invalid event ID → 400 / 404; not-found page in UI | ✅ |
| SQL-injection text in search is treated as plain text | ✅ |
| Invalid / non-UK coordinates, `http://` or `javascript:` image links → 400 | ✅ |
| Fake image (non-image bytes) upload → 400; oversized → 413 | ✅ |
| Malformed JSON → 400; oversized body → 413; unknown API route → 404 JSON | ✅ |
| Database error: damaged database file → clear message, server exits safely, **file left untouched** | ✅ |
| Network error: API unreachable → "could not reach the server" message with **Try again** button | ✅ |
| Geocoding service down → offline UK town list used; unknown place → 503 with message | ✅ |
| Server files (`server.js`, `.env`, `src/`, database) not downloadable from the browser | ✅ |

## Location search compliance

| Check | Result |
|---|---|
| Autocomplete never calls Nominatim | ✅ |
| Nominatim calls are at least 1 second apart, even when two are requested at once (measured 1100 ms) | ✅ |
| Identifying User-Agent sent | ✅ |
| Repeated searches served from cache (no repeat call to the provider) | ✅ |
| Non-UK results discarded | ✅ |

## Responsive layout

Checked automatically at **1366 px (desktop)**, **820 px (tablet)** and **390 px (mobile)** on the home page, discovery (with the autocomplete open), community story, event page and organizer dashboard. Result: no horizontal overflow and no JavaScript errors. Screenshots are in `docs/screenshots/`.

## Bugs found and fixed during testing

1. The original organizer dashboard crashed: `organizerEventList` was referenced but missing from the HTML. The panel was added.
2. The original server served the **whole project folder**, so `server.js` and the SQLite database could be downloaded. The frontend was moved to `public/`.
3. The JWT secret was hardcoded. It's now set by an environment variable, with a generated development secret.
4. `/api/events/public` did not exist. Community photos and stories were stored only in browser `sessionStorage`, not the database.
5. Login and registration forms moved focus after a delay, so fast typing landed in the wrong field. Focus is now set immediately.
6. Changing only the URL hash (e.g. `#events`) on an open page did nothing. A `hashchange` router was added.
7. At tablet width a logged-in user's header overflowed by 3 px on the detail pages. Fixed.
8. `better-sqlite3@^11` has no prebuilt binaries for Node 24 LTS, so `npm install` on Windows would try to compile C++. Upgraded to `^12`.
9. Card meta showed the member count twice when no location was chosen. Fixed.

## Not tested here (please check locally)

- `npm install` / `npm start` with the real npm packages (see the environment note above).
- Live responses from postcodes.io and Nominatim. The parsing follows their documented formats and was tested against a faithful fake.
- `START-WINDOWS.bat` (no Windows machine available).
- "Use my location" (browser geolocation needs a real device and permission).
- Real Unsplash photos (no internet in the test environment; the fallback image was verified instead).
- Safari and Firefox (only Chromium was automated).
