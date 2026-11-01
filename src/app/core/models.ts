export type Rating = 's' | 'q' | 'e';

/** Safe = s only, Mixed = s + q, Adult = e only. */
export type RatingMode = 'safe' | 'mixed' | 'adult';

export type TagCategory = 'general' | 'artist' | 'character' | 'copyright' | 'species' | 'meta';

export interface PostTag {
  name: string;
  category: TagCategory;
}

export interface Post {
  id: number;
  storageKind: 'hosted' | 'remote';
  md5: string;
  sha256: string;
  mime: string;
  ext: string;
  width: number;
  height: number;
  bytes: number;
  rating: Rating;
  score: number;
  sourceUrl: string | null;
  status: 'pending' | 'active' | 'hidden' | 'deleted';
  createdAt: string;
  tags: PostTag[];
  url: string;
  thumbUrl: string;
}

export interface PostSource {
  host: string;
  url: string;
  role: 'serve' | 'archive';
  format: string | null;
  status: 'pending' | 'ok' | 'dead' | 'rejected';
  priority: number;
}

export interface PostVariant {
  kind: 'thumb300' | 'delivery';
  url: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  format: string | null;
}

export interface PostOrigin {
  provider: string;
  pageUrl: string | null;
  fileUrl: string;
  previewUrl: string | null;
  status: 'ok' | 'source_dead';
}

export interface PostRef {
  id: number;
  url: string;
  thumbUrl: string;
  absoluteUrl: string;
  absoluteThumbUrl: string;
}

export interface PostDetail extends Post {
  sources: PostSource[];
  variants: PostVariant[];
  origins: PostOrigin[];
  commentCount: number;
  /** Original work when this post is a crop or an alternate version. */
  parent: PostRef | null;
  children: PostRef[];
  favorited: boolean;
  favoriteCount: number;
}

export interface FavoriteState {
  favorited: boolean;
  favoriteCount: number;
}

export interface FavoritePost extends Post {
  favoritedAt: string | null;
}

export interface FavoritesResponse {
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  posts: FavoritePost[];
}

export interface RandomPostResponse {
  post: Post;
}

export type PoolCategory = 'series' | 'collection' | 'event' | 'other';

