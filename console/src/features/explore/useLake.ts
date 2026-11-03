import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';

import { buildLake, type DatasetsRead, type LakeDomain } from './lake';
import { ApiError, domainApi } from '@/lib/api';
import { useConsoleAuth } from '@/lib/auth';
import { useDomains } from '@/lib/domains';
import { useFleet } from '@/lib/fleet';
import { rootQueryClient } from '@/lib/queryClient';
import type { CpDatasetList } from '@shared/types';

/**
 * Each domain's datasets as far as their reads have got. Defined once, so TanStack keeps the result
 * the same while no read changes, and the lake is not rebuilt for nothing.
 */
function combineReads(results: Array<UseQueryResult<CpDatasetList>>): DatasetsRead[] {
  return results.map((result) => ({
    data: result.data?.datasets,
    failed: result.error ? (result.error instanceof ApiError ? result.error.status : 0) : null,
    loading: result.isLoading,
  }));
}

/**
 * The lake as the person may see it (docs/design/explore.md §6.3): every domain's datasets and their
 * tables, each with the state of what writes it. Nothing new is read for it: the fleet the shell
 * already streams, and each domain's datasets, read as the person and kept a little while - in the
 * console's own cache, each under its domain's id, so no domain's answer is shown as another's.
 */
export function useLake(): LakeDomain[] {
  const domains = useDomains();
  const { data: fleet } = useFleet(null);
  const consoleAuth = useConsoleAuth();
  const reads = useQueries(
    {
      queries: domains.map((domain) => ({
        queryKey: ['lake-datasets', domain.id],
        queryFn: () => domainApi(domain.id).datasets(),
        enabled: domain.status !== 'misconfigured' && consoleAuth.forDomain(domain.id).can('datasets.view'),
        staleTime: 15_000,
        refetchInterval: 60_000,
        retry: 0,
      })),
      combine: combineReads,
    },
    rootQueryClient,
  );
  // Rebuilt when the fleet, the datasets or the person change - not on every render of the page.
  return useMemo(
    () =>
      buildLake({
        domains,
        fleet,
        datasets: Object.fromEntries(domains.map((domain, index) => [domain.id, reads[index]])),
        can: (domain, permission, datasetId) => consoleAuth.forDomain(domain).can(permission, datasetId),
      }),
    [domains, fleet, consoleAuth, reads],
  );
}
