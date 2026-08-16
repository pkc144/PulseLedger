export const supportedCurrencies = ['INR', 'USD'] as const;
export type SupportedCurrency = (typeof supportedCurrencies)[number];

export interface Account {
  balanceMinor: string;
  createdAt: string;
  currency: SupportedCurrency;
  id: string;
  status: 'active' | 'frozen' | 'closed';
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
}

export interface AccountApplication {
  create(input: CreateAccountInput, ownerPrincipalId: string): Promise<Account>;
  findOwnedById(id: string, ownerPrincipalId: string): Promise<Account | null>;
}
