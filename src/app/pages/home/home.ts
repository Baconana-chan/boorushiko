import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Api } from '../../core/api';
import { I18n } from '../../core/i18n';
import type { Post, TagSummary } from '../../core/models';
import { Preferences } from '../../core/preferences';
import { SearchState } from '../../core/search-state';
import { categoryDot, categoryLabel } from '../../core/ui';
import { PostCard } from '../../post/post-card';

const PAGE_SIZE = 30;

@Component({
  selector: 'app-home',
  imports: [PostCard],
  templateUrl: './home.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HomePage {
  private readonly api = inject(Api);
  private readonly route = inject(ActivatedRoute);

  readonly i18n = inject(I18n);
  readonly prefs = inject(Preferences);
  readonly search = inject(SearchState);

  readonly posts = signal<Post[]>([]);
  readonly popular = signal<TagSummary[]>([]);
  readonly loading = signal(false);
  readonly initialLoading = signal(true);
  readonly error = signal<string | null>(null);
  readonly hasMore = signal(false);
  readonly page = signal(1);
  readonly tokens = computed(() => this.search.tokens());
  readonly hasFilter = computed(
    () => this.tokens().length > 0 || this.prefs.ratingMode() !== 'mixed',
  );
  readonly mobileTags = computed(() => this.popular().slice(0, 12));
  readonly skeleton = Array.from({ length: 12 });
  readonly categoryDot = categoryDot;
  readonly categoryLabel = categoryLabel;
  readonly syntax = [
    'tag1 tag2',
    'pixel art',
    '-tag',
    'tag* / %tag%',
    'rating:s',
    'order:score',
    'score:>10',
  ];

  private requestId = 0;
  private firstContentRun = true;

  constructor() {
    this.route.queryParamMap.subscribe((params) => {
      this.search.tags.set((params.get('tags') ?? '').trim());
      this.reset(true);
    });

    this.api.searchTags('', 24).subscribe({
      next: (response) => this.popular.set(response.tags),
      error: () => undefined,
    });

    // Re-query when the content filter changes; the first run only records the initial state.
    effect(() => {
      const mode = this.prefs.ratingMode();
      const showSensitive = this.prefs.showSensitive();
      void mode;
      void showSensitive;
      if (this.firstContentRun) {
        this.firstContentRun = false;
        return;
      }
      this.reset(true);
    });
  }

  retry(): void {
    this.posts.set([]);
    this.error.set(null);
    this.initialLoading.set(true);
    this.scrollToTop();
    this.load(Math.max(1, this.page()), true);
  }

  goToPage(page: number): void {
    if (page < 1 || this.loading()) return;
    this.posts.set([]);
    this.hasMore.set(true);
    this.error.set(null);
    this.initialLoading.set(true);
    this.scrollToTop();
    this.load(page, true);
  }

  removeToken(index: number): void {
    this.search.removeToken(index);
  }

  clearSearch(): void {
    this.search.apply('');
  }

  private reset(force: boolean): void {
    this.posts.set([]);
    this.page.set(1);
    this.hasMore.set(true);
    this.error.set(null);
    this.initialLoading.set(true);
    this.scrollToTop();
    this.load(1, force);
  }

  private load(page: number, force = false): void {
    if (this.loading() && !force) return;
    const request = ++this.requestId;
    this.page.set(page);
    this.loading.set(true);
    this.error.set(null);

    this.api
      .listPosts({
        tags: this.search.tags(),
        page,
        limit: PAGE_SIZE,
        ratingMode: this.prefs.ratingMode(),
        showSensitive: this.prefs.showSensitive(),
      })
      .subscribe({
        next: (response) => {
          if (request !== this.requestId) return;
          this.posts.set(response.posts);
          this.page.set(page);
          this.hasMore.set(response.hasMore);
          this.loading.set(false);
          this.initialLoading.set(false);
        },
        error: () => {
          if (request !== this.requestId) return;
          this.loading.set(false);
          this.initialLoading.set(false);
          this.error.set(this.i18n.t().errorText);
        },
      });
  }

  private scrollToTop(): void {
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'auto' });
  }
}
