import { useQuery } from '@tanstack/react-query';
import { KeyRound, Link2, LogOut, MailX, Trash2, Unlock, UserCheck, UserX } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { usePasswordMinimum } from '../auth/ChangePasswordForm';
import { PasswordInput } from '../auth/PasswordInput';
import { ConfirmDialog } from './ConfirmDialog';
import { DatasetGrantsPanel } from './DatasetGrantsPanel';
import { GroupPicker } from './GroupPicker';
import { SessionList } from './SessionList';
import {
  BackLink,
  UserStatusBadges,
  errorField,
  formatDate,
  generatePassword,
  invitationLink,
  joinWays,
  linkExpired,
  orList,
  permissionMap,
  useCatalog,
  useIdentityChange,
} from './shared';
import { Avatar } from '@/components/Avatar';
import { CopyButton, RelativeTime } from '@/components/Inline';
import { Dialog } from '@/components/ui/Dialog';
import { Button, EmptyState, Field, Input, Panel, PanelHeader, Skeleton } from '@/components/ui/primitives';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useApi, useDomain, useDomainPath } from '@/lib/domains';
import type { CpPermissionCatalog, CpUserDetail, InvitationLinkResult } from '@shared/types';

type Confirm = 'sign-out' | 'deactivate' | 'reactivate' | 'delete' | 'revoke' | null;