export interface Pool {
  id: number;
  title: string;
  description: string | null;
  category: PoolCategory;
  isPublic: boolean;
  postCount: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface PoolsResponse {
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  pools: Pool[];
}

export interface PoolDetailResponse {
  pool: Pool;
  page: number;
  limit: number;
  hasMore: boolean;
  posts: Post[];
}

export interface PostsResponse {
  page: number;
  limit: number;
  hasMore: boolean;
  posts: Post[];
}

export interface RelatedPost extends Post {
  /** 0..1 weighted tag overlap with the post being viewed. */
  similarity: number;
  sharedTags: string[];
}

export interface RelatedPostsResponse {
  postId: number;
  limit: number;
  seedTags: string[];
  posts: RelatedPost[];
}

export interface TagSummary {
  name: string;
  category: TagCategory;
  postCount: number;
}

export interface TagsResponse {
  tags: TagSummary[];
}

export interface ArchiveStats {
  posts: {
    total: number;
    active: number;
    pending: number;
    hidden: number;
    deleted: number;
  };
  media: { images: number; animated: number; videos: number };
  ratings: { general: number; sensitive: number; explicit: number };
  tags: {
    total: number;
    general: number;
    artist: number;
    character: number;
    copyright: number;
    species: number;
    meta: number;
  };
  community: { members: number; uploaders: number; comments: number };
  sources: {
    hosted: number;
    remote: number;
    mirrors: number;
    origins: number;
    providers: number;
  };
  activity: { oldest: string | null; newest: string | null };
  generatedAt: string;
}

export type UserRole = 'user' | 'moderator' | 'admin';

export interface User {
  id: number;
  username: string;
  role: UserRole;
  createdAt: string;
  canUpload: boolean;
  commentKarma: number;
}

export interface MeResponse {
  user: User | null;
}

export interface AuthResponse {
  user: User;
}

export interface Comment {
  id: number;
  body: string;
  score: number;
  voteCount: number;
  hidden: boolean;
  myVote: -1 | 0 | 1;
  authorKarma: number;
  createdAt: string;
  updatedAt: string;
  user: { id: number; username: string; role: UserRole };
}

export interface CommentsResponse {
  comments: Comment[];
  hasMore: boolean;
  total: number;
}

export interface CommentResponse {
  comment: Comment;
}

export type ModerationReason =
  | 'ai'
  | '3d'
  | 'not_2d'
  | 'duplicate'
  | 'low_quality'
  | 'banned_artist'
  | 'copyright'
  | 'metadata'
  | 'other';

export const MODERATION_REASONS: readonly ModerationReason[] = [
  'ai',
  '3d',
  'not_2d',
  'duplicate',
  'low_quality',
  'banned_artist',
  'copyright',
  'metadata',
  'other',
];

export interface AdminPost {
  id: number;
  storageKind: 'hosted' | 'remote';
  mime: string;
  ext: string;
  width: number;
  height: number;
  bytes: number;
  rating: Rating;
  score: number;
  sourceUrl: string | null;
  status: 'pending' | 'active' | 'hidden' | 'deleted';
  createdAt: string;
  updatedAt: string;
  uploadedBy: string | null;
  moderatedAt: string | null;
  rejectionReason: ModerationReason | null;
  moderationNote: string | null;
  policyFlags: string[];
  sourceCount: number;
  originCount: number;
  reportCount: number;
  tags: PostTag[];
  thumbUrl: string;
}

export interface AdminOverview {
  posts: { pending: number; active: number; hidden: number; deleted: number };
  openReports: number;
  dnp: number;
  flaggedPending: number;
  pendingUploaderRequests: number;
}

export interface AdminQueueResponse {
  page: number;
  limit: number;
  hasMore: boolean;
  total: number;
  posts: AdminPost[];
}

export interface AdminReport {
  id: number;
  postId: number;
  reason: ModerationReason;
  body: string | null;
  status: 'open' | 'resolved' | 'dismissed';
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  reporter: string | null;
  resolvedBy: string | null;
  post: { id: number; status: string; rating: Rating; thumbUrl: string };
}

export interface AdminReportsResponse {
  reports: AdminReport[];
  total: number;
}

export interface DnpEntry {
  id: number;
  name: string;
  sourcePattern: string | null;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface DnpResponse {
  entries: DnpEntry[];
}

export interface AuditEntry {
  id: number;
  action: string;
  targetType: string;
  targetId: number | null;
  reason: string | null;
  details: string | null;
  createdAt: string;
  actor: string | null;
}

export interface AuditResponse {
  page: number;
  limit: number;
  total: number;
  entries: AuditEntry[];
}

export interface Notification {
  id: number;
  kind: string;
  postId: number | null;
  body: string;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationsResponse {
  notifications: Notification[];
  unread: number;
}

export interface ReportResponse {
  report: AdminReport;
}

export interface UploaderRequest {
  id: number;
  message: string | null;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
}

export interface UploaderState {
  approved: boolean;
  role: UserRole;
  request: UploaderRequest | null;
}

export interface MyUpload {
  id: number;
  status: 'pending' | 'active' | 'hidden' | 'deleted';
  rating: Rating;
  mime: string;
  ext: string;
  width: number;
  height: number;
  bytes: number;
  createdAt: string;
  updatedAt: string;
  rejectionReason: ModerationReason | null;
  moderationNote: string | null;
  policyFlags: string[];
  tags: PostTag[];
  thumbUrl: string | null;
}

export interface MyUploadsResponse {
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  uploads: MyUpload[];
}

export interface UploadResponse {
  postId: number;
  duplicate: boolean;
  status: string;
  jobs: number;
}

export interface AdminUploaderRequest extends UploaderRequest {
  userId: number;
  username: string;
  reviewer: string | null;
}

export interface UploaderEntry {
  userId: number;
  username: string;
  approvedAt: string;
  approvedBy: string | null;
  note: string | null;
  postCount: number;
}

export interface AdminUploadersResponse {
  requests: AdminUploaderRequest[];
  uploaders: UploaderEntry[];
}

export type SourceRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SourceRun {
  id: number;
  source: string;
  auto: boolean;
  mode: 'manual' | 'head' | 'backfill';
  sinceId: string | null;
  cursor: string | null;
  tags: string | null;
  limitCount: number;
  page: number;
  pageSize: number;
  delayMs: number;
  status: SourceRunStatus;
  imported: number;
  duplicates: number;
  failed: number;
  seen: number;
  pages: number;
  cancelRequested: boolean;
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface SourceRunLog {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  createdAt: string;
}

export interface SourceSchedule {
  source: string;
  enabled: boolean;
  intervalMinutes: number;
  batchLimit: number;
  dailyLimit: number;
  tags: string | null;
  nextMode: 'head' | 'backfill';
  headId: string | null;
  cursor: string | null;
  backfillDone: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastError: string | null;
  failureCount: number;
  dailyUsed: number;
}

export interface AdminSourcesResponse {
  sources: string[];
  schedules: SourceSchedule[];
  runs: SourceRun[];
}

export interface SourceScheduleResponse {
  schedule: SourceSchedule;
}

export interface SourceRunDetail {
  run: SourceRun;
  logs: SourceRunLog[];
}

export interface SourceRunResponse {
  run: SourceRun;
}
