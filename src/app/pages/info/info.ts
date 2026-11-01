import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { I18n } from '../../core/i18n';
import { infoContent, type InfoPageId } from './info-content';

@Component({
  selector: 'app-info-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article class="mx-auto max-w-3xl px-4 py-8 sm:px-5 sm:py-10">
      <a
        routerLink="/"
        class="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-500 transition hover:text-ink-200"
      >
        ← {{ i18n.t().backHome }}
      </a>

      <header class="mt-5 border-b border-white/8 pb-6">
        <p class="font-mono text-[10px] uppercase tracking-[0.2em] text-sakura-400/80">
          Boorushiko
        </p>
        <h1 class="mt-2 text-3xl font-black tracking-tight text-white sm:text-4xl">
          {{ page().title }}
        </h1>
        <p class="mt-3 max-w-2xl text-sm leading-relaxed text-ink-300">{{ page().lead }}</p>
      </header>

      <div class="mt-7 space-y-8">
        @for (section of page().sections; track $index) {
          <section>
            <h2 class="text-base font-semibold text-white sm:text-lg">{{ section.title }}</h2>
            @for (paragraph of section.paragraphs ?? []; track $index) {
              <p class="mt-2 text-sm leading-relaxed text-ink-300">{{ paragraph }}</p>
            }
            @if (section.bullets?.length) {
              <ul class="mt-2 space-y-1.5">
                @for (bullet of section.bullets ?? []; track $index) {
                  <li class="relative pl-4 text-sm leading-relaxed text-ink-300">
                    <span class="absolute left-0 top-2 h-1 w-1 rounded-full bg-sakura-400"></span>
                    {{ bullet }}
                  </li>
                }
              </ul>
            }
            @if (section.links?.length) {
              <ul class="mt-2 space-y-1.5">
                @for (link of section.links ?? []; track link.href) {
                  <li class="relative pl-4 text-sm leading-relaxed text-ink-300">
                    <span class="absolute left-0 top-2 h-1 w-1 rounded-full bg-sakura-400"></span>
                    {{ link.text }}
                    <a
                      [href]="link.href"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="break-all font-mono text-sakura-300 underline-offset-4 hover:underline"
                      >{{ link.href }}</a
                    >
                  </li>
                }
              </ul>
            }
          </section>
        }
      </div>

      @if (page().contactEmail; as email) {
        <p
          class="mt-8 rounded-xl border border-sakura-500/20 bg-sakura-500/5 px-4 py-3 text-sm text-ink-300"
        >
          {{ contactLabel() }}:
          <a
            [href]="'mailto:' + email"
            class="font-mono text-sakura-300 underline-offset-4 hover:underline"
            >{{ email }}</a
          >
        </p>
      }
    </article>
  `,
})
export class InfoPage {
  private readonly route = inject(ActivatedRoute);
  readonly i18n = inject(I18n);
  private readonly routeData = toSignal(this.route.data, {
    initialValue: this.route.snapshot.data,
  });

  readonly page = computed(() => {
    const id = (this.routeData()['page'] as InfoPageId | undefined) ?? 'about';
    return infoContent(id, this.i18n.lang());
  });

  readonly contactLabel = computed(() =>
    this.i18n.lang() === 'ru' ? 'Контакт для жалоб' : 'Takedown contact',
  );
}
