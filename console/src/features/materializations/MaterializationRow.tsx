import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { formatReadoutRate } from '@/components/Readout';
import { FactPill, StatusGlyph } from '@/components/Status';
import { DomainChip } from '@/components/DomainChip';
import { displayName, formatCount } from '@/lib/format';
import { domainPath } from '@/lib/paths';
import type { DomainMaterialization } from '@/lib/fleet';
import { itemStatus, type Status } from '@/lib/status';
import { formatEta } from '@shared/lagTrend';

/**
 * The one fact a row leads with, for its state (docs/10-design-system.md §10.6): its rate while
 * flowing, how far it has come and the time left while catching up, its rows while stopped. A state
 * that needs someone says why in words beside it instead.
 */
export function rowFact(item: DomainMaterialization, status: Status): string | null {
  switch (status.kind) {
    case 'flowing':
      return item.rowsPerSecond === null ? null : `${formatReadoutRate(item.rowsPerSecond)}/s`;
    case 'catching-up': {
      if (item.catchUp === null) return item.lag === null ? null : `${formatCount(item.lag)} behind`;
      const left = item.lagEtaMs === null ? '' : ` · ${formatEta(item.lagEtaMs)} left`;
      return `${Math.round(item.catchUp * 100)}%${left}`;
    }
    case 'stopped':
      return item.rowsCommitted === null ? null : `${formatCount(item.rowsCommitted)} rows`;
    default:
      return null;
  }
}

/**
 * A materialization in a list: its state's shape, its name, what its state says, and its one fact.
 * With `wide`, what it reads and where it writes, between them, where there is room.
 */
export function MaterializationRow({ item, showDomain, wide = false }: { item: DomainMaterialization; showDomain: boolean; wide?: boolean }): ReactNode {
  const status = itemStatus(item);
  const fact = rowFact(item, status);
  return (
    <Link
      to={domainPath(item.domain, `/materializations/${encodeURIComponent(item.materialization_id)}`)}
      data-row
      className="flex min-h-14 items-center gap-3 px-4 py-2.5 transition-colors outline-none hover:bg-[var(--color-raised)] focus-visible:bg-[var(--color-raised)] sm:px-5"
    >
      <StatusGlyph status={status} progress={item.catchUp} size={14} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-[14px] font-medium">
          <span className="truncate">{displayName(item)}</span>
          {showDomain ? <DomainChip name={item.domainName} id={item.domain} /> : null}
        </p>
        <p className="truncate text-[12px] text-[var(--color-ink-muted)]">
          {status.label}
          {status.reason ? ` · ${status.reason}` : ''}
        </p>
      </div>
      {wide ? (
        <p className="hidden min-w-0 flex-1 truncate text-[12px] text-[var(--color-ink-muted)] lg:block" title={[...item.source_topics, ...item.tables].join('\n')}>
          <span className="ident">{item.source_topics.slice(0, 2).join(', ')}</span>
          {item.source_topics.length > 2 ? ` and ${item.source_topics.length - 2} more` : null}
          {item.datasets?.length ? <span className="text-[var(--color-ink-faint)]"> → {item.datasets.join(', ')}</span> : null}
        </p>
      ) : null}
      {fact ? <FactPill kind={status.kind}>{fact}</FactPill> : null}
    </Link>
  );
}
