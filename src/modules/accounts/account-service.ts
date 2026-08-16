import type {
  Account,
  AccountApplication,
  AccountStore,
  CreateAccountInput,
} from './account-domain.js';

export class AccountService implements AccountApplication {
  public constructor(private readonly store: AccountStore) {}

  public async create(input: CreateAccountInput, ownerPrincipalId: string): Promise<Account> {
    return await this.store.create(input, ownerPrincipalId);
  }

  public async findOwnedById(id: string, ownerPrincipalId: string): Promise<Account | null> {
    return await this.store.findOwnedById(id, ownerPrincipalId);
  }
}
