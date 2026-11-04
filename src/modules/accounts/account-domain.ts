export const supportedCurrencies = ['INR', 'USD'] as const;
export type SupportedCurrency = (typeof supportedCurrencies)[number];

export interface Account {
  balanceMinor: string;
  createdAt: string;
  currency: SupportedCurrency;
  id: string;
  status: 'active' | 'frozen' | 'closed';
}

/** Page size bounds for `GET /v1/accounts`. The default keeps one page enough for most callers. */
export const ownedAccountsDefaultLimit = 100;
export const ownedAccountsMaxLimit = 100;

export class AccountError extends Error {
  public constructor(
    public readonly code: 'INVALID_CURSOR',
    message: string,
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

/** Keyset position in a principal's accounts, ordered by (createdAt, id). */
export interface OwnedAccountsCursor {
  /** Microsecond-precision UTC text, as rendered by PostgreSQL -- never a JS Date round-trip. */
  createdAt: string;
  id: string;
}

export interface OwnedAccountsPage {
  accounts: Account[];
  /** Opaque; null on the last page. A list is never silently truncated. */
  nextCursor: string | null;
}

export function encodeOwnedAccountsCursor(cursor: OwnedAccountsCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeOwnedAccountsCursor(raw: string): OwnedAccountsCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const { createdAt, id } = (parsed ?? {}) as Record<string, unknown>;
    if (
      typeof createdAt === 'string' &&
      !Number.isNaN(Date.parse(createdAt)) &&
      typeof id === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ) {
      return { createdAt, id };
    }
  } catch {
    // Falls through to the single error below.
  }
  throw new AccountError('INVALID_CURSOR', 'Cursor is malformed');
}

export interface CreateAccountInput {
  currency: SupportedCurrency;
}

/**
 * Every operation is scoped to the principal that owns the account. Lookups filter by owner in
 * SQL rather than fetching and comparing, so a caller can never read an account it does not own
 * even for the moment between load and check.
 */
export interface AccountStore {
  create(input: CreateAccountInput, ownerPrincipalId: string): Promise<Account>;
  findOwnedById(id: string, ownerPrincipalId: string): Promise<Account | null>;
  listOwned(
    ownerPrincipalId: string,
    page: { cursor?: OwnedAccountsCursor | undefined; limit: number },
  ): Promise<{ accounts: Account[]; nextCursor: OwnedAccountsCursor | null }>;
}

export interface AccountApplication {
  create(input: CreateAccountInput, ownerPrincipalId: string): Promise<Account>;
  findOwnedById(id: string, ownerPrincipalId: string): Promise<Account | null>;
  listOwned(
    ownerPrincipalId: string,
    options?: { cursor?: string | undefined; limit?: number | undefined },
  ): Promise<OwnedAccountsPage>;
}
