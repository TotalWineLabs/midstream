/**
 * The access pages' logic that needs no React: permission implications, generated passwords, telling
 * sessions apart, and the emails and links of invitations. Kept apart from the components so it can
 * be tested directly.
 */

import type { AuthProvider, CpPermissionCatalog, CpPermissionDefinition } from '@shared/types';

import { humanize } from '../../lib/format.ts';

export function permissionMap(catalog: CpPermissionCatalog | undefined): Map<string, CpPermissionDefinition> {
  return new Map((catalog?.permissions ?? []).map((permission) => [permission.key, permission]));
}

/**
 * Every permission `granted` amounts to, with what each implies, as the control plane resolves
 * it. `*` is every permission; keys the catalog does not know are dropped.
 */
export function expandPermissions(granted: Iterable<string>, catalog: CpPermissionCatalog | undefined): Set<string> {
  const byKey = permissionMap(catalog);
  const pending = [...granted];
  if (pending.includes('*')) return new Set(byKey.keys());
  const expanded = new Set<string>();
  while (pending.length > 0) {
    const key = pending.pop()!;
    if (expanded.has(key)) continue;
    const definition = byKey.get(key);
    if (!definition) continue;
    expanded.add(key);
    pending.push(...definition.implies);
  }
  return expanded;
}

/** Characters for generated passwords: no lookalikes (0/O, 1/l/I), nothing that needs quoting. */
export const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_!@#%';

/** A strong, readable initial password, from the browser's cryptographic random source. */
export function generatePassword(length = 20, random: (values: Uint32Array) => Uint32Array = (values) => crypto.getRandomValues(values)): string {
  const values = random(new Uint32Array(length));
  return Array.from(values, (value) => PASSWORD_ALPHABET[value % PASSWORD_ALPHABET.length]).join('');
}

/** Which browser a user agent describes, roughly: enough to tell one's own sessions apart. */
export function describeAgent(agent: string | null): string {
  if (!agent) return 'Unknown browser';
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /Chrome\//.test(agent)
      ? 'Chrome'
      : /Firefox\//.test(agent)
        ? 'Firefox'
        : /Safari\//.test(agent)
          ? 'Safari'
          : /curl\//.test(agent)
            ? 'curl'
            : agent.split(/[ /]/)[0] || 'Unknown browser';
  const platform = /Mac OS X|Macintosh/.test(agent)
    ? 'macOS'
    : /Windows/.test(agent)
      ? 'Windows'
      : /Android/.test(agent)
        ? 'Android'
        : /iPhone|iPad/.test(agent)
          ? 'iOS'
          : /Linux/.test(agent)
            ? 'Linux'
            : null;
  return platform ? `${browser} on ${platform}` : browser;
}

/** An audit entry's details as one readable line: changes as "before → after", lists joined. */
export function describeDetail(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length === 0 ? 'none' : value.map(describeDetail).join(', ');
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('from' in record || 'to' in record) return `${describeDetail(record.from)} → ${describeDetail(record.to)}`;
    return Object.entries(record)
      .map(([key, item]) => `${key.replace(/_/g, ' ')}: ${describeDetail(item)}`)
      .join('; ');
  }
  return String(value);
}

/** How a session was started, as a person would say it. */
export function describeMethod(method: string): string {
  if (method === 'password') return 'with a password';
  const provider = method.startsWith('sso:') ? method.slice(4) : method;
  const names: Record<string, string> = { entra: 'Microsoft', github: 'GitHub', google: 'Google', oidc: 'single sign-on' };
  return `through ${names[provider] ?? provider}`;
}

/**
 * What a refusal says about itself, wherever it was refused: the identity agent's refusal reaches the
 * page with its details as they are, the control plane's own check of the request with them under
 * `upstream_details`.
 */
export function refusalDetails(details: Record<string, unknown>): Record<string, unknown> {
  const upstream = details.upstream_details;
  return upstream && typeof upstream === 'object' ? { ...(upstream as Record<string, unknown>), ...details } : details;
}

/** As loose as the control plane's check: one @, something on each side, a dot in the domain. */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * The addresses in what someone typed or pasted: separated by commas, semicolons, spaces or lines, a
 * `Name <address>` taken as its address. Each once, in the order given, lower-cased as the control
 * plane keeps them; `invalid` holds what is not an address, to say so before anything is sent.
 */
export function parseEmails(text: string): { emails: string[]; invalid: string[] } {
  const emails: string[] = [];
  const invalid: string[] = [];
  const named = text.replace(/[^,;<>\n]*<([^<>\s]+)>/g, ' $1 ');
  for (const token of named.split(/[\s,;]+/)) {
    const value = token.trim().replace(/^mailto:/i, '').toLowerCase();
    if (!value) continue;
    if (!EMAIL.test(value)) {
      if (!invalid.includes(value)) invalid.push(value);
    } else if (!emails.includes(value)) {
      emails.push(value);
    }
  }
  return { emails, invalid };
}

