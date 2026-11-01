# Boorushiko engine

Minimal Phase 1 backend for the Boorushiko booru: Fastify + SQLite (Drizzle schema) + sharp,
zero-disk for images (files live in `tmpfs` staging only, delivery goes to mirrors).

## Requirements

- Node.js 22+
- npm 12 (it blocks install scripts by default; approve the two native packages once):

```bash
npm install-scripts approve better-sqlite3
npm install-scripts approve esbuild
npm rebuild better-sqlite3 esbuild
```

## Run

```bash
cd server
npm install
npm run dev        # tsx watch
npm test           # vitest
npm run typecheck
npm run build && npm start
```

On Linux, point staging at tmpfs so image bytes never touch the disk:

```bash
STAGING_DIR=/dev/shm/boorushiko npm start
```

For a production start copy [`.env.example`](.env.example) to `.env` and load it with a systemd
`EnvironmentFile=` or `node --env-file=.env dist/index.js`. Set `PUBLIC_BASE_URL` to the real origin
so `/robots.txt` and `/sitemap.xml` contain absolute URLs, set `SECURITY_CONTACT` for
`/.well-known/security.txt`, and keep `TRUST_PROXY=loopback` (or the actual proxy address) so login
throttling sees the client IP behind Caddy instead of `127.0.0.1`. The engine refuses to start with
an aggregated list of invalid production settings (missing token, placeholder URL, bad mirrors).

## Bootstrap the first admin

There is no default administrator. Register a normal account through the site, then promote it:

```bash
cd server
npm run promote -- alice
npm run promote -- alice --role moderator
npm run promote -- alice --db data/demo.db
```

The role defaults to `admin`; pass `--role user|moderator|admin` to change it. The command writes
the grant to `audit_log`, so it shows up in the admin audit trail.

## Import from a source

Two adapters ship: `danbooru` and `gelbooru`. Both import classic 2D images across all ratings by
default and write remote posts straight into SQLite — no HTTP server or `UPLOAD_TOKEN` is needed
for the importer itself. Pass `rating:g`, `rating:q` or `rating:e` in the tags query to narrow the
run.

Gelbooru now gates its DAPI per account: every request needs `api_key` and `user_id` from
<https://gelbooru.com/index.php?page=account&s=options>. Set `GELBOORU_API_KEY` and
`GELBOORU_USER_ID`, otherwise the API answers 401. Your account page also shows the request
budget (10 requests/second by default), so keep `--delay` at 100 ms or more in manual runs.

```bash
cd server
npm run import:source -- --limit 40
npm run import:source -- --source gelbooru --limit 40 --delay 150
npm run import:source -- --tags "landscape" --limit 20
npm run import:source -- --db data/demo.db --limit 20
npm run import:source -- --dry-run --page-size 3   # inspect without writing
```

Options: `--source danbooru|gelbooru`, `--limit`, `--page`, `--page-size`, `--tags`, `--delay`,
`--db`, `--dry-run`. Requests are spaced by ~1.1 s; the importer retries `429`/`5xx` with
backoff. Danbooru's 180px preview is replaced by the 720px media variant when available;
Gelbooru uses its ~1280px `sample` instead of the 150px thumbnail.

The two APIs paginate differently. Danbooru is walked with an `id:<oldest` keyset cursor, so new
uploads during an import do not shift the offset. Gelbooru only exposes 0-based `pid` pages and
has no id-range search, so the archive walk advances `pid`, while head polling re-reads the newest
pages and stops at the stored watermark (duplicates are ignored by `provider` + `originId`).

Danbooru reports tag categories in the post payload. Gelbooru does not, so the adapter first
reuses categories already stored in `tags` (from earlier imports and manual uploads) and asks
Gelbooru's tag endpoint for the remaining names, 100 at a time. If that lookup fails or the
endpoint ignores `names`, tags stay `general` instead of being mislabelled.

