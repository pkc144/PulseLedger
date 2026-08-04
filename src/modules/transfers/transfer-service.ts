import { randomUUID } from 'node:crypto';
import { Money } from '../ledger/ledger-domain.js';
import {
  deterministicAccountOrder,
  TransferError,
  type CreateTransferInput,
  type Transfer,
  type TransferApplication,
  type TransferMetricsPort,
  type TransferMetricsSnapshot,
  type TransferStore,
  type TransferTelemetry,
} from './transfer-domain.js';

const retryableDatabaseCodes = new Set(['40001', '40P01']);

export interface TransferServiceOptions {
  baseRetryDelayMs?: number;
  jitter?: () => number;
  maxAttempts?: number;
  metrics?: TransferMetricsPort;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  telemetry?: TransferTelemetry;
}

const noOpTelemetry: TransferTelemetry = {
  completed: () => undefined,
  retrying: () => undefined,
};

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

export class TransferMetrics implements TransferMetricsPort {
  private completedCount = 0;
  private exhaustedCount = 0;
  private retryCount = 0;

  public recordCompleted(): void {
    this.completedCount += 1;
  }

  public recordExhausted(): void {
    this.exhaustedCount += 1;
  }

  public recordRetry(): void {
    this.retryCount += 1;
  }

  public snapshot(): TransferMetricsSnapshot {
    return {
      completed: this.completedCount,
      exhausted: this.exhaustedCount,
      retries: this.retryCount,
    };
  }
}

export class TransferService implements TransferApplication {
  private readonly baseRetryDelayMs: number;
  private readonly jitter: () => number;
  private readonly maxAttempts: number;
  private readonly metrics: TransferMetricsPort;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly telemetry: TransferTelemetry;

  public constructor(
    private readonly store: TransferStore,
    options: TransferServiceOptions = {},
  ) {
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 2;
    this.jitter = options.jitter ?? Math.random;
    this.maxAttempts = options.maxAttempts ?? 12;
    this.metrics = options.metrics ?? new TransferMetrics();
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      (async (milliseconds) => {
        await new Promise((resolve) => setTimeout(resolve, milliseconds));
      });
    this.telemetry = options.telemetry ?? noOpTelemetry;
  }

  public getMetrics(): TransferMetricsPort {
    return this.metrics;
  }

  public async create(input: CreateTransferInput): Promise<Transfer> {
    const amount = Money.fromMinor(input.amountMinor);
    if (input.sourceAccountId === input.destinationAccountId) {
      throw new TransferError('SELF_TRANSFER', 'Source and destination must differ');
    }

    const transferId = randomUUID();
    const reference = `transfer:${transferId}`;
    const startedAt = this.now();

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const transfer = await this.store.runSerializable(async (transaction) => {
          const orderedIds = deterministicAccountOrder(
            input.sourceAccountId,
            input.destinationAccountId,
          );
          const accounts = await transaction.lockAccounts(orderedIds);
          const source = accounts.find(({ id }) => id === input.sourceAccountId);
          const destination = accounts.find(({ id }) => id === input.destinationAccountId);

          if (!source || source.isTreasury || !destination || destination.isTreasury) {
            throw new TransferError('ACCOUNT_NOT_FOUND', 'Account not found');
          }
          if (source.status !== 'active' || destination.status !== 'active') {
            throw new TransferError('ACCOUNT_NOT_ACTIVE', 'Both accounts must be active');
          }
          if (source.currency !== destination.currency) {
            throw new TransferError(
              'CURRENCY_MISMATCH',
              'Source and destination currencies must match',
            );
          }
          if (BigInt(source.balanceMinor) < amount.minor) {
            throw new TransferError('INSUFFICIENT_FUNDS', 'Source account has insufficient funds');
          }

          return await transaction.postTransfer({
            amountMinor: amount.toString(),
            currency: source.currency,
            destinationAccountId: destination.id,
            id: transferId,
            reference,
            sourceAccountId: source.id,
          });
        });

        const retryAttempts = attempt - 1;
        this.metrics.recordCompleted();
        this.telemetry.completed({
          elapsedMs: this.now() - startedAt,
          retryAttempts,
          transferId,
        });
        return transfer;
      } catch (error) {
        const code = databaseErrorCode(error);
        if (!code || !retryableDatabaseCodes.has(code)) throw error;
        if (attempt === this.maxAttempts) {
          this.metrics.recordExhausted();
          throw new TransferError(
            'TRANSFER_RETRY_EXHAUSTED',
            'Transfer could not be completed within the retry limit',
          );
        }

        const retryAttempt = attempt;
        const exponentialDelay = Math.min(this.baseRetryDelayMs * 2 ** (attempt - 1), 50);
        const delayMs = Math.floor(exponentialDelay * (0.5 + this.jitter() * 0.5));
        this.metrics.recordRetry();
        this.telemetry.retrying({ delayMs, errorCode: code, retryAttempt, transferId });
        await this.sleep(delayMs);
      }
    }

    throw new Error('unreachable transfer retry state');
  }

  public async findById(id: string): Promise<Transfer> {
    const transfer = await this.store.findById(id);
    if (!transfer) throw new TransferError('TRANSFER_NOT_FOUND', 'Transfer not found');
    return transfer;
  }
}
