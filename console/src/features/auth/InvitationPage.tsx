import { useQueries } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { andList, invitationEntries, orList, type InvitationEntry } from '../access/logic';
import { PasswordInput } from './PasswordInput';
import { Mark } from '@/components/Logo';
import { Button, Field, Input } from '@/components/ui/primitives';
import { ApiError, domainApi } from '@/lib/api';
import { useConsoleAuth } from '@/lib/auth';
import { domainPath, useConsoleConfig } from '@/lib/domains';
import type { ConsoleDomain, CpInvitationDescription } from '@shared/types';

/** Where this tab keeps a link's invitations once they are out of the address bar, so a reload still has them. */
const KEPT_KEY = 'console.invitation';

/** One domain's part of the invitation, as that domain describes it. */
interface Part {
  entry: InvitationEntry;
  domain: ConsoleDomain;
  description: CpInvitationDescription;
}

/** What joining did: the domains it signed this browser in to, and the ones that said no. */
interface Joined {
  joined: ConsoleDomain[];
  refused: Array<{ domain: ConsoleDomain; message: string }>;
}

/**
 * Accept an invitation (handbook 18 §18.18): the page a person's invitation link opens,
 * `/invitation#<domain>:<token>,…`. To them it is one invitation, though each domain that invited them
 * holds its own: the page says who invited them and to what, then offers the ways in - a sign-in
 * provider with the invited email, which accepts it in every domain at once, or a name and a password
 * of their own, which accepts it in each and signs this browser in to each.
 *
 * Each token is a credential. They arrive after `#`, so no server sees them in a URL; the page moves
 * them out of the address bar into this tab's storage, and hands each to its domain in request bodies.
 */
