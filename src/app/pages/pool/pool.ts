import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { I18n } from '../../core/i18n';
import type { Pool, PoolCategory, Post } from '../../core/models';
import { PostCard } from '../../post/post-card';

type ViewState = 'loading' | 'ready' | 'missing' | 'error';

@Component({
  selector: 'app-pool-page',
  imports: [PostCard, RouterLink],
  templateUrl: './pool.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PoolPage {
  private readonly api = inject(Api);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly auth = inject(AuthService);
  readonly i18n = inject(I18n);

  readonly pool = signal<Pool | null>(null);
  readonly posts = signal<Post[]>([]);
  readonly page = signal(1);
  readonly hasMore = signal(false);
  readonly state = signal<ViewState>('loading');

  readonly postId = signal('');
  readonly busy = signal(false);
  readonly actionError = signal<string | null>(null);
  readonly limit = 50;

  constructor() {
    this.route.paramMap.subscribe((params) => {
      const id = Number(params.get('id'));
      if (!Number.isInteger(id) || id <= 0) {
        this.state.set('missing');
        return;
      }
      this.load(id, 1);
    });
  }

  categoryLabel(category: PoolCategory): string {
    const t = this.i18n.t();
    const keys: Record<PoolCategory, keyof typeof t> = {
      series: 'poolCategorySeries',
      collection: 'poolCategoryCollection',
      event: 'poolCategoryEvent',
      other: 'poolCategoryOther',
    };
    return t[keys[category]];
  }

  poolId(): number {
    return Number(this.route.snapshot.paramMap.get('id'));
  }

  load(id: number, page: number): void {
    if (page < 1) return;
    this.state.set('loading');
    this.api.getPool(id, page, this.limit).subscribe({
      next: (response) => {
        this.pool.set(response.pool);
        this.posts.set(response.posts);
        this.page.set(response.page);
        this.hasMore.set(response.hasMore);
        this.state.set('ready');
      },
      error: (error: { status?: number }) =>
        this.state.set(error.status === 404 ? 'missing' : 'error'),
    });
  }

  onPostId(event: Event): void {
    this.postId.set((event.target as HTMLInputElement).value);
  }

  addPost(event: Event): void {
    event.preventDefault();
    const id = Number(this.postId().trim());
    if (!Number.isInteger(id) || id <= 0 || this.busy()) return;

    this.busy.set(true);
    this.actionError.set(null);
    this.api.addPoolPost(this.poolId(), id).subscribe({
      next: () => {
        this.busy.set(false);
        this.postId.set('');
        this.load(this.poolId(), this.page());
      },
      error: () => {
        this.busy.set(false);
        this.actionError.set(this.i18n.t().errGeneric);
      },
    });
  }

  removePost(postId: number): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.actionError.set(null);
    this.api.removePoolPost(this.poolId(), postId).subscribe({
      next: () => {
        this.busy.set(false);
        this.load(this.poolId(), this.page());
      },
      error: () => {
        this.busy.set(false);
        this.actionError.set(this.i18n.t().errGeneric);
      },
    });
  }

  deletePool(): void {
    const pool = this.pool();
    if (!pool) return;
    if (!window.confirm(`${this.i18n.t().poolDelete}: ${pool.title}?`)) return;
    this.busy.set(true);
    this.api.deletePool(pool.id).subscribe({
      next: () => {
        this.busy.set(false);
        void this.router.navigate(['/pools']);
      },
      error: () => {
        this.busy.set(false);
        this.actionError.set(this.i18n.t().errGeneric);
      },
    });
  }
}
