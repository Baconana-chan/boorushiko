import { HttpEventType } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { apiErrorCode, Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { I18n, type Messages } from '../../core/i18n';
import type { MyUpload, Rating, TagCategory, UploaderState } from '../../core/models';
import { categoryLabel, categoryText, formatDateTime, humanBytes } from '../../core/ui';

const MAX_BYTES = 32 * 1024 * 1024;
const ACCEPTED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);
const ACCEPTED_EXT = /\.(png|jpe?g|gif|webp|avif)$/i;
const TAG_CATEGORIES = new Set<TagCategory>([
  'general',
  'artist',
  'character',
  'copyright',
  'species',
  'meta',
]);

const REASON_KEYS: Record<string, keyof Messages> = {
  ai: 'reasonAi',
  '3d': 'reason3d',
  not_2d: 'reasonNot2d',
  duplicate: 'reasonDuplicate',
  low_quality: 'reasonLowQuality',
  banned_artist: 'reasonBannedArtist',
  copyright: 'reasonCopyright',
  metadata: 'reasonMetadata',
  other: 'reasonOther',
};

const FLAG_KEYS: Record<string, keyof Messages> = {
  ai_metadata: 'flagAiMetadata',
  ai_filename: 'flagAiFilename',
  '3d_metadata': 'flag3dMetadata',
  '3d_filename': 'flag3dFilename',
};

interface PreviewTag {
  name: string;
  category: TagCategory;
}

function previewTags(raw: string): PreviewTag[] {
  const seen = new Set<string>();
  const result: PreviewTag[] = [];
  for (const entry of raw.split(/[,\s]+/)) {
    let token = entry.trim().toLowerCase().replace(/\s+/g, '_');
    if (!token) continue;
    let category: TagCategory = 'general';
    const prefixed = /^([a-z_]+):(.+)$/.exec(token);
    if (prefixed && TAG_CATEGORIES.has(prefixed[1] as TagCategory)) {
      category = prefixed[1] as TagCategory;
      token = prefixed[2]!;
    }
    if (!token || seen.has(token)) continue;
    seen.add(token);
    result.push({ name: token, category });
    if (result.length >= 40) break;
  }
  return result;
}

