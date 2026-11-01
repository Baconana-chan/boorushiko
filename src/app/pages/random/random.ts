import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../../core/api';
import { I18n } from '../../core/i18n';
import { Preferences } from '../../core/preferences';
import { SearchState } from '../../core/search-state';

type ViewState = 'loading' | 'empty' | 'error';

/**
 * `/random` is a hop: the server picks one post with the visitor's content
 * filter and the router moves to its page, so the URL can be bookmarked.
 */
@Component({
  selector: 'app-random-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mx-auto flex max-w-lg flex-col items-center px-4 py-24 text-center">
      @if (state() === 'loading') {
        <div class="checker h-24 w-24 animate-pulse rounded-2xl border border-white/8"></div>
        <p class="mt-4 font-mono text-xs uppercase tracking-[0.18em] text-ink-500">
          {{ i18n.t().loading }}
        </p>
      } @else {
        <p class="text-sm text-ink-300">
          {{ state() === 'empty' ? i18n.t().randomNone : i18n.t().errorText }}
        </p>
        <div class="mt-4 flex gap-2">
          <button
            type="button"
            (click)="pick()"
            class="rounded-lg bg-sakura-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-sakura-600"
          >
            {{ state() === 'empty' ? i18n.t().random : i18n.t().retry }}
          </button>
          <a
            routerLink="/"
            class="rounded-lg border border-white/10 px-3 py-2 text-sm text-ink-200 transition hover:bg-white/5"
            >{{ i18n.t().backHome }}</a
          >
        </div>
      }
    </div>
  `,
})
export class RandomPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly prefs = inject(Preferences);
  private readonly search = inject(SearchState);
  readonly i18n = inject(I18n);

  readonly state = signal<ViewState>('loading');

  constructor() {
    this.pick();
  }

  pick(): void {
    this.state.set('loading');
    this.api
      .randomPost(this.prefs.ratingMode(), this.prefs.showSensitive(), this.search.tags())
      .subscribe({
        next: ({ post }) => {
          void this.router.navigate(['/post', post.id], { replaceUrl: true });
        },
        error: (error: { status?: number }) =>
          this.state.set(error.status === 404 ? 'empty' : 'error'),
      });
  }
}
