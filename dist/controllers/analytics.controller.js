"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getChartsData = exports.getAnalyticsSummary = void 0;
const db_1 = __importDefault(require("../config/db"));
const getAnalyticsSummary = async (req, res, next) => {
    try {
        const userId = req.user.id;
        // 1. Total Patients
        const totalPatients = await db_1.default.patient.count({ where: { userId } });
        // 2. Total Messages (sent + received)
        const totalMessages = await db_1.default.message.count({
            where: { conversation: { userId } },
        });
        // 3. Today's Chat Volume (Conversations with activity today)
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayChats = await db_1.default.conversation.count({
            where: {
                userId,
                lastMessageAt: { gte: today },
            },
        });
        // 4. AI Replies
        const aiReplies = await db_1.default.message.count({
            where: {
                conversation: { userId },
                sender: 'AI',
            },
        });
        // 5. Upcoming Appointments
        const upcomingAppointments = await db_1.default.appointment.count({
            where: {
                userId,
                status: 'UPCOMING',
                dateTime: { gte: new Date() },
            },
        });
        // 6. Knowledge Base Documents
        const kbDocuments = await db_1.default.knowledgeBase.count({
            where: { userId },
        });
        return res.status(200).json({
            success: true,
            data: {
                totalPatients,
                totalMessages,
                todayChats,
                aiReplies,
                upcomingAppointments,
                kbDocuments,
            },
        });
    }
    catch (error) {
        next(error);
    }
};
exports.getAnalyticsSummary = getAnalyticsSummary;
const getChartsData = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const { timeframe } = req.query; // daily, weekly, monthly, yearly
        let analyticsLogs = [];
        const today = new Date();
        if (timeframe === 'weekly') {
            // Last 7 days
            const pastDate = new Date();
            pastDate.setDate(today.getDate() - 7);
            analyticsLogs = await db_1.default.analytics.findMany({
                where: {
                    userId,
                    date: { gte: pastDate },
                },
                orderBy: { date: 'asc' },
            });
        }
        else if (timeframe === 'monthly') {
            // Last 30 days
            const pastDate = new Date();
            pastDate.setDate(today.getDate() - 30);
            analyticsLogs = await db_1.default.analytics.findMany({
                where: {
                    userId,
                    date: { gte: pastDate },
                },
                orderBy: { date: 'asc' },
            });
        }
        else if (timeframe === 'yearly') {
            // Last 12 months (grouped by month in database or aggregated)
            const pastDate = new Date();
            pastDate.setFullYear(today.getFullYear() - 1);
            analyticsLogs = await db_1.default.analytics.findMany({
                where: {
                    userId,
                    date: { gte: pastDate },
                },
                orderBy: { date: 'asc' },
            });
        }
        else {
            // Daily (default) - last 24 hours or last 7 days daily log
            const pastDate = new Date();
            pastDate.setDate(today.getDate() - 7); // Default to last 7 days to show a nice trend
            analyticsLogs = await db_1.default.analytics.findMany({
                where: {
                    userId,
                    date: { gte: pastDate },
                },
                orderBy: { date: 'asc' },
            });
        }
        // Format logs for charts: e.g., mapping date to a readable string
        const formattedLogs = analyticsLogs.map((log) => {
            const logDate = new Date(log.date);
            return {
                date: logDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                patients: log.patientsCount,
                messages: log.messagesCount,
                aiReplies: log.aiRepliesCount,
                appointments: log.appointmentsCount,
                kbDocs: log.kbDocsCount,
            };
        });
        // If database is empty, generate some beautiful mock seed data for initial dashboard rendering
        if (formattedLogs.length === 0) {
            const dummyData = [];
            for (let i = 6; i >= 0; i--) {
                const d = new Date();
                d.setDate(today.getDate() - i);
                dummyData.push({
                    date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                    patients: Math.floor(Math.random() * 5) + 1,
                    messages: Math.floor(Math.random() * 30) + 10,
                    aiReplies: Math.floor(Math.random() * 25) + 5,
                    appointments: Math.floor(Math.random() * 3),
                    kbDocs: 1,
                });
            }
            return res.status(200).json({
                success: true,
                data: dummyData,
                isMocked: true,
            });
        }
        return res.status(200).json({
            success: true,
            data: formattedLogs,
            isMocked: false,
        });
    }
    catch (error) {
        next(error);
    }
};
exports.getChartsData = getChartsData;
