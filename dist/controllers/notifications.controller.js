"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteNotification = exports.markAllAsRead = exports.markAsRead = exports.getNotifications = void 0;
const db_1 = __importDefault(require("../config/db"));
const getNotifications = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const notifications = await db_1.default.notification.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
        });
        return res.status(200).json({
            success: true,
            data: notifications,
        });
    }
    catch (error) {
        next(error);
    }
};
exports.getNotifications = getNotifications;
const markAsRead = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;
        const notification = await db_1.default.notification.findFirst({
            where: { id, userId },
        });
        if (!notification) {
            return res.status(404).json({
                success: false,
                message: 'Notification not found.',
            });
        }
        const updated = await db_1.default.notification.update({
            where: { id },
            data: { read: true },
        });
        return res.status(200).json({
            success: true,
            message: 'Notification marked as read.',
            data: updated,
        });
    }
    catch (error) {
        next(error);
    }
};
exports.markAsRead = markAsRead;
const markAllAsRead = async (req, res, next) => {
    try {
        const userId = req.user.id;
        await db_1.default.notification.updateMany({
            where: { userId, read: false },
            data: { read: true },
        });
        return res.status(200).json({
            success: true,
            message: 'All notifications marked as read.',
        });
    }
    catch (error) {
        next(error);
    }
};
exports.markAllAsRead = markAllAsRead;
const deleteNotification = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;
        const notification = await db_1.default.notification.findFirst({
            where: { id, userId },
        });
        if (!notification) {
            return res.status(404).json({
                success: false,
                message: 'Notification not found.',
            });
        }
        await db_1.default.notification.delete({
            where: { id },
        });
        return res.status(200).json({
            success: true,
            message: 'Notification deleted successfully.',
        });
    }
    catch (error) {
        next(error);
    }
};
exports.deleteNotification = deleteNotification;
