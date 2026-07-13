import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { ensureReady } from './ready.js';
import authRoutes from './routes/authRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import statementRoutes from './routes/statementRoutes.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      origin: env.clientOrigin.split(',').map((o) => o.trim()),
      credentials: true,
    })
  );
  // Larger cap so bulk statement imports (thousands of DOS rows) are accepted;
  // still bounded to prevent oversized-payload abuse.
  app.use(express.json({ limit: '12mb' }));
  app.use(cookieParser());
  if (env.nodeEnv !== 'test') {
    app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));
  }

  // Ensure the DB pool + schema are ready before handling any API request.
  // Cached after the first call, so this is effectively free on warm instances
  // and makes the app safe to run as a Vercel serverless function.
  app.use('/api', async (req, res, next) => {
    try {
      await ensureReady();
      next();
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/health', (req, res) =>
    res.json({ status: 'ok', service: 'statement-generator-api', time: new Date().toISOString() })
  );

  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/statements', statementRoutes);

  // 404
  app.use((req, res) => res.status(404).json({ message: 'Resource not found.' }));

  // Central error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // eslint-disable-next-line no-console
    console.error('[error]', err);
    res.status(err.status || 500).json({
      message: env.nodeEnv === 'production' ? 'An unexpected error occurred.' : err.message,
    });
  });

  return app;
}
