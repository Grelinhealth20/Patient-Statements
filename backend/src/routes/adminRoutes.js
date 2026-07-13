import { Router } from 'express';
import {
  listUsers,
  stats,
  createUser,
  updateUser,
  setStatementAccess,
  resetPassword,
  deleteUser,
} from '../controllers/adminController.js';
import { requireAuth, requireSuperAdmin, blockIfPasswordChangeRequired } from '../middleware/auth.js';

const router = Router();

// Every admin route requires an authenticated super administrator whose password is
// already set (a temp-password account must reset it first).
router.use(requireAuth, blockIfPasswordChangeRequired, requireSuperAdmin);

router.get('/stats', stats);
router.get('/users', listUsers);
router.post('/users', createUser);
router.put('/users/:id', updateUser);
router.patch('/users/:id/access', setStatementAccess);
router.post('/users/:id/reset-password', resetPassword);
router.delete('/users/:id', deleteUser);

export default router;
