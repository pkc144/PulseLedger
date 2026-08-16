/**
 * Builds a realistic baseline dataset by driving the real application services (never raw SQL),
 * so every seeded row obeys the same invariants production traffic would: balanced postings,
 * no overdraft, immutable journal. Used to give EXPLAIN ANALYZE and the k6 scenarios enough
 * volume that PostgreSQL's planner behaves the way it would in a real deployment, rather than
 * trivially seq-scanning a handful of rows.
 *
 * Usage: SEED_ACCOUNTS=200 SEED_TRANSFERS=2000 npm run seed
 */
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/infrastructure/database/pool.js';
import { runMigrations } from '../src/infrastructure/database/migrate.js';
import { PostgresAccountStore } from '../src/modules/accounts/account-repository.js';
import { AccountService } from '../src/modules/accounts/account-service.js';
import { PostgresAuthStore } from '../src/modules/auth/auth-repository.js';
import { AuthService } from '../src/modules/auth/auth-service.js';
import { PostgresLedgerStore } from '../src/modules/ledger/ledger-repository.js';
import { LedgerPostingService } from '../src/modules/ledger/ledger-service.js';
import { PostgresTransferStore } from '../src/modules/transfers/transfer-repository.js';
import { TransferService } from '../src/modules/transfers/transfer-service.js';

const currencies = ['INR', 'USD'] as const;
type Currency = (typeof currencies)[number];

const accountCount = readPositiveInt(process.env.SEED_ACCOUNTS, 200);
const transferCount = readPositiveInt(process.env.SEED_TRANSFERS, 2_000);

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(items: readonly T[]): T {
  return items[randomInt(0, items.length - 1)]!;
}

const config = loadConfig();
const pool = createPool(config.databaseUrl);

async function main(): Promise<void> {
  await runMigrations(pool);

  // No outbox store injected: seed data intentionally never writes outbox events, so it doesn't
  // hand the worker thousands of synthetic events to drain before a benchmark even starts.
  const accountService = new AccountService(new PostgresAccountStore(pool));
  const authService = new AuthService(new PostgresAuthStore(pool));
  const ledgerService = new LedgerPostingService(new PostgresLedgerStore(pool));
  const transferService = new TransferService(new PostgresTransferStore(pool));

  // Seeded accounts need an owner like any other. One principal owns the whole synthetic dataset,
  // and its key is printed so a benchmark or manual session can drive this data over HTTP.
  const principal = await authService.createPrincipal(`seed-${new Date().toISOString()}`);
  const issued = await authService.issueApiKey(principal.id);
  console.log(`Seed principal: ${principal.id}`);
  console.log(`Seed API key:   ${issued.key}`);

  const accountsByCurrency: Record<Currency, string[]> = { INR: [], USD: [] };
  const startedAt = Date.now();

  console.log(`Seeding ${accountCount} accounts...`);
  for (let i = 0; i < accountCount; i += 1) {
    const currency = pick(currencies);
    const account = await accountService.create({ currency }, principal.id);
    accountsByCurrency[currency].push(account.id);
    await ledgerService.fundAccount({
      accountId: account.id,
      amountMinor: randomInt(10_000, 1_000_000).toString(),
    });
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${accountCount} accounts funded`);
  }

  console.log(`Posting ${transferCount} transfers...`);
  let succeeded = 0;
  let failed = 0;
  for (let i = 0; i < transferCount; i += 1) {
    const currency = pick(currencies);
    const candidates = accountsByCurrency[currency];
    if (candidates.length < 2) continue;

    const sourceAccountId = pick(candidates);
    let destinationAccountId = pick(candidates);
    while (destinationAccountId === sourceAccountId) destinationAccountId = pick(candidates);

    try {
      await transferService.create(
        {
          sourceAccountId,
          destinationAccountId,
          amountMinor: randomInt(1, 5_000).toString(),
        },
        principal.id,
      );
      succeeded += 1;
    } catch {
      // Insufficient funds and similar rejections are expected and realistic; the goal is
      // volume and shape, not a 100% success rate.
      failed += 1;
    }
    if ((i + 1) % 200 === 0) console.log(`  ${i + 1}/${transferCount} transfers attempted`);
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `Seed complete: ${accountCount} accounts, ${succeeded} transfers succeeded, ` +
      `${failed} rejected, ${elapsedMs}ms elapsed`,
  );
}

try {
  await main();
} finally {
  await pool.end();
}
