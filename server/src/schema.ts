import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const posts = sqliteTable(
  'posts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    storageKind: text('storage_kind').notNull().default('hosted'),
    md5: text('md5').notNull(),
    sha256: text('sha256').notNull(),
    mime: text('mime').notNull(),
    ext: text('ext').notNull(),
    width: integer('width').notNull().default(0),
    height: integer('height').notNull().default(0),
    bytes: integer('bytes').notNull(),
    rating: text('rating').notNull().default('s'),
    score: integer('score').notNull().default(0),
    sourceUrl: text('source_url'),
    status: text('status').notNull().default('pending'),
    uploadedBy: integer('uploaded_by'),
    moderatedBy: integer('moderated_by'),
    moderatedAt: text('moderated_at'),
    rejectionReason: text('rejection_reason'),
    moderationNote: text('moderation_note'),
    policyFlags: text('policy_flags').notNull().default('[]'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('posts_md5_uq').on(t.md5),
    index('posts_created_idx').on(t.createdAt),
    index('posts_status_created_idx').on(t.status, t.createdAt),
  ],
);

export const tags = sqliteTable(
  'tags',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    category: text('category').notNull().default('general'),
    postCount: integer('post_count').notNull().default(0),
  },
  (t) => [uniqueIndex('tags_name_uq').on(t.name)],
);

export const postTags = sqliteTable(
  'post_tags',
  {
    postId: integer('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.postId, t.tagId] }),
    index('post_tags_tag_idx').on(t.tagId, t.postId),
  ],
);

export const postSources = sqliteTable(
  'post_sources',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    postId: integer('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    host: text('host').notNull(),
    remoteId: text('remote_id'),
    url: text('url').notNull(),
    role: text('role').notNull().default('serve'),
    format: text('format'),
    width: integer('width'),
    height: integer('height'),
    bytes: integer('bytes'),
    status: text('status').notNull().default('pending'),
    priority: integer('priority').notNull().default(1),
    failCount: integer('fail_count').notNull().default(0),
    lastCheckedAt: text('last_checked_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('post_sources_post_idx').on(t.postId, t.status, t.priority)],
);

export const postVariants = sqliteTable(
  'post_variants',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    postId: integer('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    url: text('url'),
    width: integer('width'),
    height: integer('height'),
    bytes: integer('bytes'),
    format: text('format'),
    quality: integer('quality'),
  },
  (t) => [index('post_variants_post_idx').on(t.postId, t.kind)],
);

export const postOrigins = sqliteTable(
  'post_origins',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    postId: integer('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    pageUrl: text('page_url'),
    fileUrl: text('file_url').notNull(),
    previewUrl: text('preview_url'),
    refererPolicy: text('referer_policy'),
    status: text('status').notNull().default('ok'),
    checkedAt: text('checked_at'),
  },
  (t) => [index('post_origins_post_idx').on(t.postId)],
);

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    username: text('username').notNull(),
    usernameLower: text('username_lower').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role').notNull().default('user'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('users_username_lower_uq').on(t.usernameLower)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

export const comments = sqliteTable(
  'comments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    postId: integer('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    score: integer('score').notNull().default(0),
    voteCount: integer('vote_count').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('comments_post_idx').on(t.postId, t.id)],
);

export const commentVotes = sqliteTable(
  'comment_votes',
  {
    commentId: integer('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    value: integer('value').notNull(),
    weight: integer('weight').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.commentId, t.userId] }),
    index('comment_votes_user_idx').on(t.userId, t.updatedAt),
  ],
);

export const commentVoteActions = sqliteTable(
  'comment_vote_actions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    commentId: integer('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    value: integer('value').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('comment_vote_actions_user_idx').on(t.userId, t.createdAt),
    index('comment_vote_actions_created_idx').on(t.createdAt),
  ],
);

export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').notNull(),
  payload: text('payload').notNull(),
  runAt: text('run_at').notNull(),
  attempts: integer('attempts').notNull().default(0),
  lockedAt: text('locked_at'),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull(),
});

export const reports = sqliteTable(
  'reports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    postId: integer('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    reporterId: integer('reporter_id').references(() => users.id, { onDelete: 'set null' }),
    reason: text('reason').notNull(),
    body: text('body'),
    status: text('status').notNull().default('open'),
    createdAt: text('created_at').notNull(),
    resolvedBy: integer('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: text('resolved_at'),
    resolutionNote: text('resolution_note'),
  },
  (t) => [index('reports_status_idx').on(t.status, t.createdAt)],
);

export const dnpArtists = sqliteTable(
  'dnp_artists',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    sourcePattern: text('source_pattern'),
    note: text('note'),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('dnp_artists_name_uq').on(t.name)],
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    actorId: integer('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: integer('target_id'),
    reason: text('reason'),
    details: text('details'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('audit_log_created_idx').on(t.createdAt)],
);

export const notifications = sqliteTable(
  'notifications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    postId: integer('post_id').references(() => posts.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    readAt: text('read_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.readAt, t.createdAt)],
);

export type PostRow = typeof posts.$inferSelect;
export type TagRow = typeof tags.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type CommentRow = typeof comments.$inferSelect;
export type CommentVoteRow = typeof commentVotes.$inferSelect;