Local filters drop `ai-generated`, `ai-assisted`, Stable Diffusion/NovelAI/Midjourney tags, `3d`,
MMD/Blender and `photorealistic`; pending, flagged, deleted and unsupported files are skipped.
The source of each post stays `post_origins`; no image bytes are copied. Re-running an import is
idempotent and also refreshes `preview_url`, which is the easiest way to upgrade older 180px
previews after the source grows a larger variant.

`--db` overrides `DB_PATH`; both accept a relative SQLite path. The importer never starts the
server, so it is safe to run while the engine is using WAL, though a heavy import is better done
before the first public launch.

## Automatic imports

The engine also runs the importer on a schedule, stored in `source_schedules`. Each source
alternates two modes:

- **head** — polls `id:>head_id order:id`, so a slow run picks up new posts oldest-first instead
  of skipping a gap;
- **backfill** — walks older pages with the `id:<cursor` keyset cursor.

Gelbooru has no id-range search, so it maps both modes onto `pid` pages: head re-reads the newest
pages until it reaches `head_id`, and backfill continues with the next `pid` cursor.

A source never has two queued/running imports, the daily cap counts processed posts (including
duplicates), and a failed run backs off exponentially up to six hours. Manual runs still work and
never move the automatic watermarks. The Sources tab in `/admin` exposes the switch, interval,
batch size, daily cap, tags and a cursor reset.

The `SOURCE_AUTO_*` variables seed a new schedule row once; after that, change the values in
`/admin` rather than restarting with different environment variables.

## Environment

