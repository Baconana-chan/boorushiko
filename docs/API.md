# Boorushiko API

Public read API for a Boorushiko archive. Read endpoints need no account, no key and no cookie.
Writes use the instance token from `UPLOAD_TOKEN` — the same one the parser uses.

- Base URL: `PUBLIC_BASE_URL` (for example `https://booru.example`)
- Machine-readable spec: [`GET /api/v1/openapi.json`](#openapi)
- Format: JSON, UTF-8. Every response carries `X-Request-Id`; quote it in bug reports.
- Versioning: breaking changes only in `/api/v2`. New fields may appear in `/v1` at any time, so
  parse by field name and ignore unknown keys.

## CORS

Read endpoints are usable from browser clients on other origins. By default any origin is allowed
(`API_CORS_ORIGINS=*`); set a comma-separated list such as
`API_CORS_ORIGINS=https://gallery.example,https://mirror.example` to narrow it, or leave it empty to
disable CORS entirely. `GET, HEAD, OPTIONS` are allowed; `/api/v1/admin`, `/api/v1/auth`,
`/api/v1/me` and every mutating method never receive CORS headers. Credentials are never allowed,
so a third-party page cannot act as a signed-in visitor.

## Authentication

- **Read** — none.
- **Writes** — `X-Upload-Token: $UPLOAD_TOKEN` on `POST /api/v1/posts` and
  `POST /api/v1/posts/remote`. This is an instance-wide token for the parser and bots; it is not
  meant for end users.

## `GET /api/v1/posts` — search

| Parameter           | Default | Meaning                                                                |
| ------------------- | ------- | ---------------------------------------------------------------------- |
| `tags`              | —       | Search query, see [syntax](#search-syntax).                            |
| `rating_mode`       | `mixed` | `safe` (s), `mixed` (s+q), `adult` (e only).                           |
| `include_sensitive` | `1`     | `0` hides posts carrying a sensitive tag (`loli`, `shota`, `rape`, …). |
| `page`              | `1`     | Offset page, ignored when a cursor is used.                            |
| `limit`             | `20`    | 1–100.                                                                 |
| `after_id`          | —       | Keyset cursor: posts with `id > after_id`, oldest first.               |
| `before_id`         | —       | Keyset cursor: posts with `id < before_id`, newest first.              |

Response:

```json
{
  "page": 1,
  "limit": 20,
  "hasMore": true,
  "baseUrl": "https://booru.example",
  "nextCursor": 1234,
  "posts": [
    {
      "id": 1234,
      "storageKind": "remote",
      "mime": "image/png",
      "width": 1200,
      "height": 900,
      "bytes": 1843200,
      "rating": "q",
      "score": 12,
      "sourceUrl": "https://www.pixiv.net/artworks/146828566",
      "status": "active",
      "createdAt": "2026-10-27T09:12:31.000Z",
      "tags": [{ "name": "flandre", "category": "character" }],
      "url": "/i/1234",
      "thumbUrl": "/t/1234?v=2",
      "absoluteUrl": "https://booru.example/i/1234",
      "absoluteThumbUrl": "https://booru.example/t/1234?v=2"
    }
  ]
}
```

`url`/`thumbUrl` are relative to `baseUrl`; the `absolute*` fields are ready to use.

### Cursors instead of pages

`page`/`offset` drifts when new posts are uploaded during a walk. For sync, use `after_id`:

```bash
# newest → oldest: start from the newest ids and keep prepending
curl -s "$BASE/api/v1/posts?limit=100&after_id=0"

# archive walk: start above the newest id, then go backwards
curl -s "$BASE/api/v1/posts?limit=100&before_id=999999999"
```

`after_id` returns posts with a larger id, oldest first; `before_id` returns posts with a smaller
id, newest first. Both ignore `page` and `order:*` and work together with tag filters and rating
modes. Pass `nextCursor` from the previous response back as the same parameter until `hasMore` is
`false`. Never combine `after_id` with `before_id` — that is a `400 invalid_cursor`.

## `GET /api/v1/posts/{id}` — one post

Returns the post object plus:

- `baseUrl` and the same four link fields;
- `sources` — mirrors (`host`, `url`, `role`, `format`, `status`, `priority`);
- `variants` — delivery/preview renditions (`kind`, `url`, `width`, `height`, `bytes`, `format`);
- `origins` — parser provenance (`provider`, `pageUrl`, `fileUrl`, `previewUrl`, `status`);
- `commentCount`;
- `parent` — `{ id, url, thumbUrl }` when this post is a crop or an alternate version, else `null`;
- `children` — active posts whose parent is this one;
- `favorited` / `favoriteCount` — the viewer's own state (when signed in) and the total.

`403 sensitive_hidden` means the post carries a sensitive tag and the request had
`include_sensitive=0`.

## `GET /api/v1/posts/{id}/related` — more like this

`limit` (1–50, default 12), `rating_mode` and `include_sensitive` work exactly as in the search
endpoint. The response is `{ postId, limit, seedTags, posts }`, where each post is a normal list
item plus:

- `similarity` — `0..1`, weighted tag overlap divided by the seed's own tag weight;
- `sharedTags` — the tags this post has in common with the seed, rarest first (max 4).

Ranking is tag overlap, not pixels. Every seed tag gets an IDF weight, so a rare artist tag counts
more than `1girl`; categories weigh artist > character > copyright > species > general; meta tags
(`highres`, `commentary_request`, `translated`, …) are ignored entirely because they appear on
almost every post. A candidate is tapered by how many tags it actually shares
(`shared / (shared + 1)`), so a lone rare hit does not outrank a genuinely similar post. The
candidate query only walks the cheaper seed tags, so one page view never becomes a table scan.

`403 sensitive_hidden` also covers the seed post: if it carries a sensitive tag and the request
sent `include_sensitive=0`.

## `GET /api/v1/posts/random` — one random post

Same filters as the list (`tags`, `rating_mode`, `include_sensitive`) and one post back as
`{ "post": { … } }`. Never cached. `404 no_posts` means the filter matched nothing.

## Favorites

Favorites are per account and need the session cookie the site itself uses; there is no API key
for them.

| Endpoint                        | Meaning                                               |
| ------------------------------- | ----------------------------------------------------- |
| `POST /api/v1/posts/{id}/favorite` | Save a post. Idempotent; returns `{ favorited, favoriteCount }`. |
| `DELETE /api/v1/posts/{id}/favorite` | Remove it.                                          |
| `GET /api/v1/me/favorites`      | `page`/`limit` (1–100, default 24); newest first, active posts only. |

`401 auth_required` without a session.

## Pools

Ordered collections of posts (a series, an event, a curated set). Reading is public:

- `GET /api/v1/pools` — public pools with `postCount`, newest activity first;
- `GET /api/v1/pools/{id}` — the pool plus its posts in pool order (`page`, `limit` ≤ 200).

Writing needs `moderator` or `admin`:

```bash
curl -s -X POST "$BASE/api/v1/pools" -b cookies.txt -H 'content-type: application/json' \
  -d '{"title":"Yuru Camp order","category":"series","description":"Camping, in reading order"}'
curl -s -X POST "$BASE/api/v1/pools/1/posts" -b cookies.txt \
  -H 'content-type: application/json' -d '{"postId":42}'
```

`PATCH` renames/hides a pool, `DELETE /api/v1/pools/{id}` removes the pool (posts stay in the
archive), `DELETE /api/v1/pools/{id}/posts/{postId}` removes one entry. Private pools answer `404`
to everyone but staff.

## `POST /api/v1/posts/{id}/parent` — versions of one artwork

Staff only. Body: `{ "parentId": 12 }` to link a crop/rescan, `{ "parentId": null }` to unlink.
`409 parent_cycle` when the link would loop, `404 parent_not_found` for a missing parent.

## Feeds and preview cards

- `GET /feed.xml` — RSS 2.0, 50 newest posts with ratings `s` and `q` only (explicit never
  appears); posts carrying a sensitive tag are skipped and only `s` posts get a thumbnail.
- `GET /post/{id}` — the HTML crawler document behind every shared link: `og:title`,
  `og:description`, `og:image` (`/t/{id}`), canonical URL. Explicit posts get a generic title, no
  image and `noindex`. Humans are served the Angular app by the reverse proxy.

## `GET /api/v1/tags` — autocomplete

`search` (empty = popular tags) and `limit` (1–50, default 20). Returns
`{ "tags": [{ "name": "flandre", "category": "character", "postCount": 1234 }] }`.

## `GET /api/v1/stats` — archive statistics

Counts by post status, media type, rating, tag category, community and source. Public.

## `POST /api/v1/posts` — upload an image

`multipart/form-data`: `file` (required), `tags`, `rating` (`s`/`q`/`e`), `sourceUrl`. Requires
`X-Upload-Token`.

```bash
curl -s -X POST "$BASE/api/v1/posts" \
  -H "X-Upload-Token: $UPLOAD_TOKEN" \
  -F "file=@art.png" -F "tags=flandre solo" -F "rating=s" \
  -F "sourceUrl=https://www.pixiv.net/artworks/146828566"
# 201 {"postId":42,"duplicate":false,"status":"pending","jobs":2}
```

The image is stored on this instance (staging → mirrors); `201` queues mirroring, `200` means the
same bytes already exist. `415` is an unsupported format (png, jpeg, webp, gif, avif only).

## `POST /api/v1/posts/remote` — index a post that stays on its source

The parser endpoint: no image bytes are copied, the original stays hotlinked and the preview is
proxied and cached. Requires `X-Upload-Token`.

```bash
curl -s -X POST "$BASE/api/v1/posts/remote" \
  -H "X-Upload-Token: $UPLOAD_TOKEN" -H 'content-type: application/json' \
  -d '{
    "provider": "gelbooru",
    "originId": "9001",
    "pageUrl": "https://gelbooru.com/index.php?page=post&s=view&id=9001",
    "fileUrl": "https://img3.gelbooru.com/images/aa/bb/9001.png",
    "previewUrl": "https://img3.gelbooru.com/samples/aa/bb/sample_9001.jpg",
    "sourceUrl": "https://www.pixiv.net/artworks/146828566",
    "rating": "q",
    "mime": "image/png",
    "tags": ["solo", "hat", "artist:someone"],
    "width": 1200,
    "height": 900
  }'
```

Re-posting the same `provider` + `originId` is idempotent (`200` with `duplicate: true`) and
refreshes the stored preview URL. `403 dnp_artist` means the artist is on the do-not-post list.

## Search syntax

The query is the same as the site's search box:

| Example          | Meaning                                                                            |
| ---------------- | ---------------------------------------------------------------------------------- |
| `flandre solo`   | both tags (AND)                                                                    |
| `pixel art`      | resolves to `pixel_art`; a literal phrase wins over two tags                       |
| `-hat`           | exclude a tag                                                                      |
| `hat*`, `%hat%`  | prefix / substring wildcard                                                        |
| `artist:someone` | category prefix (`artist`, `character`, `copyright`, `meta`, `species`, `general`) |
| `rating:s,q`     | safe + questionable                                                                |
| `score:>10`      | minimum score                                                                      |
| `order:new\|score\|random` | ordering for offset pages                                               |

Up to 25 tags per query. Unknown ratings/orders and oversized queries return `400`.

## Errors

```json
{ "error": "human readable message", "code": "machine_code" }
```

Common codes: `invalid_cursor`, `invalid_tags`, `unsupported_media`, `dnp_artist`,
`sensitive_hidden`, `cross_origin`, `unknown_source`.

## Rate limits

`GET /api/v1/posts` allows 300 requests/minute per address; `429` responses carry `Retry-After`.
Counters are in process memory, so a restart clears them.

## OpenAPI {#openapi}

The full document is served at `/api/v1/openapi.json`; it is hand-written in `server/src/openapi.ts`
alongside this reference. Example clients:

```bash
curl -s "$BASE/api/v1/openapi.json" | jq '.paths | keys'
npx @redocly/cli lint <(curl -s "$BASE/api/v1/openapi.json")
npx openapi-typescript "$BASE/api/v1/openapi.json" -o booru.d.ts
```
