import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  AdminOverview,
  AdminPost,
  AdminQueueResponse,
  AdminReport,
  AdminReportsResponse,
  AdminSourcesResponse,
  AdminUploadersResponse,
  ArchiveStats,
  AuditResponse,
  AuthResponse,
  CommentResponse,
  CommentsResponse,
  DnpEntry,
  DnpResponse,
  FavoriteState,
  FavoritesResponse,
  MeResponse,
  ModerationReason,
  MyUploadsResponse,
  RatingMode,
  NotificationsResponse,
  Pool,
  PoolCategory,
  PoolDetailResponse,
  PoolsResponse,
  PostDetail,
  PostsResponse,
  RandomPostResponse,
  RelatedPostsResponse,
  ReportResponse,
  SourceRunDetail,
  SourceRunResponse,
  SourceScheduleResponse,
  TagsResponse,
  UploaderState,
  UploadResponse,
} from './models';

export interface PostQuery {
  tags: string;
  page: number;
  limit: number;
  ratingMode: RatingMode;
  /** When false the server drops posts that carry a sensitive tag. */
  showSensitive: boolean;
}

export function apiErrorCode(error: unknown): string | null {
  const body = (error as { error?: { code?: unknown } } | null)?.error;
  return body && typeof body.code === 'string' ? body.code : null;
}

