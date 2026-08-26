import { Router } from 'express';
import { protect } from '../middleware/auth';
import {
  connectWhatsApp,
  requestPairingCode,
  disconnectWhatsApp,
  getWhatsAppStatus,
  sendManualMessage,
} from '../controllers/whatsapp.controller';

const router = Router();

router.use(protect); // Secure all WhatsApp endpoints

router.post('/connect', connectWhatsApp);
router.post('/pairing-code', requestPairingCode);
router.post('/disconnect', disconnectWhatsApp);
router.get('/status', getWhatsAppStatus);
router.post('/send', sendManualMessage);

export default router;
