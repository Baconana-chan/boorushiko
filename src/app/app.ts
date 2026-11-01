import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { I18n } from './core/i18n';
import { Header } from './layout/header/header';
import { NekoClock } from './shared/neko-clock/neko-clock';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, Header, NekoClock],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  readonly i18n = inject(I18n);
  readonly year = new Date().getFullYear();
}
