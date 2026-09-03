import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import prisma from '../config/db';

export const getSettings = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;

    let settings = await prisma.setting.findUnique({
      where: { userId },
    });

    // If no settings exist for some reason, create default settings
    if (!settings) {
      settings = await prisma.setting.create({
        data: { userId },
      });
    }

    // Upgrade legacy generic PhysioBot placeholder if present
    if (settings && (!settings.welcomeMessage || settings.welcomeMessage.includes('Welcome to our clinic! I am PhysioBot'))) {
      const cName = settings.clinicName || 'Dr asad ai';
      const cPhone = settings.phone || '+91 6378062237';
      const cAddr = settings.clinicAddress || 'Vasundhara hospital jodhpur rajasthan';
      const cWeb = settings.website || 'https://www.myomotion.co.in/';
      settings.welcomeMessage = `👋 Hello! Welcome to *${cName}*!\n\n🤖 AI Assistant Disclaimer:\nI am DR. ASAD AI, your automated clinical assistant. I am here to help you get registered and guide you through your rehabilitation intake. Please note that while I can answer clinic questions and gather details, I do not provide medical diagnosis or replace human practitioners.\n\n📍 Clinic Details:\n• Address: ${cAddr}\n• Phone: ${cPhone}\n• Website: ${cWeb}`;
    }

    // Do not send full API keys to the frontend for security.
    // Instead, send a masked version or booleans indicating if keys are set.
    let apiKeys: Record<string, string> = {};
    try {
      apiKeys = JSON.parse(settings.apiKeys || '{}');
    } catch {
      apiKeys = {};
    }

    const maskedKeys: Record<string, boolean> = {};
    Object.keys(apiKeys).forEach((key) => {
      maskedKeys[key] = !!apiKeys[key];
    });

    const responseData = {
      ...settings,
      apiKeys: maskedKeys, // Return indicator of set keys
    };

    return res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    next(error);
  }
};

export const updateSettings = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const {
      clinicName,
      clinicLogo,
      clinicAddress,
      phone,
      website,
      workingHours,
      aiPersonality,
      welcomeMessage,
      onboardingQuestions,
      autoReplyEnabled,
      languages,
      notificationSettings,
      aiProvider,
      aiModel,
      apiKeys, // JSON object containing new keys
      availableSlotsText,
      onboardingSlots,
      onboardingPollTitle,
      onboardingPollOptions,
      onboardingPollStep,
      onboardingPollPdfs,
    } = req.body;

    const existingSettings = await prisma.setting.findUnique({
      where: { userId },
    });

    if (!existingSettings) {
      return res.status(404).json({
        success: false,
        message: 'Settings not found.',
      });
    }

    // Merge API keys
    let mergedKeys: Record<string, string> = {};
    try {
      mergedKeys = JSON.parse(existingSettings.apiKeys || '{}');
    } catch {
      mergedKeys = {};
    }

    if (apiKeys && typeof apiKeys === 'object') {
      Object.keys(apiKeys).forEach((provider) => {
        const value = apiKeys[provider];
        if (value === '') {
          // If empty string is sent, clear that key
          delete mergedKeys[provider];
        } else if (value) {
          // Update key
          mergedKeys[provider] = value;
        }
      });
    }

    const updateData: any = {
      clinicName,
      clinicLogo,
      clinicAddress,
      phone,
      website,
      workingHours: workingHours ? JSON.stringify(workingHours) : undefined,
      aiPersonality,
      welcomeMessage,
      onboardingQuestions: onboardingQuestions ? (Array.isArray(onboardingQuestions) ? JSON.stringify(onboardingQuestions) : onboardingQuestions) : undefined,
      autoReplyEnabled: autoReplyEnabled !== undefined ? Boolean(autoReplyEnabled) : undefined,
      languages: languages ? JSON.stringify(languages) : undefined,
      notificationSettings: notificationSettings ? JSON.stringify(notificationSettings) : undefined,
      aiProvider,
      aiModel,
      apiKeys: JSON.stringify(mergedKeys),
      availableSlotsText,
      onboardingSlots: onboardingSlots ? (Array.isArray(onboardingSlots) ? JSON.stringify(onboardingSlots) : onboardingSlots) : undefined,
      onboardingPollTitle,
      onboardingPollOptions: onboardingPollOptions ? (Array.isArray(onboardingPollOptions) ? JSON.stringify(onboardingPollOptions) : onboardingPollOptions) : undefined,
      onboardingPollStep: onboardingPollStep !== undefined ? Number(onboardingPollStep) : undefined,
      onboardingPollPdfs: onboardingPollPdfs ? (typeof onboardingPollPdfs === 'object' ? JSON.stringify(onboardingPollPdfs) : onboardingPollPdfs) : undefined,
    };

    let updated: any;
    try {
      updated = await prisma.setting.update({
        where: { userId },
        data: updateData,
      });
    } catch (updateErr: any) {
      if (updateErr?.message && updateErr.message.includes('onboardingPollPdfs')) {
        console.warn('[Settings Controller] onboardingPollPdfs not in active Prisma DMMF yet, falling back without field');
        delete updateData.onboardingPollPdfs;
        updated = await prisma.setting.update({
          where: { userId },
          data: updateData,
        });
      } else {
        throw updateErr;
      }
    }

    // Return masked settings to frontend
    const maskedKeys: Record<string, boolean> = {};
    Object.keys(mergedKeys).forEach((key) => {
      maskedKeys[key] = !!mergedKeys[key];
    });

    const responseData = {
      ...updated,
      apiKeys: maskedKeys,
    };

    return res.status(200).json({
      success: true,
      message: 'Settings updated successfully.',
      data: responseData,
    });
  } catch (error) {
    next(error);
  }
};

export const uploadPollPdf = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No PDF file uploaded.' });
    }
    const publicUrl = `/uploads/documents/${req.file.filename}`;
    return res.status(200).json({
      success: true,
      data: {
        url: publicUrl,
        fileName: req.file.originalname,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message || 'PDF upload failed.' });
  }
};
