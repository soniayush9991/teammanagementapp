import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: env().DATABASE_URL,
      max: env().DATABASE_POOL_MAX,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      // Cap statements so a pathological query cannot hold a pooled
      // connection open indefinitely.
      statement_timeout: 15_000,
    });
    pool.on('error', (error) => logger.error({ err: error }, 'idle postgres client error'));
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  const started = Date.now();
  const result = await getPool().query<T>(text, params as unknown[]);
  const duration = Date.now() - started;
  if (duration > 250) {
    logger.warn({ duration, sql: text.slice(0, 160) }, 'slow query');
  }
  return result;
}

export async function queryRows<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  return (await query<T>(text, params)).rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await queryRows<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Runs `fn` inside a transaction, rolling back on any throw. Every write that
 * touches more than one table goes through this.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackError) => {
      logger.error({ err: rollbackError }, 'rollback failed');
    });
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = null;
}
