import { loadConfig } from '../../config.js';
import { createPool } from '../../infrastructure/database/pool.js';
import { PostgresReconciliationStore } from './reconciliation-repository.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);

try {
  const store = new PostgresReconciliationStore(pool);
  const report = await store.run();
  console.log(JSON.stringify(report, null, 2));

  if (report.ok) {
    console.log(`Reconciliation clean: ${report.accountsChecked} account(s) checked, 0 issues`);
  } else {
    console.error(`Reconciliation found ${report.issues.length} issue(s)`);
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
