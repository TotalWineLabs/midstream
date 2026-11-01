import { Plus } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { ChooseDomainDialog } from './ChooseDomainDialog';
import { Button } from '@/components/ui/primitives';
import { useConsoleAuth } from '@/lib/auth';
import { useDomains, useOptionalDomain } from '@/lib/domains';
import type { DomainMaterialization } from '@/lib/fleet';
import { domainPath } from '@/lib/paths';

/**
 * "New materialization": the create page of the page's domain, or - on a page of every domain - of
 * the domain the person chooses first, of those they may create one in (handbook 20). Renders
 * nothing for someone who may create one nowhere.
 */
export function NewMaterialization({
  label = 'New materialization',
}: {
  /** Kept for the callers that pass the fleet; the create page reads it itself. */
  materializations?: readonly DomainMaterialization[] | undefined;
  label?: string;
}): ReactNode {
  const scope = useOptionalDomain();
  const auth = useConsoleAuth();
  const domains = useDomains();
  const navigate = useNavigate();
  const creatable = useMemo(
    () =>
      (scope ? [scope] : domains).filter(
        (domain) => domain.status !== 'misconfigured' && auth.forDomain(domain.id).can('materializations.create'),
      ),
    [auth, domains, scope],
  );
  const [choosing, setChoosing] = useState(false);

  if (creatable.length === 0) return null;
  const open = (domain: string): void => {
    void navigate(domainPath(domain, '/materializations/new'));
  };
  return (
    <>
      <Button variant="primary" onClick={() => (creatable.length === 1 ? open(creatable[0]!.id) : setChoosing(true))}>
        <Plus className="size-4" />
        {label}
      </Button>
      <ChooseDomainDialog
        open={choosing}
        onClose={() => setChoosing(false)}
        domains={creatable}
        onChoose={(domain) => open(domain.id)}
        description="A materialization reads topics of its domain's Kafka cluster and writes tables into its datasets."
      />
    </>
  );
}
