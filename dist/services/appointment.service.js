"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppointmentService = void 0;
const db_1 = __importDefault(require("../config/db"));
const socket_service_1 = require("./socket.service");
class AppointmentService {
    /**
     * Check if a given slot is already booked for a user.
     */
    static async checkAvailability(userId, dateTime) {
        // Standard appointment slot is 45 minutes
        const slotStart = new Date(dateTime);
        const slotEnd = new Date(dateTime.getTime() + 45 * 60 * 1000);
        const conflict = await db_1.default.appointment.findFirst({
            where: {
                userId,
                status: 'UPCOMING',
                dateTime: {
                    gte: new Date(slotStart.getTime() - 44 * 60 * 1000), // overlapping range
                    lte: slotEnd,
                },
            },
        });
        return !conflict;
    }
    /**
     * Book an appointment for a patient.
     */
    static async bookAppointment(userId, patientId, dateTime, title, notes) {
        try {
            const isAvailable = await this.checkAvailability(userId, dateTime);
            if (!isAvailable) {
                return {
                    success: false,
                    message: 'This time slot is already booked. Please choose another time.',
                };
            }
            // Check if working hours permit
            const settings = await db_1.default.setting.findUnique({ where: { userId } });
            if (settings) {
                const workingHours = JSON.parse(settings.workingHours || '{}');
                const dayOfWeek = dateTime
                    .toLocaleDateString('en-US', { weekday: 'short' })
                    .toLowerCase(); // mon, tue, etc.
                const hours = workingHours[dayOfWeek];
                if (!hours || hours.length === 0) {
                    return {
                        success: false,
                        message: `The clinic is closed on ${dateTime.toLocaleDateString('en-US', { weekday: 'long' })}.`,
                    };
                }
                const [startStr, endStr] = hours;
                const timeStr = dateTime.toTimeString().split(' ')[0].substring(0, 5); // "HH:MM"
                if (timeStr < startStr || timeStr > endStr) {
                    return {
                        success: false,
                        message: `Selected time ${timeStr} is outside working hours (${startStr} to ${endStr}).`,
                    };
                }
            }
            const appointment = await db_1.default.appointment.create({
                data: {
                    userId,
                    patientId,
                    dateTime,
                    title: title || 'Physiotherapy Consultation',
                    notes: notes || 'Booked automatically by PhysioBot',
                    status: 'UPCOMING',
                },
                include: {
                    patient: true,
                },
            });
            // Send real-time notification
            await db_1.default.notification.create({
                data: {
                    userId,
                    type: 'APPOINTMENT',
                    title: 'New Appointment Booked',
                    message: `Appointment scheduled for ${appointment.patient.name} on ${dateTime.toLocaleString()}`,
                },
            });
            socket_service_1.SocketService.sendToUser(userId, 'notification', {
                type: 'APPOINTMENT',
                title: 'New Appointment Booked',
                message: `Appointment scheduled for ${appointment.patient.name} on ${dateTime.toLocaleString()}`,
            });
            socket_service_1.SocketService.sendToUser(userId, 'appointment_created', appointment);
            return {
                success: true,
                message: 'Appointment booked successfully.',
                appointment,
            };
        }
        catch (err) {
            console.error('[Booking Error]:', err);
            return { success: false, message: 'Failed to book appointment due to database error.' };
        }
    }
    /**
     * Cancel an appointment.
     */
    static async cancelAppointment(userId, patientId, dateTime) {
        try {
            const whereClause = {
                userId,
                patientId,
                status: 'UPCOMING',
            };
            if (dateTime) {
                // Find appointment within a 1-hour window of the specified date
                const start = new Date(dateTime.getTime() - 30 * 60 * 1000);
                const end = new Date(dateTime.getTime() + 30 * 60 * 1000);
                whereClause.dateTime = { gte: start, lte: end };
            }
            const appointment = await db_1.default.appointment.findFirst({
                where: whereClause,
                orderBy: { dateTime: 'asc' },
            });
            if (!appointment) {
                return {
                    success: false,
                    message: 'No upcoming appointment was found to cancel.',
                };
            }
            await db_1.default.appointment.update({
                where: { id: appointment.id },
                data: { status: 'CANCELLED' },
            });
            // Send real-time notification
            await db_1.default.notification.create({
                data: {
                    userId,
                    type: 'APPOINTMENT',
                    title: 'Appointment Cancelled',
                    message: `Appointment for patient has been cancelled.`,
                },
            });
            socket_service_1.SocketService.sendToUser(userId, 'notification', {
                type: 'APPOINTMENT',
                title: 'Appointment Cancelled',
                message: `An appointment has been cancelled.`,
            });
            socket_service_1.SocketService.sendToUser(userId, 'appointment_updated', { id: appointment.id, status: 'CANCELLED' });
            return {
                success: true,
                message: 'Appointment cancelled successfully.',
            };
        }
        catch (err) {
            console.error('[Cancellation Error]:', err);
            return { success: false, message: 'Failed to cancel appointment.' };
        }
    }
    /**
     * Reschedule an appointment.
     */
    static async rescheduleAppointment(userId, patientId, newDateTime) {
        try {
            // Find the next upcoming appointment
            const appointment = await db_1.default.appointment.findFirst({
                where: {
                    userId,
                    patientId,
                    status: 'UPCOMING',
                },
                orderBy: { dateTime: 'asc' },
            });
            if (!appointment) {
                return {
                    success: false,
                    message: 'No upcoming appointment was found to reschedule.',
                };
            }
            const isAvailable = await this.checkAvailability(userId, newDateTime);
            if (!isAvailable) {
                return {
                    success: false,
                    message: 'The new time slot is not available. Please choose another slot.',
                };
            }
            const updated = await db_1.default.appointment.update({
                where: { id: appointment.id },
                data: { dateTime: newDateTime },
            });
            socket_service_1.SocketService.sendToUser(userId, 'appointment_updated', updated);
            return {
                success: true,
                message: `Appointment rescheduled successfully to ${newDateTime.toLocaleString()}.`,
            };
        }
        catch (err) {
            console.error('[Reschedule Error]:', err);
            return { success: false, message: 'Failed to reschedule appointment.' };
        }
    }
    /**
     * Parse AI response for hidden tags and execute appointment actions.
     * Format of tag: [APPOINTMENT_ACTION: {"action": "BOOK"|"CANCEL"|"RESCHEDULE", "dateTime": "2026-06-29T15:00:00", "title": "..."}]
     */
    static async parseAiAction(userId, patientId, aiResponse) {
        const actionRegex = /\[APPOINTMENT_ACTION:\s*({.*?})\]/;
        const match = aiResponse.match(actionRegex);
        if (!match) {
            return { cleanResponse: aiResponse, actionResult: null };
        }
        const jsonStr = match[1];
        const cleanResponse = aiResponse.replace(actionRegex, '').trim();
        try {
            const data = JSON.parse(jsonStr);
            const action = data.action; // BOOK, CANCEL, RESCHEDULE
            const dateTimeStr = data.dateTime;
            const title = data.title || 'Physiotherapy Consultation';
            let resultMsg = '';
            if (action === 'BOOK' && dateTimeStr) {
                const dateTime = new Date(dateTimeStr);
                const res = await this.bookAppointment(userId, patientId, dateTime, title);
                resultMsg = res.message;
            }
            else if (action === 'CANCEL') {
                const dateTime = dateTimeStr ? new Date(dateTimeStr) : undefined;
                const res = await this.cancelAppointment(userId, patientId, dateTime);
                resultMsg = res.message;
            }
            else if (action === 'RESCHEDULE' && dateTimeStr) {
                const dateTime = new Date(dateTimeStr);
                const res = await this.rescheduleAppointment(userId, patientId, dateTime);
                resultMsg = res.message;
            }
            else {
                resultMsg = 'Invalid appointment action parameters.';
            }
            return {
                cleanResponse: `${cleanResponse}\n\n*(System Note: ${resultMsg})*`,
                actionResult: resultMsg,
            };
        }
        catch (err) {
            console.error('[AI Action Parse Error]:', err);
            return {
                cleanResponse,
                actionResult: 'Failed to process appointment action due to invalid formatting.',
            };
        }
    }
}
exports.AppointmentService = AppointmentService;
