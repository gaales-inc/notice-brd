import { Pool } from "pg";

export interface QueryResult<T> {
  rows: T[];
}

export interface Queryable {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/**
 * The slice of Postgres this service uses. Production runs it on `pg`; the
 * tests run the same SQL on PGlite, so nothing here may depend on a driver.
 */
export interface Db extends Queryable {
  /** Run several statements at once (schema setup). */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createPgDb(): Db {
  // The server reaches Postgres over the compose network, where TLS buys
  // nothing; an external DATABASE_URL can opt in with DB_SSL=true.
  const ssl = process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false;

  const pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL, ssl })
    : new Pool({
        host: process.env.DB_HOST || "localhost",
        port: parseInt(process.env.DB_PORT || "5432", 10),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl,
      });

  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const { rows } = await pool.query(sql, params);
      return { rows: rows as T[] };
    },

    async exec(sql: string) {
      await pool.query(sql);
    },

    async transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          async query<R>(sql: string, params: unknown[] = []) {
            const { rows } = await client.query(sql, params);
            return { rows: rows as R[] };
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },

    close: () => pool.end(),
  };
}
