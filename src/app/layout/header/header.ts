import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { I18n, type Lang } from '../../core/i18n';
import type { RatingMode, TagSummary } from '../../core/models';
import { Preferences } from '../../core/preferences';
import { SearchState, splitSearchQuery } from '../../core/search-state';
import { categoryDot, categoryLabel } from '../../core/ui';
import { NekoClock } from '../../shared/neko-clock/neko-clock';

@Component({
  selector: 'app-header',
  imports: [RouterLink, NekoClock],
  templateUrl: './header.html',
  styleUrl: './header.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:click)': 'onDocumentClick($event)',
    '(document:keydown.escape)': 'onEscape()',
  },
})
export class Header {
  private readonly api = inject(Api);
  readonly router = inject(Router);
  readonly auth = inject(AuthService);
  readonly i18n = inject(I18n);
  readonly prefs = inject(Preferences);
  readonly search = inject(SearchState);

  private readonly inputRef = viewChild<ElementRef<HTMLInputElement>>('searchInput');
  private readonly dialogRef = viewChild<ElementRef<HTMLDialogElement>>('ageDialog');
  private readonly langMenuRef = viewChild<ElementRef<HTMLElement>>('langMenu');
  private readonly ratingMenuRef = viewChild<ElementRef<HTMLElement>>('ratingMenu');
  private timer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;

  readonly query = signal('');
  readonly suggestions = signal<TagSummary[]>([]);
  readonly open = signal(false);
  readonly langOpen = signal(false);
  readonly ratingMenuOpen = signal(false);
  readonly categoryDot = categoryDot;
  readonly categoryLabel = categoryLabel;

  readonly ratingOptions = computed(() => {
    const t = this.i18n.t();
    return [
      {
        mode: 'safe' as const,
        label: t.ratingSafe,
        hint: t.ratingSafeHint,
        dot: 'bg-emerald-400',
      },
      {
        mode: 'mixed' as const,
        label: t.ratingMixed,
        hint: t.ratingMixedHint,
        dot: 'bg-amber-400',
      },
      {
        mode: 'adult' as const,
        label: t.ratingAdult,
        hint: t.ratingAdultHint,
        dot: 'bg-rose-400',
      },
    ];
  });

  readonly ratingShort = computed(() => {
    const t = this.i18n.t();
    switch (this.prefs.ratingMode()) {
      case 'safe':
        return t.ratingSafeShort;
      case 'adult':
        return t.ratingAdultShort;
      default:
        return t.ratingMixedShort;
    }
  });

  readonly ratingLabel = computed(() => {
    const t = this.i18n.t();
    switch (this.prefs.ratingMode()) {
      case 'safe':
        return t.ratingSafe;
      case 'adult':
        return t.ratingAdult;
      default:
        return t.ratingMixed;
    }
  });

  readonly ratingButtonClass = computed(() => {
    const base =
      'flex h-9 shrink-0 items-center gap-1 rounded-lg border px-2 font-mono text-[11px] font-bold tracking-wide transition';
    switch (this.prefs.ratingMode()) {
      case 'safe':
        return `${base} border-emerald-400/25 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/15`;
      case 'adult':
        return `${base} border-rose-400/40 bg-rose-500/15 text-rose-300 hover:bg-rose-500/20`;
      default:
        return `${base} border-white/10 bg-ink-850 text-ink-300 hover:border-white/20 hover:text-white`;
    }
  });

  constructor() {
    // Keep the field in sync when a tag is clicked elsewhere or the URL changes.
    effect(() => {
      const active = this.search.tags();
      this.query.set(active);
    });
  }

  onSubmit(event: Event): void {
    event.preventDefault();
    this.clearTimer();
    this.closeSuggestions();
    this.search.apply(this.query());
  }

  onInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.query.set(value);
    this.clearTimer();

    const term = splitSearchQuery(value).pop() ?? '';
    if (!term || term.startsWith('-') || term.includes(':') || term.includes('*')) {
      this.seq += 1;
      this.suggestions.set([]);
      this.open.set(false);
      return;
    }

    this.timer = setTimeout(() => {
      const seq = ++this.seq;
      this.api.searchTags(term, 8).subscribe({
        next: (response) => {
          if (seq !== this.seq) return;
          this.suggestions.set(response.tags);
          this.open.set(response.tags.length > 0);
        },
        error: () => {
          if (seq === this.seq) this.suggestions.set([]);
        },
      });
    }, 160);
  }

  accept(tag: TagSummary): void {
    const parts = splitSearchQuery(this.query());
    if (parts.length > 0) parts[parts.length - 1] = tag.name;
    else parts.push(tag.name);

    this.query.set(`${parts.join(' ')} `);
    this.suggestions.set([]);
    this.open.set(false);
    this.inputRef()?.nativeElement.focus();
  }

  clearQuery(): void {
    this.query.set('');
    this.suggestions.set([]);
    this.open.set(false);
    this.inputRef()?.nativeElement.focus();
  }

  closeSuggestions(): void {
    this.open.set(false);
  }

  toggleLanguageMenu(): void {
    this.ratingMenuOpen.set(false);
    this.langOpen.update((open) => !open);
  }

  toggleRatingMenu(): void {
    this.langOpen.set(false);
    this.ratingMenuOpen.update((open) => !open);
  }

  chooseRating(mode: RatingMode): void {
    this.ratingMenuOpen.set(false);
    if (mode !== 'adult') {
      this.prefs.setRatingMode(mode);
      return;
    }
    if (this.prefs.ageConfirmed()) {
      this.prefs.setRatingMode('adult');
      return;
    }
    this.dialogRef()?.nativeElement.showModal();
  }

  chooseLanguage(language: Lang): void {
    this.i18n.setLang(language);
    this.langOpen.set(false);
  }

  onEscape(): void {
    this.langOpen.set(false);
    this.ratingMenuOpen.set(false);
  }

  onDocumentClick(event: MouseEvent): void {
    const target = event.target as Node | null;
    if (this.langOpen() && (!target || !this.langMenuRef()?.nativeElement.contains(target))) {
      this.langOpen.set(false);
    }
    if (
      this.ratingMenuOpen() &&
      (!target || !this.ratingMenuRef()?.nativeElement.contains(target))
    ) {
      this.ratingMenuOpen.set(false);
    }
  }

  onBlur(event: FocusEvent): void {
    const wrapper = event.currentTarget as HTMLElement;
    const next = event.relatedTarget as Node | null;
    if (next && wrapper.contains(next)) return;
    setTimeout(() => this.open.set(false), 120);
  }

  confirmAge(): void {
    this.prefs.confirmAge();
    this.dialogRef()?.nativeElement.close();
  }

  cancelAge(): void {
    this.dialogRef()?.nativeElement.close();
  }

  onDialogClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.dialogRef()?.nativeElement.close();
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