/** One person's account: who they are, their groups, what they may do and why, and their sessions. */
export function UserDetail({ userId }: { userId: string }): ReactNode {
  const domainPath = useDomainPath();
  const api = useApi();
  const auth = useAuth();
  const navigate = useNavigate();
  const user = useQuery({ queryKey: ['user', userId], queryFn: () => api.user(userId) });
  const catalog = useCatalog();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [resetting, setResetting] = useState(false);
  const [linking, setLinking] = useState(false);

  const detail = user.data;
  const invited = detail?.status === 'invited';
  // An invitation is changed by whoever may invite; anyone else's account needs Manage users.
  const canManage = auth.can(invited ? 'users.invite' : 'users.manage') && Boolean(detail?.manageable);
  const name = detail?.display_name ?? 'this user';
  const links = joinWays(auth.state?.providers ?? []).links;

  const signOut = useIdentityChange((sessionId: string | undefined) => api.signOutUser(userId, sessionId), {
    success: (sessionId) => (sessionId ? 'Session signed out' : `${name} was signed out everywhere`),
    failure: 'Signing out failed',
    onApplied: () => setConfirm(null),
  });
  const unlock = useIdentityChange(() => api.unlockUser(userId), {
    success: () => `${name} can sign in again`,
    failure: 'The account was not unlocked',
  });
  const setStatus = useIdentityChange(
    (status: 'active' | 'deactivated') => api.updateUser(userId, { status, base_revision: detail?.revision }),
    {
      success: (status) => (status === 'deactivated' ? `${name} was deactivated` : `${name} was reactivated`),
      failure: 'The account was not changed',
      onApplied: () => setConfirm(null),
    },
  );
  const remove = useIdentityChange(() => api.deleteUser(userId), {
    success: () => (invited ? `The invitation for ${detail?.email ?? name} was revoked` : `${name} was deleted`),
    failure: invited ? 'The invitation was not revoked' : 'The account was not deleted',
    onApplied: () => navigate(domainPath('/settings/users')),
  });

  if (user.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-16" />
        <Skeleton className="h-48" />
      </div>
    );
  }
  if (user.error || !detail) {
    return (
      <div className="space-y-4">
        <BackLink to={domainPath('/settings/users')}>All users</BackLink>
        <Panel>
          <EmptyState
            title="This user could not be loaded"
            description={user.error instanceof Error ? user.error.message : 'They may have been deleted.'}
          />
        </Panel>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <BackLink to={domainPath('/settings/users')}>All users</BackLink>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <Avatar name={detail.display_name !== detail.email ? detail.display_name : ''} email={detail.email} size="lg" muted={detail.status !== 'active'} />
          <div className="min-w-0">
            <h2 className="truncate text-[17px] font-semibold tracking-tight">{detail.display_name}</h2>
            {detail.display_name !== detail.email ? <p className="truncate text-[13px] text-[var(--color-ink-muted)]">{detail.email}</p> : null}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <UserStatusBadges user={detail} />
            </div>
          </div>
        </div>
        {canManage && invited ? (
          <div className="flex flex-wrap gap-2">
            {links ? (
              <Button size="sm" onClick={() => setLinking(true)}>
                <Link2 className="size-3.5" />
                New link
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => setConfirm('revoke')}>
              <MailX className="size-3.5" />
              Revoke invitation
            </Button>
          </div>
        ) : canManage ? (
          <div className="flex flex-wrap gap-2">
            {detail.locked_until ? (
              <Button size="sm" loading={unlock.isPending} onClick={() => unlock.mutate(undefined)}>
                <Unlock className="size-3.5" />
                Unlock
              </Button>
            ) : null}
            {detail.status === 'active' && !detail.self ? (
              <Button size="sm" onClick={() => setResetting(true)}>
                <KeyRound className="size-3.5" />
                Reset password
              </Button>
            ) : null}
            {detail.status === 'active' ? (
              <Button size="sm" onClick={() => setConfirm('sign-out')}>
                <LogOut className="size-3.5" />
                Sign out everywhere
              </Button>
            ) : null}
            {detail.status === 'active' && !detail.self ? (
              <Button size="sm" variant="ghost" onClick={() => setConfirm('deactivate')}>
                <UserX className="size-3.5" />
                Deactivate
              </Button>
            ) : null}
            {detail.status === 'deactivated' ? (
              <>
                <Button size="sm" onClick={() => setConfirm('reactivate')}>
                  <UserCheck className="size-3.5" />
                  Reactivate
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirm('delete')}>
                  <Trash2 className="size-3.5" />
                  Delete
                </Button>
              </>
            ) : null}
          </div>
        ) : auth.can(invited ? 'users.invite' : 'users.manage') ? (
          <p className="max-w-xs text-[12px] text-[var(--color-ink-muted)]">
            {invited
              ? `This invitation holds access you do not hold, so you cannot change it.`
              : `${detail.display_name} has access you do not hold, so you cannot change their account.`}
          </p>
        ) : null}
      </div>

      {invited ? <InvitationPanel user={detail} /> : null}
      <ProfilePanel user={detail} editable={canManage} />
      <GroupsPanel user={detail} editable={canManage} />
      <AccessPanel user={detail} catalog={catalog.data} />
      <DatasetGrantsPanel grants={detail.dataset_grants ?? []} subject="user" />

      {invited ? (
        <>
          <NewLinkDialog open={linking} onClose={() => setLinking(false)} user={detail} />
          <ConfirmDialog
            open={confirm === 'revoke'}
            title={`Revoke the invitation for ${detail.email}?`}
            description="Its account is deleted with its groups and dataset roles, and its link stops working. You can invite them again."
            confirmLabel="Revoke invitation"
            danger
            pending={remove.isPending}
            onConfirm={() => remove.mutate(undefined)}
            onClose={() => setConfirm(null)}
          />
        </>
      ) : (
        // What only someone who has signed in has: their sessions, their activity, and the dialogs about them.
        <>
          <Panel>
            <PanelHeader
              title="Sessions"
              description="Browsers and scripts signed in as this person. Deactivating them or resetting their password ends every one."
            />
            <SessionList
              sessions={detail.sessions}
              onSignOut={canManage ? (sessionId) => signOut.mutate(sessionId) : undefined}
              pending={signOut.isPending}
            />
          </Panel>

          <Panel>
            <PanelHeader title="Activity" />
            <dl className="grid gap-4 px-5 py-4 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
              <Fact label="Last active">
                <RelativeTime value={detail.last_active_at} />
              </Fact>
              <Fact label="Last signed in">
                <RelativeTime value={detail.last_sign_in_at} />
              </Fact>
              <Fact label="Failed sign-ins">{detail.failed_sign_ins === 0 ? 'None' : detail.failed_sign_ins}</Fact>
              <Fact label="Added">
                {formatDate(detail.created_at)}
                <span className="block text-[12px] text-[var(--color-ink-muted)]">by {detail.created_by}</span>
              </Fact>
            </dl>
          </Panel>

          <ResetPasswordDialog open={resetting} onClose={() => setResetting(false)} user={detail} />
          <ConfirmDialog
            open={confirm === 'sign-out'}
            title={`Sign ${detail.display_name} out everywhere?`}
            description="Every browser and script signed in as them is signed out at its next request. They can sign in again at once."
            confirmLabel="Sign out everywhere"
            pending={signOut.isPending}
            onConfirm={() => signOut.mutate(undefined)}
            onClose={() => setConfirm(null)}
          />
          <ConfirmDialog
            open={confirm === 'deactivate'}
            title={`Deactivate ${detail.display_name}?`}
            description="They are signed out everywhere and cannot sign in until they are reactivated. Their groups are kept."
            confirmLabel="Deactivate"
            danger
            pending={setStatus.isPending}
            onConfirm={() => setStatus.mutate('deactivated')}
            onClose={() => setConfirm(null)}
          />
          <ConfirmDialog
            open={confirm === 'reactivate'}
            title={`Reactivate ${detail.display_name}?`}
            description="They can sign in again with their password, and have the access their groups give."
            confirmLabel="Reactivate"
            pending={setStatus.isPending}
            onConfirm={() => setStatus.mutate('active')}
            onClose={() => setConfirm(null)}
          />
          <ConfirmDialog
            open={confirm === 'delete'}
            title={`Delete ${detail.display_name}?`}
            description="Their account, sessions and activity are removed, and their email can be used for a new account. The audit log keeps what they did. This cannot be undone."
            confirmLabel="Delete"
            danger
            pending={remove.isPending}
            onConfirm={() => remove.mutate(undefined)}
            onClose={() => setConfirm(null)}
          />
        </>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] font-medium text-[var(--color-ink-faint)]">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}

function ProfilePanel({ user, editable }: { user: CpUserDetail; editable: boolean }): ReactNode {
  const api = useApi();
  const invited = user.status === 'invited';
  const [draft, setDraft] = useState({ first_name: user.first_name, last_name: user.last_name, email: user.email });
  useEffect(() => setDraft({ first_name: user.first_name, last_name: user.last_name, email: user.email }), [user]);
  // Only what changed: an invitation nobody named keeps its names empty until someone gives them.
  const changes = Object.fromEntries(
    (['first_name', 'last_name', 'email'] as const).filter((key) => draft[key].trim() !== user[key]).map((key) => [key, draft[key].trim()]),
  );
  const save = useIdentityChange(() => api.updateUser(user.user_id, { ...changes, base_revision: user.revision }), {
    success: () => 'Profile saved',
    failure: 'The profile was not saved',
  });
  const changed = Object.keys(changes).length > 0;
  const field = errorField(save.error);
  const error = (name: string): string | null => (field === name ? (save.error as Error).message : null);

  return (
    <Panel>
      <PanelHeader
        title="Profile"
        description={
          user.self
            ? 'Your name and the email you sign in with.'
            : invited
              ? 'Their name, if you know it - otherwise they give it when they accept - and the email they are invited with.'
              : 'Their name and the email they sign in with.'
        }
      />
      <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
        <Field label="First name" error={error('first_name')}>
          <Input value={draft.first_name} disabled={!editable} onChange={(event) => setDraft({ ...draft, first_name: event.target.value })} />
        </Field>
        <Field label="Last name" error={error('last_name')}>
          <Input value={draft.last_name} disabled={!editable} onChange={(event) => setDraft({ ...draft, last_name: event.target.value })} />
        </Field>
        <div className="sm:col-span-2">
          <Field
            label="Email"
            error={error('email')}
            hint={invited ? 'The invitation is accepted by signing in with this email.' : 'Changing it changes what they sign in with.'}
          >
            <Input type="email" value={draft.email} disabled={!editable} onChange={(event) => setDraft({ ...draft, email: event.target.value })} />
          </Field>
        </div>
      </div>
      {editable ? (
        <div className="flex justify-end gap-2 border-t border-[var(--color-line)] px-5 py-3">
          <Button
            size="sm"
            variant="ghost"
            disabled={!changed}
            onClick={() => setDraft({ first_name: user.first_name, last_name: user.last_name, email: user.email })}
          >
            Undo
          </Button>
          <Button size="sm" variant="primary" disabled={!changed} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Save profile
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}

/** How an invitation is accepted here, and its link: when it stops working, or that it has. */
function InvitationPanel({ user }: { user: CpUserDetail }): ReactNode {
  const auth = useAuth();
  const ways = joinWays(auth.state?.providers ?? []);
  const invitation = user.invitation;
  const expires = invitation?.link_expires_at ?? null;
  const day = (value: string): string => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return (
    <Panel>
      <PanelHeader
        title="Invitation"
        description={invitation ? `Invited by ${invitation.invited_by} on ${day(invitation.invited_at)}. Their access is theirs from their first sign-in.` : undefined}
      />
      <ul className="space-y-1.5 px-5 py-4 text-[13px]">
        {ways.providers.length > 0 ? (
          <li>
            They accept it by signing in through {orList(ways.providers)} with <span className="font-medium">{user.email}</span>.
          </li>
        ) : null}
        <li className={cn(!expires && 'text-[var(--color-ink-muted)]')}>
          {expires
            ? linkExpired(invitation)
              ? `Their link to choose a password expired on ${day(expires)}.${ways.links ? ' Make a new one to send them.' : ''}`
              : `${ways.providers.length > 0 ? 'Or they open' : 'They open'} their link to choose a password. It works until ${day(expires)}.`
            : ways.links
              ? 'It has no link to choose a password: make one to send them.'
              : 'It has no link: password sign-in is off here.'}
        </li>
      </ul>
    </Panel>
  );
}

/** Make an invitation a new link, saying first that the one before stops working; then show it, once. */
function NewLinkDialog({ open, onClose, user }: { open: boolean; onClose: () => void; user: CpUserDetail }): ReactNode {
  const api = useApi();
  const domain = useDomain();
  const [made, setMade] = useState<InvitationLinkResult | null>(null);
  const renew = useIdentityChange(() => api.renewInvitation(user.user_id), {
    success: () => `A new link for ${user.email}`,
    failure: 'No new link was made',
    quiet: true,
    onApplied: (result) => setMade(result),
  });
  const { reset } = renew;
  useEffect(() => {
    if (!open) return;
    setMade(null);
    reset();
  }, [open, reset]);
  const url = made ? invitationLink(window.location.origin, domain.id, made.link) : null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={made ? `A new link for ${user.email}` : `Make a new link for ${user.email}?`}
      description={
        made
          ? `Send it to them privately: whoever has it can join as them until ${new Date(made.link_expires_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}. It is not shown again.`
          : 'The link sent before stops working. The new one is shown once.'
      }
      footer={
        made ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" loading={renew.isPending} onClick={() => renew.mutate(undefined)}>
              Make a new link
            </Button>
          </>
        )
      }
    >
      {url ? (
        <div className="flex items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-line-strong)] px-3 py-2">
          <span className="ident min-w-0 flex-1 truncate text-[12px]" title={url}>
            {url}
          </span>
          <CopyButton value={url} label={`Copy the link for ${user.email}`} className="h-8 px-2" />
        </div>
      ) : renew.error ? (
        <p role="alert" className="rounded-[var(--radius-control)] bg-[var(--color-flare-wash)] px-3 py-2.5 text-[13px]">
          {(renew.error as Error).message}
        </p>
      ) : null}
    </Dialog>
  );
}

function GroupsPanel({ user, editable }: { user: CpUserDetail; editable: boolean }): ReactNode {
  const api = useApi();
  const current = useMemo(() => user.groups.map((group) => group.group_id), [user.groups]);
  const [draft, setDraft] = useState<string[]>(current);
  useEffect(() => setDraft(current), [current]);
  const save = useIdentityChange(() => api.updateUser(user.user_id, { group_ids: draft, base_revision: user.revision }), {
    success: () => 'Groups saved',
    failure: 'The groups were not saved',
  });
  const changed = draft.length !== current.length || draft.some((id) => !current.includes(id));

  return (
    <Panel>
      <PanelHeader title="Groups" description="Groups give roles, and roles give permissions. Everyone signed in is in All Users." />
      <div className="px-5 py-4">
        {editable ? (
          <GroupPicker value={draft} onChange={setDraft} />
        ) : (
          <ul className="space-y-1.5 text-[13px]">
            {user.memberships.map((membership) => (
              <li key={membership.group_id} className="flex items-center gap-2">
                <span className="font-medium">{membership.name}</span>
                {membership.automatic ? <span className="text-[12px] text-[var(--color-ink-faint)]">automatic</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      {editable ? (
        <div className="flex justify-end gap-2 border-t border-[var(--color-line)] px-5 py-3">
          <Button size="sm" variant="ghost" disabled={!changed} onClick={() => setDraft(current)}>
            Undo
          </Button>
          <Button size="sm" variant="primary" disabled={!changed} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Save groups
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}

/** What the person may do, by category, each permission with the groups and roles it comes through. */
export function AccessPanel({ user, catalog }: { user: Pick<CpUserDetail, 'permissions' | 'all_permissions' | 'display_name' | 'self'>; catalog: CpPermissionCatalog | undefined }): ReactNode {
  const byKey = permissionMap(catalog);
  const held = new Map(user.permissions.map((item) => [item.key, item.via]));
  return (
    <Panel>
      <PanelHeader
        title="Access"
        description={
          user.all_permissions
            ? 'Every permission, including ones added later, through the Administrator role.'
            : 'What their groups allow, and where each permission comes from.'
        }
      />
      {held.size === 0 ? (
        <p className="px-5 py-4 text-[13px] text-[var(--color-ink-muted)]">No permissions beyond what everyone has.</p>
      ) : (
        <div className="divide-y divide-[var(--color-line)]">
          {(catalog?.categories ?? []).map((category) => {
            const rows = (catalog?.permissions ?? []).filter((permission) => permission.category === category.id && held.has(permission.key));
            if (rows.length === 0) return null;
            return (
              <div key={category.id} className="px-5 py-3">
                <p className="mb-1.5 text-[12px] font-medium text-[var(--color-ink-faint)]">{category.label}</p>
                <ul className="space-y-1.5">
                  {rows.map((permission) => (
                    <li key={permission.key} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-[13px]">
                      <span title={byKey.get(permission.key)?.description}>{permission.label}</span>
                      <span className="text-[12px] text-[var(--color-ink-muted)]">
                        {[...new Set((held.get(permission.key) ?? []).map((source) => `${source.group} · ${source.role}`))].join(', ')}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function ResetPasswordDialog({ open, onClose, user }: { open: boolean; onClose: () => void; user: CpUserDetail }): ReactNode {
  const api = useApi();
  const minimum = usePasswordMinimum();
  const [password, setPassword] = useState('');
  const reset = useIdentityChange(() => api.setUserPassword(user.user_id, password), {
    success: () => `${user.display_name}'s password was reset`,
    failure: 'The password was not reset',
    onApplied: () => onClose(),
  });
  const { reset: clear } = reset;
  useEffect(() => {
    if (!open) return;
    setPassword(generatePassword());
    clear();
  }, [open, clear]);
  const error = errorField(reset.error) === 'password' ? (reset.error as Error).message : null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Reset ${user.display_name}'s password`}
      description="They are signed out everywhere, and must choose their own password the next time they sign in. A lockout is lifted too."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={reset.isPending} disabled={password.length < minimum} onClick={() => reset.mutate(undefined)}>
            Reset password
          </Button>
        </>
      }
    >
      <Field label="New password" error={error ?? (password && password.length < minimum ? `At least ${minimum} characters` : null)} hint="Share it with them privately.">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <PasswordInput value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" />
          </div>
          <CopyButton value={password} label="Copy password" className="h-9 px-2.5" />
          <Button type="button" size="sm" onClick={() => setPassword(generatePassword())}>
            Generate
          </Button>
        </div>
      </Field>
    </Dialog>
  );
}