/** One domain's invitation of a person, as a link carries it. */
export interface InvitationEntry {
  domain: string;
  token: string;
}

const DOMAIN_ID = /^[a-z][a-z0-9_]{0,31}$/;
const INVITATION_TOKEN = /^inv_[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.[A-Za-z0-9_-]{43}$/;

/**
 * A person's invitation link: the console's page for it, with their invitation in every domain that
 * invited them after `#`, as `<domain>:<token>` separated by commas. After `#`, no token reaches a
 * server's log or a referrer: the page hands each to its domain in a request body.
 */
export function invitationLink(origin: string, entries: InvitationEntry[]): string {
  return `${origin.replace(/\/+$/, '')}/invitation#${entries.map((entry) => `${entry.domain}:${entry.token}`).join(',')}`;
}

/** The invitations in a link's `#`, one per domain; none when it holds nothing that could be one. */
export function invitationEntries(hash: string): InvitationEntry[] {
  let text: string;
  try {
    text = decodeURIComponent(hash.replace(/^#/, ''));
  } catch {
    return [];
  }
  const entries: InvitationEntry[] = [];
  for (const part of text.split(',')) {
    const [domain = '', token = '', ...rest] = part.trim().split(':');
    if (rest.length === 0 && DOMAIN_ID.test(domain) && INVITATION_TOKEN.test(token) && !entries.some((entry) => entry.domain === domain)) {
      entries.push({ domain, token });
    }
  }
  return entries;
}

/** Names joined as a sentence says them: "Google", "Google or GitHub", "Microsoft, Google or GitHub". */
export function orList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** Names joined as a sentence lists them: "Domain A", "Domain A and Domain B", "A, B and C". */
export function andList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * How an invited person accepts, in a domain that takes these sign-ins: through its providers with the
 * invited email, and with a link of their own while passwords are on for everyone.
 */
export function joinWays(providers: AuthProvider[]): { providers: string[]; links: boolean } {
  const password = providers.find((provider) => provider.type === 'password');
  return {
    providers: providers.filter((provider) => provider.type === 'sso').map((provider) => provider.label),
    links: password !== undefined && !password.administrators_only,
  };
}

/** How people invited to several domains join: through any of their providers, with a link where any takes one. */
export function joinWaysAcross(domains: AuthProvider[][]): { providers: string[]; links: boolean } {
  const ways = domains.map(joinWays);
  return {
    providers: [...new Set(ways.flatMap((way) => way.providers))],
    links: ways.some((way) => way.links),
  };
}

/** What an audit entry's action reads as. */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  'session.signed_in': 'Signed in',
  'session.sign_in_failed': 'Failed sign-in',
  'session.locked_out': 'Locked out',
  'session.signed_out': 'Signed out',
  'user.created': 'Added a user',
  'user.updated': 'Changed a user',
  'user.deactivated': 'Deactivated a user',
  'user.reactivated': 'Reactivated a user',
  'user.deleted': 'Deleted a user',
  'user.password_reset': 'Reset a password',
  'user.password_changed': 'Changed their password',
  'user.signed_out': 'Signed a user out everywhere',
  'user.session_ended': 'Ended a session',
  'user.unlocked': 'Unlocked a user',
  'user.bootstrapped': 'Made the first administrator',
  'user.bootstrap_restored': 'Restored the bootstrap administrator',
  'user.provisioned': 'Made an account at a first sign-in',
  'user.identity_linked': 'Linked a sign-in provider',
  'user.invited': 'Invited a user',
  'user.invitation_renewed': 'Made a new invitation link',
  'user.invitation_revoked': 'Revoked an invitation',
  'user.invitation_accepted': 'Accepted an invitation',
  'group.created': 'Created a group',
  'group.updated': 'Changed a group',
  'group.deleted': 'Deleted a group',
  'role.created': 'Created a role',
  'role.updated': 'Changed a role',
  'role.deleted': 'Deleted a role',
  'token.created': 'Made an access token',
  'token.revoked': 'Revoked an access token',
  'token.revocation_applied': 'Recorded a token revoked in another domain',
  'dataset.created': 'Created a dataset',
  'dataset.updated': 'Changed a dataset',
  'dataset.deleted': 'Deleted a dataset',
  'dataset.access_changed': 'Changed who may use a dataset',
  'directory.seeded': 'Set up the built-in groups',
};

/** What an audit entry's action reads as: its label, or for one this console does not know, its code in words. */
export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? humanize(action.replace('.', ' '));
}
