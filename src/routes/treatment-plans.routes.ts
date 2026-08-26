import { Router } from 'express';
import { protect } from '../middleware/auth';
import {
  getTreatmentPlans,
  createTreatmentPlan,
  updateTreatmentPlan,
  deleteTreatmentPlan,
  sendTreatmentPlanReminder,
} from '../controllers/treatment-plans.controller';

const router = Router();

router.use(protect);

router.get('/', getTreatmentPlans);
router.post('/', createTreatmentPlan);
router.post('/:id/send-reminder', sendTreatmentPlanReminder);
router.put('/:id', updateTreatmentPlan);
router.patch('/:id', updateTreatmentPlan);
router.delete('/:id', deleteTreatmentPlan);

export default router;