| Variable                        | Default                       | Meaning                                                                                                   |
| ------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                      | —                             | `production` enables Secure cookies, loopback proxy trust and automatic imports                           |
| `PORT`                          | `3000`                        | HTTP port                                                                                                 |
| `HOST`                          | `127.0.0.1`                   | bind address                                                                                              |
| `PUBLIC_BASE_URL`               | `http://localhost:<port>`     | public origin for `/robots.txt`, `/sitemap.xml` and absolute links                                        |
| `DB_PATH`                       | `./data/boorushiko.db`        | SQLite file (WAL)                                                                                         |
| `STAGING_DIR`                   | OS temp dir                   | upload staging; use tmpfs in production                                                                   |
| `MIRRORS`                       | `catbox`                      | comma list: `catbox`, `imgbb`, `yourimageshare`                                                           |
| `IMGBB_KEY`                     | —                             | required when `MIRRORS` includes `imgbb`                                                                  |
| `YOURIMAGESHARE_KEY`            | —                             | required when `MIRRORS` includes `yourimageshare`; an upload-only key is enough                           |
| `UPLOAD_TOKEN`                  | —                             | required for bot endpoints (`/api/v1/posts`, `/posts/remote`); without it they return 401                 |
| `MAX_UPLOAD_BYTES`              | `33554432`                    | per-file limit (32 MB)                                                                                    |
| `MIN_MIRRORS`                   | `1`                           | successful mirrors needed before a post becomes `active`                                                  |
| `STAGING_TTL_MINUTES`           | `60`                          | stale staging cleanup                                                                                     |
| `JOBS_INTERVAL_MS`              | `5000`                        | queue poll interval                                                                                       |
| `SESSION_TTL_DAYS`              | `30`                          | account session lifetime                                                                                  |
| `COOKIE_SECURE`                 | on when `NODE_ENV=production` | `Secure` on the session cookie; set `0` for plain-HTTP IP hosts                                           |
| `TRUST_PROXY`                   | `loopback` in production      | proxy-addr expression for `X-Forwarded-For`; `0` disables, `1` trusts every hop                           |
| `RATE_LIMIT_ENABLED`            | on in production              | in-memory limits on registration, comments, reports, uploads and `/api/v1/posts` reads                    |
| `BODY_LIMIT_BYTES`              | `1048576`                     | JSON/form body cap; multipart uploads are bounded by `MAX_UPLOAD_BYTES`                                   |
| `REQUEST_TIMEOUT_MS`            | `60000`                       | Node request timeout for receiving a whole request                                                        |
| `HEADERS_TIMEOUT_MS`            | `20000`                       | time allowed to finish headers; the server also caps headers at 100 entries                               |
| `LOG_LEVEL`                     | `info`                        | `debug`, `info`, `warn` or `error`; logs are one JSON object per line                                     |
| `LOG_REQUESTS`                  | on in production              | log every request with method, status, duration and `requestId`                                           |
| `BACKUP_ENABLED`                | on in production              | daily `VACUUM INTO` snapshot inside the engine; `npm run backup` writes one on demand                     |
| `BACKUP_DIR`                    | `<db dir>/backups`            | snapshot directory; needs room for `BACKUP_KEEP` copies                                                   |
| `BACKUP_INTERVAL_HOURS`         | `24`                          | pause between automatic snapshots                                                                         |
| `BACKUP_KEEP`                   | `3`                           | local snapshots kept before the oldest is removed                                                         |
| `MAINTENANCE_VACUUM_DAYS`       | `7`                           | WAL checkpoint + `VACUUM` interval; `0` disables                                                          |
| `MONITOR_ENABLED`               | on in production              | health checks every `MONITOR_INTERVAL_MINUTES`                                                            |
| `MONITOR_INTERVAL_MINUTES`      | `5`                           | pause between health checks                                                                               |
| `MONITOR_DISK_MIN_MB`           | `512`                         | free-space alert threshold                                                                                |
| `MONITOR_QUEUE_MAX`             | `500`                         | pending-jobs alert threshold                                                                              |
| `MONITOR_RSS_MAX_MB`            | `400`                         | RSS alert threshold; matches the pm2 restart ceiling                                                      |
| `ALERT_COOLDOWN_MINUTES`        | `60`                          | re-alert interval for a condition that is still broken                                                    |
| `TELEGRAM_ALERT_BOT_TOKEN`      | —                             | bot token for alerts; set together with the chat id                                                       |
| `TELEGRAM_ALERT_CHAT_ID`        | —                             | alert chat; without it alerts are written to the JSON log                                                 |
| `SECURITY_CONTACT`              | —                             | `mailto:` or `https:` URI for security.txt; required in production                                        |
| `SECURITY_EXPIRES`              | +364 days                     | RFC 9116 expiry; must be in the future and less than one year away                                        |
| `COMMENT_COOLDOWN_SECONDS`      | `5`                           | per-user pause between comments (`0` disables)                                                            |
| `COMMENT_HIDE_SCORE`            | `-5`                          | collapse a comment at or below this score                                                                 |
| `COMMENT_HIDE_MIN_VOTES`        | `5`                           | minimum votes before the score can collapse a comment                                                     |
| `COMMENT_VOTE_COOLDOWN_SECONDS` | `1`                           | pause between non-zero vote changes per user (`0` disables)                                               |
| `COMMENT_VOTE_DAILY_LIMIT`      | `50`                          | non-zero vote actions per rolling 24 h (`0` disables; undoing a vote never counts)                        |
| `COMMENT_MOD_VOTE_WEIGHT`       | `3`                           | score multiplier for moderator and admin votes                                                            |
| `COMMENT_MUTUAL_DOWNVOTE_HOURS` | `24`                          | reject a downvote when the target author already downvoted you in this window (`0` disables)              |
| `SENSITIVE_TAGS`                | built-in conservative list    | comma list of wildcard tags hidden until a visitor opts in under `/settings`; `none` turns the filter off |
| `REMOTE_THUMB_CACHE_MB`         | `128`                         | in-RAM LRU for parser previews (`0` disables the cache)                                                   |
| `REMOTE_THUMB_MAX_BYTES`        | `8388608`                     | max downloaded source image for a preview                                                                 |
| `REMOTE_THUMB_TIMEOUT_MS`       | `8000`                        | per-request timeout when fetching a source preview                                                        |
| `SOURCE_AUTO_ENABLED`           | on when `NODE_ENV=production` | initial default for a new schedule; later use `/admin`                                                    |
| `SOURCE_AUTO_INTERVAL_MINUTES`  | `30`                          | initial pause between automatic runs                                                                      |
| `SOURCE_AUTO_BATCH`             | `20`                          | initial posts per automatic run (max 200)                                                                 |
| `SOURCE_AUTO_DAILY_LIMIT`       | `300`                         | initial processed-post cap per UTC day; `0` disables it                                                   |
| `SOURCE_AUTO_TAGS`              | —                             | initial optional source query, e.g. `rating:g`                                                            |
| `API_CORS_ORIGINS`              | `*`                           | origins allowed to read the public API from a browser; comma list or empty to disable                     |
| `GELBOORU_API_KEY`              | —                             | Gelbooru DAPI key from the account options page; set together with the user id                            |
| `GELBOORU_USER_ID`              | —                             | Gelbooru account id for the same DAPI key                                                                 |

