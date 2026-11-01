import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

/**
 * Words for something under way, with a light passing across them while it is: the console is
 * working, not stuck. The words themselves still say what is happening; under reduced motion they
 * are all that is left.
 */
export function Shimmer({ active = true, children, className }: { active?: boolean; children: ReactNode; className?: string }): ReactNode {
  return <span className={cn(active && 'shimmer', className)}>{children}</span>;
}
