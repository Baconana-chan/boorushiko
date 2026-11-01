/**
 * Tags that the public UI hides until a visitor opts in under /settings.
 * The list is deliberately conservative and configurable: `SENSITIVE_TAGS`
 * replaces it, `SENSITIVE_TAGS=none` disables filtering.
 */
export const DEFAULT_SENSITIVE_TAGS = [
  'loli*',
  'shota*',
  'rape*',
  'noncon*',
  'guro*',
  'gore*',
  'bestiality*',
  'zoophilia*',
  'incest*',
  'underage*',
  'child*',
  'toddler*',
  'cub',
  'cub_*',
  'snuff*',
  'necrophilia*',
  'scat*',
  'vore*',
  'amputee*',
  'ryona*',
  'mind_control*',
] as const;

function normalizePatterns(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw.split(',')) {
    const pattern = item.trim().toLowerCase().replace(/\s+/g, '_').replace(/\*+/g, '*');
    if (!pattern || seen.has(pattern)) continue;
    seen.add(pattern);
    result.push(pattern);
  }
  return result;
}

export function parseSensitiveTags(raw: string | undefined): string[] {
  const value = raw?.trim();
  if (!value) return [...DEFAULT_SENSITIVE_TAGS];
  if (value.toLowerCase() === 'none' || value.toLowerCase() === 'off') return [];
  return normalizePatterns(value);
}

function escapeLike(pattern: string): string {
  // `_` is a normal character in booru tags; do not let it become a LIKE wildcard.
  return pattern.replace(/[\\%_]/g, (char) => `\\${char}`).replace(/\*/g, '%');
}

function matchesPattern(name: string, pattern: string): boolean {
  if (!pattern.includes('*')) return name === pattern;
  const regex = new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );
  return regex.test(name);
}

export function isSensitiveTag(name: string, patterns: readonly string[]): boolean {
  const normalized = name.trim().toLowerCase();
  return patterns.some((pattern) => matchesPattern(normalized, pattern));
}

/**
 * SQL predicate for `queryPosts`; `p` is the posts alias used there.
 * Exact patterns use IN, wildcard patterns use one LIKE per pattern so the
 * query stays parameterized even when SENSITIVE_TAGS is reconfigured.
 */
export function sensitiveTagsClause(
  patterns: readonly string[],
): { sql: string; params: string[] } | null {
  const exact: string[] = [];
  const wildcards: string[] = [];
  for (const pattern of patterns) {
    if (pattern.includes('*')) wildcards.push(escapeLike(pattern));
    else exact.push(pattern);
  }
  if (exact.length === 0 && wildcards.length === 0) return null;

  const parts: string[] = [];
  if (exact.length > 0) parts.push(`st.name IN (${exact.map(() => '?').join(', ')})`);
  if (wildcards.length > 0) {
    parts.push(`(${wildcards.map(() => `st.name LIKE ? ESCAPE '\\'`).join(' OR ')})`);
  }

  return {
    sql: `NOT EXISTS (
      SELECT 1 FROM post_tags spt JOIN tags st ON st.id = spt.tag_id
      WHERE spt.post_id = p.id AND (${parts.join(' OR ')})
    )`,
    params: [...exact, ...wildcards],
  };
}
