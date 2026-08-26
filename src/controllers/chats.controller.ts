import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import prisma from '../config/db';
import { WhatsappService } from '../services/whatsapp.service';

export const getConversations = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;

    const conversations = await prisma.conversation.findMany({
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
    const unreadCounts = await prisma.message.groupBy({
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

    const unreadCountMap = new Map<string, number>();
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
        onboardingAnswers: conv.patient.onboardingAnswers,
        onboardingSummary: conv.patient.onboardingSummary,
      };
    });

    return res.status(200).json({
      success: true,
      data: formattedConversations,
    });
  } catch (error) {
    next(error);
  }
};

export const getMessages = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { conversationId } = req.params;

    // Verify conversation belongs to the user
    const conversation = await prisma.conversation.findFirst({
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
    await prisma.message.updateMany({
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
    WhatsappService.markChatAsRead(userId, conversation.patient.phone).catch((err) => {
      console.error('[WhatsApp] Failed to mark WhatsApp chat as read:', err);
    });

    const messages = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { timestamp: 'asc' },
    });

    return res.status(200).json({
      success: true,
      data: messages,
    });
  } catch (error) {
    next(error);
  }
};

export const toggleAiOverride = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { conversationId } = req.params;
    const { isAiEnabled } = req.body;

    if (isAiEnabled === undefined) {
      return res.status(400).json({
        success: false,
        message: 'isAiEnabled boolean is required.',
      });
    }

    // Verify and update conversation
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, userId },
    });

    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: 'Conversation not found.',
      });
    }

    const updated = await prisma.conversation.update({
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
  } catch (error) {
    next(error);
  }
};

export const getIncomingMessages = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;

    const incomingMessages = await prisma.message.findMany({
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
  } catch (error) {
    next(error);
  }
};

export const markAsRead = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { conversationId } = req.params;

    // Verify conversation belongs to the user
    const conversation = await prisma.conversation.findFirst({
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
    const updateResult = await prisma.message.updateMany({
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
    await WhatsappService.markChatAsRead(userId, conversation.patient.phone).catch((err) => {
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
  } catch (error) {
    next(error);
  }
};

export const deleteChat = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { conversationId } = req.params;

    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, userId },
      include: { patient: true },
    });

    if (!conversation) {
      return res.status(404).json({ success: false, message: 'Conversation not found.' });
    }

    // Delete messages from database
    await prisma.message.deleteMany({
      where: { conversationId },
    });

    // Delete conversation from database
    await prisma.conversation.delete({
      where: { id: conversationId },
    });

    // Reset patient last message info
    await prisma.patient.update({
      where: { id: conversation.patient.id },
      data: { lastMessage: null, lastSeen: null },
    });

    // Clear chat on WhatsApp
    await WhatsappService.clearChatHistory(userId, conversation.patient.phone).catch((err) => {
      console.error('[WhatsApp] Failed to clear chat history on WhatsApp:', err);
    });

    return res.status(200).json({ success: true, message: 'Chat deleted permanently.' });
  } catch (error) {
    next(error);
  }
};

export const restartChat = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { conversationId } = req.params;

    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, userId },
      include: { patient: true },
    });

    if (!conversation) {
      return res.status(404).json({ success: false, message: 'Conversation not found.' });
    }

    // Delete messages
    await prisma.message.deleteMany({
      where: { conversationId },
    });

    // Reset conversation last message time and AI status
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date(), isAiEnabled: true },
    });

    // Reset patient onboarding state
    await prisma.patient.update({
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
    await WhatsappService.clearChatHistory(userId, conversation.patient.phone).catch((err) => {
      console.error('[WhatsApp] Failed to clear chat history on WhatsApp:', err);
    });

    return res.status(200).json({ success: true, message: 'Chat restarted successfully.' });
  } catch (error) {
    next(error);
  }
};

export const sendMessage = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { conversationId } = req.params;
    const { body } = req.body;

    if (!body) {
      return res.status(400).json({ success: false, message: 'Message body is required.' });
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, userId },
      include: { patient: true },
    });

    if (!conversation) {
      return res.status(404).json({ success: false, message: 'Conversation not found.' });
    }

    // Send message via WhatsApp
    await WhatsappService.sendMessage(userId, conversation.patient.phone, body);

    // Create message in database
    const savedMsg = await prisma.message.create({
      data: {
        conversationId,
        sender: 'HUMAN',
        body,
        type: 'text',
        timestamp: new Date(),
      },
    });

    // Update last message in patient and conversation
    await prisma.patient.update({
      where: { id: conversation.patient.id },
      data: { lastMessage: body },
    });

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date() },
    });

    const { SocketService } = await import('../services/socket.service');
    SocketService.sendToUser(userId, 'new_message', {
      conversationId,
      message: savedMsg,
    });

    return res.status(201).json({
      success: true,
      message: 'Message sent successfully via WhatsApp.',
      data: savedMsg,
    });
  } catch (error) {
    next(error);
  }
};
