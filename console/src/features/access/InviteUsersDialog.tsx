import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { GroupPicker } from './GroupPicker';
import { errorField, invitationLink, joinWays, orList, useIdentityChange } from './shared';
import { parseEmails, refusalDetails } from './logic';
import { CopyButton } from '@/components/Inline';
import { Dialog } from '@/components/ui/Dialog';
import { Button, Field, Textarea } from '@/components/ui/primitives';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi, useDomain } from '@/lib/domains';
import type { CpInvitationProblem, InvitationsResult } from '@shared/types';

/**
 * Invite people by email (handbook 18 §18.18): an invited account each, holding the groups chosen
 * here, which its person has from their first sign-in - through a provider with the invited email,
 * or with the link this shows once, after the invitations are made.
 */
export function InviteUsersDialog({ open, onClose, onInvited }: { open: boolean; onClose: () => void; onInvited: () => void }): ReactNode {
  const api = useApi();
  const auth = useAuth();
  const domain = useDomain();
  const [text, setText] = useState('');
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [made, setMade] = useState<InvitationsResult | null>(null);
  const parsed = useMemo(() => parseEmails(text), [text]);
  const ways = joinWays(auth.state?.providers ?? []);

  // The dialog says how it went - the links, or what was refused - so no toast repeats it.
  const invite = useIdentityChange((input: { emails: string[]; group_ids: string[] }) => api.inviteUsers(input), {
    success: (input) => (input.emails.length === 1 ? `${input.emails[0]} invited` : `${input.emails.length} people invited`),
    failure: 'Nobody was invited',
    quiet: true,
    onApplied: (result) => {
      setMade(result);
      onInvited();
    },
  });
  const { reset } = invite;

  useEffect(() => {
    if (!open) return;
    setText('');
    setGroupIds([]);
    setMade(null);
    reset();
  }, [open, reset]);

  const problems = problemsOf(invite.error);
  const refused = new Set(problems.flatMap((problem) => (problem.email ? [problem.email] : [])));
  // A refusal about something else than the emails - the groups, the session - said as it came.
  const refusal = invite.error && problems.length === 0 && errorField(invite.error) !== 'emails' ? (invite.error as Error).message : null;
  const count = parsed.emails.length;
  const ready = count > 0 && parsed.invalid.length === 0;
  const submit = (): void => {
    if (ready) invite.mutate({ emails: parsed.emails, group_ids: groupIds });
  };

  if (made) {
    return (
      <Dialog
        open={open}
        onClose={onClose}
        title={made.invitations.length === 1 ? `${made.invitations[0]?.email} is invited` : `${made.invitations.length} people are invited`}
        size="lg"
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <InvitationLinks result={made} domain={domain.id} providers={ways.providers} />
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Invite people"
      description="Each person has the groups you choose from their first sign-in with the invited email."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={invite.isPending} disabled={!ready} onClick={submit}>
            {count > 1 ? `Invite ${count} people` : 'Invite'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field
          label="Emails"
          required
          error={
            parsed.invalid.length > 0
              ? `Not ${parsed.invalid.length === 1 ? 'an email' : 'emails'}: ${parsed.invalid.join(', ')}`
              : problems.length === 0 && errorField(invite.error) === 'emails'
                ? (invite.error as Error).message
                : null
          }
          hint="Separate them with commas, spaces or new lines."
        >
          <Textarea
            autoFocus
            rows={4}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              if (invite.error) reset();
            }}
            placeholder="ada@example.com, grace@example.com"
            spellCheck={false}
            autoComplete="off"
            className="font-sans text-sm"
          />
        </Field>
        {problems.length > 0 || refusal ? (
          <div role="alert" className="space-y-2 rounded-[var(--radius-control)] bg-[var(--color-flare-wash)] px-3 py-2.5 text-[13px]">
            <ul className="space-y-1">
              {problems.map((problem) => (
                <li key={`${problem.index}-${problem.email}`}>{problem.message}</li>
              ))}
              {refusal ? <li>{refusal}</li> : null}
            </ul>
            {refused.size > 0 ? (
              <Button
                size="sm"
                type="button"
                onClick={() => {
                  setText(parsed.emails.filter((email) => !refused.has(email)).join('\n'));
                  reset();
                }}
              >
                Remove {refused.size === 1 ? 'it' : 'them'} and invite the rest
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="space-y-1.5">
          <span className="text-[13px] font-medium">Groups</span>
          <GroupPicker value={groupIds} onChange={setGroupIds} />
        </div>
        <p className="text-[12px] text-[var(--color-ink-muted)]">{joinSentence(ways)}</p>
      </form>
    </Dialog>
  );
}

/** Each invitation made, with its link to send: shown this once, since only its hash is kept. */
function InvitationLinks({ result, domain, providers }: { result: InvitationsResult; domain: string; providers: string[] }): ReactNode {
  const links = result.invitations.flatMap((item) => (item.link ? [{ ...item, url: invitationLink(window.location.origin, domain, item.link) }] : []));
  const expires = links[0]?.link_expires_at;
  if (links.length === 0) {
    return (
      <p className="text-[13px] text-[var(--color-ink-muted)]">
        {providers.length > 0
          ? `They join by signing in through ${orList(providers)} with the invited email.`
          : 'They join once password sign-in is on, or a sign-in provider is: ask an administrator.'}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-[var(--color-ink-muted)]">
        Send each person their link, privately: whoever has it can join as them
        {expires ? ` until ${new Date(expires).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}. The links are
        not shown again{providers.length > 0 ? `, and they can also join by signing in through ${orList(providers)} with the invited email` : ''}.
      </p>
      <ul className="divide-y divide-[var(--color-line)] overflow-hidden rounded-[var(--radius-control)] border border-[var(--color-line-strong)]">
        {links.map((item) => (
          <li key={item.user_id} className="flex items-center gap-3 px-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{item.email}</span>
              <span className="ident block truncate text-[12px] text-[var(--color-ink-muted)]" title={item.url}>
                {item.url}
              </span>
            </span>
            <CopyButton value={item.url} label={`Copy the link for ${item.email}`} className="h-8 px-2" />
          </li>
        ))}
      </ul>
      {links.length > 1 ? (
        <div className="flex justify-end">
          <CopyAllButton value={links.map((item) => `${item.email}\t${item.url}`).join('\n')} />
        </div>
      ) : null}
    </div>
  );
}

function CopyAllButton({ value }: { value: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button size="sm" type="button" onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))}>
      {copied ? 'Copied' : 'Copy every email and link'}
    </Button>
  );
}

/** How the people invited here will join, in this domain. */
function joinSentence(ways: { providers: string[]; links: boolean }): string {
  const through = ways.providers.length > 0 ? `signing in through ${orList(ways.providers)} with that email` : '';
  if (through && ways.links) return `They join by ${through}, or with the link each one gets here.`;
  if (through) return `They join by ${through}.`;
  if (ways.links) return 'They join with the link each one gets here, choosing their own password.';
  return 'Nobody can join yet: this domain takes no sign-in provider, and only administrators may use a password.';
}

/** What the control plane said was wrong with each email, when it refused them. */
function problemsOf(error: unknown): CpInvitationProblem[] {
  if (!(error instanceof ApiError)) return [];
  const problems = refusalDetails(error.details).problems;
  return Array.isArray(problems) ? (problems as CpInvitationProblem[]) : [];
}
