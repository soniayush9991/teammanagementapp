import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * True when `moduleUrl` is the file node was launched with, so a module can
 * double as a library and a CLI entry point. Paths are realpath'd because tsx
 * and npm scripts may resolve through symlinks.
 */
export function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(entry));
  } catch {
    return false;
  }
}
