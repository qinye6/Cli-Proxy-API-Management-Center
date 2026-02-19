/**
 * Generic hook for quota data fetching and management.
 */

import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuthFileItem } from '@/types';
import { useQuotaStore } from '@/stores';
import { getStatusFromError } from '@/utils/quota';
import type { QuotaConfig } from './quotaConfigs';

type QuotaScope = 'page' | 'all';

type QuotaUpdater<T> = T | ((prev: T) => T);

type QuotaSetter<T> = (updater: QuotaUpdater<T>) => void;

export interface QuotaLoadProgress {
  total: number;
  completed: number;
  success: number;
  failed: number;
  stopped: boolean;
}

interface LoadQuotaOptions {
  concurrency?: number;
  shouldStop?: () => boolean;
  onProgress?: (progress: QuotaLoadProgress) => void;
}

interface LoadQuotaResult<TData> {
  name: string;
  status: 'success' | 'error';
  data?: TData;
  error?: string;
  errorStatus?: number;
}

export function useQuotaLoader<TState, TData>(config: QuotaConfig<TState, TData>) {
  const { t } = useTranslation();
  const quota = useQuotaStore(config.storeSelector);
  const setQuota = useQuotaStore((state) => state[config.storeSetter]) as QuotaSetter<
    Record<string, TState>
  >;

  const loadingRef = useRef(false);
  const requestIdRef = useRef(0);

  const loadQuota = useCallback(
    async (
      targets: AuthFileItem[],
      scope: QuotaScope,
      setLoading: (loading: boolean, scope?: QuotaScope | null) => void,
      options: LoadQuotaOptions = {}
    ) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      const requestId = ++requestIdRef.current;
      setLoading(true, scope);

      try {
        const total = targets.length;
        let completed = 0;
        let success = 0;
        let failed = 0;
        let nextIndex = 0;
        let stopped = false;

        const emitProgress = () => {
          options.onProgress?.({
            total,
            completed,
            success,
            failed,
            stopped
          });
        };

        emitProgress();

        if (total === 0) return;

        const concurrencyRaw = Number(options.concurrency ?? total);
        const concurrency = Number.isFinite(concurrencyRaw)
          ? Math.max(1, Math.min(total, Math.floor(concurrencyRaw)))
          : 1;

        const shouldStop = () => {
          if (requestId !== requestIdRef.current) return true;
          if (!options.shouldStop) return false;
          return options.shouldStop();
        };

        const workers = Array.from({ length: concurrency }, async () => {
          while (true) {
            if (shouldStop()) {
              stopped = completed < total;
              return;
            }

            const currentIndex = nextIndex;
            if (currentIndex >= total) return;
            nextIndex += 1;
            const file = targets[currentIndex];

            setQuota((prev) => ({
              ...prev,
              [file.name]: config.buildLoadingState()
            }));

            let result: LoadQuotaResult<TData>;
            try {
              const data = await config.fetchQuota(file, t);
              result = { name: file.name, status: 'success', data };
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : t('common.unknown_error');
              const errorStatus = getStatusFromError(err);
              result = { name: file.name, status: 'error', error: message, errorStatus };
            }

            if (requestId !== requestIdRef.current) return;

            if (result.status === 'success') {
              success += 1;
              setQuota((prev) => ({
                ...prev,
                [result.name]: config.buildSuccessState(result.data as TData)
              }));
            } else {
              failed += 1;
              setQuota((prev) => ({
                ...prev,
                [result.name]: config.buildErrorState(
                  result.error || t('common.unknown_error'),
                  result.errorStatus
                )
              }));
            }

            completed += 1;
            stopped = shouldStop() && completed < total;
            emitProgress();
          }
        });

        await Promise.all(workers);
        stopped = stopped || (options.shouldStop?.() === true && completed < total);
        emitProgress();
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
          loadingRef.current = false;
        }
      }
    },
    [config, setQuota, t]
  );

  return { quota, loadQuota };
}
