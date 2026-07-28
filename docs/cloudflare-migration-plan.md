# Ephemeris → Cloudflare Web Application: Migration Plan

**Target shape:** multi-user SaaS, TypeScript renderer (no containers), server-side reMarkable sync.

---

## 1. What exists today

A single-user CLI pipeline, orchestrated by bash + macOS Shortcuts:

1. **Fetch** — `event_fetcher.py` / `calendar_loader.py` pull ICS feeds listed in `config/config.yaml`, expand recurrences (`dateutil.rrule`), and write to a local SQLite `events` table.
2. **Render** — `ephemeris.py` reads events from SQLite and drives ReportLab to emit a year-view cover page plus one page per day (366 pages, ~4 MB) into `output/calendar_2026.pdf`.
3. **Sync** — `ephemeris_merge_from_backup.py` downloads the existing `Calendar 2026.rmdoc` from the reMarkable cloud (via a patched `rmapi` Go binary in Docker), unzips it, swaps in the new PDF, rewrites the `.content` page array so annotated page UUIDs stay at their original indices, rezips, and re-uploads with `put --force`.
4. **Schedule** — `scripts/remarkable-sync-calendar.sh` with a PID lock file, fired daily by a macOS Shortcut.

Roughly 5,700 lines of Python. Configuration is split between `config/config.yaml` (calendar sources) and ~50 environment variables read by `ephemeris/settings.py` (layout, colors, hours, sidebar, page geometry).

### Observations that shape the port

- **Rendering is pure.** No `datetime.now()` / `date.today()` anywhere in `renderers.py`, `year_calendar.py`, or `layout.py`. A page is a deterministic function of `(day, events, valid_dates, settings)`. This makes incremental page re-rendering safe — see §6.
- **The current sync is enormously wasteful.** It fetches 7 days of events and then regenerates all 366 pages. At single-user scale that is invisible; per-user-per-day in a SaaS it would be the dominant cost.
- **Two parallel ICS implementations exist.** `event_fetcher.py` (sync, `requests`, hardcoded `Pacific/Auckland`, imports `calendar_db_sqlite` as a top-level module so it only runs from inside `ephemeris/`) and `calendar_loader.py` (async, `aiohttp`, VTIMEZONE-aware, honours `settings.TZ_LOCAL`). The port should collapse these into one implementation — `calendar_loader.py` is the better base.
- **The event dedupe key is `(date, summary, dtstart)`.** No calendar, no user, no ICS UID. This must change for multi-tenancy, and storing `uid` + `recurrence_id` would also make override handling (`build_override_map`) correct rather than approximate.
- **Heavy deps are mostly vestigial.** `PyMuPDF`, `CairoSVG`, and `Pillow` are in `requirements.txt` but unused; PNG export shells out to Poppler's `pdftocairo`. The real rendering dependency is ReportLab alone — which is what makes a pdf-lib port tractable.
- **Secret hygiene is currently fine.** `config/*`, `output/`, `backups/`, and `logs/` are all gitignored; only `assets/cover.pdf` and `.gitkeep` files are tracked. The reMarkable device token in `config/.rmapi` has never been committed.

---

## 2. Target architecture

```
                    ┌──────────────── Cloudflare ────────────────┐
   browser ────────▶│  Worker (Hono + static assets)             │
                    │    ├─ /            SPA (React/Vite)        │
                    │    ├─ /api/*       REST                    │
                    │    └─ /auth/*      better-auth             │
                    │                                            │
   Cron (hourly) ──▶│  scheduled() ─▶ Queue: sync-jobs           │
                    │                      │                     │
                    │                      ▼                     │
                    │  Queue consumer ─▶ SyncCoordinator (DO)    │
                    │                      │  per-user lock      │
                    │                      ├─▶ ical ingest       │
                    │                      ├─▶ renderer          │
                    │                      └─▶ reMarkable sync   │
                    │                                            │
                    │  D1 (relational)   R2 (blobs)   KV (cache) │
                    └────────────────────────────────────────────┘
```

**One Worker**, several entrypoints (`fetch`, `scheduled`, `queue`), plus one Durable Object class. Static assets served from the same Worker via the assets binding.

### Component mapping

