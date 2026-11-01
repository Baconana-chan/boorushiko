import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { I18n } from '../../core/i18n';

type NumberSize = 'sm' | 'md' | 'lg' | 'xl';

const HEIGHTS: Record<NumberSize, string> = {
  sm: 'h-7',
  md: 'h-10',
  lg: 'h-14',
  xl: 'h-20',
};

/**
 * Renders a number with the nekotime digit GIFs. Locale separators stay as text
 * so large archive counts remain readable without breaking the pixel digits.
 */
@Component({
  selector: 'neko-number',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      class="inline-flex select-none items-end gap-px"
      role="img"
      [attr.aria-label]="display()"
      [title]="display()"
    >
      @for (glyph of glyphs(); track $index) {
        @if (glyph.digit) {
          <img
            [src]="'/nekotime/' + glyph.char + '.gif'"
            [class]="heightClass() + ' pixelated w-auto'"
            alt=""
            draggable="false"
          />
        } @else {
          <span class="self-center px-0.5 font-mono text-xs text-ink-500">{{ glyph.char }}</span>
        }
      }
    </span>
  `,
})
export class NekoNumber {
  readonly value = input.required<number>();
  readonly size = input<NumberSize>('md');
  private readonly i18n = inject(I18n);

  readonly heightClass = computed(() => HEIGHTS[this.size()]);
  readonly display = computed(() =>
    new Intl.NumberFormat(this.i18n.locale()).format(Math.max(0, Math.trunc(this.value()))),
  );
  readonly glyphs = computed(() =>
    [...this.display()].map((char) => ({ char, digit: char >= '0' && char <= '9' })),
  );
}
