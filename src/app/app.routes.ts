import { Routes } from '@angular/router';
import { HomePage } from './pages/home/home';

export const routes: Routes = [
  { path: '', component: HomePage },
  {
    path: 'post/:id',
    loadComponent: () => import('./pages/post/post').then((module) => module.PostPage),
  },
  {
    path: 'auth',
    loadComponent: () => import('./pages/auth/auth').then((module) => module.AuthPage),
  },
  {
    path: 'account',
    loadComponent: () => import('./pages/account/account').then((module) => module.AccountPage),
  },
  {
    path: 'settings',
    loadComponent: () => import('./pages/settings/settings').then((module) => module.SettingsPage),
  },
  {
    path: 'upload',
    loadComponent: () => import('./pages/upload/upload').then((module) => module.UploadPage),
  },
  {
    path: 'admin',
    loadComponent: () => import('./pages/admin/admin').then((module) => module.AdminPage),
  },
  {
    path: 'stats',
    loadComponent: () => import('./pages/stats/stats').then((module) => module.StatsPage),
  },
  {
    path: 'favorites',
    loadComponent: () =>
      import('./pages/favorites/favorites').then((module) => module.FavoritesPage),
  },
  {
    path: 'random',
    loadComponent: () => import('./pages/random/random').then((module) => module.RandomPage),
  },
  {
    path: 'pools',
    loadComponent: () => import('./pages/pools/pools').then((module) => module.PoolsPage),
  },
  {
    path: 'pools/:id',
    loadComponent: () => import('./pages/pool/pool').then((module) => module.PoolPage),
  },
  {
    path: 'about',
    loadComponent: () => import('./pages/info/info').then((module) => module.InfoPage),
    data: { page: 'about' },
  },
  {
    path: 'help',
    loadComponent: () => import('./pages/info/info').then((module) => module.InfoPage),
    data: { page: 'help' },
  },
  {
    path: 'rules',
    loadComponent: () => import('./pages/info/info').then((module) => module.InfoPage),
    data: { page: 'rules' },
  },
  {
    path: 'dmca',
    loadComponent: () => import('./pages/info/info').then((module) => module.InfoPage),
    data: { page: 'dmca' },
  },
  {
    path: 'tos',
    loadComponent: () => import('./pages/info/info').then((module) => module.InfoPage),
    data: { page: 'tos' },
  },
  {
    path: '**',
    loadComponent: () =>
      import('./pages/not-found/not-found').then((module) => module.NotFoundPage),
  },
];