## API

```bash
# upload (multipart: file, tags, rating, sourceUrl)
curl -X POST http://localhost:3000/api/v1/posts \
  -H 'x-upload-token: dev' \
  -F 'file=@art.png' \
  -F 'tags=artist:someone, character:flandre, copyright:touhou, solo' \
  -F 'rating=s'

# search: tag1 tag2, pixel art (finds pixel_art), pixel art, sign (comma separates tags),
# -tag, tag* / %tag%, rating:s,q, order:new|score|random, score:>10
curl 'http://localhost:3000/api/v1/posts?tags=flandre%20solo%20-rating:e&limit=20'
curl 'http://localhost:3000/api/v1/posts?tags=flandre&rating_mode=safe'
curl 'http://localhost:3000/api/v1/posts?limit=100&after_id=0'   # keyset sync, oldest first
curl 'http://localhost:3000/api/v1/posts?limit=100&before_id=999' # archive walk, newest first
curl 'http://localhost:3000/api/v1/openapi.json'                 # OpenAPI 3.1 document
curl 'http://localhost:3000/api/v1/tags?search=flan'
curl 'http://localhost:3000/api/v1/posts/1'
curl 'http://localhost:3000/api/v1/posts/1/related?limit=12'   # "more like this" by tag overlap
curl 'http://localhost:3000/api/v1/posts/random?rating_mode=safe'  # one post, never cached
curl 'http://localhost:3000/api/v1/pools'   # public pools
curl 'http://localhost:3000/feed.xml'       # RSS: 50 newest, no explicit posts
curl 'http://localhost:3000/post/1'         # OG/Twitter meta document for crawlers
curl 'http://localhost:3000/api/v1/stats'   # public archive counters for /stats
curl -i http://localhost:3000/i/1   # 302 to a live mirror / origin

# accounts (cookie jar keeps the session)
curl -c cookies.txt -X POST http://localhost:3000/api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"username":"someone","password":"at-least-8-chars"}'
curl -b cookies.txt http://localhost:3000/api/v1/auth/me
curl -b cookies.txt -X POST http://localhost:3000/api/v1/auth/logout
curl -b cookies.txt -X POST http://localhost:3000/api/v1/posts/1/favorite
curl -b cookies.txt http://localhost:3000/api/v1/me/favorites

# staff: pools and versions of one artwork
curl -b cookies.txt -X POST http://localhost:3000/api/v1/pools \
  -H 'content-type: application/json' -d '{"title":"Yuru Camp order","category":"series"}'
curl -b cookies.txt -X POST http://localhost:3000/api/v1/pools/1/posts \
  -H 'content-type: application/json' -d '{"postId":1}'
curl -b cookies.txt -X POST http://localhost:3000/api/v1/posts/2/parent \
  -H 'content-type: application/json' -d '{"parentId":1}'

# parser/remote post: the file stays on the source, no mirror upload
curl -X POST http://localhost:3000/api/v1/posts/remote \
  -H 'content-type: application/json' \
  -H 'x-upload-token: dev' \
  -d '{
    "provider": "danbooru",
    "originId": "987",
    "pageUrl": "https://danbooru.donmai.us/posts/987",
    "fileUrl": "https://cdn.example/art.png",
    "previewUrl": "https://cdn.example/art-preview.png",
    "refererPolicy": "none",
    "mime": "image/png",
    "width": 1200,
    "height": 900,
    "bytes": 1500000,
    "rating": "s",
    "tags": "artist:someone, character:flandre, copyright:touhou, solo"
  }'

# comments (links are rejected)
curl -b cookies.txt -X POST http://localhost:3000/api/v1/posts/1/comments \
  -H 'content-type: application/json' \
  -d '{"body":"nice shading"}'
curl 'http://localhost:3000/api/v1/posts/1/comments?limit=30&before=42'
curl -b cookies.txt -X POST http://localhost:3000/api/v1/comments/7/vote \
  -H 'content-type: application/json' -d '{"value":-1}'
curl -b cookies.txt -X DELETE http://localhost:3000/api/v1/comments/7
# Comment votes: -1/1 sets a vote, 0 removes it. A comment collapses when its
# score reaches COMMENT_HIDE_SCORE and it has at least COMMENT_HIDE_MIN_VOTES votes.
# Author karma is the sum of comment scores and never hides anything by itself.
# Anti-abuse: non-zero votes have a per-user cooldown and a rolling 24 h cap;
# staff votes weigh COMMENT_MOD_VOTE_WEIGHT; a downvote is rejected with
# 409 mutual_downvote while the target author has an active downvote on you.
curl -i http://localhost:3000/t/1   # 302 to a hosted thumbnail or 200 proxied WebP for remote
curl http://localhost:3000/healthz  # liveness + db/disk/queue/mirror/maintenance details
curl http://localhost:3000/readyz   # 200 only when the db and staging dir are usable
curl http://localhost:3000/robots.txt
curl http://localhost:3000/sitemap.xml          # sitemap index
curl http://localhost:3000/sitemap-posts-1.xml  # up to 50k active posts per file
curl http://localhost:3000/.well-known/security.txt
```

