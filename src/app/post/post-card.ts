import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { I18n } from '../core/i18n';
import type { Post } from '../core/models';
import { postAlt, ratingBadge } from '../core/ui';

@Component({
  selector: 'app-post-card',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a
      [routerLink]="['/post', post().id]"
      class="group relative block overflow-hidden rounded-xl border border-white/8 bg-ink-900 transition hover:border-sakura-500/40"
    >
      <img
        [src]="post().thumbUrl"
        [alt]="alt()"
        [attr.loading]="priority() ? 'eager' : 'lazy'"
        [class.pixelated]="post().width < 300"
        class="aspect-square w-full object-cover transition duration-300 group-hover:scale-[1.03] group-hover:opacity-95"
      />

      <span
        [class]="
          'absolute left-1.5 top-1.5 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider ring-1 ring-inset ' +
          ratingBadge(post().rating)
        "
      >
        {{ post().rating }}
      </span>

      @if (post().status === 'pending') {
        <span
          class="absolute right-1.5 top-1.5 rounded bg-ink-950/80 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-amber-300"
        >
          {{ i18n.t().pending }}
        </span>
      }

      <div
        class="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-2 pb-1.5 pt-8 opacity-0 transition group-hover:opacity-100"
      >
        <span class="truncate font-mono text-[10px] text-white/70">{{ tagName() }}</span>
        <span class="shrink-0 font-mono text-[10px] text-sakura-300">♥ {{ post().score }}</span>
      </div>
    </a>
  `,
})
export class PostCard {
  readonly post = input.required<Post>();
  readonly priority = input(false);
  readonly i18n = inject(I18n);
  readonly ratingBadge = ratingBadge;
  readonly alt = computed(() => postAlt(this.post().tags, this.post().id));
  readonly tagName = computed(() => this.post().tags[0]?.name ?? '');
}
