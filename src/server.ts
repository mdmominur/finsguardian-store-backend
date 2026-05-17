import { buildApp } from './app.js';
import { env } from './config/env.js';
import { pool } from './db/client.js';
import { isMailConfigured, verifyMailConfiguration } from './services/mail.service.js';

async function main() {
  const app = await buildApp();

  try {
    // 1. Test database connection
    const client = await pool.connect();
    app.log.info('Database connected successfully');
    client.release();

    // 2. Test SMTP connection if configured
    if (isMailConfigured()) {
      app.log.info('Testing SMTP connection...');
      const smtpCheck = await verifyMailConfiguration();
      if (smtpCheck.success) {
        app.log.info('SMTP connection established successfully');
      } else {
        const mailErr = smtpCheck.error;
        const errMsg = mailErr instanceof Error ? mailErr.message : String(mailErr);
        app.log.warn(`SMTP CONFIGURATION WARNING: ${errMsg}`);
        console.error('\x1b[33m%s\x1b[0m', '⚠️  SMTP CONFIGURATION ERROR DETECTED ON STARTUP:');
        console.error(mailErr);
        console.error(
          '\x1b[33m%s\x1b[0m',
          `EXPLANATION:\n` +
          `  The server tried to connect to SMTP server at ${env.MAIL_HOST}:${env.MAIL_PORT} but failed.\n` +
          `  This indicates a hosting firewall port block or incorrect .env settings.\n` +
          `  Since SMTP is blocked, OTP emails will FAIL to send!\n` +
          `  Please update backend/.env with correct details or ask host provider to unblock ports.\n`
        );
      }
    } else {
      app.log.warn('SMTP is not configured in .env. Email/OTP sending is disabled.');
    }

    // 3. Start web server
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`Listening on http://${env.HOST}:${env.PORT}`);
  } catch (err) {
    app.log.error(err, 'Startup failed');
    console.error('\x1b[31m%s\x1b[0m', 'CRITICAL STARTUP ERROR:', err instanceof Error ? err.message : err);
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
