import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { I18n } from '../../core/i18n';
import type { Pool, PoolCategory } from '../../core/models';
import { formatDate } from '../../core/ui';

type ViewState = 'loading' | 'ready' | 'error';

@Component({
  selector: 'app-pools-page',
  imports: [RouterLink],
  templateUrl: './pools.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PoolsPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  readonly auth = inject(AuthService);
  readonly i18n = inject(I18n);

  readonly pools = signal<Pool[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly hasMore = signal(false);
  readonly state = signal<ViewState>('loading');

  readonly creating = signal(false);
  readonly createError = signal<string | null>(null);
  readonly categories: PoolCategory[] = ['series', 'collection', 'event', 'other'];

  readonly formatDate = formatDate;

  constructor() {
    this.load(1);
  }

  load(page: number): void {
    if (page < 1) return;
    this.state.set('loading');
    this.api.listPools(page, 20).subscribe({
      next: (response) => {
        this.pools.set(response.pools);
        this.total.set(response.total);
        this.page.set(response.page);
        this.hasMore.set(response.hasMore);
        this.state.set('ready');
      },
      error: () => this.state.set('error'),
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

  create(event: Event): void {
    event.preventDefault();
    if (this.creating()) return;
    const form = event.target as HTMLFormElement;
    const data = new FormData(form);
    const title = String(data.get('title') ?? '').trim();
    const description = String(data.get('description') ?? '').trim();
    const category = String(data.get('category') ?? 'series') as PoolCategory;
    if (!title) return;

    this.creating.set(true);
    this.createError.set(null);
    this.api
      .createPool({
        title,
        ...(description ? { description } : {}),
        category,
        isPublic: data.get('isPublic') !== null,
      })
      .subscribe({
        next: ({ pool }) => {
          this.creating.set(false);
          form.reset();
          if (pool) void this.router.navigate(['/pools', pool.id]);
        },
        error: () => {
          this.creating.set(false);
          this.createError.set(this.i18n.t().errGeneric);
        },
      });
  }
}
