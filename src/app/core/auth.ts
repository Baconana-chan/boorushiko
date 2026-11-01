import { computed, inject, Injectable, signal } from '@angular/core';
import { tap } from 'rxjs';
import { Api } from './api';
import type { Comment, User } from './models';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(Api);
  readonly user = signal<User | null>(null);
  readonly ready = signal(false);
  readonly isStaff = computed(() => {
    const role = this.user()?.role;
    return role === 'moderator' || role === 'admin';
  });
  readonly canUpload = computed(() => this.user()?.canUpload ?? false);

  constructor() {
    this.refresh();
  }

  refresh(): void {
    this.api.me().subscribe({
      next: (response) => {
        this.user.set(response.user);
        this.ready.set(true);
      },
      error: () => this.ready.set(true),
    });
  }

  login(username: string, password: string) {
    return this.api.login(username, password).pipe(tap((response) => this.user.set(response.user)));
  }

  register(username: string, password: string) {
    return this.api
      .register(username, password)
      .pipe(tap((response) => this.user.set(response.user)));
  }

  logout() {
    return this.api.logout().pipe(tap(() => this.user.set(null)));
  }

  canDelete(comment: Comment): boolean {
    const user = this.user();
    if (!user) return false;
    return user.id === comment.user.id || user.role === 'moderator' || user.role === 'admin';
  }
}
