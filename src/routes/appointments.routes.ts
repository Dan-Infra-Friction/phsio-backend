import { Router } from 'express';
import { protect } from '../middleware/auth';
import {
  getAppointments,
  createAppointment,
  updateAppointment,
  deleteAppointment,
  sendAvailability,
} from '../controllers/appointments.controller';

const router = Router();

router.use(protect);

router.get('/', getAppointments);
router.post('/', createAppointment);
router.post('/send-availability', sendAvailability);
router.put('/:id', updateAppointment);
router.delete('/:id', deleteAppointment);

export default router;
