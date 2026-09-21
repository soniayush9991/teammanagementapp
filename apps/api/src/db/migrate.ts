import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from './pool.js';
import { isMainModule } from '../lib/isMain.js';
import { logger } from '../lib/logger.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Forward-only migration runner. Each file runs once, inside a transaction,
 * and its checksum is recorded so an edited migration is caught rather than
 * silently diverging between environments.
 */
export async function runMigrations(): Promise<{ applied: string[]; skipped: string[] }> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM schema_migrations',
  );
  const alreadyApplied = new Map(rows.map((row) => [row.name, row.checksum]));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const previous = alreadyApplied.get(file);

    if (previous) {
      if (previous !== checksum) {
        throw new Error(
          `Migration ${file} was modified after being applied. Add a new migration instead of editing this one.`,
        );
      }
      skipped.push(file);
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
      await client.query('COMMIT');
      applied.push(file);
      logger.info({ migration: file }, 'migration applied');
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
    } finally {
      client.release();
    }
  }

  // Messages are partitioned monthly; make sure this month and next exist so
  // an insert never lands outside a partition range.
  const now = new Date();
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  await pool.query('SELECT ensure_message_partition($1::date)', [now.toISOString().slice(0, 10)]);
  await pool.query('SELECT ensure_message_partition($1::date)', [nextMonth.toISOString().slice(0, 10)]);

  return { applied, skipped };
}

// `npm run db:migrate`
if (isMainModule(import.meta.url)) {
  runMigrations()
    .then(({ applied, skipped }) => {
      logger.info({ applied: applied.length, skipped: skipped.length }, 'migrations complete');
      console.log(`Applied ${applied.length} migration(s), ${skipped.length} already up to date.`);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
