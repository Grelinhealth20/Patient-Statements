// Vercel serverless entry point for the Statement Generator API.
//
// Vercel invokes an exported Express app as (req, res), so we simply build the
// same app used locally. The app lazily initialises the DB pool + schema on the
// first request per instance (see backend/src/ready.js), which is the correct
// pattern for serverless. All routes are mounted under /api and reached here via
// the rewrite in vercel.json.
import { createApp } from '../backend/src/app.js';

const app = createApp();

export default app;
