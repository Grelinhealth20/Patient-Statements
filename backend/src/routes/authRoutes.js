import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { login, refresh, me, logout, changePassword } from '../controllers/authController.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Throttle credential-guessing on the login endpoint.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts. Please try again in a few minutes.' },
});

router.post('/login', loginLimiter, login);
router.post('/refresh', refresh);
router.get('/me', requireAuth, me);
router.post('/logout', requireAuth, logout);
router.post('/change-password', requireAuth, changePassword);

export default router;
