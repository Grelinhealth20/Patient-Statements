// Serverless entry point for the Statement Generator API.
//
// The host invokes an exported Express app as (req, res), so we simply build the
// same app used locally. The app lazily initialises the DB pool + schema on the
// first request per instance (see backend/src/ready.js), which is the correct
// pattern for serverless. All routes are mounted under /api and reached here via
// the platform's rewrite config.
import { createApp } from '../backend/src/app.js';

// Give the function headroom for the cold-start path (lazy DB pool + schema init)
// and outbound calls to Google (Address Validation / Billing Catalog) and S3, so a
// first request on a fresh instance never trips the platform's default timeout.
export const config = { maxDuration: 30 };

const app = createApp();

export default app;
