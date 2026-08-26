"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const whatsapp_controller_1 = require("../controllers/whatsapp.controller");
const router = (0, express_1.Router)();
router.use(auth_1.protect); // Secure all WhatsApp endpoints
router.post('/connect', whatsapp_controller_1.connectWhatsApp);
router.post('/disconnect', whatsapp_controller_1.disconnectWhatsApp);
router.get('/status', whatsapp_controller_1.getWhatsAppStatus);
router.post('/send', whatsapp_controller_1.sendManualMessage);
exports.default = router;
