import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { domainStatusText } from '@/lib/domainStatus';
import type { ConsoleDomain } from '@shared/types';

export { domainStatusText } from '@/lib/domainStatus';

/** Which domain something is in, on a page that shows several (handbook 20). */
export function DomainChip({ name, id, className }: { name: string; id?: string; className?: string }): ReactNode {
  return (
    <Badge className={className} title={id ? `Domain ${name} (${id})` : `Domain ${name}`}>
      {name}
    </Badge>
  );
}

/** How a domain is, as a dot: live, reconnecting or unreachable, or not usable at all. */
export function DomainDot({ domain, className }: { domain: Pick<ConsoleDomain, 'status' | 'connected' | 'statusMessage'>; className?: string }): ReactNode {
  const usable = domain.status === 'ok' || domain.status === 'unreachable';
  return (
    <span
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        // Live is Current; reconnecting or unreachable needs attention; not usable has failed.
        domain.status === 'ok' && domain.connected
          ? 'bg-[var(--color-current)]'
          : usable
            ? 'bg-[var(--color-buoy)]'
            : 'bg-[var(--color-flare)]',
        className,
      )}
      title={domainStatusText(domain)}
    />
  );
}
