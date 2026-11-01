import type { Role, SessionUser } from './auth.js';
import type { Sqlite } from './db.js';

export interface UploaderRequestRow {
  id: number;
  message: string | null;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
}

export interface UploaderState {
  approved: boolean;
  role: Role;
  request: UploaderRequestRow | null;
}

/** Staff can always upload; members need an explicit approval row. */
export function canUpload(sqlite: Sqlite, user: Pick<SessionUser, 'id' | 'role'>): boolean {
  if (user.role !== 'user') return true;
  return Boolean(sqlite.prepare('SELECT 1 FROM uploaders WHERE user_id = ?').get(user.id));
}

export function latestUploaderRequest(sqlite: Sqlite, userId: number): UploaderRequestRow | null {
  const row = sqlite
    .prepare(
      `SELECT id, message, status, created_at AS createdAt,
              reviewed_at AS reviewedAt, review_note AS reviewNote
       FROM uploader_requests
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(userId) as UploaderRequestRow | undefined;
  return row ?? null;
}

export function uploaderState(
  sqlite: Sqlite,
  user: Pick<SessionUser, 'id' | 'role'>,
): UploaderState {
  return {
    approved: canUpload(sqlite, user),
    role: user.role,
    request: latestUploaderRequest(sqlite, user.id),
  };
}
