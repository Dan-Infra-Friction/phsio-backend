"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendManualMessage = exports.getWhatsAppStatus = exports.disconnectWhatsApp = exports.connectWhatsApp = void 0;
const whatsapp_service_1 = require("../services/whatsapp.service");
const db_1 = __importDefault(require("../config/db"));
const connectWhatsApp = async (req, res, next) => {
    try {
        const userId = req.user.id;
        // Initialize or retrieve client
        const client = await whatsapp_service_1.WhatsappService.initializeClient(userId);
        return res.status(200).json({
            success: true,
            message: 'WhatsApp client initialization started. QR code will be sent via socket.',
        });
    }
    catch (error) {
        next(error);
    }
};
exports.connectWhatsApp = connectWhatsApp;
const disconnectWhatsApp = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const success = await whatsapp_service_1.WhatsappService.disconnectClient(userId);
        if (success) {
            return res.status(200).json({
                success: true,
                message: 'WhatsApp disconnected successfully.',
            });
        }
        else {
            return res.status(400).json({
                success: false,
                message: 'No active WhatsApp session found to disconnect.',
            });
        }
    }
    catch (error) {
        next(error);
    }
};
exports.disconnectWhatsApp = disconnectWhatsApp;
const getWhatsAppStatus = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const session = await db_1.default.whatsappSession.findUnique({
            where: { userId },
        });
        return res.status(200).json({
            success: true,
            data: session || { status: 'DISCONNECTED' },
        });
    }
    catch (error) {
        next(error);
    }
};
exports.getWhatsAppStatus = getWhatsAppStatus;
const sendManualMessage = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const { patientId, message } = req.body;
        if (!patientId || !message) {
            return res.status(400).json({
                success: false,
                message: 'Please provide patientId and message body.',
            });
        }
        const patient = await db_1.default.patient.findUnique({
            where: { id: patientId },
        });
        if (!patient) {
            return res.status(404).json({
                success: false,
                message: 'Patient not found.',
            });
        }
        const client = whatsapp_service_1.WhatsappService.getClient(userId);
        if (!client) {
            return res.status(400).json({
                success: false,
                message: 'WhatsApp client is not active. Please connect first.',
            });
        }
        const session = await db_1.default.whatsappSession.findUnique({ where: { userId } });
        if (session?.status !== 'CONNECTED') {
            return res.status(400).json({
                success: false,
                message: 'WhatsApp is disconnected. Please link your account.',
            });
        }
        // Send message via WhatsApp
        await client.sendMessage(patient.phone, message);
        // Save message to database as HUMAN
        let conversation = await db_1.default.conversation.findUnique({
            where: {
                userId_patientId: {
                    userId,
                    patientId: patient.id,
                },
            },
        });
        if (!conversation) {
            conversation = await db_1.default.conversation.create({
                data: { userId, patientId: patient.id },
            });
        }
        const savedMsg = await db_1.default.message.create({
            data: {
                conversationId: conversation.id,
                sender: 'HUMAN',
                body: message,
                type: 'text',
                timestamp: new Date(),
            },
        });
        // Update last message in patient
        await db_1.default.patient.update({
            where: { id: patient.id },
            data: { lastMessage: message, lastSeen: new Date() },
        });
        // Update conversation lastMessageAt
        await db_1.default.conversation.update({
            where: { id: conversation.id },
            data: { lastMessageAt: new Date() },
        });
        return res.status(200).json({
            success: true,
            data: savedMsg,
        });
    }
    catch (error) {
        next(error);
    }
};
exports.sendManualMessage = sendManualMessage;