| Today | On Cloudflare |
|---|---|
| `config/config.yaml` calendars | D1 `calendar_sources`, URL encrypted at rest |
| ~50 `DOC_*` / `TIME_*` env vars in `settings.py` | D1 `render_settings` (JSON column, Zod-validated), defaults in code |
| `config/feeds_meta.yaml` (`_last_anchor`, `events_hash`) | D1 `sync_state` |
| `output/calendar.db` → `events` table | D1 `events` (+ `user_id`, `uid`, `recurrence_id`) |
| `output/calendar_YYYY.pdf` | R2 `u/{userId}/calendar-{year}.pdf` |
| `backups/*.rmdoc` (currently 1 GB local) | R2 `u/{userId}/backups/`, 30-day lifecycle rule |
| `logs/*.log` + loguru | D1 `sync_runs` (status, timings, redacted error) + Workers Logs |
| PID lock file in `remarkable-sync-calendar.sh` | Durable Object — inherently single-threaded per user |
| macOS Shortcuts daily trigger | Cron Trigger → Queue fan-out, per-user local time |
| `upload_to_remarkable.py` + Docker `rmapi` | `rmapi-js` in the Worker |
| `.rmdoc` zip surgery | `fflate` (zip path) or raw blob-tree merge (preferred, §7) |
| `renderers.py`, `year_calendar.py`, `layout.py`, `fonts.py` | `packages/renderer` — pdf-lib + `@pdf-lib/fontkit` |
| `event_fetcher.py`, `calendar_loader.py`, `event_processing.py` | `packages/ical` — `ical.js` |
| `fonts/*.ttf` | Static assets (subset), embedded once per document |
| `Dockerfile` | Retained **only** as the reference renderer for CI visual-diff (§5) |

### Repository layout

```
apps/
  web/            React SPA (Vite)
  worker/         Hono app, cron, queue consumer, DO
packages/
  renderer/       pdf-lib port — the long pole
  ical/           feed fetch, parse, recurrence expansion
  remarkable/     rmapi-js wrapper + annotation-preserving merge
  schema/         Zod settings schema + D1 types, shared client/server
  fixtures/       synthetic calendars for tests (never real user data)
tools/
  parity/         Python reference renderer + pixel-diff harness
```

---

## 3. Phase 0 — Spikes (do these before committing to the rest)

Three assumptions carry this plan. Each gets a timeboxed spike, and each has a defined fallback.

**S1 · `rmapi-js` runs in a Worker — 1 day.**
[`rmapi-js`](https://www.npmjs.com/package/rmapi-js) is at v9.0.0 and actively maintained (last publish ~2 weeks ago). It exposes `register()` for device tokens, `remarkable()` for clients, `listItems()`, PDF/ePub upload, a `RawRemarkableApi` for blob-level access, and a synchronous `session()` constructor for cached tokens. What is *not* yet verified is whether it runs in `workerd` — it must use `fetch` + WebCrypto only, with no `node:crypto`/`Buffer`/`fs`. Spike: register a throwaway device, list items, upload a small PDF from a Worker.
*Fallback:* `nodejs_compat` flag, or reimplement the handful of endpoints directly — the cloud API is plain HTTPS + SHA-256 content hashing.

**S2 · pdf-lib hits the CPU and memory budget — 2 days.**
Workers give 128 MB memory and, on paid plans, up to 300 s CPU via `limits.cpu_ms` (default 30 s). pdf-lib carries roughly ~10 ms/page of overhead before any drawing, so a 366-page document is plausibly 20–60 s of CPU. Spike: port one day page, measure a full-year render for CPU, wall time, and peak memory.
*Fallback ladder, in order:* (a) incremental page splicing so full renders are rare (§6); (b) chunk the year across queue messages, writing quarter-PDFs to R2 and merging; (c) drop to a rolling 90-day document; (d) reintroduce a Cloudflare Container running the existing Python for full rebuilds only.

**S3 · `ical.js` matches the Python event expansion — 1 day.**
Run `ical.js` and the current Python side by side over real feeds; diff the resulting event lists (UID, start, end, all-day flag). Recurrence, `EXDATE`, `RECURRENCE-ID` overrides, and VTIMEZONE are where these disagree.
*Fallback:* keep `rrule`-equivalent expansion in a small hand-written module over `ical.js`'s parser.

**Gate:** if S2 fails all four fallbacks, revisit the container decision before starting Phase 3.

---

## 4. Phase 1 — Foundations (~1 week)

- Monorepo scaffold (pnpm workspaces), `wrangler.jsonc` with bindings for D1, R2, KV, Queues, DO, assets.
- D1 schema + migrations (Drizzle). Sketch:

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  sync_hour INTEGER,                      -- local hour, NULL = manual only
  created_at INTEGER NOT NULL
);

