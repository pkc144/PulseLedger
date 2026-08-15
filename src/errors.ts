import type { FastifyReply, FastifyRequest } from 'fastify';

export class AppError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

const domainErrorStatus = {
  ACCOUNT_NOT_ACTIVE: 409,
  ACCOUNT_NOT_FOUND: 404,
  CURRENCY_MISMATCH: 400,
  IDEMPOTENCY_CONFLICT: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  INSUFFICIENT_FUNDS: 409,
  INVALID_AMOUNT: 400,
  INVALID_CURSOR: 400,
  INVALID_POSTING: 400,
  MIXED_CURRENCY_POSTING: 400,
  SELF_TRANSFER: 400,
  TRANSFER_NOT_FOUND: 404,
  TRANSFER_RETRY_EXHAUSTED: 503,
  TREASURY_NOT_FOUND: 500,
  UNBALANCED_POSTING: 400,
} as const;

type DomainErrorCode = keyof typeof domainErrorStatus;

interface DomainError extends Error {
  code: DomainErrorCode;
}

function isDomainError(error: Error): error is DomainError {
  return (
    'code' in error &&
    typeof error.code === 'string' &&
    Object.hasOwn(domainErrorStatus, error.code)
  );
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

export function errorHandler(error: Error, request: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof AppError) {
    void reply.status(error.statusCode).send({
      error: { code: error.code, message: error.message, requestId: request.id },
    } satisfies ErrorResponse);
    return;
  }

  if ('validation' in error) {
    void reply.status(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        requestId: request.id,
      },
    } satisfies ErrorResponse);
    return;
  }

  if (isDomainError(error)) {
    void reply.status(domainErrorStatus[error.code]).send({
      error: { code: error.code, message: error.message, requestId: request.id },
    } satisfies ErrorResponse);
    return;
  }

  // Framework-level client errors (oversized body, malformed content-type, header limits, a
  // request timing out mid-parse, ...) carry their own correct statusCode from Fastify/Node.
  // Surface it instead of collapsing every unrecognized error into a 500.
  const frameworkStatus = 'statusCode' in error ? error.statusCode : undefined;
  if (typeof frameworkStatus === 'number' && frameworkStatus >= 400 && frameworkStatus < 500) {
    request.log.warn({ err: error }, 'request rejected');
    void reply.status(frameworkStatus).send({
      error: {
        code: 'REQUEST_REJECTED',
        message: 'The request could not be processed',
        requestId: request.id,
      },
    } satisfies ErrorResponse);
    return;
  }

  request.log.error({ err: error }, 'unhandled request error');
  void reply.status(500).send({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId: request.id,
    },
  } satisfies ErrorResponse);
}
