/**
 * Minimal database port used by feature-owned persistence adapters.
 *
 * Keeping this interface independent of `pg` lets application modules run
 * against test doubles while the process entrypoint supplies a real pool.
 */
export interface QueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

export interface Database {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}
