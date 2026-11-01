import type { Messages } from './i18n';
import type { Rating, TagCategory } from './models';

/** Booru display order: source first, then who/what, then free-form tags. */
export const CATEGORY_ORDER: TagCategory[] = [
  'copyright',
  'character',
  'artist',
  'general',
  'meta',
  'species',
];

const RATING_BADGE: Record<Rating, string> = {
  s: 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/25',
  q: 'bg-amber-500/15 text-amber-300 ring-amber-400/25',
  e: 'bg-rose-500/15 text-rose-300 ring-rose-400/25',
};

const CATEGORY_DOT: Record<TagCategory, string> = {
  artist: 'bg-amber-400',
  character: 'bg-emerald-400',
  copyright: 'bg-violet-400',
  species: 'bg-rose-400',
  meta: 'bg-slate-400',
  general: 'bg-sky-400',
};

const CATEGORY_TEXT: Record<TagCategory, string> = {
  artist: 'text-amber-300',
  character: 'text-emerald-300',
  copyright: 'text-violet-300',
  species: 'text-rose-300',
  meta: 'text-slate-300',
  general: 'text-sky-300',
};

export function ratingBadge(rating: string): string {
  return RATING_BADGE[rating as Rating] ?? RATING_BADGE.s;
}

export function categoryDot(category: string): string {
  return CATEGORY_DOT[category as TagCategory] ?? CATEGORY_DOT.general;
}

export function categoryText(category: string): string {
  return CATEGORY_TEXT[category as TagCategory] ?? CATEGORY_TEXT.general;
}

export function categoryLabel(category: string, t: Messages): string {
  switch (category) {
    case 'copyright':
      return t.categoryCopyright;
    case 'character':
      return t.categoryCharacter;
    case 'artist':
      return t.categoryArtist;
    case 'meta':
      return t.categoryMeta;
    case 'species':
      return t.categorySpecies;
    default:
      return t.categoryGeneral;
  }
}

export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDate(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function postAlt(tags: { name: string }[], id: number): string {
  const names = tags.slice(0, 4).map((tag) => tag.name.replace(/_/g, ' '));
  return names.length > 0 ? `${names.join(', ')} — post #${id}` : `post #${id}`;
}
