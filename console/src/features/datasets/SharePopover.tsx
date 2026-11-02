import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, Users } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { Avatar } from '@/components/Avatar';
import { Popover } from '@/components/ui/Popover';
import { useToast } from '@/components/ui/Toast';
import { Button, Select, Skeleton } from '@/components/ui/primitives';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/domains';
import type { CpDatasetGrant, CpDatasetGrantList } from '@shared/types';

import { datasetKey } from './DatasetPage';
import { useRefreshDatasets } from './useDatasets';

type GrantRole = CpDatasetGrantList['roles'][number];

/** The built-in dataset roles first, each a step up from the last, then any custom ones. */
const ROLE_ORDER = ['dataset-reader', 'dataset-writer', 'dataset-owner'];

/** What each built-in role allows, in one sentence: what the person chooses between. */
const ROLE_SENTENCES: Record<string, string> = {
  'dataset-reader': 'sees its schemas, queries and exports its tables, and reads them through the catalog.',
  'dataset-writer': 'also adds tables to it and drops them.',
  'dataset-owner': 'also changes the dataset and who can use it.',
};

function sortRoles(roles: readonly GrantRole[]): GrantRole[] {
  const rank = (role: GrantRole): number => {
    const index = ROLE_ORDER.indexOf(role.role_id);
    return index < 0 ? ROLE_ORDER.length : index;
  };
  return [...roles].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** A role in one sentence: a built-in's own, a custom one's by what it holds. */
function sentence(role: GrantRole): string {
  return ROLE_SENTENCES[role.role_id] ?? `${role.permissions.length} ${role.permissions.length === 1 ? 'permission' : 'permissions'} on it.`;
}

/**
 * Who can use a dataset, shared the way a document is (docs/10-design-system.md §10.10, Share):
 * the people and groups with a role on it, each role in one sentence, a way to add someone, and
 * what access does not cover. Its owners grant roles they hold on it themselves; a role on a group
 * reaches everyone in it.
 */
export function SharePopover({ dataset, defaultOpen = false }: { dataset: string; defaultOpen?: boolean }): ReactNode {
  return (
    <Popover
      align="end"
      width={440}
      defaultOpen={defaultOpen}
      trigger={({ open, toggle, id }) => (
        <Button variant="primary" onClick={toggle} aria-expanded={open} aria-controls={id}>
          <Users className="size-4" />
          Share
        </Button>
      )}
    >
      {() => <ShareContent dataset={dataset} />}
    </Popover>
  );
}

function ShareContent({ dataset }: { dataset: string }): ReactNode {
  const api = useApi();
  const queryClient = useQueryClient();
  const refreshDatasets = useRefreshDatasets();
  const { reload } = useAuth();
  const toast = useToast();
  const grants = useQuery({ queryKey: ['dataset-grants', dataset], queryFn: () => api.datasetGrants(dataset), retry: 0 });

  const save = useMutation({
    mutationFn: (input: { principalId: string; principalType: 'user' | 'group'; roleIds: string[]; name: string }) =>
      api.setDatasetGrant(dataset, input.principalId, { role_ids: input.roleIds, principal_type: input.principalType }),
    onSuccess: async (_result, input) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dataset-grants', dataset] }),
        queryClient.invalidateQueries({ queryKey: datasetKey(dataset) }),
        refreshDatasets(),
        // What the person may do themselves may have changed with it.
        reload(),
      ]);
      toast.success(input.roleIds.length ? `Shared with ${input.name}` : `${input.name} no longer has access`, dataset);
    },
    onError: (failure: unknown) => toast.error('Could not change who can use it', failure instanceof ApiError ? failure.message : 'Try again in a moment.'),
  });

  if (grants.isPending) {
    return (
      <div className="space-y-2 p-4">
        <Skeleton className="h-6" />
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    );
  }
  if (grants.isError || !grants.data) {
    return (
      <p className="p-4 text-[13px] text-[var(--color-ink-muted)]">
        Who can use it could not be read. {grants.error instanceof ApiError ? grants.error.message : 'Try again in a moment.'}
      </p>
    );
  }
  const list = grants.data;
  const roles = sortRoles(list.roles);
  const change = (grant: Pick<CpDatasetGrant, 'principal_id' | 'principal_type' | 'name'>, roleIds: string[]): void =>
    save.mutate({ principalId: grant.principal_id, principalType: grant.principal_type, roleIds, name: grant.name });

  return (
    <div>
      <header className="px-4 pt-4 pb-3">
        <h2 className="text-[15px] font-semibold">
          Share <span className="ident">{dataset}</span>
        </h2>
      </header>
      <AddPerson list={list} roles={roles} pending={save.isPending} onAdd={(input) => save.mutate(input)} />
      {list.grants.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-[var(--color-ink-muted)]">Only people whose roles reach every dataset can use it.</p>
      ) : (
        <ul className="max-h-[280px] overflow-y-auto px-2 py-2">
          {list.grants.map((grant) => (
            <GrantRow key={`${grant.principal_type}:${grant.principal_id}`} grant={grant} roles={roles} onChange={(roleIds) => change(grant, roleIds)} />
          ))}
        </ul>
      )}
      <dl className="space-y-1 border-t border-[var(--color-line)] px-4 py-3 text-[12px] text-[var(--color-ink-muted)]">
        {roles.map((role) => (
          <div key={role.role_id}>
            <dt className="inline font-medium text-[var(--color-ink)]">{role.name}</dt> <dd className="inline">{sentence(role)}</dd>
          </div>
        ))}
      </dl>
      <p className="flex items-start gap-2 border-t border-[var(--color-line)] px-4 py-3 text-[12px] leading-relaxed text-[var(--color-ink-muted)]">
        <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          Midstream checks access, not the storage: anyone with a key that reads the bucket reads every table in it. Table names are not secret.
        </span>
      </p>
    </div>
  );
}

