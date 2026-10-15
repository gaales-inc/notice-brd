/**
 * PGlite: Postgres compiled to WebAssembly, run in-process. The tests use it,
 * and so does local development (PGLITE_DIR), so neither needs a database
 * server. Production never loads this file: it is only imported dynamically.
 */
import { PGlite } from "@electric-sql/pglite";
import { Db, Queryable } from "./db";

export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const pg = new PGlite(dataDir);
  await pg.waitReady;
  const wrap = (runner: { query: PGlite["query"] }): Queryable => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await runner.query(sql, params as any[]);
      return { rows: result.rows as T[] };
    },
  });
  return {
    ...wrap(pg),
    async exec(sql) {
      await pg.exec(sql);
    },
    transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))),
    close: () => pg.close(),
  };
}
