/**
 * Loads `.env` before anything reads configuration.
 *
 * This module must be imported *first* in every entry point, because
 * `lib/logger.ts` calls `env()` while its own module body is evaluating — by
 * the time a later import runs, the configuration has already been read.
 *
 * Variables already present in the environment are never overwritten, so a
 * container, a CI job or an inline `DATABASE_URL=… npm run …` always wins over
 * the file. The more specific file wins between the two candidates, for the
 * same reason: dotenv skips keys that are already set.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));

// `src/` and `dist/` both sit one level below apps/api, so the package
// directory is one up and the workspace root three up, either way.
const packageDir = resolve(here, '..');
const repoRoot = resolve(here, '..', '..', '..');

for (const candidate of [resolve(packageDir, '.env'), resolve(repoRoot, '.env')]) {
  if (existsSync(candidate)) {
    dotenv.config({ path: candidate });
  }
}
