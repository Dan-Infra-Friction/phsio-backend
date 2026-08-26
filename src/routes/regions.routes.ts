import { Router } from 'express';
import { protect } from '../middleware/auth';
import {
  getRegions,
  createRegion,
  updateRegion,
  deleteRegion,
} from '../controllers/regions.controller';

const router = Router();

router.use(protect);

router.get('/', getRegions);
router.post('/', createRegion);
router.put('/:id', updateRegion);
router.delete('/:id', deleteRegion);

export default router;
