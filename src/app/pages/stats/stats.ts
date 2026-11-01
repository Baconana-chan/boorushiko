import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../../core/api';
import { I18n } from '../../core/i18n';
import type { ArchiveStats } from '../../core/models';
import { categoryDot, formatDate, formatDateTime } from '../../core/ui';
import { NekoNumber } from '../../shared/neko-number/neko-number';

interface StatRow {
  label: string;
  value: number;
  dot?: string;
}

@Component({
  selector: 'app-stats',
  imports: [RouterLink, NekoNumber],
  templateUrl: './stats.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StatsPage {
  private readonly api = inject(Api);
  readonly i18n = inject(I18n);

  readonly stats = signal<ArchiveStats | null>(null);
  readonly loading = signal(true);
  readonly error = signal(false);
  readonly skeleton = Array.from({ length: 6 });

  readonly statusRows = computed<StatRow[]>(() => {
    const t = this.i18n.t();
    const posts = this.stats()?.posts;
    return [
      { label: t.statsLive, value: posts?.active ?? 0, dot: 'bg-emerald-400' },
      { label: t.statsInReview, value: posts?.pending ?? 0, dot: 'bg-amber-400' },
      { label: t.statsHidden, value: posts?.hidden ?? 0, dot: 'bg-slate-400' },
      { label: t.statsDeleted, value: posts?.deleted ?? 0, dot: 'bg-rose-400' },
    ];
  });

  readonly mediaRows = computed<StatRow[]>(() => {
    const t = this.i18n.t();
    const media = this.stats()?.media;
    return [
      { label: t.statsImages, value: media?.images ?? 0, dot: 'bg-sky-400' },
      { label: t.statsAnimated, value: media?.animated ?? 0, dot: 'bg-violet-400' },
      { label: t.statsVideos, value: media?.videos ?? 0, dot: 'bg-fuchsia-400' },
    ];
  });

  readonly ratingRows = computed<StatRow[]>(() => {
    const t = this.i18n.t();
    const ratings = this.stats()?.ratings;
    return [
      { label: t.statsGeneral, value: ratings?.general ?? 0, dot: 'bg-emerald-400' },
      { label: t.statsSensitive, value: ratings?.sensitive ?? 0, dot: 'bg-amber-400' },
      { label: t.statsExplicit, value: ratings?.explicit ?? 0, dot: 'bg-rose-400' },
    ];
  });

  readonly tagRows = computed<StatRow[]>(() => {
    const t = this.i18n.t();
    const tags = this.stats()?.tags;
    return [
      { label: t.statsAllTags, value: tags?.total ?? 0 },
      { label: t.categoryCopyright, value: tags?.copyright ?? 0, dot: categoryDot('copyright') },
      { label: t.categoryCharacter, value: tags?.character ?? 0, dot: categoryDot('character') },
      { label: t.categoryArtist, value: tags?.artist ?? 0, dot: categoryDot('artist') },
      { label: t.categoryGeneral, value: tags?.general ?? 0, dot: categoryDot('general') },
      { label: t.categoryMeta, value: tags?.meta ?? 0, dot: categoryDot('meta') },
      { label: t.categorySpecies, value: tags?.species ?? 0, dot: categoryDot('species') },
    ];
  });

  readonly communityRows = computed<StatRow[]>(() => {
    const t = this.i18n.t();
    const community = this.stats()?.community;
    return [
      { label: t.statsMembers, value: community?.members ?? 0, dot: 'bg-sky-400' },
      { label: t.statsUploaders, value: community?.uploaders ?? 0, dot: 'bg-emerald-400' },
      { label: t.statsComments, value: community?.comments ?? 0, dot: 'bg-violet-400' },
    ];
  });

  readonly sourceRows = computed<StatRow[]>(() => {
    const t = this.i18n.t();
    const sources = this.stats()?.sources;
    return [
      { label: t.statsHosted, value: sources?.hosted ?? 0, dot: 'bg-sky-400' },
      { label: t.statsRemote, value: sources?.remote ?? 0, dot: 'bg-amber-400' },
      { label: t.statsMirrorLinks, value: sources?.mirrors ?? 0, dot: 'bg-emerald-400' },
      { label: t.statsOriginLinks, value: sources?.origins ?? 0, dot: 'bg-violet-400' },
      { label: t.statsProviders, value: sources?.providers ?? 0, dot: 'bg-slate-400' },
    ];
  });

  constructor() {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(false);
    this.api.getStats().subscribe({
      next: (stats) => {
        this.stats.set(stats);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.error.set(true);
      },
    });
  }

  formatDay(iso: string | null): string {
    return iso ? formatDate(iso, this.i18n.locale()) : '—';
  }

  formatUpdated(iso: string): string {
    return formatDateTime(iso, this.i18n.locale());
  }
}
