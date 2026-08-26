"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteAppointment = exports.updateAppointment = exports.createAppointment = exports.getAppointments = void 0;
const appointment_service_1 = require("../services/appointment.service");
const db_1 = __importDefault(require("../config/db"));
const getAppointments = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const { start, end, status } = req.query;
        const whereClause = {
            userId,
        };
        if (status) {
            whereClause.status = String(status);
        }
        if (start && end) {
            whereClause.dateTime = {
                gte: new Date(String(start)),
                lte: new Date(String(end)),
            };
        }
        const appointments = await db_1.default.appointment.findMany({
            where: whereClause,
            include: {
                patient: true,
            },
            orderBy: { dateTime: 'asc' },
        });
        return res.status(200).json({
            success: true,
            count: appointments.length,
            data: appointments,
        });
    }
    catch (error) {
        next(error);
    }
};
exports.getAppointments = getAppointments;
const createAppointment = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const { patientId, dateTime, title, notes } = req.body;
        if (!patientId || !dateTime) {
            return res.status(400).json({
                success: false,
                message: 'Patient ID and date/time are required.',
            });
        }
        const date = new Date(dateTime);
        if (isNaN(date.getTime())) {
            return res.status(400).json({
                success: false,
                message: 'Invalid date/time format.',
            });
        }
        const result = await appointment_service_1.AppointmentService.bookAppointment(userId, patientId, date, title || 'Physiotherapy Session', notes || 'Booked manually from dashboard');
        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.message,
            });
        }
        return res.status(201).json({
            success: true,
            message: 'Appointment booked successfully.',
            data: result.appointment,
        });
    }
    catch (error) {
        next(error);
    }
};
exports.createAppointment = createAppointment;
const updateAppointment = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;
        const { dateTime, status, title, notes } = req.body;
        // Check if appointment exists and belongs to the user
        const appointment = await db_1.default.appointment.findFirst({
            where: { id, userId },
        });
        if (!appointment) {
            return res.status(404).json({
                success: false,
                message: 'Appointment not found.',
            });
        }
        const updateData = {};
        if (status)
            updateData.status = status;
        if (title)
            updateData.title = title;
        if (notes !== undefined)
            updateData.notes = notes;
        if (dateTime) {
            const newDate = new Date(dateTime);
            if (isNaN(newDate.getTime())) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid date/time format.',
                });
            }
            // If date is changing, check availability (excluding this appointment itself)
            if (newDate.getTime() !== appointment.dateTime.getTime()) {
                const isAvailable = await appointment_service_1.AppointmentService.checkAvailability(userId, newDate);
                if (!isAvailable) {
                    return res.status(400).json({
                        success: false,
                        message: 'Selected slot is already booked. Please choose another time.',
                    });
                }
                updateData.dateTime = newDate;
            }
        }
        const updatedAppointment = await db_1.default.appointment.update({
            where: { id },
            data: updateData,
            include: { patient: true },
        });
        return res.status(200).json({
            success: true,
            message: 'Appointment updated successfully.',
            data: updatedAppointment,
        });
    }
    catch (error) {
        next(error);
    }
};
exports.updateAppointment = updateAppointment;
const deleteAppointment = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;
        const appointment = await db_1.default.appointment.findFirst({
            where: { id, userId },
        });
        if (!appointment) {
            return res.status(404).json({
                success: false,
                message: 'Appointment not found.',
            });
        }
        await db_1.default.appointment.delete({
            where: { id },
        });
        return res.status(200).json({
            success: true,
            message: 'Appointment deleted successfully.',
        });
    }
    catch (error) {
        next(error);
    }
};
exports.deleteAppointment = deleteAppointment;
