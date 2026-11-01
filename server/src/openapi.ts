/**
 * Hand-written OpenAPI 3.1 document for the public API. It is served at
 * /api/v1/openapi.json so client generators and readers do not need the repo;
 * keep it in sync with app.ts and routes/*.ts when an endpoint changes.
 */
export function openApiDocument(baseUrl: string) {
  const tagList = {
    type: 'array',
    items: {
      type: 'object',
      required: ['name', 'category'],
      properties: {
        name: { type: 'string' },
        category: { type: 'string' },
      },
    },
  } as const;

  const post = {
    type: 'object',
    required: [
      'id',
      'storageKind',
      'mime',
      'ext',
      'width',
      'height',
      'bytes',
      'rating',
      'status',
      'createdAt',
      'tags',
    ],
    properties: {
      id: { type: 'integer' },
      storageKind: { type: 'string', enum: ['hosted', 'remote'] },
      md5: { type: 'string' },
      sha256: { type: 'string' },
      mime: { type: 'string' },
      ext: { type: 'string' },
      width: { type: 'integer' },
      height: { type: 'integer' },
      bytes: { type: 'integer' },
      rating: {
        type: 'string',
        enum: ['s', 'q', 'e'],
        description: 'safe, questionable, explicit.',
      },
      score: { type: 'integer' },
      sourceUrl: { type: ['string', 'null'] },
      status: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      tags: tagList,
    },
  } as const;

  const postListItem = {
    allOf: [
      { $ref: '#/components/schemas/Post' },
      {
        type: 'object',
        required: ['url', 'thumbUrl', 'absoluteUrl', 'absoluteThumbUrl'],
        properties: {
          url: { type: 'string', description: 'Original image, relative to `baseUrl`.' },
          thumbUrl: {
            type: 'string',
            description: 'Cached WebP thumbnail, relative to `baseUrl`.',
          },
          absoluteUrl: { type: 'string', format: 'uri' },
          absoluteThumbUrl: { type: 'string', format: 'uri' },
        },
      },
    ],
  } as const;

  const error = {
    type: 'object',
    required: ['error'],
    properties: {
      error: { type: 'string' },
      code: { type: 'string' },
    },
  } as const;

  const cursorParams = [
    {
      name: 'after_id',
      in: 'query',
      schema: { type: 'integer', minimum: 0 },
      description:
        'Keyset cursor: posts with `id > after_id`, oldest first. Stable for incremental sync; ' +
        'ignores `page` and `order`.',
    },
    {
      name: 'before_id',
      in: 'query',
      schema: { type: 'integer', minimum: 0 },
      description:
        'Keyset cursor: posts with `id < before_id`, newest first. Walk the archive without ' +
        'offset drift.',
    },
  ] as const;

  return {
    openapi: '3.1.0',
    info: {
      title: 'Boorushiko API',
      version: '1.0.0',
      summary: 'Read API for a Boorushiko archive, plus token-authenticated uploads.',
      description:
        'Public read endpoints need no credentials. Uploads and parser posts use the shared ' +
        'instance token from `UPLOAD_TOKEN`. Breaking changes only ever land in `/api/v2`; ' +
        'the `/v1` field set is additive.',
      license: { name: 'GPL-2.0-or-later', identifier: 'GPL-2.0-or-later' },
    },
    servers: [{ url: baseUrl.replace(/\/+$/, '') }],
    tags: [
      { name: 'posts', description: 'Search, read and ingest posts.' },
      { name: 'tags', description: 'Tag autocomplete.' },
      { name: 'favorites', description: 'Per-member saved posts.' },
      { name: 'pools', description: 'Curated ordered collections of posts.' },
      { name: 'meta', description: 'Statistics and this document.' },
    ],
    paths: {
      '/api/v1/posts': {
        get: {
          tags: ['posts'],
          operationId: 'listPosts',
          summary: 'Search posts',
          parameters: [
            {
              name: 'tags',
              in: 'query',
              schema: { type: 'string' },
              description:
                'Search syntax: `solo hat`, `-tag`, `tag*`, `rating:q`, `order:score`, ' +
                '`score:>10`, `artist:someone`. See docs/API.md.',
            },
            {
              name: 'rating_mode',
              in: 'query',
              schema: { type: 'string', enum: ['safe', 'mixed', 'adult'] },
              description: '`safe` = s, `mixed` = s+q (default), `adult` = e only.',
            },
            {
              name: 'include_sensitive',
              in: 'query',
              schema: { type: 'string', enum: ['0', '1'] },
              description: '`0` hides posts that carry a sensitive tag; defaults to showing them.',
            },
            {
              name: 'page',
              in: 'query',
              schema: { type: 'integer', minimum: 1, default: 1 },
              description: 'Offset page. Ignored when a cursor is used.',
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            },
            ...cursorParams,
          ],
          responses: {
            '200': {
              description: 'One page of posts.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['page', 'limit', 'hasMore', 'baseUrl', 'posts'],
                    properties: {
                      page: { type: 'integer' },
                      limit: { type: 'integer' },
                      hasMore: { type: 'boolean' },
                      baseUrl: { type: 'string', format: 'uri' },
                      nextCursor: {
                        type: ['integer', 'null'],
                        description: 'Pass as `after_id` or `before_id` for the next page.',
                      },
                      posts: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/PostListItem' },
                      },
                    },
                  },
                },
              },
            },
            '400': {
              description: 'Invalid search, rating mode or cursor.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            '429': { description: 'Rate limited; honor the `Retry-After` header.' },
          },
        },
        post: {
          tags: ['posts'],
          operationId: 'uploadPost',
          summary: 'Upload an image and mirror it',
          security: [{ uploadToken: [] }],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file'],
                  properties: {
                    file: { type: 'string', format: 'binary' },
                    tags: { type: 'string', description: 'Space- or comma-separated tag list.' },
                    rating: { type: 'string', enum: ['s', 'q', 'e'] },
                    sourceUrl: { type: 'string', format: 'uri' },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Queued for mirroring (200 for a duplicate).',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      postId: { type: 'integer' },
                      duplicate: { type: 'boolean' },
                      status: { type: 'string' },
                      jobs: { type: 'integer' },
                    },
                  },
                },
              },
            },
            '401': { description: 'Missing or wrong upload token.' },
            '415': { description: 'Unsupported media type.' },
          },
        },
      },
      '/api/v1/posts/{id}': {
        get: {
          tags: ['posts'],
          operationId: 'getPost',
          summary: 'Read one post',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: {
            '200': {
              description: 'The post with mirrors, variants and origins.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/PostDetail' } },
              },
            },
            '403': {
              description: 'Post carries a sensitive tag and `include_sensitive=0` was sent.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            '404': { description: 'No such post.' },
          },
        },
      },
      '/api/v1/posts/{id}/related': {
        get: {
          tags: ['posts'],
          operationId: 'listRelatedPosts',
          summary: 'More like this',
          description:
            'Ranked by weighted tag overlap: rare tags count more than common ones and ' +
            'artist/character/copyright tags weigh more than general ones. Meta tags ' +
            '(`highres`, `commentary_request`, ...) are ignored.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
            {
              name: 'rating_mode',
              in: 'query',
              schema: { type: 'string', enum: ['safe', 'mixed', 'adult'] },
              description: '`safe` = s, `mixed` = s+q (default), `adult` = e only.',
            },
            {
              name: 'include_sensitive',
              in: 'query',
              schema: { type: 'string', enum: ['0', '1'] },
              description: '`0` hides posts that carry a sensitive tag; defaults to showing them.',
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 50, default: 12 },
            },
          ],
          responses: {
            '200': {
              description: 'Related posts, best match first.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['postId', 'limit', 'seedTags', 'posts'],
                    properties: {
                      postId: { type: 'integer' },
                      limit: { type: 'integer' },
                      seedTags: {
                        type: 'array',
                        items: { type: 'string' },
                        description:
                          'Seed tags that took part in the ranking (noise already dropped).',
                      },
                      posts: {
                        type: 'array',
                        items: {
                          allOf: [
                            { $ref: '#/components/schemas/PostListItem' },
                            {
                              type: 'object',
                              required: ['similarity', 'sharedTags'],
                              properties: {
                                similarity: {
                                  type: 'number',
                                  minimum: 0,
                                  maximum: 1,
                                  description: 'Weighted overlap divided by the seed tag weight.',
                                },
                                sharedTags: {
                                  type: 'array',
                                  items: { type: 'string' },
                                  description: 'Shared tags, rarest first (max 4).',
                                },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
            '400': {
              description: 'Invalid `rating_mode`.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            '403': {
              description: 'Seed post carries a sensitive tag and `include_sensitive=0` was sent.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            '404': { description: 'No such post.' },
            '429': { description: 'Rate limited; honor the `Retry-After` header.' },
          },
        },
      },
      '/api/v1/posts/remote': {
        post: {
          tags: ['posts'],
          operationId: 'createRemotePost',
          summary: 'Index a post that stays on its source (parser endpoint)',
          security: [{ uploadToken: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['provider', 'pageUrl', 'fileUrl', 'mime', 'rating', 'tags'],
                  properties: {
                    provider: { type: 'string' },
                    originId: { type: 'string' },
                    pageUrl: { type: 'string', format: 'uri' },
                    fileUrl: { type: 'string', format: 'uri' },
                    sourceUrl: { type: 'string', format: 'uri' },
                    previewUrl: { type: 'string', format: 'uri' },
                    refererPolicy: { type: 'string', enum: ['none', 'page', 'origin'] },
                    rating: { type: 'string', enum: ['s', 'q', 'e'] },
                    tags: { type: 'array', items: { type: 'string' } },
                    mime: {
                      type: 'string',
                      enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'],
                    },
                    width: { type: 'integer' },
                    height: { type: 'integer' },
                    bytes: { type: 'integer' },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Post indexed (200 when it already existed).',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      postId: { type: 'integer' },
                      duplicate: { type: 'boolean' },
                      status: { type: 'string' },
                    },
                  },
                },
              },
            },
            '400': { description: 'Invalid body.' },
            '401': { description: 'Missing or wrong upload token.' },
            '403': { description: 'Artist is on the do-not-post list.' },
            '415': { description: 'Unsupported media type.' },
          },
        },
      },
      '/api/v1/posts/random': {
        get: {
          tags: ['posts'],
          operationId: 'getRandomPost',
          summary: 'One random post',
          description:
            'A random post matching the tag query and the rating filter. Used by /random; ' +
            'the response is never cached.',
          parameters: [
            { name: 'tags', in: 'query', schema: { type: 'string' } },
            {
              name: 'rating_mode',
              in: 'query',
              schema: { type: 'string', enum: ['safe', 'mixed', 'adult'] },
            },
            {
              name: 'include_sensitive',
              in: 'query',
              schema: { type: 'string', enum: ['0', '1'] },
            },
          ],
          responses: {
            '200': {
              description: 'A post with links.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['post'],
                    properties: { post: { $ref: '#/components/schemas/PostListItem' } },
                  },
                },
              },
            },
            '400': { description: 'Invalid query.' },
            '404': {
              description: 'Nothing matches; `code` is `no_posts`.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            '429': { description: 'Rate limited.' },
          },
        },
      },
      '/api/v1/posts/{id}/favorite': {
        post: {
          tags: ['favorites'],
          operationId: 'addFavorite',
          summary: 'Save a post to favorites',
          description: 'Idempotent. Requires a session cookie.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: {
            '200': {
              description: 'Favorite state after the change.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['favorited', 'favoriteCount'],
                    properties: {
                      favorited: { type: 'boolean' },
                      favoriteCount: { type: 'integer' },
                    },
                  },
                },
              },
            },
            '401': { description: 'Not signed in (`auth_required`).' },
            '404': { description: 'No such post.' },
          },
        },
        delete: {
          tags: ['favorites'],
          operationId: 'removeFavorite',
          summary: 'Remove a post from favorites',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: {
            '200': { description: 'Favorite state after the change.' },
            '401': { description: 'Not signed in.' },
          },
        },
      },
      '/api/v1/me/favorites': {
        get: {
          tags: ['favorites'],
          operationId: 'listFavorites',
          summary: 'Posts saved by the signed-in user',
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 24 },
            },
          ],
          responses: {
            '200': { description: 'Newest favorites first; only active posts are listed.' },
            '401': { description: 'Not signed in.' },
          },
        },
      },
      '/api/v1/pools': {
        get: {
          tags: ['pools'],
          operationId: 'listPools',
          summary: 'Public pools',
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 50, default: 20 } },
          ],
          responses: { '200': { description: 'Pools with their post counts, newest first.' } },
        },
        post: {
          tags: ['pools'],
          operationId: 'createPool',
          summary: 'Create a pool (staff)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['title'],
                  properties: {
                    title: { type: 'string', maxLength: 120 },
                    description: { type: 'string', maxLength: 2000 },
                    category: {
                      type: 'string',
                      enum: ['series', 'collection', 'event', 'other'],
                      default: 'series',
                    },
                    isPublic: { type: 'boolean', default: true },
                  },
                },
              },
            },
          },
          responses: {
            '201': { description: 'The pool.' },
            '400': { description: 'Invalid title.' },
            '403': { description: 'Moderator access required (`staff_required`).' },
          },
        },
      },
      '/api/v1/pools/{id}': {
        get: {
          tags: ['pools'],
          operationId: 'getPool',
          summary: 'One pool and its posts',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
            { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200, default: 50 } },
          ],
          responses: {
            '200': { description: 'The pool and its posts in pool order.' },
            '404': { description: 'No such pool, or it is private and you are not staff.' },
          },
        },
        patch: {
          tags: ['pools'],
          operationId: 'updatePool',
          summary: 'Rename, describe or hide a pool (staff)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: {
            '200': { description: 'The updated pool.' },
            '403': { description: 'Moderator access required.' },
            '404': { description: 'No such pool.' },
          },
        },
        delete: {
          tags: ['pools'],
          operationId: 'deletePool',
          summary: 'Delete a pool (staff)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: {
            '204': { description: 'Deleted; the posts stay in the archive.' },
            '403': { description: 'Moderator access required.' },
            '404': { description: 'No such pool.' },
          },
        },
      },
      '/api/v1/pools/{id}/posts': {
        post: {
          tags: ['pools'],
          operationId: 'addPoolPost',
          summary: 'Append or move a post in a pool (staff)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['postId'],
                  properties: {
                    postId: { type: 'integer' },
                    position: { type: 'integer', minimum: 0 },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'The post id and its position.' },
            '403': { description: 'Moderator access required.' },
            '404': { description: 'No such pool or post.' },
          },
        },
      },
      '/api/v1/pools/{id}/posts/{postId}': {
        delete: {
          tags: ['pools'],
          operationId: 'removePoolPost',
          summary: 'Remove a post from a pool (staff)',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
            { name: 'postId', in: 'path', required: true, schema: { type: 'integer' } },
          ],
          responses: {
            '204': { description: 'Removed.' },
            '403': { description: 'Moderator access required.' },
          },
        },
      },
      '/api/v1/posts/{id}/parent': {
        post: {
          tags: ['posts'],
          operationId: 'setPostParent',
          summary: 'Link a post to its original (staff)',
          description:
            'Crops, higher-resolution rescans and alternate versions point at their parent. ' +
            'Cycles are rejected with `409 parent_cycle`.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { parentId: { type: ['integer', 'null'] } },
                },
              },
            },
          },
          responses: {
            '200': { description: '`{ postId, parentId }` after the change.' },
            '400': { description: '`parentId` is not a post id or null.' },
            '403': { description: 'Moderator access required.' },
            '404': { description: 'No such post or parent.' },
            '409': { description: 'The link would create a cycle.' },
          },
        },
      },
      '/api/v1/tags': {
        get: {
          tags: ['tags'],
          operationId: 'searchTags',
          summary: 'Tag autocomplete',
          parameters: [
            { name: 'search', in: 'query', schema: { type: 'string', default: '' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 50, default: 20 } },
          ],
          responses: {
            '200': {
              description: 'Matching tags with their category and post count.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      tags: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            name: { type: 'string' },
                            category: { type: 'string' },
                            postCount: { type: 'integer' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/api/v1/stats': {
        get: {
          tags: ['meta'],
          operationId: 'getStats',
          summary: 'Archive statistics',
          responses: {
            '200': { description: 'Counts by status, media, rating, tag category and source.' },
          },
        },
      },
      '/api/v1/openapi.json': {
        get: {
          tags: ['meta'],
          operationId: 'getOpenApi',
          summary: 'This document',
          responses: { '200': { description: 'OpenAPI 3.1 JSON.' } },
        },
      },
    },
    components: {
      securitySchemes: {
        uploadToken: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Upload-Token',
          description: 'The instance-wide `UPLOAD_TOKEN`; intended for the parser, not browsers.',
        },
      },
      schemas: {
        Post: post,
        PostListItem: postListItem,
        PostDetail: {
          allOf: [
            { $ref: '#/components/schemas/PostListItem' },
            {
              type: 'object',
              properties: {
                baseUrl: { type: 'string', format: 'uri' },
                commentCount: { type: 'integer' },
                favorited: { type: 'boolean' },
                favoriteCount: { type: 'integer' },
                parent: {
                  type: ['object', 'null'],
                  description: 'The original post when this one is a version of it.',
                  properties: {
                    id: { type: 'integer' },
                    url: { type: 'string' },
                    thumbUrl: { type: 'string' },
                  },
                },
                children: {
                  type: 'array',
                  description: 'Active versions whose parent is this post.',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'integer' },
                      url: { type: 'string' },
                      thumbUrl: { type: 'string' },
                    },
                  },
                },
                sources: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      host: { type: 'string' },
                      url: { type: 'string' },
                      role: { type: 'string' },
                      format: { type: 'string' },
                      status: { type: 'string' },
                      priority: { type: 'integer' },
                    },
                  },
                },
                variants: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      kind: { type: 'string' },
                      url: { type: 'string' },
                      width: { type: 'integer' },
                      height: { type: 'integer' },
                      bytes: { type: 'integer' },
                      format: { type: 'string' },
                    },
                  },
                },
                origins: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      provider: { type: 'string' },
                      pageUrl: { type: 'string' },
                      fileUrl: { type: 'string' },
                      previewUrl: { type: 'string' },
                      status: { type: 'string' },
                    },
                  },
                },
              },
            },
          ],
        },
        Error: error,
      },
    },
  };
}
