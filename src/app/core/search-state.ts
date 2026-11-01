import { inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';

/** `rating:s,q` and `order:new` keep their commas; every other comma separates tags. */
const LIST_META = /^[-~]?(?:rating|order):/i;

export function splitSearchQuery(input: string): string[] {
  return input
    .trim()
    .split(/\s+/)
    .flatMap((raw) => {
      if (!raw) return [];
      const meta = raw.replace(/,+$/, '');
      if (LIST_META.test(meta)) return [meta];
      return raw.split(',').filter(Boolean);
    });
}

export function normalizeSearchQuery(input: string): string {
  return splitSearchQuery(input).join(' ');
}

/** Keeps the active tag query in one place so the header and pages agree on it. */
@Injectable({ providedIn: 'root' })
export class SearchState {
  private readonly router = inject(Router);
  readonly tags = signal('');

  apply(tags: string): void {
    const normalized = normalizeSearchQuery(tags);
    this.tags.set(normalized);
    void this.router.navigate(['/'], {
      queryParams: normalized ? { tags: normalized } : {},
    });
  }

  removeToken(index: number): void {
    const tokens = this.tokens();
    if (index < 0 || index >= tokens.length) return;
    tokens.splice(index, 1);
    this.apply(tokens.join(' '));
  }

  tokens(): string[] {
    return splitSearchQuery(this.tags());
  }
}
