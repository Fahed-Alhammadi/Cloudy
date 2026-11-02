import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { config } from './config.ts';

// bigint columns (sizes, ids) as JS numbers; safe up to 2^53.
pg.types.setTypeParser(20, (v: string) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
// An idle connection dropped by the server (restart, failover, idle timeout) is an 'error' event on the pool;
// without a listener it would bring the whole process down. The pool discards the client and reconnects on demand.
pool.on('error', (e) => console.error('database connection lost', e.message));

export type Db = pg.Pool | pg.PoolClient;

export async function q<T = any>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T[]> {
  return (await db.query(sql, params)).rows as T[];
}

export async function one<T = any>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T | undefined> {
  return (await db.query(sql, params)).rows[0] as T | undefined;
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function migrate(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (e) {
      if (attempt >= 30) throw e;
      console.log(`waiting for database (${attempt})...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await pool.query(await readFile(config.schemaFile, 'utf8'));
}
