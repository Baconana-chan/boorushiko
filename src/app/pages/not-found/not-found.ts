import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { I18n } from '../../core/i18n';

@Component({
  selector: 'app-not-found',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col items-center px-4 py-24 text-center">
      <div class="flex items-end gap-1">
        <img src="/nekotime/4.gif" alt="4" class="pixelated h-32 w-auto" />
        <img src="/nekotime/0.gif" alt="0" class="pixelated h-32 w-auto" />
        <img src="/nekotime/4.gif" alt="4" class="pixelated h-32 w-auto" />
      </div>
      <h1 class="mt-6 text-2xl font-bold text-white">{{ i18n.t().notFoundTitle }}</h1>
      <p class="mt-2 max-w-sm text-sm text-ink-400">{{ i18n.t().notFoundText }}</p>
      <a
        routerLink="/"
        class="mt-6 rounded-lg bg-sakura-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sakura-600"
        >{{ i18n.t().backHome }}</a
      >
    </div>
  `,
})
export class NotFoundPage {
  readonly i18n = inject(I18n);
}
