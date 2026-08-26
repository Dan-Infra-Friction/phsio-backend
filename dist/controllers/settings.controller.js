"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateSettings = exports.getSettings = void 0;
const db_1 = __importDefault(require("../config/db"));
const getSettings = async (req, res, next) => {
    try {
        const userId = req.user.id;
        let settings = await db_1.default.setting.findUnique({
            where: { userId },
        });
        // If no settings exist for some reason, create default settings
        if (!settings) {
            settings = await db_1.default.setting.create({
                data: { userId },
            });
        }
        // Do not send full API keys to the frontend for security.
        // Instead, send a masked version or booleans indicating if keys are set.
        let apiKeys = {};
        try {
            apiKeys = JSON.parse(settings.apiKeys || '{}');
        }
        catch {
            apiKeys = {};
        }
        const maskedKeys = {};
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
    }
    catch (error) {
        next(error);
    }
};
exports.getSettings = getSettings;
const updateSettings = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const { clinicName, clinicLogo, clinicAddress, phone, website, workingHours, aiPersonality, welcomeMessage, onboardingQuestions, autoReplyEnabled, languages, notificationSettings, aiProvider, aiModel, apiKeys, // JSON object containing new keys
         } = req.body;
        const existingSettings = await db_1.default.setting.findUnique({
            where: { userId },
        });
        if (!existingSettings) {
            return res.status(404).json({
                success: false,
                message: 'Settings not found.',
            });
        }
        // Merge API keys
        let mergedKeys = {};
        try {
            mergedKeys = JSON.parse(existingSettings.apiKeys || '{}');
        }
        catch {
            mergedKeys = {};
        }
        if (apiKeys && typeof apiKeys === 'object') {
            Object.keys(apiKeys).forEach((provider) => {
                const value = apiKeys[provider];
                if (value === '') {
                    // If empty string is sent, clear that key
                    delete mergedKeys[provider];
                }
                else if (value) {
                    // Update key
                    mergedKeys[provider] = value;
                }
            });
        }
        // Update settings in database
        const updated = await db_1.default.setting.update({
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
            },
        });
        // Return masked settings to frontend
        const maskedKeys = {};
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
    }
    catch (error) {
        next(error);
    }
};
exports.updateSettings = updateSettings;