In production the reverse proxy must send `/robots.txt`, `/sitemap.xml`, `/sitemap-pages.xml`,
`/sitemap-posts-*.xml` and `/.well-known/security.txt` to Fastify; everything else can stay on the
static Angular build.

The public read endpoints answer to any origin by default (`API_CORS_ORIGINS=*`): browser clients can
list and search posts, while `/admin`, `/auth`, `/me` and every mutating method never receive CORS
headers. Post objects carry both relative `url`/`thumbUrl` and absolute
`absoluteUrl`/`absoluteThumbUrl` links plus the `baseUrl` they belong to.

For pagination prefer keyset cursors over `page`: `after_id` returns posts with a larger id, oldest
first, `before_id` returns smaller ids, newest first. Both ignore `page`/`order:*` and return
`nextCursor` for the next request, so new uploads cannot shift a page. `docs/API.md` at the repo
root is the human-readable reference and `GET /api/v1/openapi.json` is the machine-readable one.

`rating_mode` is `safe` (`s` only), `mixed` (`s+q`, the default) or `adult` (`e` only). A `rating:`
filter can narrow the mode but never widen it. `show_explicit=1` is the legacy "all ratings" flag for
parser/API clients; it is not the same as `rating_mode=adult`.

Tag categories are set with prefixes: `copyright:`, `character:`, `artist:`, `species:`, `meta:` and
`general:` (the default). On a post page the UI groups tags in that order and localizes the labels.

`POST /api/v1/uploads` accepts the same multipart body from a signed-in approved uploader
(`GET /api/v1/me/uploader`, apply with `POST /api/v1/me/uploader-request`); staff can always
upload. `GET /api/v1/me/uploads` lists the caller's posts and moderation feedback.

Admins can start a Danbooru or Gelbooru import from `/admin` → Sources. Runs are stored in `source_runs`,
queued as `source_import` jobs and write progress plus `source_run_logs`; cancellation is checked
between posts and aborts an in-flight request. A source can have only one queued/running run.

