import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { invitationToken, orList } from '../access/logic';
import { PasswordInput } from './PasswordInput';
import { Mark } from '@/components/Logo';
import { Button, Field, Input } from '@/components/ui/primitives';
import { ApiError, domainApi } from '@/lib/api';
import { useConsoleAuth } from '@/lib/auth';
import { domainPath, useConsoleConfig } from '@/lib/domains';

/** Where this tab keeps a link's token once it is out of the address bar, so a reload still has it. */
const TOKEN_KEY = 'console.invitation';

/**
 * Accept an invitation (handbook 18 §18.18): the page an invitation's link opens,
 * `/invitation/<domain>#<token>`. It says who is invited and by whom, and offers the ways in: a
 * sign-in provider with the invited email, or a password of their own, which the link allows.
 *
 * The token is the credential. It arrives after `#`, so no server sees it in a URL; the page moves it
 * out of the address bar into this tab's storage, and hands it to the domain in request bodies.
 */
export function InvitationPage(): ReactNode {
  const { domain: domainId = '' } = useParams<{ domain: string }>();
  const navigate = useNavigate();
  const consoleAuth = useConsoleAuth();
  const config = useConsoleConfig();
  const [token] = useState<string | null>(() => takeToken(domainId));
  const domain = (config.data?.domains ?? []).find((entry) => entry.id === domainId) ?? null;
  const many = (config.data?.domains.length ?? 0) > 1;
  const api = domainApi(domainId);
  const described = useQuery({
    queryKey: ['invitation', domainId, token],
    queryFn: () => api.describeInvitation(token as string),
    enabled: Boolean(token),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const invitation = described.data;
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!invitation) return;
    setFirstName((current) => current || invitation.first_name);
    setLastName((current) => current || invitation.last_name);
  }, [invitation]);

  const minimum = invitation?.password_policy.min_length ?? 12;
  const where = many && domain ? domain.name : 'Midstream';
  // The providers this console signs people in with that the domain takes.
  const providers = consoleAuth.providers.filter((provider) => invitation?.providers.some((offered) => offered.id === provider.id));
  const signedInAs = consoleAuth.forDomain(domainId).signedIn ? consoleAuth.forDomain(domainId).principal.email : null;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!token) return;
    setError(null);
    setSubmitting(true);
    try {
      const state = await api.acceptInvitation({ token, first_name: firstName.trim(), last_name: lastName.trim(), password });
      forgetToken();
      consoleAuth.forDomain(domainId).adopt(state);
      await consoleAuth.reload();
      navigate(domainPath(domainId), { replace: true });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'The invitation could not be accepted. Check your connection and try again.');
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  };

  if (config.isLoading || (described.isLoading && Boolean(token))) {
    return (
      <div className="flex min-h-full items-center justify-center">
        {/* The console itself is waiting: its mark flows (§10.7). */}
        <Mark size={32} working label="Loading" className="text-[var(--color-ink-faint)]" />
      </div>
    );
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-[var(--color-canvas)] px-4 py-12">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex flex-col items-center text-center">
          <Mark size={52} tile working={submitting} label="Midstream" className="rounded-[13px]" />
          <h1 className="display mt-5 text-[24px] font-semibold">{invitation ? `Join ${where}` : unusable(token, described.error).title}</h1>
          <p className="mt-1 text-[13px] text-[var(--color-ink-muted)]">
            {invitation ? (
              <>
                {invitation.invited_by} invited you as <span className="font-medium text-[var(--color-ink)]">{invitation.email}</span>.
              </>
            ) : (
              unusable(token, described.error).message
            )}
          </p>
        </div>

        {invitation ? (
          <div className="panel space-y-4 p-6 shadow-sm">
            {signedInAs && signedInAs !== invitation.email ? (
              <p className="text-[12px] text-[var(--color-ink-muted)]">
                You are signed in to {where} as {signedInAs}. Accepting signs you in as {invitation.email} instead.
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
                      forgetToken();
                      // The provider's pages are a full navigation away; the domain accepts the
                      // invitation when the provider vouches for the invited email.
                      window.location.assign(`/api/auth/sso/${provider.id}/start?return=${encodeURIComponent(domainPath(domainId))}`);
                    }}
                  >
                    Continue with {provider.label}
                  </Button>
                ))}
                <p className="text-center text-[12px] text-[var(--color-ink-muted)]">
                  Use your {orList(providers.map((provider) => provider.label))} account for {invitation.email}.
                </p>
              </div>
            ) : null}
            {providers.length > 0 && invitation.password_sign_in ? (
              <p className="flex items-center gap-3 text-[12px] text-[var(--color-ink-faint)]">
                <span className="h-px flex-1 bg-[var(--color-line)]" />
                or choose a password
                <span className="h-px flex-1 bg-[var(--color-line)]" />
              </p>
            ) : null}
            {invitation.password_sign_in ? (
              <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
                {error ? (
                  <div role="alert" className="flex items-start gap-2 rounded-[var(--radius-control)] bg-[var(--color-flare-wash)] px-3 py-2.5 text-[13px]">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--color-flare-ink)]" />
                    <span>{error}</span>
                  </div>
                ) : null}
                {/* For a password manager: the account the new password belongs to. */}
                <input type="email" autoComplete="username" value={invitation.email} readOnly hidden />
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
                  Join {where}
                </Button>
              </form>
            ) : providers.length === 0 ? (
              <p className="text-[13px] text-[var(--color-ink-muted)]">
                {where} takes no sign-in this console offers for this invitation. Ask whoever invited you.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="mt-5 text-center text-[12px] text-[var(--color-ink-muted)]">
          <p>
            Already have an account?{' '}
            <Link to={domain ? `/sign-in/${encodeURIComponent(domainId)}` : '/sign-in'} className="font-medium text-[var(--color-ink)] hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

/** Why a link opens nothing, in words: incomplete, expired, no longer working, or unreadable now. */
function unusable(token: string | null, error: unknown): { title: string; message: string } {
  if (!token) return { title: 'This invitation link is incomplete', message: 'Open it again from the message it came in, all of it.' };
  if (error instanceof ApiError && error.status === 410) {
    return { title: 'This invitation link has expired', message: 'Ask whoever invited you for a new one.' };
  }
  if (error instanceof ApiError && error.status < 500 && error.status !== 429) {
    return { title: 'This invitation link does not work', message: error.message };
  }
  return { title: 'The invitation cannot be read right now', message: error instanceof Error ? error.message : 'Try again in a moment.' };
}

/**
 * The link's token: from the address bar, moved into this tab's storage so a reload keeps it and the
 * address bar, history and screenshots do not; else what this tab kept for the same domain.
 */
function takeToken(domain: string): string | null {
  const fromLink = invitationToken(window.location.hash);
  if (fromLink) {
    window.history.replaceState(window.history.state, '', window.location.pathname);
    try {
      window.sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ domain, token: fromLink }));
    } catch {
      // Without storage a reload asks for the link again; nothing else is lost.
    }
    return fromLink;
  }
  try {
    const kept = JSON.parse(window.sessionStorage.getItem(TOKEN_KEY) ?? 'null') as { domain?: string; token?: string } | null;
    return kept?.domain === domain && typeof kept.token === 'string' ? kept.token : null;
  } catch {
    return null;
  }
}

function forgetToken(): void {
  try {
    window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing kept, nothing to forget.
  }
}
