import { useQuery } from '@tanstack/react-query';

import { useApi } from '@/lib/domains';
import type { ThroughputSample } from '@shared/types';

import { needsHistory, withHistory, type ThroughputWindow } from './throughputHistory';

/**
 * A materialization's throughput for a chart's window: the stream's recent points, and for a window
 * wider than they cover, the console's history before them, read again each minute it is shown.
 */
export function useThroughput(
  materializationId: string,
  recent: ThroughputSample[],
  window: ThroughputWindow,
  shown = true,
): ThroughputSample[] {
  const api = useApi();
  const history = useQuery({
    queryKey: ['throughput-history', api.domain, materializationId],
    queryFn: () => api.throughputHistory(materializationId),
    enabled: shown && needsHistory(window),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  return needsHistory(window) ? withHistory(recent, history.data?.series ?? []) : recent;
}
