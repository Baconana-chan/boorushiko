import sharp from 'sharp';
import type { Sqlite } from './db.js';

const AI_TEXT =
  /(?:^|[^a-z0-9])(parameters|workflow|prompt|negative prompt|stable diffusion|novelai|comfyui|automatic1111|a1111|midjourney|dall-e|dall·e)(?:[^a-z0-9]|$)/i;
const AI_FILENAME = /(?:comfyui|stable[_-]?diffusion|novelai|midjourney|dall[_-]?e|a1111)/i;
const THREE_D_TEXT =
  /(?:^|[^a-z0-9])(blender|cycles|source filmmaker|mmd|mikumikudance|maya|3ds max|cinema 4d|unreal engine)(?:[^a-z0-9]|$)/i;
const THREE_D_FILENAME = /(?:blender|mmd|mikumikudance|source[_-]?filmmaker)/i;

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

/** Metadata is a review signal, never an automatic rejection. */
export function flagsFromText(text: string, kind: 'metadata' | 'filename'): string[] {
  if (!text.trim()) return [];
  const ai = kind === 'filename' ? AI_FILENAME : AI_TEXT;
  const threeD = kind === 'filename' ? THREE_D_FILENAME : THREE_D_TEXT;
  const flags: string[] = [];
  if (ai.test(text)) flags.push(kind === 'filename' ? 'ai_filename' : 'ai_metadata');
  if (threeD.test(text)) flags.push(kind === 'filename' ? '3d_filename' : '3d_metadata');
  return flags;
}

export async function detectPolicyFlags(filePath: string, filename = ''): Promise<string[]> {
  const flags = new Set<string>(flagsFromText(filename, 'filename'));
  try {
    const meta = await sharp(filePath).metadata();
    const pieces: string[] = [];
    for (const comment of meta.comments ?? []) pieces.push(comment.keyword, comment.text);
    if (meta.xmp) pieces.push(meta.xmp.toString('utf8'));
    if (meta.exif) pieces.push(meta.exif.toString('latin1'));
    for (const flag of flagsFromText(pieces.join('\n'), 'metadata')) flags.add(flag);
  } catch {
    // Broken metadata must not reject an otherwise valid upload.
  }
  return [...flags];
}

export interface PolicyTag {
  name: string;
  category: string;
}

export interface DnpMatch {
  name: string;
  sourcePattern: string | null;
}

/**
 * DNP is checked by artist tag and, when configured, by a substring of the
 * source URL. Existing posts stay put; moderators hide them explicitly.
 */
export function findDnpMatch(
  sqlite: Sqlite,
  tags: PolicyTag[],
  sourceUrl?: string | null,
): DnpMatch | null {
  const byName = sqlite.prepare(
    'SELECT name, source_pattern AS sourcePattern FROM dnp_artists WHERE name = ?',
  );
  for (const tag of tags) {
    if (tag.category !== 'artist') continue;
    const row = byName.get(tag.name) as DnpMatch | undefined;
    if (row) return row;
  }

  if (sourceUrl) {
    const row = sqlite
      .prepare(
        `SELECT name, source_pattern AS sourcePattern FROM dnp_artists
         WHERE source_pattern IS NOT NULL AND source_pattern <> ''
           AND instr(lower(?), lower(source_pattern)) > 0
         LIMIT 1`,
      )
      .get(sourceUrl) as DnpMatch | undefined;
    if (row) return row;
  }
  return null;
}

export function isModerationReason(value: unknown): value is ModerationReason {
  return typeof value === 'string' && MODERATION_REASONS.includes(value as ModerationReason);
}

export class DnpArtistError extends Error {
  readonly artist: string;

  constructor(artist: string) {
    super(`artist is on the do-not-post list: ${artist}`);
    this.name = 'DnpArtistError';
    this.artist = artist;
  }
}
