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

    // Update settings in database
    const updated = await prisma.setting.update({
      where: { userId },
      data: {
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
      },
    });

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
