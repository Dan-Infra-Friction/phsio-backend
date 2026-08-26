import { Router } from 'express';
import { protect } from '../middleware/auth';
import { getSettings, updateSettings } from '../controllers/settings.controller';

const router = Router();

router.use(protect);

router.get('/', getSettings);
router.put('/', updateSettings);

export default router;
