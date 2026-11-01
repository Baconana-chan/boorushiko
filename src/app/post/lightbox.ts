import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

@Component({
  selector: 'app-lightbox',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'close.emit()',
  },
  template: `
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/95 p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      (click)="close.emit()"
    >
      <button
        type="button"
        (click)="close.emit()"
        aria-label="Close"
        class="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/60 text-lg text-white/80 transition hover:border-white/40 hover:text-white"
      >
        ×
      </button>
      <img
        [src]="src()"
        [alt]="alt()"
        class="max-h-full max-w-full rounded-lg object-contain shadow-2xl shadow-black"
        (click)="$event.stopPropagation()"
      />
    </div>
  `,
})
export class Lightbox {
  readonly src = input.required<string>();
  readonly alt = input('');
  readonly close = output<void>();
}
