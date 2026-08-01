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

  request.log.error({ err: error }, 'unhandled request error');
  void reply.status(500).send({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId: request.id,
    },
  } satisfies ErrorResponse);
}
