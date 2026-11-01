import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { I18n } from '../../core/i18n';
import type { Notification, UserRole } from '../../core/models';
import { formatDate, formatDateTime } from '../../core/ui';

@Component({
  selector: 'app-account-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mx-auto max-w-2xl px-4 py-10">
      @if (!auth.ready()) {
        <div class="h-64 animate-pulse rounded-2xl border border-white/8 bg-ink-900/60"></div>
      } @else if (auth.user(); as user) {
        <div class="overflow-hidden rounded-2xl border border-white/8 bg-ink-900/60">
          <div
            class="flex items-center gap-4 border-b border-white/5 bg-gradient-to-r from-sakura-500/10 to-transparent px-6 py-6"
          >
            <span
              class="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-sakura-500/15 font-mono text-xl font-bold uppercase text-sakura-300 ring-1 ring-inset ring-sakura-400/30"
            >
              {{ user.username.charAt(0) }}
            </span>
            <div class="min-w-0">
              <p class="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-500">
                {{ i18n.t().account }}
              </p>
              <h1 class="truncate text-xl font-bold text-white">@{{ user.username }}</h1>
            </div>
            <span
              [class]="
                'ml-auto shrink-0 rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-wider ring-1 ring-inset ' +
                (user.canUpload && user.role === 'user'
                  ? 'bg-sakura-500/15 text-sakura-300 ring-sakura-400/30'
                  : roleClass(user.role))
              "
            >
              {{
                user.canUpload && user.role === 'user'
                  ? i18n.t().roleUploader
                  : roleLabel(user.role)
              }}
            </span>
          </div>

          <dl class="grid gap-4 px-6 py-5 sm:grid-cols-2">
            <div>
              <dt class="font-mono text-[10px] uppercase tracking-wider text-ink-500">
                {{ i18n.t().memberSince }}
              </dt>
              <dd class="mt-1 text-sm text-ink-200">
                {{ formatDate(user.createdAt, i18n.locale()) }}
              </dd>
            </div>
            <div>
              <dt class="font-mono text-[10px] uppercase tracking-wider text-ink-500">
                {{ i18n.t().role }}
              </dt>
              <dd class="mt-1 text-sm text-ink-200">
                {{
                  user.canUpload && user.role === 'user'
                    ? i18n.t().roleUploader
                    : roleLabel(user.role)
                }}
              </dd>
            </div>
            <div>
              <dt
                class="font-mono text-[10px] uppercase tracking-wider text-ink-500"
                [title]="i18n.t().commentKarmaHint"
              >
                {{ i18n.t().accountCommentKarma }}
              </dt>
              <dd
                [class]="
                  'mt-1 font-mono text-sm ' +
                  (user.commentKarma > 0
                    ? 'text-emerald-300'
                    : user.commentKarma < 0
                      ? 'text-rose-300'
                      : 'text-ink-200')
                "
              >
                {{ user.commentKarma }}
              </dd>
            </div>
          </dl>

          <div class="flex flex-wrap items-center gap-2 border-t border-white/5 px-6 py-4">
            <a
              routerLink="/"
              class="rounded-lg border border-white/10 px-3 py-2 text-sm text-ink-200 transition hover:bg-white/5"
              >{{ i18n.t().backHome }}</a
            >
            <a
              routerLink="/settings"
              class="rounded-lg border border-white/10 px-3 py-2 text-sm text-ink-200 transition hover:bg-white/5"
              >{{ i18n.t().settings }}</a
            >
            <a
              routerLink="/upload"
              class="rounded-lg border border-sakura-400/25 bg-sakura-500/10 px-3 py-2 text-sm text-sakura-200 transition hover:bg-sakura-500/20"
              >{{ i18n.t().upload }}</a
            >
            @if (user.role !== 'user') {
              <a
                routerLink="/admin"
                class="rounded-lg border border-sakura-400/25 bg-sakura-500/10 px-3 py-2 text-sm text-sakura-200 transition hover:bg-sakura-500/20"
                >{{ i18n.t().admin }}</a
              >
            }
            <button
              type="button"
              (click)="signOut()"
              [disabled]="signingOut()"
              class="ml-auto rounded-lg border border-rose-400/25 bg-rose-500/5 px-3 py-2 text-sm text-rose-200 transition hover:bg-rose-500/10 disabled:opacity-60"
            >
              {{ i18n.t().signOut }}
            </button>
          </div>

          @if (error()) {
            <p class="border-t border-white/5 px-6 py-3 text-xs text-rose-300">{{ error() }}</p>
          }
        </div>

        @if (notifications().length > 0) {
          <section class="mt-4 rounded-2xl border border-white/8 bg-ink-900/60">
            <div class="flex items-center justify-between gap-2 border-b border-white/5 px-4 py-3">
              <h2 class="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-500">
                {{ i18n.t().notifications }}
                @if (unread() > 0) {
                  <span
                    class="ml-1 rounded bg-sakura-500/15 px-1.5 py-0.5 text-[10px] text-sakura-300"
                    >{{ unread() }}</span
                  >
                }
              </h2>
              @if (unread() > 0) {
                <button
                  type="button"
                  (click)="markRead()"
                  class="font-mono text-[10px] uppercase tracking-wider text-ink-500 transition hover:text-ink-200"
                >
                  {{ i18n.t().markAllRead }}
                </button>
              }
            </div>
            <ul class="divide-y divide-white/5">
              @for (note of notifications(); track note.id) {
                <li class="px-4 py-3" [class.opacity-60]="note.readAt">
                  <p class="text-sm text-ink-300">{{ note.body }}</p>
                  <p class="mt-1 font-mono text-[10px] text-ink-500">
                    {{ formatDateTime(note.createdAt, i18n.locale()) }}
                    @if (note.postId) {
                      ·
                      <a
                        [routerLink]="['/post', note.postId]"
                        class="text-sakura-300 hover:text-sakura-200"
                        >#{{ note.postId }}</a
                      >
                    }
                  </p>
                </li>
              }
            </ul>
          </section>
        }
      }
    </div>
  `,
})
export class AccountPage {
  private readonly api = inject(Api);
  readonly auth = inject(AuthService);
  readonly i18n = inject(I18n);
  private readonly router = inject(Router);
  readonly signingOut = signal(false);
  readonly error = signal<string | null>(null);
  readonly notifications = signal<Notification[]>([]);
  readonly unread = signal(0);
  readonly formatDate = formatDate;
  readonly formatDateTime = formatDateTime;

  constructor() {
    effect(() => {
      if (this.auth.ready() && !this.auth.user()) {
        void this.router.navigate(['/auth'], { queryParams: { next: '/account' } });
        return;
      }
      if (this.auth.user()) this.loadNotifications();
    });
  }

  markRead(): void {
    this.api.markNotificationsRead().subscribe({
      next: () => {
        this.unread.set(0);
        this.notifications.update((list) =>
          list.map((note) => (note.readAt ? note : { ...note, readAt: new Date().toISOString() })),
        );
      },
      error: () => undefined,
    });
  }

  private loadNotifications(): void {
    this.api.getNotifications().subscribe({
      next: (response) => {
        this.notifications.set(response.notifications);
        this.unread.set(response.unread);
      },
      error: () => undefined,
    });
  }

  roleLabel(role: UserRole): string {
    const t = this.i18n.t();
    if (role === 'admin') return t.roleAdmin;
    if (role === 'moderator') return t.roleModerator;
    return t.roleUser;
  }

  roleClass(role: UserRole): string {
    if (role === 'admin') return 'bg-rose-500/15 text-rose-300 ring-rose-400/30';
    if (role === 'moderator') return 'bg-amber-500/15 text-amber-300 ring-amber-400/30';
    return 'bg-sky-500/15 text-sky-300 ring-sky-400/30';
  }

  signOut(): void {
    this.error.set(null);
    this.signingOut.set(true);
    this.auth.logout().subscribe({
      next: () => {
        this.signingOut.set(false);
        void this.router.navigate(['/']);
      },
      error: () => {
        this.signingOut.set(false);
        this.error.set(this.i18n.t().errGeneric);
      },
    });
  }
}
