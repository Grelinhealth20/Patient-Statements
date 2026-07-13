import { createApp } from './app.js';
import { env } from './config/env.js';
import { ensureReady } from './ready.js';

/**
 * Traditional (non-serverless) entry point. Initialises the DB + schema up front
 * so the process fails fast on a bad configuration, then starts listening.
 * On Vercel this file is not used — see /api/index.js.
 */
async function bootstrap() {
  try {
    console.log('[boot] Preparing database + schema...');
    await ensureReady();
    console.log('[boot] Database ready.');

    const app = createApp();
    app.listen(env.port, () => {
      console.log(`\n  Statement Generator API listening on http://localhost:${env.port}`);
      console.log(`  Environment: ${env.nodeEnv}\n`);
    });
  } catch (err) {
    console.error('[boot] Fatal startup error:', err);
    process.exit(1);
  }
}

bootstrap();