/** A role, or the roles together when someone holds several, as the choice of a select. */
function roleValue(roleIds: readonly string[]): string {
  return [...roleIds].sort().join('+');
}

function GrantRow({ grant, roles, onChange }: { grant: CpDatasetGrant; roles: GrantRole[]; onChange: (roleIds: string[]) => void }): ReactNode {
  // A role the person cannot grant cannot be taken away by them either.
  const changeable = grant.role_ids.every((roleId) => roles.find((role) => role.role_id === roleId)?.grantable ?? false);
  const several = grant.role_ids.length > 1;
  return (
    <li className="flex items-center gap-3 rounded-[var(--radius-control)] px-2 py-1.5">
      {grant.principal_type === 'group' ? (
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--color-raised)] text-[var(--color-ink-muted)]" aria-label="group">
          <Users className="size-3.5" />
        </span>
      ) : (
        <Avatar name={grant.name} email={grant.email} size="sm" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{grant.name}</span>
        <span className="block truncate text-[12px] text-[var(--color-ink-faint)]">
          {grant.principal_type === 'group' ? 'Group' : grant.invited ? `Invited · ${grant.email}` : grant.email}
        </span>
      </span>
      {changeable ? (
        <Select
          value={roleValue(grant.role_ids)}
          onChange={(event) => onChange(event.target.value === '' ? [] : event.target.value.split('+'))}
          aria-label={`${grant.name}’s role`}
          className="h-8 w-auto shrink-0 text-[12px]"
        >
          {several ? <option value={roleValue(grant.role_ids)}>{grant.roles.map((role) => role.name).join(' + ')}</option> : null}
          {roles.map((role) => (
            <option key={role.role_id} value={role.role_id} disabled={!role.grantable}>
              {role.name}
            </option>
          ))}
          <option value="">Remove access</option>
        </Select>
      ) : (
        <span className="shrink-0 text-[12px] text-[var(--color-ink-muted)]" title="It holds a role you cannot grant on this dataset">
          {grant.roles.map((role) => role.name).join(' + ')}
        </span>
      )}
    </li>
  );
}

/** Add a person or group, with a role: Reader unless chosen otherwise. */
function AddPerson({
  list,
  roles,
  pending,
  onAdd,
}: {
  list: CpDatasetGrantList;
  roles: GrantRole[];
  pending: boolean;
  onAdd: (input: { principalId: string; principalType: 'user' | 'group'; roleIds: string[]; name: string }) => void;
}): ReactNode {
  const granted = new Set(list.grants.map((grant) => `${grant.principal_type}:${grant.principal_id}`));
  const groups = list.candidates.groups.filter((group) => !granted.has(`group:${group.group_id}`));
  const users = list.candidates.users.filter((user) => !granted.has(`user:${user.user_id}`));
  const grantable = roles.filter((role) => role.grantable);
  const [principal, setPrincipal] = useState('');
  const [role, setRole] = useState(grantable.find((candidate) => candidate.role_id === 'dataset-reader')?.role_id ?? grantable[0]?.role_id ?? '');
  if ((groups.length === 0 && users.length === 0) || grantable.length === 0) return null;
  const [type, id] = principal.split(':') as ['user' | 'group' | '', string | undefined];
  const name = type === 'group' ? groups.find((group) => group.group_id === id)?.name : users.find((user) => user.user_id === id)?.name;

  return (
    <div className="flex flex-wrap items-center gap-2 border-y border-[var(--color-line)] bg-[var(--color-raised)] px-4 py-3">
      <Select value={principal} onChange={(event) => setPrincipal(event.target.value)} className="h-8 min-w-0 flex-1 text-[13px]" aria-label="Person or group">
        <option value="">Add a person or group</option>
        {groups.length > 0 ? (
          <optgroup label="Groups">
            {groups.map((group) => (
              <option key={group.group_id} value={`group:${group.group_id}`}>
                {group.name}
              </option>
            ))}
          </optgroup>
        ) : null}
        {users.length > 0 ? (
          <optgroup label="People">
            {users.map((user) => (
              <option key={user.user_id} value={`user:${user.user_id}`}>
                {/* An invitation nobody named is its email alone; it is shared before they join. */}
                {user.name === user.email ? user.email : `${user.name} · ${user.email}`}
                {user.invited ? ' (invited)' : ''}
              </option>
            ))}
          </optgroup>
        ) : null}
      </Select>
      <Select value={role} onChange={(event) => setRole(event.target.value)} className="h-8 w-auto text-[12px]" aria-label="Role">
        {grantable.map((candidate) => (
          <option key={candidate.role_id} value={candidate.role_id}>
            {candidate.name}
          </option>
        ))}
      </Select>
      <Button
        size="sm"
        variant="primary"
        disabled={!type || !id || !role}
        loading={pending}
        onClick={() => {
          if (!type || !id || !role) return;
          onAdd({ principalId: id, principalType: type, roleIds: [role], name: name ?? id });
          setPrincipal('');
        }}
      >
        Share
      </Button>
    </div>
  );
}