Uploads land as `pending`; a queue job uploads the delivery file and the 300px WebP preview
to each configured mirror, then flips the post to `active` once `MIN_MIRRORS` sources are `ok`.
Staging is removed after that (with the last job), otherwise by the TTL sweep.

Remote posts are created directly as `active`: there is no file to mirror, and the parser token is
trusted. Retries are idempotent by `provider` + `originId` (or `fileUrl` when the source has no id),
which is stored as a synthetic hash in `posts.md5`; real content hashes require downloading the
original and are intentionally not calculated. `/i/:id` redirects to `fileUrl`, while `/t/:id`
downloads `previewUrl` (or `fileUrl` as fallback), renders a 480px WebP and keeps it in a bounded
RAM LRU. The proxy resolves and rejects private/reserved addresses, re-checks every redirect, and
limits download size and time. Permanent `403/404/410` on `fileUrl` marks the origin `source_dead`;
the post itself stays intact and `/t/:id` returns a placeholder instead of a broken image.

## Backups, health and logs

Snapshots use `VACUUM INTO`: the copy is transactionally consistent while the engine serves
requests, and it is already defragmented. The engine takes one every `BACKUP_INTERVAL_HOURS` and
keeps `BACKUP_KEEP` copies. The schedule is stored in `maintenance_runs`, so a pm2 restart neither
skips a daily backup nor repeats a weekly `VACUUM`. Before a deploy, write one by hand:

```bash
cd server && npm run backup          # tsx, with dev dependencies
# installed build without dev dependencies:
cd server && npm run backup:prod     # node dist/cli/backup.js
# {"path":"data/backups/boorushiko-2026-....db","bytes":270336,"posts":0,"removed":[]}
```

The copy is verified (`PRAGMA integrity_check` plus a real `posts` query) before the command
reports success. Point `BACKUP_DIR` at a directory your offsite job picks up (`rclone copy`,
`rsync`), and keep the local `BACKUP_KEEP` small: the shared VPS does not have room for an archive.
Restore drill: stop the engine, copy the newest snapshot over `DB_PATH` (remove stale `-wal`/`-shm`
files), start it, then check `/healthz` (`db.ok`, `posts`) and open one post. Do this once a month;
an untested backup is a guess.

`MAINTENANCE_VACUUM_DAYS` (default 7) runs `wal_checkpoint(TRUNCATE)`, `VACUUM` and
`PRAGMA optimize`; `0` disables it. On a 0.6 GB archive that is a short write pause once a week.

`/healthz` reports the database, free/total disk, pending jobs, per-mirror link counts, uptime and
the last maintenance runs; it answers 503 when the database does not respond. `/readyz` is the
deploy check: 200 only if the database answers and `STAGING_DIR` is writable. Every response
carries `X-Request-Id`.

Logs are one JSON object per line. `LOG_LEVEL` filters them and `LOG_REQUESTS` adds a line per
request with method, URL, status, duration and `requestId`:

```bash
pm2 logs boorushiko | jq -c 'select(.level == "error" or .status >= 500)'
```

`MONITOR_ENABLED` checks for a broken database, low disk (`MONITOR_DISK_MIN_MB`), high RSS
(`MONITOR_RSS_MAX_MB`), a long queue (`MONITOR_QUEUE_MAX`), a mirror with no live copies and a
stale or failed backup. Each condition is
reported once per `ALERT_COOLDOWN_MINUTES`, and one "recovered" message closes the incident. With
`TELEGRAM_ALERT_BOT_TOKEN` and `TELEGRAM_ALERT_CHAT_ID` alerts go to Telegram; without them they
are written to the JSON log as `health alert` warnings.

## What is implemented

