import type {
  ReconciliationApplication,
  ReconciliationReport,
  ReconciliationStore,
} from './reconciliation-domain.js';

export class ReconciliationService implements ReconciliationApplication {
  public constructor(private readonly store: ReconciliationStore) {}

  public async run(): Promise<ReconciliationReport> {
    return await this.store.run();
  }
}
