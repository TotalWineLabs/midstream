import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import Fastify from 'fastify';

import { ConsoleError, answerError } from './errors.ts';

async function app() {
  const server = Fastify();
  server.setErrorHandler(answerError);
  server.post('/thing', async () => ({ ok: true }));
  server.delete('/thing', async () => ({ ok: true }));
  server.get('/refused', async () => {
    throw new ConsoleError('forbidden', 'You may not.', 403, { dataset: 'domain_a.sales' });
  });
  server.get('/broken', async () => {
    throw new Error('a secret path /var/lib/console');
  });
  return server;
}

describe('a failure, answered', () => {
  it('answers a request it could not read as the caller’s, with its status', async () => {
    const server = await app();
    const empty = await server.inject({ method: 'DELETE', url: '/thing', headers: { 'content-type': 'application/json' } });
    assert.equal(empty.statusCode, 400, 'an empty JSON body');
    assert.equal(empty.json().error.code, 'invalid_request');
    const malformed = await server.inject({ method: 'POST', url: '/thing', headers: { 'content-type': 'application/json' }, payload: '{' });
    assert.equal(malformed.statusCode, 400, 'malformed JSON');
    const unknownType = await server.inject({ method: 'POST', url: '/thing', headers: { 'content-type': 'application/x-unknown' }, payload: 'x' });
    assert.equal(unknownType.statusCode, 415, 'a type it does not take');
  });

  it('answers a refusal as it says, and its own failure without its message', async () => {
    const server = await app();
    const refused = await server.inject({ url: '/refused' });
    assert.deepEqual([refused.statusCode, refused.json()], [403, { error: { code: 'forbidden', message: 'You may not.', details: { dataset: 'domain_a.sales' } } }]);
    const broken = await server.inject({ url: '/broken' });
    assert.equal(broken.statusCode, 500);
    assert.equal(broken.json().error.code, 'internal_error');
    assert.ok(!broken.body.includes('/var/lib'), 'the failure’s own words stay in the log');
  });
});
