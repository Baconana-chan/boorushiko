import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { apiErrorCode, Api } from '../../core/api';
import { I18n } from '../../core/i18n';
import type { FavoritePost } from '../../core/models';
import { PostCard } from '../../post/post-card';

type ViewState = 'loading' | 'ready' | 'error';

@Component({
  selector: 'app-favorites-page',
  imports: [PostCard, RouterLink],
  templateUrl: './favorites.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FavoritesPage {
  private readonly api = inject(Api);
  readonly i18n = inject(I18n);

  readonly posts = signal<FavoritePost[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly hasMore = signal(false);
  readonly state = signal<ViewState>('loading');
  readonly needsAuth = signal(false);
  readonly limit = 24;

  constructor() {
    this.load(1);
  }

  load(page: number): void {
    if (page < 1) return;
    this.state.set('loading');
    this.needsAuth.set(false);
    this.api.listFavorites(page, this.limit).subscribe({
      next: (response) => {
        this.posts.set(response.posts);
        this.total.set(response.total);
        this.page.set(response.page);
        this.hasMore.set(response.hasMore);
        this.state.set('ready');
      },
      // A guest gets 401 here; that is not an engine failure, just a sign-in.
      error: (error: unknown) => {
        this.needsAuth.set(apiErrorCode(error) === 'auth_required');
        this.state.set('error');
      },
    });
  }

  previous(): void {
    this.load(this.page() - 1);
  }

  next(): void {
    this.load(this.page() + 1);
  }
}
