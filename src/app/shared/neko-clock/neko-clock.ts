import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { I18n } from '../../core/i18n';

type ClockSize = 'sm' | 'md' | 'lg';

const HEIGHTS: Record<ClockSize, string> = {
  sm: 'h-12',
  md: 'h-16',
  lg: 'h-24',
};

@Component({
  selector: 'neko-clock',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="flex select-none items-end gap-0.5"
      role="img"
      [attr.aria-label]="i18n.t().clock + ': ' + clock()"
      [title]="clock()"
    >
      @for (digit of digits(); track $index) {
        <img
          [src]="'/nekotime/' + digit + '.gif'"
          [class]="heightClass() + ' pixelated w-auto'"
          alt=""
          draggable="false"
        />
        @if ($index === 1) {
          <span class="flex flex-col gap-2 self-center px-0.5" aria-hidden="true">
            <span class="h-1 w-1 animate-pulse rounded-full bg-sakura-400"></span>
            <span class="h-1 w-1 animate-pulse rounded-full bg-sakura-400"></span>
          </span>
        }
      }
    </div>
  `,
})
export class NekoClock {
  readonly size = input<ClockSize>('md');
  readonly i18n = inject(I18n);

  // Browser-local time: new Date() follows the visitor's time zone, never the server clock.
  private readonly now = signal(new Date());
  readonly heightClass = computed(() => HEIGHTS[this.size()]);
  readonly clock = computed(() => {
    const date = this.now();
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  });
  readonly digits = computed(() =>
    this.clock()
      .replace(':', '')
      .split('')
      .map((digit) => Number(digit)),
  );

  constructor() {
    const timer = setInterval(() => this.now.set(new Date()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }
}
