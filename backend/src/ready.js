import { initPool } from './config/db.js';
import { initSchema } from './config/initDb.js';

/**
 * Lazily initialises the DB pool and schema exactly once per runtime instance.
 * On a traditional server this runs at boot; on Vercel serverless it runs on the
 * first request of each cold-started instance and is cached thereafter.
 *
 * The promise is cleared on failure so a transient DB outage can be retried on
 * the next request rather than permanently poisoning the instance.
 */
let readyPromise;

export function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await initPool();
      await initSchema();
    })().catch((err) => {
      readyPromise = undefined;
      throw err;
    });
  }
  return readyPromise;
}
