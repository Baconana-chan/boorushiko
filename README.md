# Boorushiko

A booru for classic hand-drawn 2D art: no AI-generated images, no 3D renders. The repo has two
parts:

- `src/` — Angular 22 UI (standalone components, signals, zoneless, Tailwind 4)
- `server/` — Fastify + SQLite engine; see [server/README.md](server/README.md)

## Requirements

- Node.js 22.22.3+, 24.15+ or 26+ — the Angular CLI refuses older releases
- npm 12 (it asks to approve `better-sqlite3` and `esbuild` install scripts once)

This checkout also contains a portable Node 22.22.3 under `.tools/` (gitignored), because the
system Node was 22.18.0. Run the CLI with `.tools/node-v22.22.3-win-x64/node.exe
node_modules/@angular/cli/bin/ng.js …` if `ng` is unavailable.

## Run locally

Terminal 1 — engine with demo data:

```bash
cd server
npm install
npm run seed:demo
DB_PATH=data/demo.db MIRRORS= npm run dev
```

`npm run seed:demo` writes ten posts that point at the `public/nekotime` GIFs, so the UI is
reviewable before the upload pipeline and parsers exist. It does not seed accounts or comments:
register through `/auth`. Delete `server/data/demo.db` to reseed. It never touches production data.

For a production install use [server/.env.example](server/.env.example): it documents every engine
variable, including `PUBLIC_BASE_URL`, `SECURITY_CONTACT`, `MIN_MIRRORS=2`, `TRUST_PROXY` and the
perimeter limits (`RATE_LIMIT_ENABLED`, `BODY_LIMIT_BYTES`, `REQUEST_TIMEOUT_MS`). The
first administrator is created by registering normally and running
`npm run promote -- <username>` in `server/`. The Caddy + pm2 setup, security headers and the
same-origin guard are covered in [deploy/README.md](deploy/README.md); daily SQLite snapshots,
`/healthz`/`/readyz`, JSON logs and Telegram alerts are documented in
[server/README.md](server/README.md#backups-health-and-logs).

Add real 2D art from Danbooru to the same demo database (no image files are stored; previews are
proxied and cached in RAM):

```bash
cd server
npm run import:source -- --db data/demo.db --limit 20
npm run import:source -- --db data/demo.db --tags "landscape" --limit 12
```

Terminal 2 — UI:

```bash
npm install
npm start
```

Open http://localhost:4200. The dev server proxies `/api`, `/i`, `/t`, `/healthz` and `/feed.xml`
to `http://127.0.0.1:3000` (`proxy.conf.json`). In development `/post/:id` stays the Angular route;
the crawler HTML is only served when Caddy sees a bot user agent, so check it with
`curl http://localhost:3000/post/1`. If `PORT` is set in your shell, Angular picks it up;
use `PORT=4200 npm start` to pin the port.

## What the UI does

- tag search with autocomplete, `-tag`, `*`/`%` wildcards, `rating:s`, `order:score` pass-through
- relative tag matching: `pixel art` finds `pixel_art`, case is ignored, commas separate tags
  (`pixel art, sign`), and an exact tag wins over a substring fallback
- popular-tag sidebar, responsive grid, page-based pagination (30 posts per page), skeleton/empty/error states
- post page with zoom lightbox, tags grouped by Copyright / Character / Artist / General / Meta /
  Species with localized category labels, dimensions, sources/mirrors and a pending banner;
  a dead mirror falls through to the next live copy, and “copy image link” gives the direct
  `/i/:id` URL
- favorites: one click on a post, `/favorites` lists them newest first; parent/child versions
  (crops, rescans) are linked on the post page, staff can attach or detach them there
- `/pools` and `/pools/:id`: ordered collections; staff create pools and add or remove posts
  straight from the pool page
- `/random` opens a random post inside the current filter; `/feed.xml` is the RSS mirror
- accounts: registration, login, cookie sessions, account page and sign-out
- comments on posts with a no-links rule, cooldown, author/moderation deletion, up/down votes,
  score-based collapsing and derived author karma; staff votes weigh more, with vote cooldowns,
  a rolling daily cap and a reciprocal-downvote guard
- uploader applications, a session-based upload page for approved uploaders and a personal upload queue with moderation feedback
- admin Sources tab: automatic head/backfill imports with daily caps, manual runs, live progress, per-run logs and cancellation
- public `/stats` page with archive, media, rating, tag, community and source counts rendered with nekotime digits
- English by default, RU/EN from a language registry (manual choice persists; add a dictionary + one entry for a new language)
- content filter with Safe (s), Mixed (s+q) and Adult (explicit only) modes; Adult requires a one-time age confirmation
- `/settings` for guests and members: rating mode plus an opt-in for sensitive tags (`loli*`, `shota*`,
  `rape*`, …) with no account required; the server applies it to feeds and post pages, and a hidden
  post offers a one-click reveal. Signed-in visitors also get an account section and sign-out
- footer links to About, Help, Stats, Rules, DMCA and Terms pages, all with EN/RU content
- nekotime GIFs as the header clock, empty-state mascot and the 404 page

## API

Public read endpoints need no account: `GET /api/v1/posts` (tag search, rating modes and keyset
cursors `after_id`/`before_id`), `GET /api/v1/posts/:id`, `GET /api/v1/posts/random`,
`GET /api/v1/posts/:id/related`, `GET /api/v1/pools`, `GET /api/v1/tags` and `GET /api/v1/stats`.
Post objects carry relative and absolute image/thumbnail links, plus parent/children and favorite
counts. Browser clients on other origins are allowed by default (`API_CORS_ORIGINS=*`); session
endpoints never get CORS headers. Uploads and parser posts use the instance `UPLOAD_TOKEN`;
favorites need a session, pools and parent links need a moderator or admin.

Reference: [docs/API.md](docs/API.md). Machine-readable spec: `GET /api/v1/openapi.json`.

## Build and checks

```bash
npm run build                             # production bundle
ng test                                   # Vitest + jsdom
cd server && npm test && npm run typecheck
cd server && npm run build && npm run smoke   # engine + SQLite + HTTP, offline
```

`.github/workflows/ci.yml` runs all of the above on every push and pull request: server tests and
typecheck, the production Angular build, and the smoke pass. The deploy job is present but disabled
until there is a target.

## Not in the UI yet

- email verification, password reset, registration throttling
- tag editing and bulk pool editing in the admin panel
- Pixiv as the next source adapter; Twitter/X stays a source link, not an adapter
- Telegram mirror status

## License

Boorushiko is free software: you can redistribute it and/or modify it under the terms of the GNU
General Public License as published by the Free Software Foundation, either version 2 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See
[LICENSE](LICENSE) for the full text.

The engine is copyleft: if you distribute a modified version, you must make the source available
under the same license.

The nekotime GIFs in `public/nekotime/` come from
[NekoTime](https://github.com/redtidev1918/NekoTime) and are used under the MIT license. Other
third-party assets are not automatically covered by this license; check their origin and terms
before redistributing them, or replace them with your own art.
