import { currentIdToken } from './firebase';
import { readCredential, writeCredential } from './session';

export type Currency = 'INR' | 'USD';
export const currencies: Currency[] = ['INR', 'USD'];

export interface Account {
  id: string;
  currency: Currency;
  status: 'active' | 'frozen' | 'closed';
  balanceMinor: string;
  createdAt: string;
}

export interface JournalEntry {
  id: string;
  transactionId: string;
  direction: 'debit' | 'credit';
  amountMinor: string;
  currency: Currency;
  createdAt: string;
}

export interface Transfer {
  id: string;
  sourceAccountId: string;
  destinationAccountId: string;
  amountMinor: string;
  currency: Currency;
  status: string;
  reference: string;
  createdAt: string;
}

export interface Principal {
  id: string;
  name: string;
  status: string;
  createdAt: string;
}

export interface IssuedApiKey {
  id: string;
  principalId: string;
  keyPrefix: string;
  key: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface FundingResult {
  id: string;
  amountMinor: string;
  currency: Currency;
  fundedAccountId: string;
  createdAt: string;
}

export interface ReconciliationReport {
  ok: boolean;
  accountsChecked: number;
  generatedAt: string;
  issues: {
    accountId: string;
    type: 'mismatched' | 'missing' | 'unexpected';
    cachedBalanceMinor?: string;
    computedBalanceMinor?: string;
    currency?: string;
  }[];
}

export interface Readiness {
  status: string;
  outbox?: { pending: number; processing: number; failed: number };
}

/** Every API error has the same `{ error: { code, message, requestId } }` envelope. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
  }

  /** A rolled-back failure that is always correct to retry with the same Idempotency-Key. */
  get retryable(): boolean {
    return this.code === 'TRANSFER_RETRY_EXHAUSTED' || this.code === 'IDEMPOTENCY_IN_PROGRESS';
  }
}

type Auth = 'customer' | 'admin' | 'none';

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  options: {
    auth: Auth;
    body?: unknown;
    headers?: Record<string, string>;
    /** Checks a candidate credential without storing it; a rejection then clears nothing. */
    credential?: string;
  },
): Promise<T> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  // Customer credential: an API key explicitly chosen in this tab wins; otherwise the signed-in
  // Firebase user's ID token. The API accepts either as a bearer credential.
  let usedApiKey = false;
  if (options.auth === 'customer') {
    const apiKey = options.credential ?? readCredential('customerKey');
    usedApiKey = apiKey !== null && options.credential === undefined;
    headers.authorization = `Bearer ${apiKey ?? (await currentIdToken()) ?? ''}`;
  } else if (options.auth === 'admin') {
    headers['x-admin-api-key'] = options.credential ?? readCredential('adminKey') ?? '';
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the PulseLedger API. Is it running?');
  }

  const text = await response.text();
  const payload: unknown = text ? safeJson(text) : undefined;

  if (!response.ok) {
    const envelope = (
      payload as { error?: { code?: string; message?: string; requestId?: string } }
    )?.error;
    // A rejected credential is dropped so the UI falls back to the sign-in screen instead of
    // repeating the same 401 on every request.
    // A Firebase session is left alone: its token refreshes itself, and signing the user out on
    // a misconfigured server would only hide the real error.
    if (
      response.status === 401 &&
      options.credential === undefined &&
      (options.auth === 'admin' || usedApiKey)
    ) {
      writeCredential(options.auth === 'customer' ? 'customerKey' : 'adminKey', null);
    }
    throw new ApiError(
      response.status,
      envelope?.code ?? `HTTP_${response.status}`,
      envelope?.message ?? (response.statusText || 'Request failed'),
      envelope?.requestId,
    );
  }
  return payload as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export const api = {
  // Customer
  listAccounts: () => request<{ accounts: Account[] }>('GET', '/v1/accounts', { auth: 'customer' }),
  createAccount: (currency: Currency) =>
    request<Account>('POST', '/v1/accounts', { auth: 'customer', body: { currency } }),
  getAccount: (id: string) =>
    request<Account>('GET', `/v1/accounts/${encodeURIComponent(id)}`, { auth: 'customer' }),
  listEntries: (id: string, cursor?: string, limit = 20) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    return request<{ entries: JournalEntry[]; nextCursor: string | null }>(
      'GET',
      `/v1/accounts/${encodeURIComponent(id)}/entries?${query}`,
      { auth: 'customer' },
    );
  },
  createTransfer: (
    input: { sourceAccountId: string; destinationAccountId: string; amountMinor: string },
    idempotencyKey: string,
  ) =>
    request<Transfer>('POST', '/v1/transfers', {
      auth: 'customer',
      body: input,
      headers: { 'idempotency-key': idempotencyKey },
    }),
  getTransfer: (id: string) =>
    request<Transfer>('GET', `/v1/transfers/${encodeURIComponent(id)}`, { auth: 'customer' }),

  // Admin
  createPrincipal: (name: string) =>
    request<Principal>('POST', '/v1/admin/principals', { auth: 'admin', body: { name } }),
  issueApiKey: (principalId: string) =>
    request<IssuedApiKey>(
      'POST',
      `/v1/admin/principals/${encodeURIComponent(principalId)}/api-keys`,
      { auth: 'admin' },
    ),
  revokeApiKey: (keyId: string) =>
    request<{ id: string; revoked: boolean }>(
      'POST',
      `/v1/admin/api-keys/${encodeURIComponent(keyId)}/revoke`,
      { auth: 'admin' },
    ),
  fund: (accountId: string, amountMinor: string) =>
    request<FundingResult>('POST', '/v1/admin/fund', {
      auth: 'admin',
      body: { accountId, amountMinor },
    }),
  reconcile: () => request<ReconciliationReport>('POST', '/v1/admin/reconcile', { auth: 'admin' }),
  metrics: () =>
    request<{ transfers: { completed: number; retries: number; exhausted: number } }>(
      'GET',
      '/v1/admin/metrics',
      { auth: 'admin' },
    ),

  // Credential checks for the login pages: prove a key works before it is stored anywhere.
  verifyCustomerKey: (key: string) =>
    request<{ accounts: Account[] }>('GET', '/v1/accounts', { auth: 'customer', credential: key }),
  verifyAdminKey: (key: string) =>
    request<unknown>('GET', '/v1/admin/metrics', { auth: 'admin', credential: key }),

  // Public
  ready: async (): Promise<Readiness> => {
    try {
      return await request<Readiness>('GET', '/health/ready', { auth: 'none' });
    } catch (error) {
      if (error instanceof ApiError && error.status === 503) return { status: 'unavailable' };
      throw error;
    }
  },
};