@Component({
  selector: 'app-upload-page',
  imports: [RouterLink],
  templateUrl: './upload.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UploadPage {
  private readonly api = inject(Api);
  private readonly destroyRef = inject(DestroyRef);
  readonly auth = inject(AuthService);
  readonly i18n = inject(I18n);

  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');
  readonly previewUrl = signal<string | null>(null);

  readonly loading = signal(true);
  readonly loadError = signal(false);
  readonly state = signal<UploaderState | null>(null);

  readonly file = signal<File | null>(null);
  readonly dragging = signal(false);
  readonly tags = signal('');
  readonly rating = signal<Rating>('s');
  readonly sourceUrl = signal('');
  readonly parsedTags = computed(() => previewTags(this.tags()));

  readonly submitting = signal(false);
  readonly progress = signal(0);
  readonly formError = signal<string | null>(null);
  readonly success = signal<'queued' | 'duplicate' | null>(null);

  readonly requestMessage = signal('');
  readonly applying = signal(false);
  readonly applyError = signal<string | null>(null);

  readonly uploads = signal<MyUpload[]>([]);
  readonly uploadsTotal = signal(0);
  readonly uploadsPage = signal(1);
  readonly uploadsHasMore = signal(false);
  readonly uploadsLoading = signal(false);
  readonly uploadsError = signal(false);

  readonly ratings: Rating[] = ['s', 'q', 'e'];
  readonly formatDateTime = formatDateTime;
  readonly humanBytes = humanBytes;
  readonly categoryText = categoryText;
  readonly categoryLabel = categoryLabel;

  private loaded = false;

  constructor() {
    this.destroyRef.onDestroy(() => this.releasePreview());

    effect(() => {
      if (!this.auth.ready()) return;
      if (!this.auth.user()) {
        this.loading.set(false);
        return;
      }
      if (this.loaded) return;
      this.loaded = true;
      this.loadState();
    });
  }

  retry(): void {
    if (!this.auth.user()) return;
    this.loadState();
  }

  onFileInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.setFile(input.files?.[0] ?? null);
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(true);
  }

  onDragLeave(): void {
    this.dragging.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    this.setFile(event.dataTransfer?.files?.[0] ?? null);
  }

  setFile(file: File | null): void {
    if (!file) return;
    this.success.set(null);
    this.formError.set(null);

    if (file.size > MAX_BYTES) {
      this.formError.set(this.i18n.t().uploadTooLarge);
      return;
    }
    if (file.type && !ACCEPTED_TYPES.has(file.type)) {
      this.formError.set(this.i18n.t().uploadUnsupported);
      return;
    }
    if (!file.type && !ACCEPTED_EXT.test(file.name)) {
      this.formError.set(this.i18n.t().uploadUnsupported);
      return;
    }

    this.releasePreview();
    this.file.set(file);
    if (file.type.startsWith('image/')) {
      this.previewUrl.set(URL.createObjectURL(file));
    }
  }

  clearFile(): void {
    this.releasePreview();
    this.file.set(null);
    const input = this.fileInput()?.nativeElement;
    if (input) input.value = '';
  }

  onTags(event: Event): void {
    this.tags.set((event.target as HTMLTextAreaElement).value);
  }

  onSource(event: Event): void {
    this.sourceUrl.set((event.target as HTMLInputElement).value);
  }

  setRating(rating: Rating): void {
    this.rating.set(rating);
  }

  ratingClass(rating: Rating): string {
    const base =
      'flex-1 rounded-lg border px-3 py-2 font-mono text-[11px] uppercase tracking-wider transition';
    if (this.rating() !== rating) {
      return `${base} border-white/10 bg-ink-850 text-ink-400 hover:border-white/20 hover:text-ink-200`;
    }
    if (rating === 'e') return `${base} border-rose-400/40 bg-rose-500/15 text-rose-200`;
    if (rating === 'q') return `${base} border-amber-400/40 bg-amber-500/15 text-amber-200`;
    return `${base} border-emerald-400/40 bg-emerald-500/15 text-emerald-200`;
  }

  submit(event: Event): void {
    event.preventDefault();
    if (this.submitting()) return;

    this.formError.set(null);
    this.success.set(null);

    const file = this.file();
    if (!file) {
      this.formError.set(this.i18n.t().uploadNeedFile);
      return;
    }
    if (this.parsedTags().length === 0) {
      this.formError.set(this.i18n.t().uploadTagsRequired);
      return;
    }
    const source = this.sourceUrl().trim();
    if (source) {
      try {
        const url = new URL(source);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
      } catch {
        this.formError.set(this.i18n.t().uploadSourceInvalid);
        return;
      }
    }

    const body = new FormData();
    body.append('file', file);
    body.append('tags', this.tags());
    body.append('rating', this.rating());
    if (source) body.append('sourceUrl', source);

    this.submitting.set(true);
    this.progress.set(0);
    this.api.uploadPost(body).subscribe({
      next: (event) => {
        if (event.type === HttpEventType.UploadProgress) {
          const total = event.total ?? file.size;
          this.progress.set(total ? Math.min(99, Math.round((event.loaded / total) * 100)) : 0);
          return;
        }
        if (event.type !== HttpEventType.Response || !event.body) return;

        this.submitting.set(false);
        this.progress.set(100);
        this.success.set(event.body.duplicate ? 'duplicate' : 'queued');
        this.clearFile();
        this.tags.set('');
        this.sourceUrl.set('');
        this.rating.set('s');
        this.loadUploads(1);
      },
      error: (error: unknown) => {
        this.submitting.set(false);
        this.progress.set(0);
        const code = apiErrorCode(error);
        const status = (error as { status?: number }).status;
        if (code === 'dnp_artist') this.formError.set(this.i18n.t().uploadDnp);
        else if (code === 'uploader_required') {
          this.formError.set(this.i18n.t().errGeneric);
          this.loadState();
        } else if (status === 413) this.formError.set(this.i18n.t().uploadTooLarge);
        else if (status === 415) this.formError.set(this.i18n.t().uploadUnsupported);
        else this.formError.set(this.i18n.t().uploadFailed);
      },
    });
  }

  apply(event: Event): void {
    event.preventDefault();
    if (this.applying()) return;
    this.applyError.set(null);
    this.applying.set(true);
    this.api.applyForUploader(this.requestMessage().trim()).subscribe({
      next: (state) => {
        this.applying.set(false);
        this.state.set(state);
        this.requestMessage.set('');
      },
      error: (error: unknown) => {
        this.applying.set(false);
        const code = apiErrorCode(error);
        if (code === 'request_pending' || code === 'already_uploader') {
          this.loadState();
          return;
        }
        this.applyError.set(this.i18n.t().errGeneric);
      },
    });
  }

  onRequestMessage(event: Event): void {
    this.requestMessage.set((event.target as HTMLTextAreaElement).value);
  }

  loadMoreUploads(): void {
    if (this.uploadsLoading() || !this.uploadsHasMore()) return;
    this.loadUploads(this.uploadsPage() + 1);
  }

  refreshUploads(): void {
    this.loadUploads(1);
  }

  statusLabel(status: string): string {
    if (status === 'active') return this.i18n.t().uploadStatusActive;
    if (status === 'hidden') return this.i18n.t().uploadStatusHidden;
    if (status === 'deleted') return this.i18n.t().uploadStatusDeleted;
    return this.i18n.t().uploadStatusPending;
  }

  statusClass(status: string): string {
    if (status === 'active') return 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30';
    if (status === 'pending') return 'bg-amber-500/15 text-amber-300 ring-amber-400/30';
    if (status === 'hidden') return 'bg-rose-500/15 text-rose-300 ring-rose-400/30';
    return 'bg-white/5 text-ink-400 ring-white/10';
  }

  reasonLabel(reason: string | null): string {
    if (!reason) return '';
    const key = REASON_KEYS[reason];
    return key ? this.i18n.t()[key] : reason;
  }

  flagLabel(flag: string): string {
    const key = FLAG_KEYS[flag];
    return key ? this.i18n.t()[key] : flag;
  }

  private loadState(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.api.getUploaderState().subscribe({
      next: (state) => {
        this.state.set(state);
        this.loading.set(false);
        if (state.approved) {
          if (!this.auth.canUpload()) this.auth.refresh();
          this.loadUploads(1);
        }
      },
      error: () => {
        this.loading.set(false);
        this.loadError.set(true);
      },
    });
  }

  private loadUploads(page: number): void {
    this.uploadsLoading.set(true);
    this.uploadsError.set(false);
    this.api.listMyUploads(page).subscribe({
      next: (response) => {
        this.uploads.set(page === 1 ? response.uploads : [...this.uploads(), ...response.uploads]);
        this.uploadsTotal.set(response.total);
        this.uploadsPage.set(page);
        this.uploadsHasMore.set(response.hasMore);
        this.uploadsLoading.set(false);
      },
      error: () => {
        this.uploadsLoading.set(false);
        this.uploadsError.set(true);
      },
    });
  }

  private releasePreview(): void {
    const current = this.previewUrl();
    if (current) URL.revokeObjectURL(current);
    this.previewUrl.set(null);
  }
}
