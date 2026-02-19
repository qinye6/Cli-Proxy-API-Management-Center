/**
 * Generic quota section component.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { triggerHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNotificationStore, useQuotaStore, useThemeStore } from '@/stores';
import type { AuthFileItem, ResolvedTheme } from '@/types';
import { QuotaCard } from './QuotaCard';
import type { QuotaStatusState } from './QuotaCard';
import { useQuotaLoader, type QuotaLoadProgress } from './useQuotaLoader';
import type { QuotaConfig } from './quotaConfigs';
import { useGridColumns } from './useGridColumns';
import { IconRefreshCw } from '@/components/ui/icons';
import styles from '@/pages/QuotaPage.module.scss';

type QuotaUpdater<T> = T | ((prev: T) => T);

type QuotaSetter<T> = (updater: QuotaUpdater<T>) => void;

type ViewMode = 'paged' | 'all';
type RefreshScope = 'page' | 'all';

interface PendingQuotaRefreshRequest {
  scope: RefreshScope;
  concurrency: number;
}

const MAX_SHOW_ALL_THRESHOLD = 500;
const PAGE_SIZE_OPTIONS = [10, 50, 100, 200, 500, 1000] as const;
const DEFAULT_PAGE_SIZE = 10;
const DEFAULT_REFRESH_CONCURRENCY = 10;
const MAX_REFRESH_CONCURRENCY = 1000;

interface QuotaPaginationState<T> {
  pageSize: number;
  totalPages: number;
  currentPage: number;
  pageItems: T[];
  setPageSize: (size: number) => void;
  goToPrev: () => void;
  goToNext: () => void;
  loading: boolean;
  loadingScope: 'page' | 'all' | null;
  setLoading: (loading: boolean, scope?: 'page' | 'all' | null) => void;
}

const useQuotaPagination = <T,>(items: T[], defaultPageSize = 6): QuotaPaginationState<T> => {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(defaultPageSize);
  const [loading, setLoadingState] = useState(false);
  const [loadingScope, setLoadingScope] = useState<'page' | 'all' | null>(null);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(items.length / pageSize)),
    [items.length, pageSize]
  );

  const currentPage = useMemo(() => Math.min(page, totalPages), [page, totalPages]);

  const pageItems = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, currentPage, pageSize]);

  const setPageSize = useCallback((size: number) => {
    setPageSizeState(size);
    setPage(1);
  }, []);

  const goToPrev = useCallback(() => {
    setPage((prev) => Math.max(1, prev - 1));
  }, []);

  const goToNext = useCallback(() => {
    setPage((prev) => Math.min(totalPages, prev + 1));
  }, [totalPages]);

  const setLoading = useCallback((isLoading: boolean, scope?: 'page' | 'all' | null) => {
    setLoadingState(isLoading);
    setLoadingScope(isLoading ? (scope ?? null) : null);
  }, []);

  return {
    pageSize,
    totalPages,
    currentPage,
    pageItems,
    setPageSize,
    goToPrev,
    goToNext,
    loading,
    loadingScope,
    setLoading
  };
};

interface QuotaSectionProps<TState extends QuotaStatusState, TData> {
  config: QuotaConfig<TState, TData>;
  files: AuthFileItem[];
  loading: boolean;
  disabled: boolean;
}

export function QuotaSection<TState extends QuotaStatusState, TData>({
  config,
  files,
  loading,
  disabled
}: QuotaSectionProps<TState, TData>) {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const setQuota = useQuotaStore((state) => state[config.storeSetter]) as QuotaSetter<
    Record<string, TState>
  >;

  const [, gridRef] = useGridColumns(220); // Keep in sync with QuotaPage.module.scss grid min width
  const [viewMode, setViewMode] = useState<ViewMode>('paged');
  const [pageSizeOption, setPageSizeOption] = useState<number>(DEFAULT_PAGE_SIZE);
  const [showTooManyWarning, setShowTooManyWarning] = useState(false);
  const [refreshModalOpen, setRefreshModalOpen] = useState(false);
  const [refreshConcurrencyInput, setRefreshConcurrencyInput] = useState(
    String(DEFAULT_REFRESH_CONCURRENCY)
  );
  const [refreshConcurrencyError, setRefreshConcurrencyError] = useState('');
  const [refreshProgress, setRefreshProgress] = useState<QuotaLoadProgress | null>(null);

  const filteredFiles = useMemo(() => files.filter((file) => config.filterFn(file)), [
    files,
    config
  ]);
  const showAllAllowed = filteredFiles.length <= MAX_SHOW_ALL_THRESHOLD;
  const effectiveViewMode: ViewMode = viewMode === 'all' && !showAllAllowed ? 'paged' : viewMode;

  const {
    pageSize,
    totalPages,
    currentPage,
    pageItems,
    setPageSize,
    goToPrev,
    goToNext,
    loading: sectionLoading,
    setLoading
  } = useQuotaPagination(filteredFiles);

  useEffect(() => {
    if (showAllAllowed) return;
    if (viewMode !== 'all') return;

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setViewMode('paged');
      setShowTooManyWarning(true);
    });

    return () => {
      cancelled = true;
    };
  }, [showAllAllowed, viewMode]);

  // Update page size based on view mode and user selection
  useEffect(() => {
    if (effectiveViewMode === 'all') {
      setPageSize(Math.max(1, filteredFiles.length));
    } else {
      setPageSize(pageSizeOption);
    }
  }, [effectiveViewMode, filteredFiles.length, pageSizeOption, setPageSize]);

  const { quota, loadQuota } = useQuotaLoader(config);

  const pendingQuotaRefreshRef = useRef<PendingQuotaRefreshRequest | null>(null);
  const stopRefreshRef = useRef(false);
  const prevFilesLoadingRef = useRef(loading);

  const parseRefreshConcurrency = useCallback((): number | null => {
    const parsed = Number.parseInt(refreshConcurrencyInput.trim(), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setRefreshConcurrencyError(t('quota_management.refresh_concurrency_invalid'));
      return null;
    }
    setRefreshConcurrencyError('');
    return Math.min(parsed, MAX_REFRESH_CONCURRENCY);
  }, [refreshConcurrencyInput, t]);

  const handleOpenRefreshModal = useCallback(() => {
    setRefreshConcurrencyError('');
    setRefreshModalOpen(true);
  }, []);

  const handleStopRefresh = useCallback(() => {
    stopRefreshRef.current = true;
  }, []);

  const handleStartRefresh = useCallback(
    (scope: RefreshScope) => {
      const concurrency = parseRefreshConcurrency();
      if (!concurrency) return;

      pendingQuotaRefreshRef.current = { scope, concurrency };
      stopRefreshRef.current = false;
      setRefreshProgress(null);
      setRefreshModalOpen(false);
      void triggerHeaderRefresh();
    },
    [parseRefreshConcurrency]
  );

  useEffect(() => {
    const wasLoading = prevFilesLoadingRef.current;
    prevFilesLoadingRef.current = loading;

    const pendingRefresh = pendingQuotaRefreshRef.current;
    if (!pendingRefresh) return;
    if (loading) return;
    if (!wasLoading) return;

    pendingQuotaRefreshRef.current = null;
    const scope = pendingRefresh.scope;
    const targets = scope === 'all' ? filteredFiles : pageItems;

    if (targets.length === 0) return;

    void (async () => {
      await loadQuota(targets, scope, setLoading, {
        concurrency: pendingRefresh.concurrency,
        shouldStop: () => stopRefreshRef.current,
        onProgress: (progress) => setRefreshProgress(progress)
      });

      if (stopRefreshRef.current) {
        showNotification(t('quota_management.refresh_stopped'), 'warning');
      }
      stopRefreshRef.current = false;
    })();
  }, [loading, filteredFiles, pageItems, loadQuota, setLoading, showNotification, t]);

  useEffect(() => {
    if (loading) return;
    if (filteredFiles.length === 0) {
      setQuota({});
      return;
    }
    setQuota((prev) => {
      const nextState: Record<string, TState> = {};
      filteredFiles.forEach((file) => {
        const cached = prev[file.name];
        if (cached) {
          nextState[file.name] = cached;
        }
      });
      return nextState;
    });
  }, [filteredFiles, loading, setQuota]);

  const titleNode = (
    <div className={styles.titleWrapper}>
      <span>{t(`${config.i18nPrefix}.title`)}</span>
      {filteredFiles.length > 0 && (
        <span className={styles.countBadge}>
          {filteredFiles.length}
        </span>
      )}
    </div>
  );

  const refreshRunning = Boolean(
    refreshProgress &&
      refreshProgress.total > 0 &&
      refreshProgress.completed < refreshProgress.total &&
      !refreshProgress.stopped
  );
  const refreshPercent =
    refreshProgress && refreshProgress.total > 0
      ? Math.round((refreshProgress.completed / refreshProgress.total) * 100)
      : 0;
  const pageSizeOptions = PAGE_SIZE_OPTIONS.map((value) => ({
    value: String(value),
    label: String(value)
  }));

  const isRefreshing = sectionLoading || loading || refreshRunning;

  return (
    <>
      <Card
      title={titleNode}
      extra={
        <div className={styles.headerActions}>
          <div className={styles.pageSizeControl}>
            <span className={styles.pageSizeLabel}>{t('quota_management.page_size_label')}</span>
            <Select
              value={String(pageSizeOption)}
              options={pageSizeOptions}
              onChange={(value) => {
                const parsed = Number.parseInt(value, 10);
                if (!Number.isFinite(parsed)) return;
                setPageSizeOption(parsed);
              }}
              ariaLabel={t('quota_management.page_size_label')}
              className={styles.pageSizeSelectWrap}
              fullWidth={false}
              disabled={effectiveViewMode !== 'paged'}
            />
          </div>
          <div className={styles.viewModeToggle}>
            <Button
              variant={effectiveViewMode === 'paged' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setViewMode('paged')}
            >
              {t('auth_files.view_mode_paged')}
            </Button>
            <Button
              variant={effectiveViewMode === 'all' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => {
                if (filteredFiles.length > MAX_SHOW_ALL_THRESHOLD) {
                  setShowTooManyWarning(true);
                } else {
                  setViewMode('all');
                }
              }}
            >
              {t('auth_files.view_mode_all')}
            </Button>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleOpenRefreshModal}
            disabled={disabled || isRefreshing}
            loading={isRefreshing}
            title={t('quota_management.refresh_files_and_quota')}
            aria-label={t('quota_management.refresh_files_and_quota')}
          >
            {!isRefreshing && <IconRefreshCw size={16} />}
          </Button>
        </div>
      }
    >
      {refreshProgress && refreshProgress.total > 0 && (
        <div className={styles.refreshProgressPanel}>
          <div className={styles.refreshProgressHeader}>
            <span className={styles.refreshProgressTitle}>
              {refreshRunning
                ? t('quota_management.refreshing')
                : refreshProgress.stopped
                  ? t('quota_management.refresh_stopped')
                  : t('quota_management.refresh_completed')}
            </span>
            <span className={styles.refreshProgressStats}>
              {t('quota_management.refresh_progress', {
                completed: refreshProgress.completed,
                total: refreshProgress.total
              })}
            </span>
          </div>
          <div className={styles.refreshProgressBar}>
            <div className={styles.refreshProgressBarFill} style={{ width: `${refreshPercent}%` }} />
          </div>
          <div className={styles.refreshProgressMeta}>
            {t('quota_management.refresh_progress_detail', {
              success: refreshProgress.success,
              failed: refreshProgress.failed
            })}
          </div>
          {refreshRunning && (
            <div className={styles.refreshProgressActions}>
              <Button variant="danger" size="sm" onClick={handleStopRefresh}>
                {t('quota_management.refresh_stop')}
              </Button>
            </div>
          )}
        </div>
      )}
      {filteredFiles.length === 0 ? (
        <EmptyState
          title={t(`${config.i18nPrefix}.empty_title`)}
          description={t(`${config.i18nPrefix}.empty_desc`)}
        />
      ) : (
        <>
          <div ref={gridRef} className={config.gridClassName}>
            {pageItems.map((item) => (
              <QuotaCard
                key={item.name}
                item={item}
                quota={quota[item.name]}
                resolvedTheme={resolvedTheme}
                i18nPrefix={config.i18nPrefix}
                cardClassName={config.cardClassName}
                defaultType={config.type}
                renderQuotaItems={config.renderQuotaItems}
              />
            ))}
          </div>
          {filteredFiles.length > pageSize && effectiveViewMode === 'paged' && (
            <div className={styles.pagination}>
              <Button
                variant="secondary"
                size="sm"
                onClick={goToPrev}
                disabled={currentPage <= 1}
              >
                {t('auth_files.pagination_prev')}
              </Button>
              <div className={styles.pageInfo}>
                {t('auth_files.pagination_info', {
                  current: currentPage,
                  total: totalPages,
                  count: filteredFiles.length
                })}
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={goToNext}
                disabled={currentPage >= totalPages}
              >
                {t('auth_files.pagination_next')}
              </Button>
            </div>
          )}
        </>
      )}
      {showTooManyWarning && (
        <div className={styles.warningOverlay} onClick={() => setShowTooManyWarning(false)}>
          <div className={styles.warningModal} onClick={(e) => e.stopPropagation()}>
            <p>{t('auth_files.too_many_files_warning')}</p>
            <Button variant="primary" size="sm" onClick={() => setShowTooManyWarning(false)}>
              {t('common.confirm')}
            </Button>
          </div>
        </div>
      )}
      </Card>

      <Modal
        open={refreshModalOpen}
        onClose={() => setRefreshModalOpen(false)}
        title={t('quota_management.refresh_scope_modal_title')}
        footer={
          <div className={styles.refreshScopeModalFooter}>
            <Button variant="secondary" onClick={() => setRefreshModalOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="secondary" onClick={() => handleStartRefresh('page')}>
              {t('quota_management.refresh_scope_current_page')}
            </Button>
            <Button onClick={() => handleStartRefresh('all')}>
              {t('quota_management.refresh_scope_all')}
            </Button>
          </div>
        }
      >
        <div className={styles.refreshScopeModalBody}>
          <p className={styles.refreshScopeModalDesc}>
            {t('quota_management.refresh_scope_modal_desc')}
          </p>
          <Input
            label={t('quota_management.refresh_concurrency_label')}
            value={refreshConcurrencyInput}
            onChange={(event) => setRefreshConcurrencyInput(event.target.value)}
            error={refreshConcurrencyError || undefined}
            hint={t('quota_management.refresh_concurrency_hint', {
              max: MAX_REFRESH_CONCURRENCY
            })}
            inputMode="numeric"
            pattern="[0-9]*"
          />
        </div>
      </Modal>
    </>
  );
}
