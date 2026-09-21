import { createServer } from 'node:http';
import { createApp } from './app.js';
import { closePool, query } from './db/pool.js';
import { env, loadEnv } from './env.js';
import { logger } from './lib/logger.js';
import { runMigrations } from './db/migrate.js';
import { Scheduler } from './jobs/scheduler.js';
import { RealtimeGateway } from './realtime/gateway.js';

async function main(): Promise<void> {
  // Validate configuration before anything opens a socket.
  loadEnv();

  if (process.env.RUN_MIGRATIONS_ON_BOOT !== 'false') {
    const { applied } = await runMigrations();
    if (applied.length > 0) logger.info({ applied }, 'applied pending migrations on boot');
  }
  await query('SELECT 1');

  const app = createApp();
  const server = createServer(app);
  const gateway = new RealtimeGateway(server);

  const scheduler = new Scheduler();
  if (process.env.RUN_JOBS !== 'false') scheduler.start();

  server.listen(env().PORT, () => {
    logger.info({ port: env().PORT, env: env().NODE_ENV }, 'TeamSpace API listening');
  });

  // Graceful shutdown: stop accepting work, close sockets, drain the pool.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    scheduler.stop();
    await gateway.close();
    server.close();
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
}

main().catch((error) => {
  logger.error({ err: error }, 'failed to start the API');
  process.exit(1);
});
