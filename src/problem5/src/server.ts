import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPostgresDatabase } from './db/client.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger(config);
const database = createPostgresDatabase(config.DATABASE_URL, config.DB_POOL_MAX);
const app = createApp({ config, db: database.db, logger });

const server = app.listen(config.PORT, (error) => {
  if (error) {
    logger.fatal({ err: error }, 'failed to start server');
    process.exit(1);
  }
  logger.info({ port: config.PORT, auth: Boolean(config.API_KEY) }, 'server listening');
});

/** Stop accepting connections, let in-flight requests finish, then close the connection pool. */
function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'shutting down');
  setTimeout(() => {
    logger.error('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000).unref();

  server.close(async () => {
    await database.close();
    logger.info('shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
