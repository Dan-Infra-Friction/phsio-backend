import { Router } from 'express';
import { protect } from '../middleware/auth';
import { getAnalyticsSummary, getChartsData } from '../controllers/analytics.controller';

const router = Router();

router.use(protect);

router.get('/summary', getAnalyticsSummary);
router.get('/charts', getChartsData);

export default router;
