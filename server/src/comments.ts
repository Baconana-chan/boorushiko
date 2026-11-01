export const COMMENT_MAX_LENGTH = 2000;

export type CommentValidationCode = 'comment_empty' | 'comment_too_long' | 'link_not_allowed';

export type CommentValidation =
  { ok: true; body: string } | { ok: false; code: CommentValidationCode };

// Schemes, www., or anything that looks like a bare domain with a real TLD.
const LINK_PATTERN =
  /(?:https?:\/\/|www\.|:\/\/)|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/i;

export function containsLink(text: string): boolean {
  return LINK_PATTERN.test(text);
}

export function validateCommentBody(raw: unknown): CommentValidation {
  if (typeof raw !== 'string') return { ok: false, code: 'comment_empty' };

  const body = raw.replace(/\r\n?/g, '\n').trim();
  if (!body || body.includes('\u0000')) return { ok: false, code: 'comment_empty' };
  if (body.length > COMMENT_MAX_LENGTH) return { ok: false, code: 'comment_too_long' };
  if (containsLink(body)) return { ok: false, code: 'link_not_allowed' };

  return { ok: true, body };
}
