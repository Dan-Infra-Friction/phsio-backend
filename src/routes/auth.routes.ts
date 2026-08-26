import { Router } from 'express';
import { signup, login, refresh, forgotPassword, sendWhatsappOtp, verifyWhatsappOtp } from '../controllers/auth.controller';

const router = Router();

router.post('/signup', signup);
router.post('/login', login);
router.post('/refresh', refresh);
router.post('/forgot-password', forgotPassword);
router.post('/send-whatsapp-otp', sendWhatsappOtp);
router.post('/verify-whatsapp-otp', verifyWhatsappOtp);

export default router;
