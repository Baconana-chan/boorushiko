import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { apiErrorCode, Api } from '../core/api';
import { AuthService } from '../core/auth';
import { I18n, type Messages } from '../core/i18n';
import type { Comment, UserRole } from '../core/models';
import { formatDateTime } from '../core/ui';

const ERROR_KEYS: Record<string, keyof Messages> = {
  link_not_allowed: 'commentLinkBlocked',
  comment_empty: 'commentEmpty',
  comment_too_long: 'commentTooLong',
  slow_down: 'commentSlowDown',
  auth_required: 'authRequired',
  post_not_found: 'commentsLoadError',
  self_vote: 'commentSelfVote',
  invalid_vote: 'commentVoteError',
  vote_limit: 'commentVoteLimit',
  vote_slow_down: 'commentVoteCooldown',
  mutual_downvote: 'commentMutualDownvote',
};

@Component({
  selector: 'app-comments',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './comments.html',
})
export class Comments {
  private readonly api = inject(Api);
  readonly auth = inject(AuthService);
  readonly i18n = inject(I18n);

  readonly postId = input.required<number>();
  readonly initialTotal = input(0);

  readonly comments = signal<Comment[]>([]);
  readonly total = signal(0);
  readonly loading = signal(false);
  readonly loadError = signal(false);
  readonly hasMore = signal(false);
  readonly draft = signal('');
  readonly submitting = signal(false);
  readonly notice = signal<string | null>(null);
  readonly confirmingId = signal<number | null>(null);
  readonly deletingId = signal<number | null>(null);
  readonly votingId = signal<number | null>(null);
  readonly expandedHidden = signal<ReadonlySet<number>>(new Set());

  readonly canSubmit = computed(() => this.draft().trim().length > 0 && !this.submitting());
  readonly formatDateTime = formatDateTime;
  readonly maxLength = 2000;

  private requestId = 0;

  constructor() {
    effect(() => {
      const postId = this.postId();
      this.comments.set([]);
      this.total.set(this.initialTotal());
      this.hasMore.set(false);
      this.loadError.set(false);
      this.notice.set(null);
      this.votingId.set(null);
      this.expandedHidden.set(new Set());
      this.load(postId);
    });
  }

  onDraft(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
  }

  loadEarlier(): void {
    const first = this.comments()[0];
    if (!first || this.loading()) return;
    this.load(this.postId(), first.id);
  }

  retry(): void {
    this.comments.set([]);
    this.load(this.postId());
  }

  submit(event: Event): void {
    event.preventDefault();
    if (this.submitting()) return;

    const body = this.draft().trim();
    if (!body) {
      this.notice.set(this.i18n.t().commentEmpty);
      return;
    }

    this.submitting.set(true);
    this.notice.set(null);
    this.api.addComment(this.postId(), body).subscribe({
      next: (response) => {
        this.comments.update((list) => [...list, response.comment]);
        this.total.update((total) => total + 1);
        this.draft.set('');
        this.submitting.set(false);
      },
      error: (error: unknown) => {
        this.submitting.set(false);
        this.notice.set(this.messageFor(apiErrorCode(error)));
      },
    });
  }

  remove(comment: Comment): void {
    if (this.confirmingId() !== comment.id) {
      this.confirmingId.set(comment.id);
      return;
    }

    this.deletingId.set(comment.id);
    this.notice.set(null);
    this.api.deleteComment(comment.id).subscribe({
      next: () => {
        this.comments.update((list) => list.filter((item) => item.id !== comment.id));
        this.total.update((total) => Math.max(0, total - 1));
        this.confirmingId.set(null);
        this.deletingId.set(null);
      },
      error: (error: unknown) => {
        this.deletingId.set(null);
        this.notice.set(this.messageFor(apiErrorCode(error)));
      },
    });
  }

  vote(comment: Comment, direction: -1 | 1): void {
    const user = this.auth.user();
    if (!user) {
      this.notice.set(this.i18n.t().commentLoginToVote);
      return;
    }
    if (comment.user.id === user.id) {
      this.notice.set(this.i18n.t().commentSelfVote);
      return;
    }
    if (this.votingId() !== null) return;

    const value: -1 | 0 | 1 = comment.myVote === direction ? 0 : direction;
    this.votingId.set(comment.id);
    this.notice.set(null);
    this.api.voteComment(comment.id, value).subscribe({
      next: ({ comment: updated }) => {
        const karmaDelta = updated.score - comment.score;
        this.comments.update((list) =>
          list.map((item) => {
            if (item.id === updated.id) return updated;
            if (item.user.id === updated.user.id) {
              return { ...item, authorKarma: item.authorKarma + karmaDelta };
            }
            return item;
          }),
        );
        this.votingId.set(null);
      },
      error: (error: unknown) => {
        this.votingId.set(null);
        this.notice.set(this.messageFor(apiErrorCode(error)));
      },
    });
  }

  isHiddenExpanded(comment: Comment): boolean {
    return this.expandedHidden().has(comment.id);
  }

  toggleHidden(comment: Comment): void {
    this.expandedHidden.update((current) => {
      const next = new Set(current);
      if (next.has(comment.id)) next.delete(comment.id);
      else next.add(comment.id);
      return next;
    });
  }

  scoreClass(score: number): string {
    if (score > 0) return 'text-emerald-300';
    if (score < 0) return 'text-rose-300';
    return 'text-ink-500';
  }

  karmaClass(karma: number): string {
    if (karma > 0) return 'text-emerald-300/80';
    if (karma < 0) return 'text-rose-300/80';
    return 'text-ink-500';
  }

  roleLabel(role: UserRole): string {
    const t = this.i18n.t();
    if (role === 'admin') return t.roleAdmin;
    if (role === 'moderator') return t.roleModerator;
    return t.roleUser;
  }

  roleClass(role: UserRole): string {
    return role === 'admin'
      ? 'bg-rose-500/15 text-rose-300 ring-rose-400/30'
      : 'bg-amber-500/15 text-amber-300 ring-amber-400/30';
  }

  private load(postId: number, beforeId?: number): void {
    const request = ++this.requestId;
    this.loading.set(true);
    this.loadError.set(false);

    this.api.listComments(postId, beforeId).subscribe({
      next: (response) => {
        if (request !== this.requestId) return;
        this.comments.update((list) =>
          beforeId ? [...response.comments, ...list] : response.comments,
        );
        this.total.set(response.total);
        this.hasMore.set(response.hasMore);
        this.loading.set(false);
      },
      error: () => {
        if (request !== this.requestId) return;
        this.loading.set(false);
        this.loadError.set(true);
      },
    });
  }

  private messageFor(code: string | null): string {
    const key = code ? ERROR_KEYS[code] : undefined;
    return key ? this.i18n.t()[key] : this.i18n.t().errGeneric;
  }
}
