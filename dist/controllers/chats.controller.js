"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.restartChat = exports.deleteChat = exports.markAsRead = exports.getIncomingMessages = exports.toggleAiOverride = exports.getMessages = exports.getConversations = void 0;
const db_1 = __importDefault(require("../config/db"));
const whatsapp_service_1 = require("../services/whatsapp.service");
const getConversations = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const conversations = await db_1.default.conversation.findMany({
            where: { userId },
            include: {
                patient: true,
                messages: {
                    orderBy: { timestamp: 'desc' },
                    take: 1, // Only get the last message for the preview
                },
            },
            orderBy: { lastMessageAt: 'desc' },
        });
        // Calculate true unread count using groupBy
        const unreadCounts = await db_1.default.message.groupBy({
            by: ['conversationId'],
            where: {
                conversation: { userId },
                sender: 'PATIENT',
                status: { not: 'READ' },
            },
            _count: {
                _all: true,
            },
        });
        const unreadCountMap = new Map();
        unreadCounts.forEach((item) => {
            unreadCountMap.set(item.conversationId, item._count._all);
        });
        // Format conversations for the UI
        const formattedConversations = conversations.map((conv) => {
            const lastMsg = conv.messages[0] || null;
            return {
                id: conv.id,
                patientId: conv.patientId,
                patientName: conv.patient.name,
                patientPhone: conv.patient.phone,
                patientPhoto: conv.patient.profilePhoto,
                isAiEnabled: conv.isAiEnabled,
                lastMessage: lastMsg ? lastMsg.body : 'No messages yet',
                lastMessageTime: conv.lastMessageAt,
                lastMessageSender: lastMsg ? lastMsg.sender : null,
                lastMessageType: lastMsg ? lastMsg.type : 'text',
                unreadCount: unreadCountMap.get(conv.id) || 0,
                status: conv.patient.status,
            };
        });
        return res.status(200).json({
            success: true,
            data: formattedConversations,
        });
    }
    catch (error) {
        next(error);
    }
};
exports.getConversations = getConversations;
const getMessages = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const { conversationId } = req.params;
        // Verify conversation belongs to the user
        const conversation = await db_1.default.conversation.findFirst({
            where: { id: conversationId, userId },
            include: { patient: true },
        });
        if (!conversation) {
            return res.status(404).json({
                success: false,
                message: 'Conversation not found.',
            });
        }
        // Mark messages as read in database
        await db_1.default.message.updateMany({
            where: {
                conversationId,
                sender: 'PATIENT',
                status: { not: 'READ' },
            },
            data: {
                status: 'READ',
            },
        });
        // Mark as read on WhatsApp
        whatsapp_service_1.WhatsappService.markChatAsRead(userId, conversation.patient.phone).catch((err) => {
            console.error('[WhatsApp] Failed to mark WhatsApp chat as read:', err);
        });
        const messages = await db_1.default.message.findMany({
            where: { conversationId },
            orderBy: { timestamp: 'asc' },
        });
        return res.status(200).json({
            success: true,
            data: messages,
        });
    }
    catch (error) {
        next(error);
    }
};
exports.getMessages = getMessages;
const toggleAiOverride = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const { conversationId } = req.params;
        const { isAiEnabled } = req.body;
        if (isAiEnabled === undefined) {
            return res.status(400).json({
                success: false,
                message: 'isAiEnabled boolean is required.',
            });
        }
        // Verify and update conversation
        const conversation = await db_1.default.conversation.findFirst({
            where: { id: conversationId, userId },
        });
        if (!conversation) {
            return res.status(404).json({
                success: false,
                message: 'Conversation not found.',
            });
        }
        const updated = await db_1.default.conversation.update({
            where: { id: conversationId },
            data: { isAiEnabled: Boolean(isAiEnabled) },
        });
        return res.status(200).json({
            success: true,
            message: `AI replies have been ${updated.isAiEnabled ? 'enabled' : 'paused'} for this patient.`,
            data: {
                id: updated.id,
                isAiEnabled: updated.isAiEnabled,
            },
        });
    }
    catch (error) {
        next(error);
    }
};
exports.toggleAiOverride = toggleAiOverride;
const getIncomingMessages = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const incomingMessages = await db_1.default.message.findMany({
            where: {
                sender: 'PATIENT',
                conversation: {
                    userId,
                },
            },
            include: {
                conversation: {
                    include: {
                        patient: true,
                    },
                },
            },
            orderBy: { timestamp: 'desc' },
            take: 50,
        });
        const formattedMessages = incomingMessages.map((msg) => ({
            id: msg.id,
            conversationId: msg.conversationId,
            body: msg.body,
            type: msg.type,
            mediaUrl: msg.mediaUrl,
            timestamp: msg.timestamp,
            patientName: msg.conversation.patient.name,
            patientPhone: msg.conversation.patient.phone,
            patientId: msg.conversation.patient.id,
        }));
        return res.status(200).json({
            success: true,
            data: formattedMessages,
        });
    }
    catch (error) {
        next(error);
    }
};
exports.getIncomingMessages = getIncomingMessages;
const markAsRead = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const { conversationId } = req.params;
        // Verify conversation belongs to the user
        const conversation = await db_1.default.conversation.findFirst({
            where: { id: conversationId, userId },
            include: { patient: true },
        });
        if (!conversation) {
            return res.status(404).json({
                success: false,
                message: 'Conversation not found.',
            });
        }
        // Mark messages as read in database
        const updateResult = await db_1.default.message.updateMany({
            where: {
                conversationId,
                sender: 'PATIENT',
                status: { not: 'READ' },
            },
            data: {
                status: 'READ',
            },
        });
        // Mark as read on WhatsApp
        await whatsapp_service_1.WhatsappService.markChatAsRead(userId, conversation.patient.phone).catch((err) => {
            console.error('[WhatsApp] Failed to mark WhatsApp chat as read:', err);
        });
        return res.status(200).json({
            success: true,
            message: 'Conversation marked as read.',
            data: {
                conversationId,
                count: updateResult.count,
            },
        });
    }
    catch (error) {
        next(error);
    }
};
exports.markAsRead = markAsRead;
const deleteChat = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const { conversationId } = req.params;
        const conversation = await db_1.default.conversation.findFirst({
            where: { id: conversationId, userId },
            include: { patient: true },
        });
        if (!conversation) {
            return res.status(404).json({ success: false, message: 'Conversation not found.' });
        }
        // Delete messages from database
        await db_1.default.message.deleteMany({
            where: { conversationId },
        });
        // Delete conversation from database
        await db_1.default.conversation.delete({
            where: { id: conversationId },
        });
        // Reset patient last message info
        await db_1.default.patient.update({
            where: { id: conversation.patient.id },
            data: { lastMessage: null, lastSeen: null },
        });
        // Clear chat on WhatsApp
        await whatsapp_service_1.WhatsappService.clearChatHistory(userId, conversation.patient.phone).catch((err) => {
            console.error('[WhatsApp] Failed to clear chat history on WhatsApp:', err);
        });
        return res.status(200).json({ success: true, message: 'Chat deleted permanently.' });
    }
    catch (error) {
        next(error);
    }
};
exports.deleteChat = deleteChat;
const restartChat = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const { conversationId } = req.params;
        const conversation = await db_1.default.conversation.findFirst({
            where: { id: conversationId, userId },
            include: { patient: true },
        });
        if (!conversation) {
            return res.status(404).json({ success: false, message: 'Conversation not found.' });
        }
        // Delete messages
        await db_1.default.message.deleteMany({
            where: { conversationId },
        });
        // Reset conversation last message time and AI status
        await db_1.default.conversation.update({
            where: { id: conversationId },
            data: { lastMessageAt: new Date(), isAiEnabled: true },
        });
        // Reset patient onboarding state
        await db_1.default.patient.update({
            where: { id: conversation.patient.id },
            data: {
                lastMessage: null,
                lastSeen: new Date(),
                onboardingStep: 0,
                onboardingAnswers: '{}',
                onboardingSummary: null,
            },
        });
        // Clear chat on WhatsApp
        await whatsapp_service_1.WhatsappService.clearChatHistory(userId, conversation.patient.phone).catch((err) => {
            console.error('[WhatsApp] Failed to clear chat history on WhatsApp:', err);
        });
        return res.status(200).json({ success: true, message: 'Chat restarted successfully.' });
    }
    catch (error) {
        next(error);
    }
};
exports.restartChat = restartChat;
