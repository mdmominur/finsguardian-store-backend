import { buildApp } from './app.js';
import { env } from './config/env.js';
import { pool } from './db/client.js';

async function main() {
  const app = await buildApp();

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`Listening on http://${env.HOST}:${env.PORT}`);
  } catch (err) {
    app.log.error(err);
    await pool.end().catch(() => undefined);
    process.exit(1);
  }

  const shutdown = async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