CREATE TABLE calendar_sources (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, color TEXT NOT NULL DEFAULT 'gray4',
  url_ciphertext BLOB NOT NULL, url_iv BLOB NOT NULL,   -- §9
  etag TEXT, last_modified TEXT, last_fetched_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES calendar_sources(id) ON DELETE CASCADE,
  date TEXT NOT NULL, uid TEXT NOT NULL, recurrence_id TEXT,
  summary TEXT, description TEXT, location TEXT,
  dtstart TEXT NOT NULL, dtend TEXT NOT NULL, all_day INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX events_unique ON events(user_id, source_id, uid, COALESCE(recurrence_id,''), dtstart);
CREATE INDEX events_user_date ON events(user_id, date);

CREATE TABLE render_settings (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                              json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE remarkable_accounts (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                                  token_ciphertext BLOB NOT NULL, token_iv BLOB NOT NULL,
                                  device_id TEXT, connected_at INTEGER, last_ok_at INTEGER);
CREATE TABLE documents (user_id TEXT NOT NULL, year INTEGER NOT NULL, rm_doc_id TEXT,
                        page_count INTEGER, pdf_r2_key TEXT, page_hashes TEXT,  -- JSON, for §6
                        PRIMARY KEY (user_id, year));
CREATE TABLE sync_runs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, started_at INTEGER NOT NULL,
                        finished_at INTEGER, status TEXT NOT NULL, stage TEXT,
                        pages_rendered INTEGER, error_code TEXT, error_detail TEXT);
```

- **Auth:** `better-auth` on D1 — email OTP plus Google OAuth (natural, since most sources are Google ICS URLs, and it opens the door to the Calendar API later instead of secret ICS links).
- **Settings schema:** port `settings.py` to a Zod schema in `packages/schema`, preserving every current default so existing output is reproducible. Single source of truth for the API, the UI form, and the renderer.
- **CI:** typecheck, unit tests, `wrangler deploy --dry-run`, and the parity harness from §5.

---

## 5. Phase 3 — Renderer port (~2–3 weeks; the long pole)

Porting `renderers.py` (1,433 lines) + `year_calendar.py` (208) + `layout.py` (166) to pdf-lib. Order of work:

1. **Primitives** — a thin ReportLab-shaped shim over pdf-lib: `drawString`, `line`, `rect`, `setFillColor`, `stringWidth`. Porting call-by-call against a familiar surface is far less error-prone than restructuring while translating.
2. **Fonts** — 7 Montserrat weights via `@pdf-lib/fontkit`, embedded with `{ subset: true }`. `stringWidth` → `font.widthOfTextAtSize`. Text wrapping and truncation logic must be ported exactly; small measurement differences show up as different line breaks.
3. **Colors** — `webcolors` + the `grayN` / `gray(20%)` conventions in `utils.py` → a small TS module.
4. **Day page**, then **year page**.
5. **Links and outlines** — the sharp edge. ReportLab's `bookmarkPage()` / named destinations have no first-class pdf-lib equivalent; `/Outlines` dictionaries and `/Link` annotations with `/Dest` must be constructed manually against the low-level object API. Budget real time here, and verify on-device: the year view's tap-to-day links are a core feature.
6. **Parity harness** (`tools/parity`) — run the existing Python renderer and the TS renderer over the same fixture events, rasterise both with `pdftocairo`, pixel-diff. Runs in GitHub Actions (not in Workers). Fail CI above a small diff threshold. Keep the `Dockerfile` alive purely for this. This harness is the single most important quality gate in the project — it is what makes a 1,650-line pixel-precise rewrite safe.

---

## 6. Incremental rendering (the key optimisation)

Because page output is pure, the full-year rebuild is only required when settings or the year change. Steady state becomes:

1. Hash each day's `(events, settings revision)` → compare against `documents.page_hashes`.
2. Re-render only changed days (typically 0–7 pages).
3. Load last year's PDF from R2, `copyPages` the unchanged ones, splice the new pages at the same indices, save.
4. Store the new PDF and hashes.

Page indices stay stable, so the annotation merge in §7 keeps working unchanged. This turns the daily path from ~366 page-renders into ~7, which is what makes per-user daily syncs affordable.

**Caveat to verify during S2:** `DOC_MINICAL_INDICATE_RANGE` makes mini-calendars depend on `valid_dates`. In the sync flow `valid_dates` is the whole year and therefore stable, but confirm that no page's output varies with the *current* date before relying on this.

---

## 7. Phase 4 — reMarkable sync (~1.5 weeks)

**Pairing:** user gets a one-time code from my.remarkable.com, pastes it into the app, the Worker calls `register()`, and the resulting long-lived device token is encrypted and stored. The UI shows connection status and a **Disconnect** action that deletes the token.

**Merge — preferred (raw blob tree):** rather than round-tripping the whole `.rmdoc` zip, use `RawRemarkableApi` to read the document's file list, upload the new PDF as a blob, rewrite the `.content` JSON (page array, `pageCount`, `originalPageCount`, `redirectionPageMap`) while retaining the existing `.rm` page blob hashes, and commit a new root. The annotations never need to be downloaded — only their hashes are referenced. That is both faster and dramatically cheaper on bandwidth than today's approach, which pulls a 4 MB archive every run.

**Merge — fallback (zip):** replicate the current logic with `fflate`, which works in Workers. Functionally identical to `ephemeris_merge_from_backup.py`.

**Backups:** before committing, write the prior `.content` + blob manifest (or the full `.rmdoc` on the zip path) to R2 under `u/{userId}/backups/`, with a 30-day lifecycle rule. This replaces the 1 GB of local `.rmdoc` files, which have no retention policy today.

**Fragility:** the `Dockerfile` comments record that reMarkable's API broke every released `rmapi` in ~May 2026 by requiring file extensions on `rm-filename` headers. Assume this recurs. Mitigations: pin `rmapi-js`, isolate all cloud calls behind `packages/remarkable`, add a synthetic health check, distinguish "our bug" from "their API changed" in `sync_runs.error_code`, and always keep the manual PDF download working so users are never fully blocked.

---

## 8. Phase 5 — Scheduling and multi-tenancy (~1 week)

- **Cron** `0 * * * *` → select users whose local `sync_hour` matches the current UTC hour → enqueue one message per user. (Hourly granularity; drop to `*/15` if users want finer control. Timezone handling matters — NZ and Romania are 10–11 hours apart and both observe DST.)
- **Queue consumer** with retries and a dead-letter queue; a failed user never blocks another.
- **SyncCoordinator DO**, one per user: serialises runs (replacing the PID lock), holds run state, uses alarms for backoff, and streams progress to the UI over WebSocket or SSE.
- **Quotas:** cap feeds per user, feed size, and syncs per day. A malicious ICS URL is an SSRF and a memory-exhaustion vector — validate scheme and host, block private ranges, and cap the response body.

---

## 9. Security and privacy

This is a service that stores other people's calendar contents and long-lived credentials to their document store. Treating it as a normal CRUD app would be a mistake.

- **Envelope encryption** for reMarkable device tokens *and* ICS URLs (Google "private" ICS links embed a secret token). Per-record DEK, AES-GCM via WebCrypto, master key in a Worker secret or Cloudflare Secrets Store. Never return either to the client; mask URLs in the UI as `…/basic.ics`.
- **A device token grants access to the user's entire reMarkable library**, not just the calendar. Scope every call, log the intent, and make revocation one click.
- **Never log event titles, locations, descriptions, or feed URLs.** `sync_runs.error_detail` must be redacted at the point of capture, not at read time.
- **Synthetic data only in dev and test.** No copying production D1 into a dev environment, ever; `packages/fixtures` provides seed calendars.
- **Account deletion** purges D1 rows (cascades are already in the schema), deletes the R2 prefix, and revokes the reMarkable device.
- **Check reMarkable's terms of service** before launching publicly — a hosted service uploading on users' behalf is a different posture from a personal CLI, and this is worth confirming before the multi-user build lands.

---

## 10. Phasing, effort, and cost

| Phase | Scope | Estimate |
|---|---|---|
| 0 | Spikes S1–S3 | 4 days |
| 1 | Monorepo, D1, auth, CI | 1 week |
| 2 | ICS ingest + sources/settings API | 1 week |
| 3 | **Renderer port + parity harness** | 2–3 weeks |
| 4 | reMarkable pairing, merge, backups | 1.5 weeks |
| 5 | Cron, queues, DO, quotas, encryption | 1 week |
| 6 | SPA polish, preview, sync history, docs | 1.5 weeks |

**~8–10 weeks for one developer.** Phases 2 and 3 can run in parallel with two.

**Running cost** (order of magnitude, verify against current pricing): Workers Paid $5/mo base with 30 M CPU-ms included; D1 and R2 comfortably inside free tiers at low hundreds of users; R2 has no egress fees, which suits PDF serving. With incremental rendering, expect single-digit dollars per month until you have real traction — the cost curve bends on CPU-ms, which is exactly what §6 controls.

---

## 11. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Renderer visual drift from ReportLab | High — the design *is* the product | Pixel-diff CI gate (§5); keep Python as reference |
| `rmapi-js` incompatible with `workerd` | High | Spike S1; `nodejs_compat`; hand-rolled client |
| Full-year render exceeds CPU/memory | High | Incremental splicing (§6); chunking; container fallback |
| reMarkable API breaks again | High | Isolated adapter, pinned version, health check, manual-download escape hatch |
| Recurrence/timezone divergence | Medium | Spike S3, differential testing against real feeds |
| Storing third-party credentials at scale | Medium | Envelope encryption, revocation, no logging (§9) |
| PDF outlines/links harder than expected in pdf-lib | Medium | Time-boxed in Phase 3; verify on a real device early |

---

## 12. First concrete steps

1. Run spikes S1–S3 and write up the numbers — especially S2's CPU and memory figures.
2. Decide on the fallback ladder position based on S2 before any Phase 3 work starts.
3. Stand up the monorepo and D1 schema.
4. Build the parity harness *before* porting the first page — it is the safety net for everything that follows.
