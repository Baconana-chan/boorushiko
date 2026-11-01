import { Injectable, signal } from '@angular/core';
import type { RatingMode } from './models';

const RATING_MODE_KEY = 'boorushiko.ratingMode';
const LEGACY_EXPLICIT_KEY = 'boorushiko.explicit';
const AGE_KEY = 'boorushiko.ageConfirmed';
const SENSITIVE_KEY = 'boorushiko.showSensitive';

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Best-effort: the in-memory signal still works for this session.
  }
}

function isRatingMode(value: string | null): value is RatingMode {
  return value === 'safe' || value === 'mixed' || value === 'adult';
}

function readRatingMode(): RatingMode {
  try {
    const stored = localStorage.getItem(RATING_MODE_KEY);
    if (isRatingMode(stored)) return stored;
    // The old binary 18+ switch meant "show explicit": migrate it to Adult.
    if (localStorage.getItem(LEGACY_EXPLICIT_KEY) === '1') return 'adult';
  } catch {
    // Storage can be unavailable in private mode; Mixed is the safe default.
  }
  return 'mixed';
}

@Injectable({ providedIn: 'root' })
export class Preferences {
  readonly ratingMode = signal<RatingMode>(readRatingMode());
  readonly ageConfirmed = signal(readFlag(AGE_KEY));
  /** Off by default: tags like loli/shota/rape stay out of listings until opted in. */
  readonly showSensitive = signal(readFlag(SENSITIVE_KEY));

  confirmAge(): void {
    this.ageConfirmed.set(true);
    writeFlag(AGE_KEY, true);
    this.setRatingMode('adult');
  }

  setRatingMode(value: RatingMode): void {
    this.ratingMode.set(value);
    try {
      localStorage.setItem(RATING_MODE_KEY, value);
    } catch {
      // Best-effort persistence.
    }
  }

  setShowSensitive(value: boolean): void {
    this.showSensitive.set(value);
    writeFlag(SENSITIVE_KEY, value);
  }
}
