/**
 * Invitations in the console's API (handbook 18 §18.18): inviting people by email, a new link, and
 * changing or revoking an invitation with Invite users alone - each answered once the domain's
 * identity agent applied it, with the links shown that once.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import Fastify, { type FastifyInstance } from 'fastify';

import { installTestAuth, testPrincipal } from '../auth/testing.ts';
import { installTestDomains } from '../domains/testing.ts';
import { ConsoleError } from '../errors.ts';
import { registerIdentityRoutes } from './identity.ts';
import type { CpPrincipal } from '../../shared/types.ts';

const domain = (await installTestDomains(['domain_a'])).require('domain_a');
const controlPlane = domain.controlPlane;
const original = { ...controlPlane } as Record<string, unknown>;

afterEach(() => {
  Object.assign(controlPlane, original);
});

async function app(principal: CpPrincipal): Promise<FastifyInstance> {
  const server = Fastify();
  server.setErrorHandler((error: ConsoleError, _request, reply) =>
    reply.code(error.statusCode ?? 500).send(error instanceof ConsoleError ? error.toBody() : { error: { code: 'internal_error', message: String(error) } }),
  );
  installTestAuth(server, principal);
  await server.register(registerIdentityRoutes, { prefix: '/api/d/:domain' });
  return server;
}

const inviter = testPrincipal(['users.invite', 'users.view_details', 'users.view', 'groups.view']);
const accepted = { request_id: 'idr-1', action: 'invite_users', entity_type: 'user', entity_id: '', accepted_at: '2026-11-02T12:00:00Z', status_url: '/identity/requests/idr-1' };

describe('inviting people', () => {
  it('needs Invite users, and answers each link once the invitations are made', async () => {
    let sent: unknown = null;
    Object.assign(controlPlane, {
      inviteUsers: async (caller: { token: string | null }, input: unknown) => {
        sent = { token: caller.token, input };
        return { ...accepted, invitations: [{ user_id: 'usr-ada', email: 'ada@example.com', link: 'inv_usr-ada.secret', link_expires_at: '2026-11-09T12:00:00Z' }] };
      },
      identityRequest: async () => ({ request_id: 'idr-1', status: 'applied' }),
    });
    const server = await app(inviter);
    const response = await server.inject({
      method: 'POST',
      url: '/api/d/domain_a/users/invitations',
      payload: { emails: ['ada@example.com'], group_ids: ['editor'] },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(sent, { token: 'token-test', input: { emails: ['ada@example.com'], group_ids: ['editor'] } });
    assert.equal(response.json().status, 'applied');
    assert.deepEqual(response.json().invitations, [{ user_id: 'usr-ada', email: 'ada@example.com', link: 'inv_usr-ada.secret', link_expires_at: '2026-11-09T12:00:00Z' }]);

    const looker = await app(testPrincipal(['users.view', 'users.view_details']));
    const refused = await looker.inject({ method: 'POST', url: '/api/d/domain_a/users/invitations', payload: { emails: ['ada@example.com'] } });
    assert.equal(refused.statusCode, 403);
    assert.equal(refused.json().error.details.permission, 'users.invite');
  });

  it('shows no link when the identity agent refused the invitations', async () => {
    Object.assign(controlPlane, {
      inviteUsers: async () => ({ ...accepted, invitations: [{ user_id: 'usr-ada', email: 'ada@example.com', link: 'inv_usr-ada.secret', link_expires_at: null }] }),
      identityRequest: async () => ({ request_id: 'idr-1', status: 'rejected', reason: 'already_exists', message: 'ada@example.com is invited already.', field: 'emails.0' }),
    });
    const server = await app(inviter);
    const response = await server.inject({ method: 'POST', url: '/api/d/domain_a/users/invitations', payload: { emails: ['ada@example.com'] } });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.details.field, 'emails.0');
    assert.doesNotMatch(response.body, /secret/);
  });

  it('takes a list of addresses and nothing else', async () => {
    const server = await app(inviter);
    for (const payload of [
      { emails: [] },
      { emails: 'ada@example.com' },
      { emails: Array.from({ length: 101 }, (_, index) => `p${index}@example.com`) },
      { emails: ['ada@example.com'], password: 'x' },
    ]) {
      const response = await server.inject({ method: 'POST', url: '/api/d/domain_a/users/invitations', payload });
      assert.equal(response.statusCode, 400, JSON.stringify(payload).slice(0, 60));
    }
  });

  it('gives an invitation a new link, shown once', async () => {
    let renewed: string | null = null;
    Object.assign(controlPlane, {
      renewInvitation: async (_caller: unknown, userId: string) => (
        (renewed = userId), { ...accepted, action: 'renew_invitation', entity_id: userId, link: 'inv_usr-ada.new', link_expires_at: '2026-11-09T12:00:00Z' }
      ),
      identityRequest: async () => ({ request_id: 'idr-1', status: 'applied' }),
    });
    const server = await app(inviter);
    const response = await server.inject({ method: 'POST', url: '/api/d/domain_a/users/usr-ada/invitation' });
    assert.equal(response.statusCode, 200);
    assert.equal(renewed, 'usr-ada');
    assert.equal(response.json().link, 'inv_usr-ada.new');
    assert.equal(response.headers['cache-control'], 'no-store');
  });

  it('lets Invite users change and revoke an invitation, leaving every other account to the domain', async () => {
    const asked: string[] = [];
    Object.assign(controlPlane, {
      updateUser: async (_caller: unknown, userId: string) => (asked.push(`update ${userId}`), { ...accepted, action: 'update_user' }),
      deleteUser: async (_caller: unknown, userId: string) => (asked.push(`delete ${userId}`), { ...accepted, action: 'delete_user' }),
      identityRequest: async () => ({ request_id: 'idr-1', status: 'applied' }),
    });
    const server = await app(inviter);
    assert.equal((await server.inject({ method: 'PATCH', url: '/api/d/domain_a/users/usr-ada', payload: { group_ids: [] } })).statusCode, 200);
    assert.equal((await server.inject({ method: 'DELETE', url: '/api/d/domain_a/users/usr-ada' })).statusCode, 200);
    assert.deepEqual(asked, ['update usr-ada', 'delete usr-ada']);
    // The domain refuses the rest itself: Manage users for an account that is not an invitation.
    Object.assign(controlPlane, {
      updateUser: async () => {
        throw new ConsoleError('control_plane_error', 'You do not have permission to do this: it needs “Manage users”.', 403, {});
      },
    });
    assert.equal((await server.inject({ method: 'PATCH', url: '/api/d/domain_a/users/usr-viewer', payload: { first_name: 'Vera' } })).statusCode, 403);
    const looker = await app(testPrincipal(['users.view', 'users.view_details']));
    assert.equal((await looker.inject({ method: 'DELETE', url: '/api/d/domain_a/users/usr-ada' })).statusCode, 403);
  });
});
