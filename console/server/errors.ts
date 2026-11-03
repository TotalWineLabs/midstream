import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiErrorBody } from '../shared/types.ts';

/** Transport-agnostic API failure carrying the status code the console should return. */
export class ConsoleError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, statusCode = 400, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ConsoleError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

/**
 * Every route's failure, answered (`main.ts` installs it): a `ConsoleError` as it says; a request
 * Fastify could not read - an empty or malformed JSON body, one too large, a type it does not take -
 * as the caller's, with Fastify's status; anything else as the console's own failure, logged, its
 * message kept from the caller.
 */
export function answerError(error: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (error instanceof ConsoleError) {
    request.log.debug({ err: error, url: request.url }, 'console error');
    return reply.code(error.statusCode).send(error.toBody());
  }
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    request.log.debug({ err: error, url: request.url }, 'request not readable');
    return reply.code(status).send(new ConsoleError('invalid_request', (error as Error).message, status).toBody());
  }
  request.log.error({ err: error, url: request.url }, 'unhandled console failure');
  return reply.code(500).send({ error: { code: 'internal_error', message: 'the console failed to handle this request', details: {} } });
}

export const badRequest = (message: string, details: Record<string, unknown> = {}): ConsoleError =>
  new ConsoleError('invalid_request', message, 400, details);

export const notFound = (message: string, details: Record<string, unknown> = {}): ConsoleError =>
  new ConsoleError('not_found', message, 404, details);

export const unavailable = (message: string, details: Record<string, unknown> = {}): ConsoleError =>
  new ConsoleError('unavailable', message, 503, details);

export const upstreamError = (
  message: string,
  statusCode: number,
  details: Record<string, unknown> = {},
): ConsoleError => new ConsoleError('control_plane_error', message, statusCode, details);

/** Materialization ids are used in filesystem paths and SQL literals; keep them opaque and safe. */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertSafeIdentifier(value: string, field = 'materialization_id'): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw badRequest(`${field} contains unsupported characters`, { field });
  }
  return value;
}
