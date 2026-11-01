# Deploying Boorushiko

Two processes: Caddy (TLS, static files, headers) and the Fastify engine under pm2
(loopback only). Image bytes stay on the external mirrors, so the VPS keeps its disk.

## 1. Build

```bash
npm ci && npm run build                  # Angular bundle -> dist/boorushiko/browser
cd server && npm ci && npm run build     # engine -> server/dist/index.js
```

Copy `dist/boorushiko/browser` to `/srv/boorushiko/browser` on the server, then
`server/` (sources not needed, but `dist/`, `node_modules/` and `migrations/` are).

## 2. Environment

```bash
cd /path/to/server
cp .env.example .env && chmod 600 .env
```

Set at least:

- `PUBLIC_BASE_URL=https://your-domain.example` — sitemap, robots.txt, canonical URLs and the
  same-origin check all use it.
- `SECURITY_CONTACT=mailto:security@your-domain.example`
- `UPLOAD_TOKEN` — `openssl rand -hex 32`, for the parser and bot endpoints.
- `MIRRORS=catbox,imgbb` + `IMGBB_KEY`, `MIN_MIRRORS=2`.
- `STAGING_DIR=/dev/shm/boorushiko` (tmpfs, so uploads never touch the shared disk).
- `TRUST_PROXY=loopback` when Caddy runs on the same host.
- `GELBOORU_API_KEY` + `GELBOORU_USER_ID` if the Gelbooru schedule stays enabled; without them
  its runs fail with 401 and back off, so disable the source in `/admin` instead.
- `API_CORS_ORIGINS` — `*` (default) lets any browser origin read the public API; list specific
  origins to narrow it, or leave it empty and keep API access server-side only.

The engine refuses to start if a production value is missing or contradictory; the full list is
printed at once. `RATE_LIMIT_ENABLED=1` is the production default — leave it on.

## 3. pm2

```bash
npm i -g pm2
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup systemd            # copy/paste the printed command once
```

`ecosystem.config.cjs` keeps one fork, restarts above 400 MB RSS and launches `run.sh`, which
applies `nice -n 10` (and `ionice -c2 -n7` when available) so the site yields to its neighbours.

Log rotation (7 days, 10 MB per file):

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
```

Run `pm2 start ...` from the repository root: the wrapper resolves `../server` from its own path.

## 4. Caddy

```bash
caddy validate --config deploy/Caddyfile
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # replace booru.example first
sudo systemctl reload caddy
```

Caddy handles TLS and HSTS/CSP/`nosniff`/`Referrer-Policy`/`Permissions-Policy`, serves the
Angular bundle with an SPA fallback, and proxies `/api`, `/i`, `/t`, `/healthz`, `/readyz`,
`/robots.txt`, `/feed.xml`, `sitemap*.xml` and `/.well-known/*` to `127.0.0.1:3000`. `/post/*` is
proxied only when the `User-Agent` looks like a crawler, so a shared link gets OG tags for chat
and search bots while people still get the Angular page. The engine must stay bound to loopback;
its `HOST` default already does that.

## 5. Verify the perimeter

```bash
curl -sI https://your-domain.example | grep -Ei 'strict-transport|content-security|referrer|x-content'
curl -s https://your-domain.example/healthz | jq '{ok, db: .db.ok, disk: .disk.freeBytes, queue}'
curl -s -o /dev/null -w '%{http_code}\n' https://your-domain.example/readyz   # 200 expected
pm2 logs boorushiko --lines 5 --nostream                                            # JSON lines

# cross-origin mutations must be refused (403 cross_origin)
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Origin: https://evil.example' -H 'content-type: application/json' \
  -d '{"username":"x","password":"password123"}' \
  https://your-domain.example/api/v1/auth/register

# the same request from our own origin is accepted (201) or validated normally (400/409)
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Origin: https://your-domain.example' -H 'content-type: application/json' \
  -d '{"username":"x","password":"password123"}' \
  https://your-domain.example/api/v1/auth/register
```

`GET /api/v1/posts` allows 300 requests/minute per address, registration 5/hour per address,
comments 20/10 minutes per user, reports 10/hour, uploader applications 3/day and uploads
60/hour per user. All of them answer `429` with `Retry-After`; the counters live in process
memory, so a restart clears them.

## 6. Backups and alerts

The engine snapshots SQLite itself (`VACUUM INTO`, verified and pruned by `BACKUP_KEEP`) and keeps
the schedule in `maintenance_runs`, so `pm2 restart` neither skips nor repeats work. Local copies
are a staging area, not an archive — copy them offsite:

```bash
# after the daily snapshot; adjust paths and the rclone remote
rclone copy /srv/boorushiko/server/data/backups remote:boorushiko-backups --max-age 48h
```

Run the offsite job from cron/systemd on the host, or call `npm run backup:prod` right before it
(the compiled command needs no dev dependencies).
Restore drill once a month: stop pm2, copy the newest snapshot over `DB_PATH` (delete stale
`-wal`/`-shm` files first), start pm2, then check `/healthz` for `db.ok` and the expected post
count and open a post.

With `TELEGRAM_ALERT_BOT_TOKEN` and `TELEGRAM_ALERT_CHAT_ID` the monitor sends Telegram messages
for a broken database, low disk, high RSS, a long queue, a dead mirror and a stale/failed backup; without
them the same alerts are `health alert` warnings in the pm2 JSON log. `/healthz` is for monitoring,
`/readyz` is the deploy gate. Both are public through Caddy — if that is not wanted, restrict their
`handle` blocks to your monitoring address.
