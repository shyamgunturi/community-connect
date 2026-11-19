# Community Connect

A location-based community discovery platform. Visitors explore local communities and public events without an account; **participants** join communities and register for events; **organizers** publish communities (with photographs) and events.

**Stack:** Node.js · Express 4 · SQLite (better-sqlite3) · JWT authentication · bcrypt password hashing · vanilla HTML/CSS/JS frontend.

---

## 1. Requirements

- **Node.js 22 LTS or 24 LTS** (minimum 20). Download from <https://nodejs.org> (choose "LTS").
- An internet connection for `npm install`, the Unsplash starter photos and live location search. Without internet the app still runs: location search falls back to a built-in list of about 60 UK towns.

## 2. Quick start

```bash
npm install
npm start
```

Open **http://localhost:3000**. The health check is at **http://localhost:3000/api/health**.

On Windows you can instead double-click **`START-WINDOWS.bat`**. It checks Node.js, runs `npm install` the first time, opens your browser and starts the server.

Stop the server with **Ctrl + C**. Your data stays in `data/community-connect.sqlite`.

## 3. Opening the project in VS Code

1. Unzip the project to a folder such as `Documents\community-connect`. Do **not** run it from inside the ZIP.
2. Open VS Code → **File → Open Folder…** → select the `community-connect` folder (the one containing `package.json`) → **Select Folder**. If asked, choose **Yes, I trust the authors**.
3. Open a terminal: **Terminal → New Terminal** (or <kbd>Ctrl</kbd> + <kbd>`</kbd>).
4. Run `node -v` and check it prints v20 or higher.
5. Run `npm install`, then `npm start`.
6. <kbd>Ctrl</kbd>-click `http://localhost:3000` in the terminal output.
7. Optional: copy `.env.example` to `.env` to change settings (see section 7).

To run the automated tests: `npm test` (uses a temporary database — your real data is never touched).

## 4. Project structure

```
community-connect/
├── server.js               Entry point (npm start)
├── src/
│   ├── app.js              Express app: all API routes, auth, permissions, uploads
│   ├── db.js               SQLite connection, migrations, starter data
│   ├── config.js           Settings from environment / .env
│   ├── validation.js       Input validation rules
│   ├── geocode.js          UK location search (postcodes.io + Nominatim fallback, cache, throttle)
│   ├── gazetteer.js        Offline fallback list of UK towns
│   └── security.js         Security headers, rate limiting
├── public/                 Everything the browser can see (only this folder is served)
│   ├── index.html          Homepage, discovery, participant + organizer dashboards
│   ├── community.html      Community story page   (community.html?id=1)
│   ├── event.html          Public event page      (event.html?id=1)
│   ├── styles.css, detail-pages.css
│   ├── images/community-fallback.svg
│   └── js/ common.js, app.js, detail-shared.js, community-page.js, event-page.js
├── data/                   SQLite database + uploaded photos (created automatically)
├── test/                   api.test.js (npm test), e2e.browser.js (optional browser test)
├── docs/                   API guide, testing report, screenshots
├── .env.example            Configuration template
└── START-WINDOWS.bat       One-click start for Windows
```

## 5. How to demonstrate it

**Starter data:** on first run, with an empty database, 7 communities (Middlesbrough, Stockton, Yarm, Newcastle) and 4 upcoming events are added as real SQLite records. Turn this off with `SEED_DEMO_DATA=false`. They belong to `demo-organizer@communityconnect.local`; set `SEED_ORGANIZER_PASSWORD` in `.env` **before the first run** if you want to log in as that organizer.

Suggested demo:

1. **Visitor** — Home → *Explore communities*. Type `Middles`, pick **Middlesbrough** from the suggestions, move the distance slider, change the category. Try a postcode such as `TS1 3BX`.
2. **Organizer** — *Organizer* → *Create an organizer account to publish*. Create a community: start typing the town and pick a suggestion (this fills the map position), upload a photo, then **Publish community**. Then **Publish an event**. Log out.
3. **Participant** — *Events* → open your event → *Log in / Register to take part* → create a participant account → **Join** (step 1) → **Register** (step 2). *My dashboard* shows the community and the event.
4. **Persistence** — stop the server (Ctrl+C), `npm start` again, log in: everything is still there.

## What's new in v6 — admin dashboard, commission & payouts

| Feature | Where | How it works |
|---|---|---|
| **Platform admin** | `admin.html` — log in as `admin@communityconnect.local` / `Admin12345` (development; set `ADMIN_PASSWORD` in production) | Admins live in their own `admins` table and get an admin-only token. Dashboard: participants, organizers, communities, events, tickets, attendance, gross sales, **platform revenue**, money held, ready to pay, paid out, refunds, monthly charts, top organizers/communities, newest sign-ups. |
| **Commission (platform fee)** | Every paid ticket | The customer pays Community Connect. Each paid ticket stores `platform_fee_pence` (10% by default, `PLATFORM_FEE_PERCENT`), `organizer_net_pence` and the rate used, so changing the rate never changes old sales. |
| **Organizer payouts** | Admin → *Organizer payouts*; organizer → *Analytics → Your earnings & payouts* | Status: **Pending** (event not held yet — money held) → **Ready** (event finished) → **Paid** (admin clicks *Mark as paid*, with an optional bank reference; the organizer gets a 🔔 notification). Paid payouts are frozen. |
| **Cancel event with refunds** | Organizer → *My events → Cancel event* | Every paid ticket is refunded (Stripe refunds in Stripe mode), free places are cancelled, everyone (and the waitlist) is notified, the event disappears from listings and no payout is created. |
| **Continue with Google** | Every login form | Google Identity Services button; the server verifies the Google ID token (audience = our client id, verified email). New emails get an account, existing ones are linked. Hidden until `GOOGLE_CLIENT_ID` is set. |
| **Show / hide password** | Every password field | Eye button toggles the password; it hides again after submitting. |
| **More demo data** | Everywhere | 10 more upcoming events across all communities, and two more organizers (Sara Khan — Leeds Board Gamers, Tom Reed — Durham Photo Walks) with past sales and payout history. Added automatically to existing databases too. |

**In a real business** the money would go through **Stripe Connect** (organizers connect their own Stripe account; Stripe holds the funds, deducts our fee and pays out), because holding other people's money can need financial authorisation. The demo uses the same calculations and statuses without real money.

### Setting up Continue with Google (10 minutes)
1. Go to https://console.cloud.google.com → create a project (e.g. *Community Connect*).
2. *APIs & Services → OAuth consent screen* → External → app name, your email → Save (testing mode is fine; add your own Google account as a test user).
3. *APIs & Services → Credentials → Create credentials → OAuth client ID* → **Web application**.
4. *Authorised JavaScript origins*: `http://localhost:3000` and your Render URL (e.g. `https://community-connect-xxxx.onrender.com`). No redirect URI is needed.
5. Copy the **Client ID** (ends in `.apps.googleusercontent.com`) into `.env` as `GOOGLE_CLIENT_ID=…` and into Render → *Environment*. Restart / redeploy.

## What's new in v5 (presentation build)

| Feature | Where to see it | How it works |
|---|---|---|
| **QR e-tickets** | After paying (payment page), event page, *My dashboard → 🎟 QR ticket* | Every booking gets a secret random 24-character `ticket_code`. The QR code (drawn by our own encoder, `public/js/qr.js`, no library) holds the link `…/checkin.html?code=…`. Download as SVG or print. |
| **Door check-in by scanning** | Organizer: *My events → 📷 Scan tickets* or open `checkin.html` | Scan with the laptop/phone camera (BarcodeDetector) or the phone's camera app, or type the code. Green = checked in, amber = already used, red = invalid / another organizer's event. Opens 36 h before the start. Attendance and analytics update instantly. |
| **Featured & trending** | Homepage *Hot right now* (🔥 Trending / ★ Featured / ⚡ Deals) | Trending = most bookings in the last 48 h + how full. Organizer: *My events → ☆ Feature*. Badges: Featured, Flash sale, Selling fast, Only X left, Sold out, New. |
| **Flash sale** | Organizer: *My events → ⚡ Flash sale* | Choose % off and how long; members get a notification; a live countdown appears. The cheapest live price wins (flash sale vs early bird vs standard). |
| **Bring a friend** | After buying a ticket | Personal link `event.html?id=…&ref=CODE`. The friend gets 10% off (not combined with promo codes); the referrer is notified; analytics shows top referrers and referral revenue. |
| **Share buttons** | Every event page | WhatsApp, Facebook, X, LinkedIn, copy link and the phone's share sheet. |
| **Waitlist** | Event page when full | Join the queue and see your position. When someone cancels (or capacity is raised) the first person gets a 🔔 notification and the place is held for 2 hours. |
| **Notifications bell 🔔** | Header on every page when logged in | Ticket confirmed, friend booked, waitlist offer, flash sale, new event in your community, checked in, and an automatic reminder 24 h before your event. |
| **Map view** | *Explore communities → 🗺 Map* | OpenStreetMap tiles drawn directly (no map library) with a pin per community; drag, zoom, click a pin for details. |

**Demo data for the presentation** (kept fresh automatically every time the server starts):
- *Open Evening & Networking* (Teesside Tech Collective) always takes place within the next ~26 hours, already has 9 paid tickets and promo code `OPEN50` — so QR check-in works live.
- *November Book Night* always has a live **40% flash sale** with a countdown.
- *Build Something Weekend* is **featured**.

**5-minute v5 demo:** register a participant → join *Teesside Tech Collective* → open *Open Evening* → buy (card 4242 4242 4242 4242) → QR ticket + invite link appear → open the 🔔 bell → log in as `demo-organizer@communityconnect.local` / `Demo12345` → *My events → 📷 Scan tickets* → scan the QR from your phone screen (or paste the code) → green tick, “1 of 10 checked in” → *Analytics* shows QR check-ins, referrals and waitlists.

## 6. Features and how they work

| Area | Implementation |
|---|---|
| Accounts | Participant / organizer registration, login, persistent login (token in `localStorage`), logout. Email unique (case-insensitive). Passwords: bcrypt, at least 8 characters with a letter and a number. |
| Roles | Enforced by the **backend**: organizers can't join or register; participants can't create communities or events; organizers can only edit or delete their own communities and events (403 otherwise). |
| Discovery | `GET /api/communities` with `lat`, `lon`, `radius` (1–50 miles) and `category`. The server filters by real distance (haversine) and sorts nearest first. |
| Location search | Autocomplete via `/api/locations/search` → **postcodes.io** (ONS / Ordnance Survey open data: towns, cities, full and partial postcodes). Pressing **Search**/Enter can also fall back to **Nominatim**, never for autocomplete, at most **1 request/second app-wide**, with a User-Agent and cached results, following the OSM usage policy. Results are cached on the server for 24 hours and in the browser. The browser debounces typing (320 ms) and cancels stale requests. |
| Photos | Organizers upload a JPG/PNG/WebP/GIF. It's resized in the browser to at most 1600 px, checked on the server by file signature, size-limited to 4 MB and stored in `data/uploads/`, or they paste an `https://` link. The URL is saved in the database. Every photo is shown **whole** (`object-fit: contain`) over a blurred copy of itself, so frames are consistent and nothing is cropped. Broken links fall back to a placeholder. |
| Events | Public previews (name, community, date, time, venue, description, photo) for everyone. Registration requires a participant account **and** membership of the community (checked by the server). Dates must be real, not in the past and at most two years ahead. |
| Dashboards | Participant: joined communities (leave), registered events (cancel). Organizer: stats, communities (view/edit/delete/add event), events with registration counts (view/delete). |

### New in version 3: analytics and organizer tools

| Feature | Where to find it | How it works |
|---|---|---|
| **Analytics dashboard** | Organizer → **Analytics** (opens first when you have events) | Key figures (revenue, registrations, attendance rate, rating, members, upcoming bookings) plus graphs: registered vs attended per past event, ticket revenue by month, attendance by month, member growth, revenue by community, and places booked for upcoming events. Hover any graph for details. Switch between 6 and 12 months. **Download CSV** exports the data. |
| **Run again** | Organizer → **My events** → **↻ Run again** (also in the analytics table) | One click copies the event — name, time, venue, description, photo, price and capacity — to the next free week. Edit it afterwards if needed. |
| **Edit events** | My events → **Edit** (upcoming events) | Change any detail. Capacity can't go below the number already booked. |
| **Ticket prices and revenue** | Price (£) when publishing an event | The price is recorded with each registration and shown as revenue in analytics. *Payments are recorded, not charged online — "pay on the day". Real card payments would need a provider such as Stripe.* |
| **Capacity** | Capacity when publishing an event | Shows "places left"; registration closes automatically when full (checked safely inside a database transaction). |
| **Attendance check-in** | My events → **Attendance** (after the event starts) | Tick who came, or **Mark everyone as attended**. This produces the attendance rate. |
| **Ratings** | Participant dashboard → **Rate it** | People marked as attended can give 1–5 stars and a comment. Average ratings appear in analytics and on the event page. |
| **Add to calendar** | Event page → **📅 Add to calendar** | Downloads an `.ics` file for Google, Outlook or Apple Calendar. |
| **Recommended for you** | Participant dashboard | Suggests up to 3 communities based on the categories you joined, distance and upcoming events. |

### New in version 4: ticket sales, promotion and payments

| Feature | Where to find it | How it works |
|---|---|---|
| **Online payment** | Event page → **Buy ticket** → checkout → e-ticket | Paid events are booked by paying online. Your place is held for 30 minutes while you pay. After payment you get an e-ticket (`CC-0018-00032`) saved in your dashboard. |
| **Early-bird pricing** | Organizer → Publish an event → *Tickets & promotion* | Set a standard price plus a cheaper early-bird price, when it ends, and (optionally) how many early-bird tickets. The price switches to standard automatically when time runs out or the tickets are gone. |
| **Countdown timers** | Event page (big timer), event cards (small timer) | "Early-bird price ends in 02 days 05 hrs…" and "Event starts in…", ticking every second to encourage people to book. |
| **Promo codes** | My events → **% Promo codes** | Create codes like `STUDENT20` (20% off), optionally limited to a number of uses. Buyers enter them in the ticket panel. |
| **Sales analytics** | Analytics → *Ticket sales by type*, *Promo codes used* | Revenue and tickets for early-bird vs standard, and which promo codes were used with the discount given. |
| **Run again** | (from v3) | Now also copies the early-bird timing (same gap before the event) and the promo codes. |

**Two payment modes:**
- **Demo mode (default — no setup, no real money).** A built-in test checkout. Use card `4242 4242 4242 4242`, any future expiry (e.g. `12/30`), any 3-digit code. `4000 0000 0000 0002` shows a declined card. Card details are checked, never stored.
- **Stripe (real card payments).** Create a free account at stripe.com, copy the **test** secret key (starts `sk_test_`) and set `STRIPE_SECRET_KEY` in `.env` or Render → Environment. Set `PUBLIC_URL` to your site address (e.g. `https://community-connect-xxxx.onrender.com`). Buyers are sent to Stripe Checkout and returned to `payment.html`, where the server confirms the payment with Stripe. Stripe test cards work the same way (`4242…`). Before taking real money, also add a Stripe webhook and terms/refund policy.

**Demo data for analytics:** a new, empty database gets 15 past events with registrations, attendance, revenue and ratings from 30 demo members. Log in as the demo organizer to see the graphs:
- Locally: `demo-organizer@communityconnect.local` / `Demo12345` (printed in the terminal on first start).
- On Render (production): set the environment variable `SEED_ORGANIZER_PASSWORD` (e.g. `Demo12345`) — without it the demo organizer gets a random password.
- If your local database was created by an older version, the demo history isn't added. Stop the server and delete `data/community-connect.sqlite*` to start fresh (**this deletes all accounts**).

## 7. Configuration (`.env`)

Copy `.env.example` to `.env`. All values are optional in development. Key ones: `PORT`, `JWT_SECRET`, `DATABASE_PATH`, `SEED_DEMO_DATA`, `SEED_ORGANIZER_PASSWORD`, `GEOCODER_USER_AGENT`, `GEOCODER_CONTACT_EMAIL`.

If `JWT_SECRET` is empty in development, a random secret is generated once in `data/.dev-jwt-secret`, so logins survive restarts and no secret is hardcoded in the code.

## 8. Database

SQLite file: `data/community-connect.sqlite`. If an **older** `community-connect.sqlite` exists in the project root, from the original starter, it is used automatically so existing accounts aren't lost.

Tables: `users`, `communities`, `memberships` (primary key user+community → no duplicates), `events` (with `price_pence`, `capacity`, `repeated_from`), `event_registrations` (primary key user+event → no duplicates; with `attended`, `checked_in_at`, `amount_pence`), `event_feedback` (one 1–5 rating per person per event), `event_promo_codes` (code, % off, max uses). Registrations also store `ticket_type`, `list_price_pence`, `promo_code`, `payment_status` (free / pending / paid), `payment_ref` and `paid_at`. Foreign keys are enforced with `ON DELETE CASCADE`. Deleting a community removes its events, memberships and registrations, so nothing is left orphaned.

**Migrations** are versioned (`PRAGMA user_version`) and additive only. They never drop tables or rows, and run automatically on start. Migration 2 adds photos, postcode, status, timestamps and indexes; migration 3 adds prices, capacity, attendance, amounts paid and the feedback table; migration 4 adds early-bird pricing, promo codes and payment status; migration 5 adds `ticket_code` (QR), `referral_code`, `referred_by`, `checked_in_by` on registrations, `featured`, `flash_percent`, `flash_until` on events, and two new tables: `event_waitlist` (user, event, waiting/offered) and `notifications` (bell). A database trigger gives every new registration a random ticket code and referral code. Migration 6 adds the `admins` and `payouts` tables, `platform_fee_pence` / `organizer_net_pence` / `fee_percent` / `refunded_at` on registrations, `cancelled_at` / `cancel_reason` on events and `google_sub` on users.

To inspect the data, use the VS Code extension "SQLite Viewer", or [DB Browser for SQLite](https://sqlitebrowser.org/), and open `data/community-connect.sqlite`. Stop the server first if you want to edit data.

To start completely fresh: stop the server and delete `data/community-connect.sqlite*` (this deletes all accounts).

## 9. API

See **[docs/API.md](docs/API.md)** for every endpoint with request and response examples.

## 10. Testing

`npm test` runs `test/api.test.js` (49 tests), `test/v5.test.js` (11 tests: QR check-in, referrals, flash sales, featured/trending, waitlist, notifications) and `test/v6.test.js` (7 tests: admin, commission, payouts, cancellation with refunds, Continue with Google, demo data) — **67 in total**.

- `npm test` runs **49 automated API tests**: registration/login, validation, permissions, joining, registration, location search, distance filtering, uploads, restart persistence, cascades, migrations, and damaged-database and geocoder-outage handling.
- Optional browser test (42 steps across desktop, tablet and mobile, including analytics, run again, attendance, ratings, early bird, promo codes, countdown and checkout):
  ```bash
  npm install --no-save playwright
  npx playwright install chromium
  node test/e2e.browser.js
  ```
- Results: **[docs/TESTING-REPORT.md](docs/TESTING-REPORT.md)**.

## 11. Troubleshooting

| Problem | Fix |
|---|---|
| `npm install` fails building `better-sqlite3` (mentions node-gyp / Python / Visual Studio) | You are probably on a very new or very old Node.js. Install **Node 22 or 24 LTS**, delete `node_modules` and `package-lock.json`, run `npm install` again. |
| `Port 3000 is already in use` | Close the other server, or set `PORT=3001` in `.env`. |
| "A required package is missing" | Run `npm install` in the project folder (the one with `package.json`). |
| Location search says it is unavailable | Check your internet connection. The offline town list still covers major towns. |
| Photos from Unsplash don't show | They need internet. Uploaded photos are stored locally and always work. |
| Logged out unexpectedly | Logins last 7 days (`JWT_EXPIRES_IN`). Changing `JWT_SECRET` logs everyone out. |

## 12. Before production deployment

This build is ready for a university demonstration on `localhost`. Before putting it on the public internet:

- Set `NODE_ENV=production` and a strong random `JWT_SECRET` (the server refuses to start in production without it).
- Serve over **HTTPS** behind a reverse proxy (set `TRUST_PROXY=true`).
- Set `GEOCODER_USER_AGENT` / `GEOCODER_CONTACT_EMAIL` to real contact details. For real traffic, use a commercial geocoder or your own Nominatim instance. The public one allows 1 request/second for the whole application.
- Add email verification, password reset, organizer verification and content moderation.
- Move rate-limiting to a shared store (e.g. Redis) if you run more than one server process.
- Consider storing tokens in `HttpOnly` cookies with CSRF protection instead of `localStorage`.
- Back up `data/` (database and uploads) regularly, and add a privacy policy (UK GDPR).
- Unused uploaded photos aren't cleaned up automatically. Add a periodic clean-up job.

## Credits

Location data: [postcodes.io](https://postcodes.io) (Office for National Statistics and Ordnance Survey open data, Open Government Licence) and © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors via Nominatim. Starter photographs: Unsplash.

## 13. Known limitations

- No email verification, password reset or account deletion screen yet.
- Payments run in demo mode unless a Stripe key is set. Refunds are handled by the organizer outside the app; there is no Stripe webhook yet (the payment is confirmed when the buyer returns to the site).
- Communities are published immediately. There is no draft or moderation step.
- Live geocoding depends on postcodes.io and Nominatim being reachable. Offline, only about 60 larger UK towns are recognised.
- Distances are straight-line ("as the crow flies"), not travel distance.
- Rate limiting and the geocoding cache are in memory: they reset on restart and assume a single server process.
- Uploaded photos that are later replaced are not deleted from `data/uploads/`.
