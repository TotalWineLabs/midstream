import { Check } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { GroupPicker } from './GroupPicker';
import { IDENTITY_QUERY_ROOTS, invitationLink, orList } from './shared';
import { andList, joinWaysAcross, parseEmails, refusalDetails, type InvitationEntry } from './logic';
import { CopyButton } from '@/components/Inline';
import { Dialog } from '@/components/ui/Dialog';
import { Button, Field, Textarea } from '@/components/ui/primitives';
import { ApiError, domainApi } from '@/lib/api';
import { useConsoleAuth } from '@/lib/auth';
import { DomainProvider, useDomain, useDomains } from '@/lib/domains';
import { queryClientFor } from '@/lib/queryClient';
import type { ConsoleDomain, CpInvitationMade, CpInvitationProblem } from '@shared/types';

/** What inviting did in one domain. */
interface DomainRun {
  domain: ConsoleDomain;
  /** Each invitation made there, and each one there already, given a new link so one link joins them all. */
  invited: CpInvitationMade[];
  /** The emails invited there already, whose invitations keep their groups. */
  renewed: string[];
  /** Emails it left out: each has an account there already, or an invitation it could not renew. */
  skipped: CpInvitationProblem[];
  /** Why nobody was invited there, when the domain refused the whole request. */
  error: string | null;
}

/**
 * Invite people by email (handbook 18 §18.18): an invited account for each in this domain, and in any
 * other domain chosen where the person inviting may invite, each holding the groups chosen for it
 * there. Its person has them from their first sign-in - through a provider with the invited email,
 * which accepts every domain's invitation at once, or with the one link this shows for them, once.
 */
