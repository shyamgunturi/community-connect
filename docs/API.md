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
| POST | `/events` | 🛠 owner of community | `{ community_id, name, event_date: "YYYY-MM-DD", event_time: "HH:MM", venue, description?, image_url? }` → **201** `{ event }`. The date must be real, today or later (up to 2 years); a time today must not have passed. |
| DELETE | `/events/:id` | 🛠 owner | Deletes the event and its registrations |
| POST | `/events/:id/register` | 🧑 member | **201** registered, **200** `{ already_registered: true }`, **403** `MEMBERSHIP_REQUIRED`, **400** past event |
| DELETE | `/events/:id/register` | 🧑 | Cancel registration |

Event object: `id, community_id, name, event_date, event_time, venue, description, image_url, community_name, community_town, community_category, community_image_url, registration_count, registered, is_member, is_owner, is_past`.

## Dashboards
| Method | Path | Access | Returns |
|---|---|---|---|
| GET | `/organizer/communities` | 🛠 | Your communities with `member_count`, `event_count` |
| GET | `/organizer/events` | 🛠 | Events of your communities with `registration_count` |
| GET | `/participant/communities` | 🧑 | Communities you joined |
| GET | `/participant/events` | 🧑 | Events you registered for (upcoming first, then past) |

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
