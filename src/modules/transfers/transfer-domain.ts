export interface CreateTransferInput {
  amountMinor: string;
  destinationAccountId: string;
  sourceAccountId: string;
}

export type TransferErrorCode =
  | 'ACCOUNT_NOT_ACTIVE'
  | 'ACCOUNT_NOT_FOUND'
  | 'CURRENCY_MISMATCH'
  | 'INSUFFICIENT_FUNDS'
  | 'SELF_TRANSFER'
  | 'TRANSFER_NOT_FOUND'
  | 'TRANSFER_RETRY_EXHAUSTED';

export class TransferError extends Error {
  public constructor(
    public readonly code: TransferErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TransferError';
  }
}

export interface Transfer {
  amountMinor: string;
  createdAt: string;
  currency: string;
  destinationAccountId: string;
  id: string;
  reference: string;
  sourceAccountId: string;
  status: 'completed';
}

export interface LockedTransferAccount {
  balanceMinor: string;
  currency: string;
  id: string;
  isTreasury: boolean;
  /** Null for treasuries. Read from the locked row so ownership cannot be raced. */
  ownerPrincipalId: string | null;
  status: 'active' | 'frozen' | 'closed';
}

export interface PostTransferInput {
  amountMinor: string;
  currency: string;
  destinationAccountId: string;
  id: string;
  reference: string;
  sourceAccountId: string;
  idempotency?: { key: string; operation: string; principalId: string } | undefined;
}

export interface TransferTransaction {
  lockAccounts(accountIds: readonly [string, string]): Promise<readonly LockedTransferAccount[]>;
  postTransfer(input: PostTransferInput): Promise<Transfer>;
}

export interface TransferStore {
  findVisibleById(id: string, principalId: string): Promise<Transfer | null>;
  runSerializable<T>(work: (transaction: TransferTransaction) => Promise<T>): Promise<T>;
}

export interface CreateTransferOptions {
  idempotencyKey?: string | undefined;
}

export interface TransferApplication {
  /**
   * `principalId` must own the source account; the destination may belong to anyone. Both are
   * validated against rows locked inside the transaction, never against an earlier read.
   */
  create(
    input: CreateTransferInput,
    principalId: string,
    options?: CreateTransferOptions,
  ): Promise<Transfer>;
  /** Readable by either participant's owner; anyone else gets `TRANSFER_NOT_FOUND`. */
  findById(id: string, principalId: string): Promise<Transfer>;
}

export interface TransferTelemetry {
  completed(event: { elapsedMs: number; retryAttempts: number; transferId: string }): void;
  retrying(event: {
    delayMs: number;
    errorCode: string;
    retryAttempt: number;
    transferId: string;
  }): void;
}

export interface TransferMetricsSnapshot {
  completed: number;
  exhausted: number;
  retries: number;
}

export interface TransferMetricsPort {
  recordCompleted(): void;
  recordExhausted(): void;
  recordRetry(): void;
  snapshot(): TransferMetricsSnapshot;
}

export function deterministicAccountOrder(
  firstId: string,
  secondId: string,
): readonly [string, string] {
  return firstId < secondId ? [firstId, secondId] : [secondId, firstId];
}
