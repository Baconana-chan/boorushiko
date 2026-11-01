import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { apiErrorCode, Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { I18n } from '../../core/i18n';
import { Preferences } from '../../core/preferences';
import {
  MODERATION_REASONS,
  type ModerationReason,
  type PostDetail,
  type PostTag,
  type RelatedPost,
  type TagCategory,
} from '../../core/models';
import {
  CATEGORY_ORDER,
  categoryDot,
  categoryLabel,
  categoryText,
  formatDate,
  humanBytes,
  postAlt,
  ratingBadge,
} from '../../core/ui';
import { Comments } from '../../comments/comments';
import { Lightbox } from '../../post/lightbox';

type ViewState = 'loading' | 'ready' | 'missing' | 'sensitive' | 'error';

function sourceDot(status: string): string {
  if (status === 'ok') return 'bg-emerald-400';
  if (status === 'pending') return 'bg-amber-400';
  return 'bg-rose-400';
}

interface TagGroup {
  category: TagCategory;
  tags: PostTag[];
}

interface SourceLink {
  url: string;
  label: string;
  /** `source` is the page the art came from, `mirror` is a copy of our file. */
  role: 'source' | 'mirror';
  status: string;
}

@Component({
  selector: 'app-post-page',
  imports: [RouterLink, Lightbox, Comments],
  templateUrl: './post.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PostPage {
  private readonly api = inject(Api);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly auth = inject(AuthService);
  readonly i18n = inject(I18n);
  readonly prefs = inject(Preferences);

  readonly post = signal<PostDetail | null>(null);
  /** "More like this" — ranked by the server from tag overlap. */
  readonly related = signal<RelatedPost[]>([]);
  readonly state = signal<ViewState>('loading');
  readonly lightbox = signal(false);
  readonly copied = signal(false);
  readonly directCopied = signal(false);
  /** Index into `imageCandidates`: a dead mirror moves the <img> to the next one. */
  readonly imageIndex = signal(0);
  readonly favoriteSaving = signal(false);
  readonly favoriteError = signal<string | null>(null);
  readonly parentInput = signal('');
  readonly parentSaving = signal(false);
  readonly parentError = signal<string | null>(null);
  readonly reportOpen = signal(false);
  readonly reportReason = signal<ModerationReason>('ai');
  readonly reportBody = signal('');
  readonly reportSending = signal(false);
  readonly reportSent = signal(false);
  readonly reportError = signal<string | null>(null);
  readonly reasons = MODERATION_REASONS;

  readonly groups = computed<TagGroup[]>(() => {
    const tags = this.post()?.tags ?? [];
    const grouped = new Map<TagCategory, PostTag[]>();
    for (const tag of tags) {
      const list = grouped.get(tag.category) ?? [];
      list.push(tag);
      grouped.set(tag.category, list);
    }
    return CATEGORY_ORDER.filter((category) => grouped.has(category)).map((category) => ({
      category,
      tags: grouped.get(category) ?? [],
    }));
  });

  /**
   * Danbooru's API exposes the original artist page in `source`; the engine
   * keeps it in `sourceUrl`. Merge it with mirrors and the booru page into one
   * list so a post can show every known source without duplicate rows.
   */
  readonly sourceLinks = computed<SourceLink[]>(() => {
    const post = this.post();
    if (!post) return [];

    const links: SourceLink[] = [];
    const seen = new Set<string>();
    const add = (
      url: string | null | undefined,
      label: string,
      role: SourceLink['role'],
      status = 'ok',
    ) => {
      if (!url || seen.has(url)) return;
      seen.add(url);
      links.push({ url, label, role, status });
    };

    for (const source of post.sources) {
      add(source.url, source.host, source.role === 'archive' ? 'source' : 'mirror', source.status);
    }
    for (const origin of post.origins) {
      add(origin.pageUrl ?? origin.fileUrl, origin.provider, 'source', origin.status);
    }
    if (post.sourceUrl) add(post.sourceUrl, this.sourceLabel(post.sourceUrl), 'source');

    return links;
  });

  /**
   * The post's own `/i/:id` redirect first, then every live mirror and origin,
   * so one dead host degrades to the next copy instead of a broken image.
   */
  readonly imageCandidates = computed<string[]>(() => {
    const post = this.post();
    if (!post) return [];
    const urls = [post.url];
    for (const source of post.sources) {
      if (source.status === 'ok') urls.push(source.url);
    }
    for (const origin of post.origins) {
      if (origin.status === 'ok') urls.push(origin.fileUrl);
    }
    return [...new Set(urls.filter((url) => Boolean(url)))];
  });

  readonly imageSrc = computed(() => this.imageCandidates()[this.imageIndex()] ?? '');

  readonly ratingBadge = ratingBadge;
  readonly categoryDot = categoryDot;
  readonly categoryLabel = categoryLabel;
  readonly categoryText = categoryText;
  readonly humanBytes = humanBytes;
  readonly formatDate = formatDate;
  readonly postAlt = postAlt;
  readonly sourceDot = sourceDot;

  constructor() {
    this.route.paramMap.subscribe((params) => {
      const id = Number(params.get('id'));
      if (!Number.isInteger(id) || id <= 0) {
        this.state.set('missing');
        return;
      }
      this.load(id);
    });
  }

  retry(): void {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    if (!Number.isInteger(id) || id <= 0) return;
    this.load(id);
  }

  /** Enables sensitive tags for this visitor and re-fetches the post. */
  allowSensitive(): void {
    this.prefs.setShowSensitive(true);
    this.retry();
  }

  private load(id: number): void {
    this.state.set('loading');
    this.post.set(null);
    this.related.set([]);
    this.imageIndex.set(0);
    this.parentInput.set('');
    this.parentError.set(null);
    this.api.getPost(id, this.prefs.showSensitive()).subscribe({
      next: (post) => {
        this.post.set(post);
        this.state.set('ready');
        this.loadRelated(id);
      },
      error: (error: { status?: number }) => {
        const hidden = error.status === 403 && apiErrorCode(error) === 'sensitive_hidden';
        this.state.set(error.status === 404 ? 'missing' : hidden ? 'sensitive' : 'error');
      },
    });
  }

  private loadRelated(id: number): void {
    this.api.relatedPosts(id, this.prefs.ratingMode(), this.prefs.showSensitive()).subscribe({
      next: (response) => this.related.set(response.posts),
      // The block is an extra: a failure leaves the page exactly as it was.
      error: () => this.related.set([]),
    });
  }

  openReport(): void {
    const post = this.post();
    if (!post) return;
    if (!this.auth.user()) {
      void this.router.navigate(['/auth'], { queryParams: { next: `/post/${post.id}` } });
      return;
    }
    this.reportSent.set(false);
    this.reportError.set(null);
    this.reportOpen.set(true);
  }

  closeReport(): void {
    this.reportOpen.set(false);
  }

  onReportReason(event: Event): void {
    this.reportReason.set((event.target as HTMLSelectElement).value as ModerationReason);
  }

  onReportBody(event: Event): void {
    this.reportBody.set((event.target as HTMLTextAreaElement).value);
  }

  submitReport(event: Event): void {
    event.preventDefault();
    const post = this.post();
    if (!post || this.reportSending()) return;
    this.reportSending.set(true);
    this.reportError.set(null);
    this.api.reportPost(post.id, this.reportReason(), this.reportBody().trim()).subscribe({
      next: () => {
        this.reportSending.set(false);
        this.reportOpen.set(false);
        this.reportBody.set('');
        this.reportSent.set(true);
      },
      error: (error: unknown) => {
        this.reportSending.set(false);
        const code = apiErrorCode(error);
        this.reportError.set(
          code === 'already_reported'
            ? this.i18n.t().reportAlready
            : code === 'auth_required'
              ? this.i18n.t().authRequired
              : this.i18n.t().errGeneric,
        );
      },
    });
  }

  reasonLabel(reason: string): string {
    const t = this.i18n.t();
    const keys: Record<string, keyof typeof t> = {
      ai: 'reasonAi',
      '3d': 'reason3d',
      not_2d: 'reasonNot2d',
      duplicate: 'reasonDuplicate',
      low_quality: 'reasonLowQuality',
      banned_artist: 'reasonBannedArtist',
      copyright: 'reasonCopyright',
      metadata: 'reasonMetadata',
      other: 'reasonOther',
    };
    const key = keys[reason];
    return key ? t[key] : reason;
  }

  sourceLabel(url: string): string {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname === '/' ? '' : parsed.pathname;
      return `${parsed.hostname.replace(/^www\./, '')}${path}${parsed.search}`;
    } catch {
      return url;
    }
  }

  onImageError(): void {
    const next = this.imageIndex() + 1;
    if (next < this.imageCandidates().length) this.imageIndex.set(next);
  }

  recount(): void {
    const post = this.post();
    if (post) this.load(post.id);
  }

  toggleFavorite(): void {
    const post = this.post();
    if (!post || this.favoriteSaving()) return;
    if (!this.auth.user()) {
      void this.router.navigate(['/auth'], { queryParams: { next: `/post/${post.id}` } });
      this.favoriteError.set(this.i18n.t().favoriteLogin);
      return;
    }
    this.favoriteSaving.set(true);
    this.favoriteError.set(null);
    const request = post.favorited
      ? this.api.unfavoritePost(post.id)
      : this.api.favoritePost(post.id);
    request.subscribe({
      next: (state) => {
        this.favoriteSaving.set(false);
        this.post.set({ ...post, ...state });
      },
      error: () => {
        this.favoriteSaving.set(false);
        this.favoriteError.set(this.i18n.t().errGeneric);
      },
    });
  }

  onParentInput(event: Event): void {
    this.parentInput.set((event.target as HTMLInputElement).value);
  }

  setParent(): void {
    const post = this.post();
    if (!post || this.parentSaving()) return;
    const raw = this.parentInput().trim();
    const parentId = raw === '' ? null : Number(raw);
    if (parentId !== null && (!Number.isInteger(parentId) || parentId <= 0)) {
      this.parentError.set(this.i18n.t().errGeneric);
      return;
    }
    if (parentId === post.id) {
      this.parentError.set(this.i18n.t().errGeneric);
      return;
    }
    this.parentSaving.set(true);
    this.parentError.set(null);
    this.api.setPostParent(post.id, parentId).subscribe({
      next: () => {
        this.parentSaving.set(false);
        this.recount();
      },
      error: () => {
        this.parentSaving.set(false);
        this.parentError.set(this.i18n.t().errGeneric);
      },
    });
  }

  async copyDirectLink(): Promise<void> {
    const post = this.post();
    if (!post) return;
    try {
      await navigator.clipboard.writeText(`${location.origin}/i/${post.id}`);
      this.directCopied.set(true);
      setTimeout(() => this.directCopied.set(false), 1600);
    } catch {
      // Clipboard can be blocked by permissions; the direct link stays in `Open original`.
    }
  }

  async copyLink(): Promise<void> {
    const post = this.post();
    if (!post) return;
    try {
      await navigator.clipboard.writeText(`${location.origin}${post.url}`);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1600);
    } catch {
      // Clipboard can be blocked by permissions; the URL stays visible in the bar.
    }
  }
}
