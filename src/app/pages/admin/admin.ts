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
import { Router, RouterLink } from '@angular/router';
import { apiErrorCode, Api } from '../../core/api';
import { AuthService } from '../../core/auth';
import { I18n, type Messages } from '../../core/i18n';
import { MODERATION_REASONS } from '../../core/models';
import type {
  AdminOverview,
  AdminPost,
  AdminReport,
  AdminUploaderRequest,
  AuditEntry,
  DnpEntry,
  ModerationReason,
  SourceRun,
  SourceRunLog,
  SourceSchedule,
  UploaderEntry,
} from '../../core/models';
import { formatDate, formatDateTime, humanBytes } from '../../core/ui';

type Tab = 'queue' | 'reports' | 'dnp' | 'uploaders' | 'sources' | 'audit';
type QueueStatus = 'pending' | 'active' | 'hidden' | 'deleted';

interface SourceForm {
  source: string;
  tags: string;
  limit: number;
  page: number;
}

const QUEUE_STATUSES: QueueStatus[] = ['pending', 'active', 'hidden', 'deleted'];

const REASON_KEYS: Record<ModerationReason, keyof Messages> = {
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

const ACTION_KEYS: Record<string, keyof Messages> = {
  'post.approve': 'actionPostApprove',
  'post.reject': 'actionPostReject',
  'post.delete': 'actionPostDelete',
  'post.rating': 'actionPostRating',
  'report.resolve': 'actionReportResolve',
  'report.dismiss': 'actionReportDismiss',
  'report.create': 'actionReportCreate',
  'dnp.add': 'actionDnpAdd',
  'dnp.remove': 'actionDnpRemove',
  'uploader.approve': 'actionUploaderApprove',
  'uploader.reject': 'actionUploaderReject',
  'uploader.revoke': 'actionUploaderRevoke',
  'source.run': 'actionSourceRun',
  'source.cancel': 'actionSourceCancel',
  'source.schedule': 'actionSourceSchedule',
};

@Component({
  selector: 'app-admin-page',
  imports: [RouterLink],
  templateUrl: './admin.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  readonly auth = inject(AuthService);
  readonly i18n = inject(I18n);

  readonly tab = signal<Tab>('queue');
  readonly queueStatus = signal<QueueStatus>('pending');
  readonly queueStatuses = QUEUE_STATUSES;
  readonly reasons = MODERATION_REASONS;

  readonly overview = signal<AdminOverview | null>(null);
  readonly queue = signal<AdminPost[]>([]);
  readonly queueTotal = signal(0);
  readonly queuePage = signal(1);
  readonly queueHasMore = signal(false);
  readonly queueLoading = signal(false);
  readonly queueError = signal(false);

  readonly reports = signal<AdminReport[]>([]);
  readonly reportStatus = signal<'open' | 'all'>('open');
  readonly reportsLoading = signal(false);
  readonly reportsError = signal(false);

  readonly dnp = signal<DnpEntry[]>([]);
  readonly dnpLoading = signal(false);
  readonly dnpError = signal(false);
  readonly dnpName = signal('');
  readonly dnpSource = signal('');
  readonly dnpNote = signal('');
  readonly dnpSaving = signal(false);

  readonly uploaderRequests = signal<AdminUploaderRequest[]>([]);
  readonly uploaderList = signal<UploaderEntry[]>([]);
  readonly uploaderLoading = signal(false);
  readonly uploaderError = signal(false);
  readonly uploaderBusyId = signal<number | null>(null);
  readonly revokeBusyId = signal<number | null>(null);
  readonly uploaderRejectId = signal<number | null>(null);
  readonly uploaderNote = signal('');

  readonly sources = signal<string[]>(['danbooru']);
  readonly sourceSchedules = signal<SourceSchedule[]>([]);
  readonly scheduleSaving = signal<string | null>(null);
  readonly sourceRuns = signal<SourceRun[]>([]);
  readonly sourceLoading = signal(false);
  readonly sourceError = signal(false);
  readonly sourceStarting = signal(false);
  readonly sourceCancelling = signal(false);
  readonly selectedSourceRunId = signal<number | null>(null);
  readonly selectedSourceRun = signal<SourceRun | null>(null);
  readonly sourceLogs = signal<SourceRunLog[]>([]);
  readonly sourceLogLoading = signal(false);
  readonly sourceForm = signal<SourceForm>({
    source: 'danbooru',
    tags: '',
    limit: 40,
    page: 1,
  });
  readonly activeSourceCount = computed(
    () => this.sourceRuns().filter((run) => this.isSourceActive(run.status)).length,
  );
  readonly activeSourceRun = computed(() => {
    const source = this.sourceForm().source;
    return this.sourceRuns().find(
      (run) => run.source === source && this.isSourceActive(run.status),
    );
  });

  readonly audit = signal<AuditEntry[]>([]);
  readonly auditLoading = signal(false);
  readonly auditError = signal(false);

  readonly notice = signal<string | null>(null);
  readonly busyId = signal<number | null>(null);
  readonly reportBusyId = signal<number | null>(null);
  readonly rejectTarget = signal<AdminPost | null>(null);
  readonly rejectReason = signal<ModerationReason>('other');
  readonly rejectNote = signal('');

  readonly isStaff = computed(() => this.auth.isStaff());
  readonly overviewCards = computed(() => {
    const data = this.overview();
    if (!data) return [];
    return [
      { key: 'pending', label: this.i18n.t().adminOverviewPending, value: data.posts.pending },
      { key: 'reports', label: this.i18n.t().adminOverviewReports, value: data.openReports },
      { key: 'dnp', label: this.i18n.t().adminOverviewDnp, value: data.dnp },
      { key: 'flagged', label: this.i18n.t().adminOverviewFlagged, value: data.flaggedPending },
    ];
  });

  readonly formatDate = formatDate;
  readonly formatDateTime = formatDateTime;
  readonly humanBytes = humanBytes;

  private readonly destroyRef = inject(DestroyRef);
  private readonly logBox = viewChild<ElementRef<HTMLElement>>('logBox');
  private started = false;
  private sourcesLoaded = false;
  private sourceTimer: ReturnType<typeof setTimeout> | undefined;
  private lastLogId = 0;

  constructor() {
    this.destroyRef.onDestroy(() => this.stopSourcePolling());

    effect(() => {
      if (!this.auth.ready()) return;
      if (!this.auth.user()) {
        void this.router.navigate(['/auth'], { queryParams: { next: '/admin' } });
        return;
      }
      if (!this.auth.isStaff() || this.started) return;
      this.started = true;
      this.refreshAll();
    });
  }

  refreshAll(): void {
    this.loadOverview();
    this.loadQueue(1);
    this.loadReports();
    this.loadDnp();
    this.loadUploaders();
    this.loadSources();
    this.loadAudit();
  }

  setTab(tab: Tab): void {
    this.tab.set(tab);
    this.notice.set(null);
    if (tab === 'sources') {
      if (!this.sourcesLoaded) this.loadSources();
      if (this.selectedSourceRunId() === null && this.sourceRuns().length > 0) {
        this.selectSourceRun(this.sourceRuns()[0]!.id);
      }
      this.scheduleSourcePolling();
    } else {
      this.stopSourcePolling();
    }
  }

  setQueueStatus(status: QueueStatus): void {
    if (this.queueStatus() === status) return;
    this.queueStatus.set(status);
    this.loadQueue(1);
  }

  loadMoreQueue(): void {
    if (this.queueLoading() || !this.queueHasMore()) return;
    this.loadQueue(this.queuePage() + 1);
  }

  openPending(): void {
    this.setTab('queue');
    this.setQueueStatus('pending');
  }

  setReportStatus(status: 'open' | 'all'): void {
    if (this.reportStatus() === status) return;
    this.reportStatus.set(status);
    this.loadReports();
  }

  tabClass(tab: Tab): string {
    const base = 'rounded-lg px-3 py-2 font-mono text-[11px] uppercase tracking-wider transition';
    return `${base} ${
      this.tab() === tab
        ? 'bg-sakura-500 text-white shadow-sm shadow-sakura-600/30'
        : 'text-ink-400 hover:bg-white/5 hover:text-ink-100'
    }`;
  }

  statusClass(status: string): string {
    if (status === 'active') return 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30';
    if (status === 'pending') return 'bg-amber-500/15 text-amber-300 ring-amber-400/30';
    if (status === 'hidden') return 'bg-rose-500/15 text-rose-300 ring-rose-400/30';
    return 'bg-white/5 text-ink-400 ring-white/10';
  }

  statusLabel(status: string): string {
    if (status === 'active') return this.i18n.t().adminStatusActive;
    if (status === 'pending') return this.i18n.t().adminStatusPending;
    if (status === 'hidden') return this.i18n.t().adminStatusHidden;
    return this.i18n.t().adminStatusDeleted;
  }

  reasonLabel(reason: string | null): string {
    if (!reason) return '';
    const key = REASON_KEYS[reason as ModerationReason];
    return key ? this.i18n.t()[key] : reason;
  }

  flagLabel(flag: string): string {
    const key = FLAG_KEYS[flag];
    return key ? this.i18n.t()[key] : flag;
  }

  actionLabel(action: string): string {
    const key = ACTION_KEYS[action];
    return key ? this.i18n.t()[key] : action;
  }

  reportStatusLabel(status: string): string {
    if (status === 'resolved') return this.i18n.t().adminReportResolved;
    if (status === 'dismissed') return this.i18n.t().adminReportDismissed;
    return this.i18n.t().adminOpen;
  }

  approve(post: AdminPost): void {
    this.moderate(post, { status: 'active' });
  }

  startReject(post: AdminPost): void {
    this.rejectTarget.set(post);
    this.rejectReason.set(
      post.policyFlags.some((flag) => flag.startsWith('3d'))
        ? '3d'
        : post.policyFlags.some((flag) => flag.startsWith('ai'))
          ? 'ai'
          : post.reportCount > 0
            ? 'other'
            : 'not_2d',
    );
    this.rejectNote.set('');
  }

  cancelReject(): void {
    this.rejectTarget.set(null);
  }

  confirmReject(): void {
    const post = this.rejectTarget();
    if (!post || this.busyId() !== null) return;
    this.moderate(post, {
      status: 'hidden',
      reason: this.rejectReason(),
      note: this.rejectNote().trim() || undefined,
    });
  }

  changeRating(post: AdminPost, event: Event): void {
    const rating = (event.target as HTMLSelectElement).value;
    if (rating === post.rating) return;
    this.moderate(post, { rating });
  }

  resolveReport(report: AdminReport, status: 'resolved' | 'dismissed', hidePost = false): void {
    if (this.reportBusyId() !== null) return;
    this.reportBusyId.set(report.id);
    this.notice.set(null);
    this.api.resolveAdminReport(report.id, { status, hidePost }).subscribe({
      next: () => {
        this.reportBusyId.set(null);
        this.notice.set(status === 'resolved' ? this.i18n.t().adminReportResolved : null);
        this.refreshAll();
      },
      error: () => {
        this.reportBusyId.set(null);
        this.notice.set(this.i18n.t().errGeneric);
      },
    });
  }

  addDnp(event: Event): void {
    event.preventDefault();
    const name = this.dnpName().trim();
    if (!name || this.dnpSaving()) return;
    this.dnpSaving.set(true);
    this.notice.set(null);
    this.api.addDnp(name, this.dnpSource().trim(), this.dnpNote().trim()).subscribe({
      next: () => {
        this.dnpSaving.set(false);
        this.dnpName.set('');
        this.dnpSource.set('');
        this.dnpNote.set('');
        this.loadDnp();
        this.loadOverview();
        this.loadAudit();
      },
      error: (error: unknown) => {
        this.dnpSaving.set(false);
        this.notice.set(
          apiErrorCode(error) === 'dnp_exists'
            ? this.i18n.t().adminDnpExists
            : this.i18n.t().errGeneric,
        );
      },
    });
  }

  removeDnp(entry: DnpEntry): void {
    if (this.dnpSaving()) return;
    this.dnpSaving.set(true);
    this.api.removeDnp(entry.id).subscribe({
      next: () => {
        this.dnpSaving.set(false);
        this.dnp.set(this.dnp().filter((item) => item.id !== entry.id));
        this.loadOverview();
        this.loadAudit();
      },
      error: () => {
        this.dnpSaving.set(false);
        this.notice.set(this.i18n.t().errGeneric);
      },
    });
  }

  reviewUploader(request: AdminUploaderRequest, status: 'approved' | 'rejected'): void {
    if (this.uploaderBusyId() !== null) return;
    this.uploaderBusyId.set(request.id);
    this.notice.set(null);
    const note = status === 'rejected' ? this.uploaderNote().trim() || undefined : undefined;
    this.api.reviewUploaderRequest(request.id, status, note).subscribe({
      next: () => {
        this.uploaderBusyId.set(null);
        this.uploaderRejectId.set(null);
        this.uploaderNote.set('');
        this.loadUploaders();
        this.loadOverview();
        this.loadAudit();
      },
      error: () => {
        this.uploaderBusyId.set(null);
        this.notice.set(this.i18n.t().errGeneric);
      },
    });
  }

  startUploaderReject(request: AdminUploaderRequest): void {
    this.uploaderRejectId.set(request.id);
    this.uploaderNote.set('');
  }

  cancelUploaderReject(): void {
    this.uploaderRejectId.set(null);
    this.uploaderNote.set('');
  }

  confirmUploaderReject(): void {
    const id = this.uploaderRejectId();
    if (id === null) return;
    const request = this.uploaderRequests().find((item) => item.id === id);
    if (request) this.reviewUploader(request, 'rejected');
  }

  revokeUploader(entry: UploaderEntry): void {
    if (this.revokeBusyId() !== null) return;
    this.revokeBusyId.set(entry.userId);
    this.notice.set(null);
    this.api.revokeUploader(entry.userId).subscribe({
      next: () => {
        this.revokeBusyId.set(null);
        this.loadUploaders();
        this.loadAudit();
      },
      error: () => {
        this.revokeBusyId.set(null);
        this.notice.set(this.i18n.t().errGeneric);
      },
    });
  }

  onUploaderNote(event: Event): void {
    this.uploaderNote.set((event.target as HTMLTextAreaElement).value);
  }

  isSourceActive(status: string): boolean {
    return status === 'queued' || status === 'running';
  }

  onSourceAdapter(event: Event): void {
    const source = (event.target as HTMLSelectElement).value;
    this.sourceForm.update((form) => ({ ...form, source }));
  }

  onSourceTags(event: Event): void {
    this.sourceForm.update((form) => ({
      ...form,
      tags: (event.target as HTMLInputElement).value,
    }));
  }

  onSourceLimit(event: Event): void {
    this.sourceForm.update((form) => ({
      ...form,
      limit: Number((event.target as HTMLInputElement).value),
    }));
  }

  onSourcePage(event: Event): void {
    this.sourceForm.update((form) => ({
      ...form,
      page: Number((event.target as HTMLInputElement).value),
    }));
  }

  startSourceRun(event: Event): void {
    event.preventDefault();
    if (this.sourceStarting()) return;

    const form = this.sourceForm();
    const limit = Math.floor(Number(form.limit));
    const page = Math.floor(Number(form.page));
    if (!Number.isFinite(limit) || limit < 1 || limit > 500) {
      this.notice.set(this.i18n.t().adminSourceStartError);
      return;
    }
    if (!Number.isFinite(page) || page < 1) {
      this.notice.set(this.i18n.t().adminSourceStartError);
      return;
    }

    this.sourceStarting.set(true);
    this.notice.set(null);
    this.api
      .startSourceRun({
        source: form.source,
        ...(form.tags.trim() ? { tags: form.tags.trim() } : {}),
        limit,
        page,
      })
      .subscribe({
        next: ({ run }) => {
          this.sourceStarting.set(false);
          this.updateSourceRun(run);
          this.selectedSourceRunId.set(run.id);
          this.selectedSourceRun.set(run);
          this.sourceLogs.set([]);
          this.lastLogId = 0;
          this.loadSourceRun(run.id, 0);
          this.scheduleSourcePolling();
        },
        error: (error: unknown) => {
          this.sourceStarting.set(false);
          this.notice.set(
            apiErrorCode(error) === 'source_busy'
              ? this.i18n.t().adminSourceBusy
              : this.i18n.t().adminSourceStartError,
          );
        },
      });
  }

  selectSourceRun(id: number): void {
    if (this.selectedSourceRunId() === id && this.sourceLogs().length > 0) {
      this.scheduleSourcePolling();
      return;
    }
    this.selectedSourceRunId.set(id);
    this.selectedSourceRun.set(this.sourceRuns().find((run) => run.id === id) ?? null);
    this.sourceLogs.set([]);
    this.lastLogId = 0;
    this.loadSourceRun(id, 0);
  }

  cancelSourceRun(run: SourceRun): void {
    if (!this.isSourceActive(run.status) || this.sourceCancelling()) return;
    this.sourceCancelling.set(true);
    this.notice.set(null);
    this.api.cancelSourceRun(run.id).subscribe({
      next: ({ run: updated }) => {
        this.sourceCancelling.set(false);
        this.updateSourceRun(updated);
        if (this.selectedSourceRunId() === updated.id) {
          this.selectedSourceRun.set(updated);
          this.loadSourceRun(updated.id, this.lastLogId);
        }
        this.scheduleSourcePolling();
      },
      error: () => {
        this.sourceCancelling.set(false);
        this.notice.set(this.i18n.t().errGeneric);
      },
    });
  }

  toggleSourceSchedule(schedule: SourceSchedule): void {
    this.saveSourceSchedule(schedule, { enabled: !schedule.enabled });
  }

  updateScheduleNumber(
    schedule: SourceSchedule,
    field: 'intervalMinutes' | 'batchLimit' | 'dailyLimit',
    event: Event,
  ): void {
    const value = Math.floor(Number((event.target as HTMLInputElement).value));
    if (!Number.isFinite(value)) return;
    const patch: { intervalMinutes?: number; batchLimit?: number; dailyLimit?: number } = {};
    patch[field] = value;
    this.saveSourceSchedule(schedule, patch);
  }

  updateScheduleTags(schedule: SourceSchedule, event: Event): void {
    const tags = (event.target as HTMLInputElement).value.trim();
    this.saveSourceSchedule(schedule, { tags: tags || null });
  }

  resetSourceSchedule(schedule: SourceSchedule): void {
    this.saveSourceSchedule(schedule, { reset: true });
  }

  scheduleModeLabel(schedule: SourceSchedule): string {
    if (!schedule.enabled) return this.i18n.t().adminSourceAutoOff;
    if (schedule.backfillDone) return this.i18n.t().adminSourceAutoDone;
    return schedule.nextMode === 'backfill'
      ? this.i18n.t().adminSourceAutoBackfill
      : this.i18n.t().adminSourceAutoHead;
  }

  sourceStatusLabel(run: SourceRun): string {
    if (run.cancelRequested && run.status === 'running') {
      return this.i18n.t().adminSourceCancelling;
    }
    switch (run.status) {
      case 'queued':
        return this.i18n.t().adminSourceStatusQueued;
      case 'running':
        return this.i18n.t().adminSourceStatusRunning;
      case 'completed':
        return this.i18n.t().adminSourceStatusCompleted;
      case 'failed':
        return this.i18n.t().adminSourceStatusFailed;
      default:
        return this.i18n.t().adminSourceStatusCancelled;
    }
  }

  sourceStatusClass(status: string): string {
    if (status === 'running') return 'bg-sky-500/15 text-sky-300 ring-sky-400/30';
    if (status === 'queued') return 'bg-amber-500/15 text-amber-300 ring-amber-400/30';
    if (status === 'completed') return 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30';
    if (status === 'failed') return 'bg-rose-500/15 text-rose-300 ring-rose-400/30';
    return 'bg-white/5 text-ink-400 ring-white/10';
  }

  logLevelClass(level: string): string {
    if (level === 'warn') return 'text-amber-300';
    if (level === 'error') return 'text-rose-300';
    return 'text-ink-300';
  }

  sourceProgress(run: SourceRun): number {
    if (run.limitCount <= 0) return 0;
    return Math.min(100, Math.round((run.seen / run.limitCount) * 100));
  }

  dnpTarget(entry: AuditEntry): string {
    if (entry.targetType === 'post' && entry.targetId) return `#${entry.targetId}`;
    if (entry.targetType === 'report' && entry.targetId) return `#${entry.targetId}`;
    return entry.details ?? '—';
  }

  reportReason(report: AdminReport): string {
    return this.reasonLabel(report.reason);
  }

  private moderate(
    post: AdminPost,
    patch: { status?: string; rating?: string; reason?: ModerationReason; note?: string },
  ): void {
    if (this.busyId() !== null) return;
    this.busyId.set(post.id);
    this.notice.set(null);
    this.api.moderatePost(post.id, patch).subscribe({
      next: () => {
        this.busyId.set(null);
        this.rejectTarget.set(null);
        this.refreshAll();
      },
      error: () => {
        this.busyId.set(null);
        this.notice.set(this.i18n.t().errGeneric);
      },
    });
  }

  private loadOverview(): void {
    this.api.getAdminOverview().subscribe({
      next: (overview) => this.overview.set(overview),
      error: () => this.overview.set(null),
    });
  }

  private loadQueue(page: number): void {
    this.queueLoading.set(true);
    this.queueError.set(false);
    this.api.listAdminQueue(this.queueStatus(), page).subscribe({
      next: (response) => {
        this.queue.set(page === 1 ? response.posts : [...this.queue(), ...response.posts]);
        this.queueTotal.set(response.total);
        this.queuePage.set(page);
        this.queueHasMore.set(response.hasMore);
        this.queueLoading.set(false);
      },
      error: () => {
        this.queueLoading.set(false);
        this.queueError.set(true);
      },
    });
  }

  private loadReports(): void {
    this.reportsLoading.set(true);
    this.reportsError.set(false);
    this.api.listAdminReports(this.reportStatus()).subscribe({
      next: (response) => {
        this.reports.set(response.reports);
        this.reportsLoading.set(false);
      },
      error: () => {
        this.reportsLoading.set(false);
        this.reportsError.set(true);
      },
    });
  }

  private loadDnp(): void {
    this.dnpLoading.set(true);
    this.dnpError.set(false);
    this.api.listDnp().subscribe({
      next: (response) => {
        this.dnp.set(response.entries);
        this.dnpLoading.set(false);
      },
      error: () => {
        this.dnpLoading.set(false);
        this.dnpError.set(true);
      },
    });
  }

  private loadUploaders(): void {
    this.uploaderLoading.set(true);
    this.uploaderError.set(false);
    this.api.listUploaders().subscribe({
      next: (response) => {
        this.uploaderRequests.set(response.requests);
        this.uploaderList.set(response.uploaders);
        this.uploaderLoading.set(false);
      },
      error: () => {
        this.uploaderLoading.set(false);
        this.uploaderError.set(true);
      },
    });
  }

  private saveSourceSchedule(
    schedule: SourceSchedule,
    patch: {
      enabled?: boolean;
      intervalMinutes?: number;
      batchLimit?: number;
      dailyLimit?: number;
      tags?: string | null;
      reset?: boolean;
    },
  ): void {
    if (this.scheduleSaving() !== null) return;
    this.scheduleSaving.set(schedule.source);
    this.notice.set(null);
    this.api.updateSourceSchedule(schedule.source, patch).subscribe({
      next: ({ schedule: updated }) => {
        this.scheduleSaving.set(null);
        this.sourceSchedules.update((items) =>
          items.map((item) => (item.source === updated.source ? updated : item)),
        );
      },
      error: () => {
        this.scheduleSaving.set(null);
        this.notice.set(this.i18n.t().adminSourceAutoSaveError);
      },
    });
  }

  private loadSources(): void {
    this.sourceLoading.set(true);
    this.sourceError.set(false);
    this.api.listSources().subscribe({
      next: (response) => {
        this.sourcesLoaded = true;
        this.sources.set(response.sources);
        this.sourceSchedules.set(response.schedules);
        this.sourceRuns.set(response.runs);
        this.sourceForm.update((form) => ({
          ...form,
          source: form.source || response.sources[0] || 'danbooru',
        }));
        const selectedId = this.selectedSourceRunId();
        if (selectedId !== null) {
          const updated = response.runs.find((run) => run.id === selectedId);
          if (updated) this.selectedSourceRun.set(updated);
        }
        this.sourceLoading.set(false);
        this.scheduleSourcePolling();
      },
      error: () => {
        this.sourceLoading.set(false);
        this.sourceError.set(true);
      },
    });
  }

  private loadSourceRun(id: number, after: number): void {
    this.sourceLogLoading.set(after === 0);
    this.api.getSourceRun(id, after).subscribe({
      next: (detail) => {
        if (this.selectedSourceRunId() !== id) return;
        this.selectedSourceRun.set(detail.run);
        this.updateSourceRun(detail.run);
        this.sourceLogs.update((existing) =>
          after === 0 ? detail.logs : [...existing, ...detail.logs],
        );
        if (detail.logs.length > 0) {
          this.lastLogId = detail.logs[detail.logs.length - 1]!.id;
        } else if (after === 0) {
          this.lastLogId = 0;
        }
        this.sourceLogLoading.set(false);
        this.scrollLogs();
        this.scheduleSourcePolling();
      },
      error: () => {
        this.sourceLogLoading.set(false);
        this.notice.set(this.i18n.t().adminSourceLogError);
      },
    });
  }

  private updateSourceRun(run: SourceRun): void {
    this.sourceRuns.update((runs) => {
      if (!runs.some((item) => item.id === run.id)) return [run, ...runs];
      return runs.map((item) => (item.id === run.id ? run : item));
    });
  }

  private scheduleSourcePolling(delay = 1000): void {
    this.stopSourcePolling();
    if (this.tab() !== 'sources') return;
    const run = this.selectedSourceRun();
    if (!run || !this.isSourceActive(run.status)) return;
    this.sourceTimer = setTimeout(() => this.pollSourceRun(), delay);
  }

  private pollSourceRun(): void {
    const run = this.selectedSourceRun();
    if (!run || !this.isSourceActive(run.status) || this.tab() !== 'sources') return;
    const id = run.id;
    this.api.getSourceRun(id, this.lastLogId).subscribe({
      next: (detail) => {
        if (this.selectedSourceRunId() !== id) return;
        this.selectedSourceRun.set(detail.run);
        this.updateSourceRun(detail.run);
        if (detail.logs.length > 0) {
          this.sourceLogs.update((existing) => [...existing, ...detail.logs]);
          this.lastLogId = detail.logs[detail.logs.length - 1]!.id;
          this.scrollLogs();
        }
        this.scheduleSourcePolling();
      },
      error: () => this.scheduleSourcePolling(2500),
    });
  }

  private stopSourcePolling(): void {
    if (this.sourceTimer !== undefined) clearTimeout(this.sourceTimer);
    this.sourceTimer = undefined;
  }

  private scrollLogs(): void {
    setTimeout(() => {
      const element = this.logBox()?.nativeElement;
      if (element) element.scrollTop = element.scrollHeight;
    }, 0);
  }

  private loadAudit(): void {
    this.auditLoading.set(true);
    this.auditError.set(false);
    this.api.listAudit().subscribe({
      next: (response) => {
        this.audit.set(response.entries);
        this.auditLoading.set(false);
      },
      error: () => {
        this.auditLoading.set(false);
        this.auditError.set(true);
      },
    });
  }

  onDnpName(event: Event): void {
    this.dnpName.set((event.target as HTMLInputElement).value);
  }

  onDnpSource(event: Event): void {
    this.dnpSource.set((event.target as HTMLInputElement).value);
  }

  onDnpNote(event: Event): void {
    this.dnpNote.set((event.target as HTMLInputElement).value);
  }

  onRejectReason(event: Event): void {
    this.rejectReason.set((event.target as HTMLSelectElement).value as ModerationReason);
  }

  onRejectNote(event: Event): void {
    this.rejectNote.set((event.target as HTMLTextAreaElement).value);
  }

  trackPost(_: number, post: AdminPost): number {
    return post.id;
  }
}
