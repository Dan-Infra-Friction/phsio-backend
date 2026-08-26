import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { WhatsappService } from '../services/whatsapp.service';
import prisma from '../config/db';

export const connectWhatsApp = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    
    // Initialize Baileys client
    await WhatsappService.initializeClient(userId);
    
    return res.status(200).json({
      success: true,
      message: 'WhatsApp client initialization started. QR code will be sent via socket.',
    });
  } catch (error) {
    next(error);
  }
};

export const requestPairingCode = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        message: 'Phone number is required to generate pairing code.',
      });
    }

    const code = await WhatsappService.requestPairingCode(userId, phoneNumber);

    return res.status(200).json({
      success: true,
      message: 'Pairing code generated successfully.',
      data: { code },
    });
  } catch (error) {
    next(error);
  }
};

export const disconnectWhatsApp = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const success = await WhatsappService.disconnectClient(userId);
    
    if (success) {
      return res.status(200).json({
        success: true,
        message: 'WhatsApp disconnected successfully.',
      });
    } else {
      return res.status(400).json({
        success: false,
        message: 'No active WhatsApp session found to disconnect.',
      });
    }
  } catch (error) {
    next(error);
  }
};

export const getWhatsAppStatus = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    
    const session = await prisma.whatsappSession.findUnique({
      where: { userId },
    });

    return res.status(200).json({
      success: true,
      data: session || { status: 'DISCONNECTED', phone: null, profileName: null, qrCode: null },
    });
  } catch (error) {
    next(error);
  }
};

export const sendManualMessage = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { patientId, message } = req.body;

    if (!patientId || !message) {
      return res.status(400).json({
        success: false,
        message: 'Please provide patientId and message body.',
      });
    }

    const patient = await prisma.patient.findUnique({
      where: { id: patientId },
    });

    if (!patient) {
      return res.status(404).json({
        success: false,
        message: 'Patient not found.',
      });
    }

    const client = WhatsappService.getClient(userId);
    if (!client) {
      return res.status(400).json({
        success: false,
        message: 'WhatsApp client is not active. Please connect first.',
      });
    }

    const session = await prisma.whatsappSession.findUnique({ where: { userId } });
    if (session?.status !== 'CONNECTED') {
      return res.status(400).json({
        success: false,
        message: 'WhatsApp is disconnected. Please link your account.',
      });
    }

    // Send message via WhatsApp
    await client.sendMessage(patient.phone, message);

    // Save message to database as HUMAN
    let conversation = await prisma.conversation.findUnique({
      where: {
        userId_patientId: {
          userId,
          patientId: patient.id,
        },
      },
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: { userId, patientId: patient.id },
      });
    }

    const savedMsg = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        sender: 'HUMAN',
        body: message,
        type: 'text',
        timestamp: new Date(),
      },
    });

    // Update last message in patient
    await prisma.patient.update({
      where: { id: patient.id },
      data: { lastMessage: message, lastSeen: new Date() },
    });

    // Update conversation lastMessageAt
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() },
    });

    return res.status(200).json({
      success: true,
      data: savedMsg,
    });
  } catch (error) {
    next(error);
  }
};