export function InviteUsersDialog({ open, onClose, onInvited }: { open: boolean; onClose: () => void; onInvited: () => void }): ReactNode {
  const here = useDomain();
  const consoleAuth = useConsoleAuth();
  const served = useDomains();
  // Every domain where they may invite, this one first: all of them unless they choose fewer.
  const invitable = useMemo(
    () => [here, ...served.filter((domain) => domain.id !== here.id && domain.status !== 'misconfigured' && consoleAuth.forDomain(domain.id).can('users.invite'))],
    [here, served, consoleAuth],
  );
  const [text, setText] = useState('');
  const [chosen, setChosen] = useState<string[]>(() => invitable.map((domain) => domain.id));
  const [groups, setGroups] = useState<Record<string, string[]>>({});
  const [sending, setSending] = useState(false);
  const [runs, setRuns] = useState<DomainRun[] | null>(null);
  const parsed = useMemo(() => parseEmails(text), [text]);
  const domains = invitable.filter((domain) => chosen.includes(domain.id));
  const ways = joinWaysAcross(domains.map((domain) => consoleAuth.forDomain(domain.id).state?.providers ?? []));

  useEffect(() => {
    if (!open) return;
    setText('');
    setChosen(invitable.map((domain) => domain.id));
    setGroups({});
    setRuns(null);
    // Chosen afresh each time the dialog opens; not as the session reloads while it is open.
  }, [open]);

  const count = parsed.emails.length;
  const ready = count > 0 && parsed.invalid.length === 0 && domains.length > 0 && !sending;
  const invited = runs?.some((run) => run.invited.length > 0) ?? false;

  const submit = async (): Promise<void> => {
    if (!ready) return;
    setSending(true);
    try {
      const done = await Promise.all(domains.map((domain) => inviteIn(domain, parsed.emails, groups[domain.id] ?? [])));
      // Whatever was invited may change what each domain's pages show.
      for (const domain of domains) {
        for (const root of IDENTITY_QUERY_ROOTS) void queryClientFor(domain.id).invalidateQueries({ queryKey: [root] });
      }
      await consoleAuth.reload();
      setRuns(done);
      if (done.some((run) => run.invited.length > 0)) onInvited();
    } finally {
      setSending(false);
    }
  };

  if (runs && invited) {
    const people = new Set(runs.flatMap((run) => run.invited.map((item) => item.email)));
    return (
      <Dialog
        open={open}
        onClose={onClose}
        title={people.size === 1 ? `${[...people][0]} is invited` : `${people.size} people are invited`}
        size="lg"
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <InvitationLinks runs={runs} emails={parsed.emails} providers={ways.providers} />
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
          <Button variant="primary" loading={sending} disabled={!ready} onClick={() => void submit()}>
            {count > 1 ? `Invite ${count} people` : 'Invite'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field
          label="Emails"
          required
          error={parsed.invalid.length > 0 ? `Not ${parsed.invalid.length === 1 ? 'an email' : 'emails'}: ${parsed.invalid.join(', ')}` : null}
          hint="Separate them with commas, spaces or new lines."
        >
          <Textarea
            autoFocus
            rows={4}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setRuns(null);
            }}
            placeholder="ada@example.com, grace@example.com"
            spellCheck={false}
            autoComplete="off"
            className="font-sans text-sm"
          />
        </Field>
        {runs ? <Refusals runs={runs} /> : null}
        {invitable.length > 1 ? (
          <div className="space-y-1.5">
            <span className="text-[13px] font-medium">Domains</span>
            <div className="flex flex-wrap gap-2">
              {invitable.map((domain) => {
                const on = chosen.includes(domain.id);
                // An invitation is to one domain at least.
                const last = on && domains.length === 1;
                return (
                  <label
                    key={domain.id}
                    title={last ? 'An invitation is to one domain at least' : undefined}
                    className="flex min-h-9 cursor-pointer items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-line-strong)] px-3 text-[13px] has-[:disabled]:cursor-default"
                  >
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--color-primary)]"
                      checked={on}
                      disabled={last}
                      onChange={() => setChosen(on ? chosen.filter((id) => id !== domain.id) : [...chosen, domain.id])}
                    />
                    {domain.name}
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}
        {domains.map((domain) => (
          <div key={domain.id} className="space-y-1.5">
            <span className="text-[13px] font-medium">{invitable.length > 1 ? `Groups in ${domain.name}` : 'Groups'}</span>
            {/* Each domain's groups are its own: picked from its list, with what it lets this person give. */}
            <DomainProvider domain={domain}>
              <GroupPicker value={groups[domain.id] ?? []} onChange={(ids) => setGroups((current) => ({ ...current, [domain.id]: ids }))} />
            </DomainProvider>
          </div>
        ))}
        <p className="text-[12px] text-[var(--color-ink-muted)]">{joinSentence(ways, domains.length)}</p>
      </form>
    </Dialog>
  );
}

/**
 * Invite in one domain. When some emails have an account there already, the rest are invited and those
 * are left out; when some are invited there already, their invitations get a new link, so the one
 * link each person gets joins every domain. Any other refusal invites nobody there.
 */
async function inviteIn(domain: ConsoleDomain, emails: string[], groupIds: string[]): Promise<DomainRun> {
  const api = domainApi(domain.id);
  try {
    const result = await api.inviteUsers({ emails, group_ids: groupIds });
    return { domain, invited: result.invitations, renewed: [], skipped: [], error: null };
  } catch (error) {
    const problems = problemsOf(error);
    if (problems.length === 0 || problems.some((problem) => problem.reason !== 'already_exists' && problem.reason !== 'invited')) {
      return { domain, invited: [], renewed: [], skipped: [], error: messageOf(error) };
    }
    const accounts = problems.filter((problem) => problem.reason === 'already_exists');
    const refused = new Set(problems.map((problem) => problem.email));
    const rest = emails.filter((email) => !refused.has(email));
    const invited: CpInvitationMade[] = [];
    const renewed: string[] = [];
    const skipped = [...accounts];
    for (const problem of problems.filter((item) => item.reason === 'invited' && item.user_id && item.email)) {
      try {
        const made = await api.renewInvitation(problem.user_id as string);
        invited.push({ user_id: problem.user_id as string, email: problem.email as string, link: made.link, link_expires_at: made.link_expires_at });
        renewed.push(problem.email as string);
      } catch (cause) {
        skipped.push({ ...problem, message: messageOf(cause) });
      }
    }
    if (rest.length === 0) return { domain, invited, renewed, skipped, error: null };
    try {
      const result = await api.inviteUsers({ emails: rest, group_ids: groupIds });
      return { domain, invited: [...result.invitations, ...invited], renewed, skipped, error: null };
    } catch (again) {
      return { domain, invited, renewed, skipped, error: messageOf(again) };
    }
  }
}

/** Each person invited, with the one link that joins every domain that invited them: shown this once. */
function InvitationLinks({ runs, emails, providers }: { runs: DomainRun[]; emails: string[]; providers: string[] }): ReactNode {
  const many = runs.length > 1;
  const people = emails.flatMap((email) => {
    const entries: InvitationEntry[] = [];
    const domains: string[] = [];
    for (const run of runs) {
      const made = run.invited.find((item) => item.email === email);
      if (!made) continue;
      domains.push(run.domain.name);
      if (made.link) entries.push({ domain: run.domain.id, token: made.link });
    }
    const elsewhere = runs.flatMap((run) =>
      run.skipped.filter((problem) => problem.email === email).map((problem) => ({ domain: run.domain.name, message: problem.message })),
    );
    const again = runs.filter((run) => run.renewed.includes(email)).map((run) => run.domain.name);
    if (domains.length === 0 && elsewhere.length === 0) return [];
    return [{ email, domains, elsewhere, again, url: entries.length > 0 ? invitationLink(window.location.origin, entries) : null }];
  });
  const expires = runs
    .flatMap((run) => run.invited.map((item) => item.link_expires_at))
    .filter((value): value is string => Boolean(value))
    .sort()[0];
  const withLinks = people.filter((person) => person.url);
  const failed = runs.filter((run) => run.error);

  return (
    <div className="space-y-3">
      {withLinks.length > 0 ? (
        <p className="text-[13px] text-[var(--color-ink-muted)]">
          Send each person their link, privately: whoever has it can join as them
          {expires ? ` until ${new Date(expires).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}
          {many ? ', in every domain it names' : ''}. The links are not shown again
          {providers.length > 0 ? `, and they can also join by signing in through ${orList(providers)} with the invited email` : ''}.
        </p>
      ) : (
        <p className="text-[13px] text-[var(--color-ink-muted)]">
          {providers.length > 0
            ? `They join by signing in through ${orList(providers)} with the invited email.`
            : 'They join once password sign-in is on, or a sign-in provider is: ask an administrator.'}
        </p>
      )}
      <ul className="divide-y divide-[var(--color-line)] overflow-hidden rounded-[var(--radius-control)] border border-[var(--color-line-strong)]">
        {people.map((person) => (
          <li key={person.email} className="flex items-center gap-3 px-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{person.email}</span>
              {many && person.domains.length > 0 ? (
                <span className="block truncate text-[12px] text-[var(--color-ink-muted)]">{andList(person.domains)}</span>
              ) : null}
              {person.url ? (
                <span className="ident block truncate text-[12px] text-[var(--color-ink-muted)]" title={person.url}>
                  {person.url}
                </span>
              ) : null}
              {person.again.length > 0 ? (
                <span className="block text-[12px] text-[var(--color-ink-muted)]">
                  Invited already{many ? ` in ${andList(person.again)}` : ''}: a new link, with the groups they had
                </span>
              ) : null}
              {person.elsewhere.map((note) => (
                <span key={note.domain} className="block text-[12px] text-[var(--color-ink-muted)]">
                  {many ? `Not in ${note.domain}: ` : 'Not invited: '}
                  {note.message}
                </span>
              ))}
            </span>
            {person.url ? <CopyButton value={person.url} label={`Copy the link for ${person.email}`} className="h-8 px-2" /> : null}
          </li>
        ))}
      </ul>
      {failed.length > 0 ? (
        <ul role="alert" className="space-y-1 rounded-[var(--radius-control)] bg-[var(--color-flare-wash)] px-3 py-2.5 text-[13px]">
          {failed.map((run) => (
            <li key={run.domain.id}>
              Nobody was invited in {run.domain.name}: {run.error}
            </li>
          ))}
        </ul>
      ) : null}
      {withLinks.length > 1 ? (
        <div className="flex justify-end">
          <CopyAllButton value={withLinks.map((person) => `${person.email}\t${person.url}`).join('\n')} />
        </div>
      ) : null}
    </div>
  );
}

/** Why nobody was invited anywhere: what each domain left out or refused. */
function Refusals({ runs }: { runs: DomainRun[] }): ReactNode {
  const many = runs.length > 1;
  const lines = runs.flatMap((run) => [
    ...run.skipped.map((problem) => (many ? `${run.domain.name}: ${problem.message}` : problem.message)),
    ...(run.error ? [many ? `${run.domain.name}: ${run.error}` : run.error] : []),
  ]);
  return (
    <ul role="alert" className="space-y-1 rounded-[var(--radius-control)] bg-[var(--color-flare-wash)] px-3 py-2.5 text-[13px]">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
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
      {copied ? <Check className="size-3.5" /> : null}
      {copied ? 'Copied' : 'Copy every email and link'}
    </Button>
  );
}

/** How the people invited here will join, in the domains chosen. */
function joinSentence(ways: { providers: string[]; links: boolean }, domains: number): string {
  const through = ways.providers.length > 0 ? `signing in through ${orList(ways.providers)} with that email` : '';
  const link = domains > 1 ? 'the one link each gets here, for every domain' : 'the link each one gets here';
  if (through && ways.links) return `They join by ${through}, or with ${link}.`;
  if (through) return `They join by ${through}.`;
  if (ways.links) return `They join with ${link}, choosing their own password.`;
  return 'Nobody can join yet: no sign-in provider is on, and only administrators may use a password.';
}

/** What the control plane said was wrong with each email, when it refused them. */
function problemsOf(error: unknown): CpInvitationProblem[] {
  if (!(error instanceof ApiError)) return [];
  const problems = refusalDetails(error.details).problems;
  return Array.isArray(problems) ? (problems as CpInvitationProblem[]) : [];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
