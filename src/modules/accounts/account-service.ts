import type {
  Account,
  AccountApplication,
  AccountStore,
  CreateAccountInput,
} from './account-domain.js';

export class AccountService implements AccountApplication {
  public constructor(private readonly store: AccountStore) {}

  public async create(input: CreateAccountInput): Promise<Account> {
    return await this.store.create(input);
  }

  public async findById(id: string): Promise<Account | null> {
    return await this.store.findById(id);
  }
}
