import type {
  Account,
  AccountApplication,
  AccountStore,
  CreateAccountInput,
} from './account-domain.js';
import {
  decodeOwnedAccountsCursor,
  encodeOwnedAccountsCursor,
  ownedAccountsDefaultLimit,
  ownedAccountsMaxLimit,
  type OwnedAccountsPage,
} from './account-domain.js';

export class AccountService implements AccountApplication {
  public constructor(private readonly store: AccountStore) {}

  public async create(input: CreateAccountInput, ownerPrincipalId: string): Promise<Account> {
    return await this.store.create(input, ownerPrincipalId);
  }

  public async findOwnedById(id: string, ownerPrincipalId: string): Promise<Account | null> {
    return await this.store.findOwnedById(id, ownerPrincipalId);
  }

  public async listOwned(
    ownerPrincipalId: string,
    options: { cursor?: string | undefined; limit?: number | undefined } = {},
  ): Promise<OwnedAccountsPage> {
    const requested = options.limit;
    const limit =
      requested !== undefined && Number.isInteger(requested) && requested >= 1
        ? Math.min(requested, ownedAccountsMaxLimit)
        : ownedAccountsDefaultLimit;
    const page = await this.store.listOwned(ownerPrincipalId, {
      cursor: options.cursor ? decodeOwnedAccountsCursor(options.cursor) : undefined,
      limit,
    });
    return {
      accounts: page.accounts,
      nextCursor: page.nextCursor ? encodeOwnedAccountsCursor(page.nextCursor) : null,
    };
  }
}
