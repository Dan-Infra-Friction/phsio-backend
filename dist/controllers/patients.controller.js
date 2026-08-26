"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deletePatient = exports.updatePatient = exports.createPatient = exports.getPatientById = exports.getPatients = void 0;
const db_1 = __importDefault(require("../config/db"));
const getPatients = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const { search, tag, status } = req.query;
        const whereClause = {
            userId,
        };
        if (status) {
            whereClause.status = String(status);
        }
        if (search) {
            const searchStr = String(search);
            whereClause.OR = [
                { name: { contains: searchStr } },
                { phone: { contains: searchStr } },
                { email: { contains: searchStr } },
            ];
        }
        let patients = await db_1.default.patient.findMany({
            where: whereClause,
            orderBy: { updatedAt: 'desc' },
        });
        // Filter by tag in memory since SQLite stores tags as a JSON string
        if (tag) {
            const filterTag = String(tag).toLowerCase();
            patients = patients.filter((p) => {
                try {
                    const tagsArray = JSON.parse(p.tags || '[]');
                    return tagsArray.some((t) => t.toLowerCase() === filterTag);
                }
                catch {
                    return false;
                }
            });
        }
        return res.status(200).json({
            success: true,
            count: patients.length,
            data: patients,
        });
    }
    catch (error) {
        next(error);
    }
};
exports.getPatients = getPatients;
const getPatientById = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;
        const patient = await db_1.default.patient.findFirst({
            where: { id, userId },
            include: {
                appointments: {
                    orderBy: { dateTime: 'desc' },
                },
                conversations: {
                    include: {
                        messages: {
                            orderBy: { timestamp: 'asc' },
                        },
                    },
                },
            },
        });
        if (!patient) {
            return res.status(404).json({
                success: false,
                message: 'Patient not found.',
            });
        }
        return res.status(200).json({
            success: true,
            data: patient,
        });
    }
    catch (error) {
        next(error);
    }
};
exports.getPatientById = getPatientById;
const createPatient = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const { name, phone, email, tags, notes } = req.body;
        if (!name || !phone) {
            return res.status(400).json({
                success: false,
                message: 'Name and phone number are required.',
            });
        }
        // Standardize phone number for WhatsApp e.g. adding @c.us if not present
        let formattedPhone = phone.trim().replace(/[+\s-]/g, '');
        if (!formattedPhone.endsWith('@c.us')) {
            formattedPhone = `${formattedPhone}@c.us`;
        }
        // Check if patient already exists
        const existingPatient = await db_1.default.patient.findUnique({
            where: {
                userId_phone: {
                    userId,
                    phone: formattedPhone,
                },
            },
        });
        if (existingPatient) {
            return res.status(400).json({
                success: false,
                message: 'A patient with this phone number already exists.',
            });
        }
        // Format tags as a JSON string
        const formattedTags = Array.isArray(tags) ? JSON.stringify(tags) : '[]';
        const patient = await db_1.default.patient.create({
            data: {
                userId,
                name,
                phone: formattedPhone,
                email,
                tags: formattedTags,
                notes,
                status: 'ACTIVE',
            },
        });
        // Automatically create a blank conversation
        await db_1.default.conversation.create({
            data: {
                userId,
                patientId: patient.id,
            },
        });
        return res.status(201).json({
            success: true,
            message: 'Patient created successfully.',
            data: patient,
        });
    }
    catch (error) {
        next(error);
    }
};
exports.createPatient = createPatient;
const updatePatient = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;
        const { name, email, tags, notes, status, profilePhoto } = req.body;
        const patient = await db_1.default.patient.findFirst({
            where: { id, userId },
        });
        if (!patient) {
            return res.status(404).json({
                success: false,
                message: 'Patient not found.',
            });
        }
        const formattedTags = Array.isArray(tags) ? JSON.stringify(tags) : undefined;
        const updatedPatient = await db_1.default.patient.update({
            where: { id },
            data: {
                name,
                email,
                tags: formattedTags,
                notes,
                status,
                profilePhoto,
            },
        });
        return res.status(200).json({
            success: true,
            message: 'Patient updated successfully.',
            data: updatedPatient,
        });
    }
    catch (error) {
        next(error);
    }
};
exports.updatePatient = updatePatient;
const deletePatient = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;
        const patient = await db_1.default.patient.findFirst({
            where: { id, userId },
        });
        if (!patient) {
            return res.status(404).json({
                success: false,
                message: 'Patient not found.',
            });
        }
        await db_1.default.patient.delete({
            where: { id },
        });
        return res.status(200).json({
            success: true,
            message: 'Patient and all associated records deleted successfully.',
        });
    }
    catch (error) {
        next(error);
    }
};
exports.deletePatient = deletePatient;
