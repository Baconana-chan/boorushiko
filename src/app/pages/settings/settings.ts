import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth';
import { I18n } from '../../core/i18n';
import type { RatingMode, UserRole } from '../../core/models';
import { Preferences } from '../../core/preferences';
import { formatDate } from '../../core/ui';

@Component({
  selector: 'app-settings-page',
  imports: [RouterLink],
  templateUrl: './settings.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPage {
  readonly prefs = inject(Preferences);
  readonly auth = inject(AuthService);
  readonly i18n = inject(I18n);
  private readonly router = inject(Router);

  readonly agePrompt = signal(false);
  readonly signingOut = signal(false);
  readonly formatDate = formatDate;

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

  chooseRating(mode: RatingMode): void {
    if (mode === 'adult' && !this.prefs.ageConfirmed()) {
      this.agePrompt.set(true);
      return;
    }
    this.agePrompt.set(false);
    this.prefs.setRatingMode(mode);
  }

  confirmAge(): void {
    this.prefs.confirmAge();
    this.agePrompt.set(false);
  }

  cancelAge(): void {
    this.agePrompt.set(false);
  }

  toggleSensitive(): void {
    this.prefs.setShowSensitive(!this.prefs.showSensitive());
  }

  roleLabel(role: UserRole): string {
    const t = this.i18n.t();
    if (role === 'admin') return t.roleAdmin;
    if (role === 'moderator') return t.roleModerator;
    return this.auth.canUpload() ? t.roleUploader : t.roleUser;
  }

  signOut(): void {
    if (this.signingOut()) return;
    this.signingOut.set(true);
    this.auth.logout().subscribe({
      next: () => {
        this.signingOut.set(false);
        void this.router.navigate(['/']);
      },
      error: () => this.signingOut.set(false),
    });
  }
}
