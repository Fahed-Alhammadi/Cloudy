import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { config } from './config.ts';

// bigint columns (sizes, ids) as JS numbers; safe up to 2^53.
pg.types.setTypeParser(20, (v: string) => Number(v));

// connectionTimeoutMillis: a request that finds all ten connections taken (writers waiting for one user's tree lock
// each hold one) gives up after ten seconds and is answered 503; without it every request of every user waited for
// as long as the writers did, with nothing to tell the apps to try again.
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 10_000 });
// An idle connection dropped by the server (restart, failover, idle timeout) is an 'error' event on the pool;
// without a listener it would bring the whole process down. The pool discards the client and reconnects on demand.
pool.on('error', (e) => console.error('database connection lost', e.message));

export type Db = pg.Pool | pg.PoolClient;

export const BUSY_MESSAGE = 'The server is busy, try again in a moment';

/**
 * The database had no free connection in time (the pool's own errors: no code, only these texts), or a write waited
 * too long for another one's lock (lock_timeout, SQLSTATE 55P03). Neither is a fault of the request: it is answered
 * 503, which the apps try again.
 */
export function isBusy(e: any): boolean {
  if (e?.code === '55P03') return true;
  return e instanceof Error && /^(timeout exceeded when trying to connect|Connection terminated due to connection timeout)$/.test(e.message);
}

export async function q<T = any>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T[]> {
  return (await db.query(sql, params)).rows as T[];
}

export async function one<T = any>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T | undefined> {
  return (await db.query(sql, params)).rows[0] as T | undefined;
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  // While a client is checked out the pool does not listen to its errors: a connection lost in the middle of a
  // transaction (database restart) would be an unhandled 'error' event and end the process. The query that was running
  // fails on its own; this only keeps the event from being fatal, and the broken client is discarded on release.
  let broken: Error | undefined;
  const onError = (e: Error) => {
    broken = e;
    console.error('database connection lost during a transaction', e.message);
  };
  c.on('error', onError);
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.removeListener('error', onError);
    c.release(broken);
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
