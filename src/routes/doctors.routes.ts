import { Router } from 'express';
import { protect } from '../middleware/auth';
import {
  getDoctors,
  createDoctor,
  updateDoctor,
  deleteDoctor,
} from '../controllers/doctors.controller';

const router = Router();

router.use(protect);

router.get('/', getDoctors);
router.post('/', createDoctor);
router.put('/:id', updateDoctor);
router.delete('/:id', deleteDoctor);

export default router;
