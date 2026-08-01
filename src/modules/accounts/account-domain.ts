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

export interface AccountStore {
  create(input: CreateAccountInput): Promise<Account>;
  findById(id: string): Promise<Account | null>;
}
