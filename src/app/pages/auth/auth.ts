import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { apiErrorCode } from '../../core/api';
import { AuthService } from '../../core/auth';
import { I18n, type Messages } from '../../core/i18n';

type Mode = 'login' | 'register';

const ERROR_KEYS: Record<string, keyof Messages> = {
  invalid_username: 'errUsername',
  weak_password: 'errPassword',
  username_taken: 'errUsernameTaken',
  invalid_credentials: 'errCredentials',
  slow_down: 'errSlowDown',
};

@Component({
  selector: 'app-auth-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './auth.html',
})
export class AuthPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  readonly i18n = inject(I18n);

  readonly mode = signal<Mode>('login');
  readonly username = signal('');
  readonly password = signal('');
  readonly confirm = signal('');
  readonly error = signal<string | null>(null);
  readonly submitting = signal(false);

  private readonly next = (() => {
    const raw = this.route.snapshot.queryParamMap.get('next');
    return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
  })();

  constructor() {
    effect(() => {
      if (this.auth.ready() && this.auth.user()) {
        void this.router.navigateByUrl(this.next);
      }
    });
  }

  switchMode(mode: Mode): void {
    this.mode.set(mode);
    this.error.set(null);
    this.password.set('');
    this.confirm.set('');
  }

  onUsername(event: Event): void {
    this.username.set((event.target as HTMLInputElement).value);
  }

  onPassword(event: Event): void {
    this.password.set((event.target as HTMLInputElement).value);
  }

  onConfirm(event: Event): void {
    this.confirm.set((event.target as HTMLInputElement).value);
  }

  tabClass(mode: Mode): string {
    const base = 'flex-1 rounded-lg px-3 py-2 text-sm font-medium transition';
    return `${base} ${
      this.mode() === mode
        ? 'bg-sakura-500 text-white shadow-sm shadow-sakura-600/30'
        : 'text-ink-400 hover:text-ink-200'
    }`;
  }

  submit(event: Event): void {
    event.preventDefault();
    if (this.submitting()) return;

    this.error.set(null);
    const username = this.username().trim();
    const password = this.password();

    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
      this.error.set(this.i18n.t().errUsername);
      return;
    }
    if (password.length < 8 || password.length > 200) {
      this.error.set(this.i18n.t().errPassword);
      return;
    }
    if (this.mode() === 'register' && password !== this.confirm()) {
      this.error.set(this.i18n.t().errPasswordMatch);
      return;
    }

    this.submitting.set(true);
    const request =
      this.mode() === 'login'
        ? this.auth.login(username, password)
        : this.auth.register(username, password);

    request.subscribe({
      next: () => this.submitting.set(false),
      error: (error: unknown) => {
        this.submitting.set(false);
        this.error.set(this.messageFor(apiErrorCode(error)));
      },
    });
  }

  private messageFor(code: string | null): string {
    const key = code ? ERROR_KEYS[code] : undefined;
    return key ? this.i18n.t()[key] : this.i18n.t().errGeneric;
  }
}