- SQLite schema and forward-only SQL migrations (`migrations/`)
- streaming upload with md5/sha256, magic-byte validation, size limits, dedupe by md5
- 300px hosted / 480px remote WebP previews via sharp (encoded to a buffer: on Windows libvips keeps `.toFile()` handles)
- tag parsing with categories (`artist:`, `character:`, ...), tag search, AND-search with exclusions
- mirror adapters: catbox (no key; no formal API docs, uses the form endpoint from `/tools.php`),
  imgbb (API key, 32 MB), yourimageshare (documented JSON API, `X-API-Key`, 100 MB per request);
  retries with backoff in the jobs table
- `/i/:id` and `/t/:id` redirects; `/t/:id` proxies parser previews with a RAM cache and SSRF guard
- `remote` posts: trusted parser endpoint, idempotent origins, source-dead tracking, placeholder fallback
- Danbooru source adapter + CLI importer with cursor pagination, retries and AI/3D filtering
- Safe / Mixed / Adult content modes (`rating_mode=safe|mixed|adult`); explicit posts are hidden by default
- sensitive-tag filter (`SENSITIVE_TAGS`, `*` wildcards) that keeps flagged posts out of listings
  and post details until the client sends `include_sensitive=1`; no account needed to opt in
- accounts: scrypt password hashes, hashed session tokens in HTTP-only cookies, `/me`, logout
- comments: link rejection, per-user cooldown, author/moderation delete, keyset pagination,
  up/down votes, score-based collapsing and derived author karma, weighted staff votes,
  vote cooldown/daily cap and a reciprocal-downvote guard
- uploader applications, admin approval/revocation, session-based uploads and a personal queue
- favorites per account and curated pools (public read, staff write) with ordered membership
- parent/child links for crops and alternate versions, cycle-checked server side
- `/api/v1/posts/random`, RSS at `/feed.xml` (never lists explicit posts) and crawler HTML at
  `/post/:id` with OG/Twitter meta; explicit posts get `noindex` and no preview image
- background source runs with progress, logs and cancellation in the admin UI
- automatic head/backfill schedule with daily caps, overlap guard and failure backoff
- public `/api/v1/stats` aggregate for the footer-linked statistics page
- daily `VACUUM INTO` snapshots with integrity verification, retention and `npm run backup`
- `/healthz` (database, disk, queue, mirrors, maintenance) and `/readyz` (database + staging)
- structured JSON logs with request ids, plus a health monitor with deduplicated Telegram alerts
- same-origin guard on every mutating request (`Origin`/`Referer` against `PUBLIC_BASE_URL`
  and the request host; requests without either header, such as the parser, still pass)
- in-memory fixed-window rate limits on registration, comments, reports, uploader
  applications, uploads and public post reads, all with `Retry-After`
- `/robots.txt` and a sitemap index with static pages plus active posts (50k per file)
- RFC 9116 `/.well-known/security.txt` from `SECURITY_CONTACT`/`SECURITY_EXPIRES`
- startup config validation: public origin, production token, mirrors, proxy syntax, security.txt
- CLI role promotion for the first administrator (`npm run promote`), audited in `audit_log`
- 154 tests (search, relative tag matching, sensitive-tag filtering, upload pipeline, remote
  posts/proxy, mirror adapters, Danbooru parsing/import, source runs, scheduler, HTTP routes,
  sitemap/robots/security.txt, same-origin guard, rate limits, body limits, backups/restore,
  health/readiness, log records, alert deduplication, config validation, accounts, comments,
  uploaders, stats, favorites, pools, parent/child, random post, RSS and OG documents)
- `npm run smoke` starts the built engine on a scratch database and checks the public surface
  end to end; CI runs it after the server build
- `deploy/` with a Caddyfile (TLS, HSTS/CSP/headers, static bundle, API proxy) and a pm2
  ecosystem running the engine via `nice`/`ionice`

## Not implemented yet

- email verification, password reset, profile editing
- tag editing and aliases; bulk pool editing
- additional source adapters (Pixiv next); Twitter/X stays a source link, not an adapter
- Telegram channel mirror and restore
- health-check cron for mirror links

## License

Part of Boorushiko, licensed under GPL-2.0-or-later. See [../LICENSE](../LICENSE) for the full text.