@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);

  listPosts(query: PostQuery) {
    const params: Record<string, string> = {
      tags: query.tags,
      page: String(query.page),
      limit: String(query.limit),
    };
    params['rating_mode'] = query.ratingMode;
    params['include_sensitive'] = query.showSensitive ? '1' : '0';
    return this.http.get<PostsResponse>('/api/v1/posts', { params });
  }

  getPost(id: number, showSensitive = false) {
    return this.http.get<PostDetail>(`/api/v1/posts/${id}`, {
      params: { include_sensitive: showSensitive ? '1' : '0' },
    });
  }

  /** "More like this": weighted tag overlap, computed by the server. */
  relatedPosts(postId: number, ratingMode: RatingMode, showSensitive: boolean, limit = 12) {
    return this.http.get<RelatedPostsResponse>(`/api/v1/posts/${postId}/related`, {
      params: {
        limit: String(limit),
        rating_mode: ratingMode,
        include_sensitive: showSensitive ? '1' : '0',
      },
    });
  }

  /** One post that matches the current filters, chosen by the database. */
  randomPost(ratingMode: RatingMode, showSensitive: boolean, tags = '') {
    return this.http.get<RandomPostResponse>('/api/v1/posts/random', {
      params: {
        rating_mode: ratingMode,
        include_sensitive: showSensitive ? '1' : '0',
        ...(tags ? { tags } : {}),
      },
    });
  }

  favoritePost(id: number) {
    return this.http.post<FavoriteState>(`/api/v1/posts/${id}/favorite`, {});
  }

  unfavoritePost(id: number) {
    return this.http.delete<FavoriteState>(`/api/v1/posts/${id}/favorite`);
  }

  listFavorites(page = 1, limit = 24) {
    return this.http.get<FavoritesResponse>('/api/v1/me/favorites', {
      params: { page: String(page), limit: String(limit) },
    });
  }

  listPools(page = 1, limit = 20) {
    return this.http.get<PoolsResponse>('/api/v1/pools', {
      params: { page: String(page), limit: String(limit) },
    });
  }

  getPool(id: number, page = 1, limit = 50) {
    return this.http.get<PoolDetailResponse>(`/api/v1/pools/${id}`, {
      params: { page: String(page), limit: String(limit) },
    });
  }

  createPool(input: {
    title: string;
    description?: string;
    category?: PoolCategory;
    isPublic?: boolean;
  }) {
    return this.http.post<{ pool: Pool }>('/api/v1/pools', input);
  }

  updatePool(id: number, patch: { title?: string; description?: string | null; isPublic?: boolean }) {
    return this.http.patch<{ pool: Pool }>(`/api/v1/pools/${id}`, patch);
  }

  addPoolPost(poolId: number, postId: number) {
    return this.http.post<{ postId: number; position: number }>(`/api/v1/pools/${poolId}/posts`, {
      postId,
    });
  }

  removePoolPost(poolId: number, postId: number) {
    return this.http.delete<void>(`/api/v1/pools/${poolId}/posts/${postId}`);
  }

  deletePool(poolId: number) {
    return this.http.delete<void>(`/api/v1/pools/${poolId}`);
  }

  setPostParent(postId: number, parentId: number | null) {
    return this.http.post<{ postId: number; parentId: number | null }>(
      `/api/v1/posts/${postId}/parent`,
      { parentId },
    );
  }

  getStats() {
    return this.http.get<ArchiveStats>('/api/v1/stats');
  }

  searchTags(search: string, limit = 8) {
    return this.http.get<TagsResponse>('/api/v1/tags', {
      params: { search, limit: String(limit) },
    });
  }

  me() {
    return this.http.get<MeResponse>('/api/v1/auth/me');
  }

  register(username: string, password: string) {
    return this.http.post<AuthResponse>('/api/v1/auth/register', { username, password });
  }

  login(username: string, password: string) {
    return this.http.post<AuthResponse>('/api/v1/auth/login', { username, password });
  }

  logout() {
    return this.http.post<void>('/api/v1/auth/logout', {});
  }

  listComments(postId: number, beforeId?: number, limit = 30) {
    const params: Record<string, string> = { limit: String(limit) };
    if (beforeId !== undefined) params['before'] = String(beforeId);
    return this.http.get<CommentsResponse>(`/api/v1/posts/${postId}/comments`, { params });
  }

  voteComment(commentId: number, value: -1 | 0 | 1) {
    return this.http.post<CommentResponse>(`/api/v1/comments/${commentId}/vote`, { value });
  }

  addComment(postId: number, body: string) {
    return this.http.post<CommentResponse>(`/api/v1/posts/${postId}/comments`, { body });
  }

  deleteComment(commentId: number) {
    return this.http.delete<void>(`/api/v1/comments/${commentId}`);
  }

  reportPost(postId: number, reason: ModerationReason, body: string) {
    return this.http.post<ReportResponse>(`/api/v1/posts/${postId}/reports`, { reason, body });
  }

  getUploaderState() {
    return this.http.get<UploaderState>('/api/v1/me/uploader');
  }

  applyForUploader(message: string) {
    return this.http.post<UploaderState>('/api/v1/me/uploader-request', { message });
  }

  listMyUploads(page = 1, limit = 20) {
    return this.http.get<MyUploadsResponse>('/api/v1/me/uploads', {
      params: { page: String(page), limit: String(limit) },
    });
  }

  uploadPost(body: FormData) {
    return this.http.post<UploadResponse>('/api/v1/uploads', body, {
      reportProgress: true,
      observe: 'events',
    });
  }

  getNotifications() {
    return this.http.get<NotificationsResponse>('/api/v1/me/notifications');
  }

  markNotificationsRead() {
    return this.http.post<{ unread: number }>('/api/v1/me/notifications/read', {});
  }

  getAdminOverview() {
    return this.http.get<AdminOverview>('/api/v1/admin/overview');
  }

  listAdminQueue(status: string, page = 1, limit = 20) {
    return this.http.get<AdminQueueResponse>('/api/v1/admin/queue', {
      params: { status, page: String(page), limit: String(limit) },
    });
  }

  moderatePost(
    postId: number,
    patch: { status?: string; rating?: string; reason?: ModerationReason; note?: string },
  ) {
    return this.http.patch<{ post: AdminPost }>(`/api/v1/admin/posts/${postId}`, patch);
  }

  listAdminReports(status = 'open') {
    return this.http.get<AdminReportsResponse>('/api/v1/admin/reports', {
      params: { status },
    });
  }

  resolveAdminReport(
    reportId: number,
    patch: { status: 'resolved' | 'dismissed'; note?: string; hidePost?: boolean },
  ) {
    return this.http.patch<{ report: AdminReport }>(`/api/v1/admin/reports/${reportId}`, patch);
  }

  listDnp() {
    return this.http.get<DnpResponse>('/api/v1/admin/dnp');
  }

  addDnp(name: string, sourcePattern: string, note: string) {
    return this.http.post<{ entry: DnpEntry }>('/api/v1/admin/dnp', {
      name,
      sourcePattern,
      note,
    });
  }

  removeDnp(id: number) {
    return this.http.delete<void>(`/api/v1/admin/dnp/${id}`);
  }

  listAudit(page = 1, limit = 50) {
    return this.http.get<AuditResponse>('/api/v1/admin/audit', {
      params: { page: String(page), limit: String(limit) },
    });
  }

  listUploaders() {
    return this.http.get<AdminUploadersResponse>('/api/v1/admin/uploaders');
  }

  reviewUploaderRequest(id: number, status: 'approved' | 'rejected', note?: string) {
    return this.http.patch<{ request: AdminUploadersResponse['requests'][number] }>(
      `/api/v1/admin/uploader-requests/${id}`,
      { status, note },
    );
  }

  revokeUploader(userId: number) {
    return this.http.delete<void>(`/api/v1/admin/uploaders/${userId}`);
  }

  listSources() {
    return this.http.get<AdminSourcesResponse>('/api/v1/admin/sources');
  }

  startSourceRun(input: { source: string; tags?: string; limit: number; page?: number }) {
    return this.http.post<SourceRunResponse>('/api/v1/admin/source-runs', input);
  }

  updateSourceSchedule(
    source: string,
    patch: {
      enabled?: boolean;
      intervalMinutes?: number;
      batchLimit?: number;
      dailyLimit?: number;
      tags?: string | null;
      reset?: boolean;
    },
  ) {
    return this.http.patch<SourceScheduleResponse>(
      `/api/v1/admin/source-schedules/${source}`,
      patch,
    );
  }

  getSourceRun(id: number, after = 0) {
    return this.http.get<SourceRunDetail>(`/api/v1/admin/source-runs/${id}`, {
      params: { after: String(after) },
    });
  }

  cancelSourceRun(id: number) {
    return this.http.post<SourceRunResponse>(`/api/v1/admin/source-runs/${id}/cancel`, {});
  }
}