export function InvitationPage(): ReactNode {
  const navigate = useNavigate();
  const consoleAuth = useConsoleAuth();
  const config = useConsoleConfig();
  const [entries] = useState<InvitationEntry[]>(() => takeEntries());
  const served = config.data?.domains ?? [];
  const many = served.length > 1;
  const described = useQueries({
    queries: entries.map((entry) => ({
      queryKey: ['invitation', entry.domain, entry.token],
      queryFn: () => domainApi(entry.domain).describeInvitation(entry.token),
      retry: false,
      staleTime: Number.POSITIVE_INFINITY,
    })),
  });
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [joined, setJoined] = useState<Joined | null>(null);

  const parts: Part[] = entries.flatMap((entry, index) => {
    const domain = served.find((candidate) => candidate.id === entry.domain);
    const description = described[index]?.data;
    return domain && description ? [{ entry, domain, description }] : [];
  });
  const dead = entries.flatMap((entry, index) => {
    const failure = described[index]?.error;
    const domain = served.find((candidate) => candidate.id === entry.domain);
    return failure || (!domain && !config.isLoading) ? [{ entry, domain, error: failure }] : [];
  });
  const loading = config.isLoading || described.some((query) => query.isLoading);
  const first = parts[0]?.description;

  useEffect(() => {
    if (!first) return;
    setFirstName((current) => current || first.first_name);
    setLastName((current) => current || first.last_name);
  }, [first]);

  useEffect(() => {
    // A link that will never work again is not worth keeping for a reload.
    if (!loading && entries.length > 0 && parts.length === 0) forgetEntries();
  }, [loading, entries.length, parts.length]);

  const byPassword = parts.filter((part) => part.description.password_sign_in);
  const minimum = Math.max(12, ...byPassword.map((part) => part.description.password_policy.min_length));
  // The providers this console signs people in with that some domain of the invitation takes.
  const providers = consoleAuth.providers.filter((provider) => parts.some((part) => part.description.providers.some((offered) => offered.id === provider.id)));
  const destination = parts.length === 1 && parts[0] ? domainPath(parts[0].domain.id) : '/';
  const inviters = [...new Set(parts.map((part) => part.description.invited_by))];
  const elsewhere = parts.find((part) => {
    const auth = consoleAuth.forDomain(part.domain.id);
    return auth.signedIn && auth.principal.email !== part.description.email;
  });

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const results = await Promise.all(
        byPassword.map(async (part) => {
          try {
            const state = await domainApi(part.domain.id).acceptInvitation({
              token: part.entry.token,
              first_name: firstName.trim(),
              last_name: lastName.trim(),
              password,
            });
            consoleAuth.forDomain(part.domain.id).adopt(state);
            return { part, message: null };
          } catch (cause) {
            return { part, message: cause instanceof ApiError ? cause.message : 'It could not be reached. Try again in a moment.' };
          }
        }),
      );
      const done = results.filter((result) => result.message === null).map((result) => result.part.domain);
      const refused = results.flatMap((result) => (result.message === null ? [] : [{ domain: result.part.domain, message: result.message }]));
      if (done.length === 0) {
        setError(refused.map((item) => (many && refused.length > 1 ? `${item.domain.name}: ${item.message}` : item.message)).join(' '));
        setPassword('');
        return;
      }
      forgetEntries();
      await consoleAuth.reload();
      // A domain taking only provider sign-ins is joined through the provider, not here.
      const unjoined = parts.filter((part) => !part.description.password_sign_in);
      if (refused.length === 0 && unjoined.length === 0) {
        navigate(done.length === 1 && done[0] ? domainPath(done[0].id) : '/', { replace: true });
        return;
      }
      setJoined({
        joined: done,
        refused: [
          ...refused,
          ...unjoined.map((part) => ({
            domain: part.domain,
            message: `it takes sign-ins through ${orList(part.description.providers.map((provider) => provider.label))} only: sign in through it to join there too.`,
          })),
        ],
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-full items-center justify-center">
        {/* The console itself is waiting: its mark flows (§10.7). */}
        <Mark size={32} working label="Loading" className="text-[var(--color-ink-faint)]" />
      </div>
    );
  }

  const failure = parts.length === 0 ? unusable(entries.length > 0, dead.map((item) => item.error)) : null;
  return (
    <div className="flex min-h-full items-center justify-center bg-[var(--color-canvas)] px-4 py-12">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex flex-col items-center text-center">
          <Mark size={52} tile working={submitting} label="Midstream" className="rounded-[13px]" />
          <h1 className="display mt-5 text-[24px] font-semibold">{failure ? failure.title : joined ? 'Welcome to Midstream' : 'Join Midstream'}</h1>
          <p className="mt-1 text-[13px] text-[var(--color-ink-muted)]">
            {failure ? (
              failure.message
            ) : first ? (
              <>
                {inviters.length === 1 ? `${inviters[0]} invited you` : 'You are invited'} as{' '}
                <span className="font-medium text-[var(--color-ink)]">{first.email}</span>.
                {many ? ` It gives you access to ${andList(parts.map((part) => part.domain.name))}.` : ''}
              </>
            ) : null}
          </p>
        </div>

        {joined ? (
          <div className="panel space-y-4 p-6 shadow-sm">
            <p className="text-[13px]">You joined {andList(joined.joined.map((domain) => domain.name))}.</p>
            <ul className="space-y-1 text-[13px] text-[var(--color-ink-muted)]">
              {joined.refused.map((item) => (
                <li key={item.domain.id}>
                  {item.domain.name}: {item.message}
                </li>
              ))}
            </ul>
            <Button variant="primary" className="w-full" onClick={() => navigate(joined.joined.length === 1 && joined.joined[0] ? domainPath(joined.joined[0].id) : '/', { replace: true })}>
              Continue
              <ArrowRight className="size-4" />
            </Button>
          </div>
        ) : first ? (
          <div className="panel space-y-4 p-6 shadow-sm">
            {dead.length > 0 ? (
              <p className="text-[12px] text-[var(--color-ink-muted)]">
                Not {andList(dead.map((item) => item.domain?.name ?? item.entry.domain))}: that part of your invitation no longer works. Ask whoever
                invited you.
              </p>
            ) : null}
            {elsewhere ? (
              <p className="text-[12px] text-[var(--color-ink-muted)]">
                You are signed in{many ? ` to ${elsewhere.domain.name}` : ''} as {consoleAuth.forDomain(elsewhere.domain.id).principal.email}. Joining signs you in
                as {first.email} instead.
              </p>
            ) : null}
            {providers.length > 0 ? (
              <div className="space-y-2">
                {providers.map((provider) => (
                  <Button
                    key={provider.id}
                    type="button"
                    className="w-full"
                    onClick={() => {
                      forgetEntries();
                      // The provider's pages are a full navigation away; every domain that invited the
                      // email it vouches for accepts the invitation there.
                      window.location.assign(`/api/auth/sso/${provider.id}/start?return=${encodeURIComponent(destination)}`);
                    }}
                  >
                    Continue with {provider.label}
                  </Button>
                ))}
                <p className="text-center text-[12px] text-[var(--color-ink-muted)]">
                  Use your {orList(providers.map((provider) => provider.label))} account for {first.email}.
                </p>
              </div>
            ) : null}
            {providers.length > 0 && byPassword.length > 0 ? (
              <p className="flex items-center gap-3 text-[12px] text-[var(--color-ink-faint)]">
                <span className="h-px flex-1 bg-[var(--color-line)]" />
                or choose a password
                <span className="h-px flex-1 bg-[var(--color-line)]" />
              </p>
            ) : null}
            {byPassword.length > 0 ? (
              <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
                {error ? (
                  <div role="alert" className="flex items-start gap-2 rounded-[var(--radius-control)] bg-[var(--color-flare-wash)] px-3 py-2.5 text-[13px]">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--color-flare-ink)]" />
                    <span>{error}</span>
                  </div>
                ) : null}
                {/* For a password manager: the account the new password belongs to. */}
                <input type="email" autoComplete="username" value={first.email} readOnly hidden />
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="First name">
                    <Input autoComplete="given-name" value={firstName} onChange={(event) => setFirstName(event.target.value)} required />
                  </Field>
                  <Field label="Last name">
                    <Input autoComplete="family-name" value={lastName} onChange={(event) => setLastName(event.target.value)} required />
                  </Field>
                </div>
                <Field label="Password" hint={`At least ${minimum} characters. Only you will know it.`}>
                  <PasswordInput autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
                </Field>
                <Button
                  type="submit"
                  variant="primary"
                  className="w-full"
                  loading={submitting}
                  disabled={!firstName.trim() || !lastName.trim() || password.length < minimum}
                >
                  Join Midstream
                </Button>
              </form>
            ) : providers.length === 0 ? (
              <p className="text-[13px] text-[var(--color-ink-muted)]">This invitation takes no sign-in this console offers. Ask whoever invited you.</p>
            ) : null}
          </div>
        ) : null}

        {joined ? null : (
          <div className="mt-5 text-center text-[12px] text-[var(--color-ink-muted)]">
            <p>
              Already have an account?{' '}
              <Link to="/sign-in" className="font-medium text-[var(--color-ink)] hover:underline">
                Sign in
              </Link>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/** Why a link opens nothing, in words: incomplete, expired, no longer working, or unreadable now. */
function unusable(hadEntries: boolean, errors: unknown[]): { title: string; message: string } {
  if (!hadEntries) return { title: 'This invitation link is incomplete', message: 'Open it again from the message it came in, all of it.' };
  const statuses = errors.map((error) => (error instanceof ApiError ? error.status : 0));
  if (statuses.length > 0 && statuses.every((status) => status === 410)) {
    return { title: 'This invitation link has expired', message: 'Ask whoever invited you for a new one.' };
  }
  if (statuses.every((status) => status === 404 || status === 410 || status === 0)) {
    return {
      title: 'This invitation link does not work',
      message: 'A newer link replaced it, or the invitation was revoked or accepted. Ask whoever invited you for a new link, or sign in.',
    };
  }
  const reason = errors.find((error) => error instanceof Error);
  return { title: 'The invitation cannot be read right now', message: reason instanceof Error ? reason.message : 'Try again in a moment.' };
}

/**
 * The link's invitations: from the address bar, moved into this tab's storage so a reload keeps them
 * and the address bar, history and screenshots do not; else what this tab kept.
 */
function takeEntries(): InvitationEntry[] {
  const fromLink = invitationEntries(window.location.hash);
  if (fromLink.length > 0) {
    window.history.replaceState(window.history.state, '', window.location.pathname);
    try {
      window.sessionStorage.setItem(KEPT_KEY, JSON.stringify(fromLink));
    } catch {
      // Without storage a reload asks for the link again; nothing else is lost.
    }
    return fromLink;
  }
  try {
    const kept = JSON.parse(window.sessionStorage.getItem(KEPT_KEY) ?? '[]') as unknown;
    return Array.isArray(kept)
      ? kept.filter((item): item is InvitationEntry => typeof item?.domain === 'string' && typeof item?.token === 'string')
      : [];
  } catch {
    return [];
  }
}

function forgetEntries(): void {
  try {
    window.sessionStorage.removeItem(KEPT_KEY);
  } catch {
    // Nothing kept, nothing to forget.
  }
}
