/**
 * A person's invitation across domains (handbook 18 §18.18): to the person it is one invitation, with
 * one link, though each domain holds an invited account of its own. These find, renew and revoke it in
 * every domain that holds it and where the person asking may invite.
 */

import type { InvitationEntry } from './logic';
import { domainApi } from '@/lib/api';
import type { ConsoleDomain, CpUser } from '@shared/types';

/** One domain's invitation of the person. */
export interface HeldInvitation {
  domain: ConsoleDomain;
  user: CpUser;
}

/** The person's invitation in each of `domains` that holds one; a domain that cannot be asked is left out. */
export async function invitationsOf(email: string, domains: ConsoleDomain[]): Promise<HeldInvitation[]> {
  const found = await Promise.all(
    domains.map(async (domain) => {
      try {
        const listing = await domainApi(domain.id).users({ status: 'invited', q: email });
        const user = listing.users.find((candidate) => candidate.email === email.toLowerCase());
        return user ? [{ domain, user }] : [];
      } catch {
        return [];
      }
    }),
  );
  return found.flat();
}

/** What renewing did: each domain's new link, and the domains that refused, with why. */
export interface Renewed {
  entries: InvitationEntry[];
  expires: string | null;
  failed: Array<{ domain: ConsoleDomain; message: string }>;
}

/** A new link in each domain, so one link joins them all; the ones before stop working. */
export async function renewInvitations(held: HeldInvitation[]): Promise<Renewed> {
  const results = await Promise.all(
    held.map(async ({ domain, user }) => {
      try {
        const made = await domainApi(domain.id).renewInvitation(user.user_id);
        return { domain, made, message: null };
      } catch (error) {
        return { domain, made: null, message: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  const entries = results.flatMap((result) => (result.made ? [{ domain: result.domain.id, token: result.made.link }] : []));
  const expires = results.flatMap((result) => (result.made ? [result.made.link_expires_at] : [])).sort()[0] ?? null;
  const failed = results.flatMap((result) => (result.message === null ? [] : [{ domain: result.domain, message: result.message }]));
  return { entries, expires, failed };
}

/** Withdraw the invitation in each domain; the domains that refused, with why. */
export async function revokeInvitations(held: HeldInvitation[]): Promise<Array<{ domain: ConsoleDomain; message: string }>> {
  const results = await Promise.all(
    held.map(async ({ domain, user }) => {
      try {
        await domainApi(domain.id).deleteUser(user.user_id);
        return null;
      } catch (error) {
        return { domain, message: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  return results.filter((result): result is { domain: ConsoleDomain; message: string } => result !== null);
}
