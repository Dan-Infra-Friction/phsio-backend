"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const express_rate_limit_1 = require("express-rate-limit");
const dotenv_1 = __importDefault(require("dotenv"));
// Load environment variables
dotenv_1.default.config();
const auth_routes_1 = __importDefault(require("./routes/auth.routes"));
const whatsapp_routes_1 = __importDefault(require("./routes/whatsapp.routes"));
const patients_routes_1 = __importDefault(require("./routes/patients.routes"));
const chats_routes_1 = __importDefault(require("./routes/chats.routes"));
const appointments_routes_1 = __importDefault(require("./routes/appointments.routes"));
const knowledge_routes_1 = __importDefault(require("./routes/knowledge.routes"));
const settings_routes_1 = __importDefault(require("./routes/settings.routes"));
const notifications_routes_1 = __importDefault(require("./routes/notifications.routes"));
const analytics_routes_1 = __importDefault(require("./routes/analytics.routes"));
const error_1 = __importDefault(require("./middleware/error"));
const socket_service_1 = require("./services/socket.service");
const whatsapp_service_1 = require("./services/whatsapp.service");
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
const PORT = process.env.PORT || 5000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
// 1. Core Security Middlewares
app.use((0, helmet_1.default)({
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allows loading local media in frontend
}));
app.use((0, cors_1.default)({
    origin: FRONTEND_URL,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
}));
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
// 2. Local Storage Directories Setup
const storageDirs = [
    path_1.default.join(process.cwd(), 'storage'),
    path_1.default.join(process.cwd(), 'storage', 'sessions'),
    path_1.default.join(process.cwd(), 'storage', 'uploads'),
    path_1.default.join(process.cwd(), 'storage', 'uploads', 'pdf'),
    path_1.default.join(process.cwd(), 'storage', 'uploads', 'images'),
    path_1.default.join(process.cwd(), 'storage', 'uploads', 'audio'),
    path_1.default.join(process.cwd(), 'storage', 'uploads', 'video'),
    path_1.default.join(process.cwd(), 'storage', 'uploads', 'documents'),
    path_1.default.join(process.cwd(), 'storage', 'uploads', 'avatars'),
    path_1.default.join(process.cwd(), 'storage', 'backups'),
];
storageDirs.forEach((dir) => {
    if (!fs_1.default.existsSync(dir)) {
        fs_1.default.mkdirSync(dir, { recursive: true });
        console.log(`[Storage] Created directory: ${dir}`);
    }
});
// Serve uploaded files statically
app.use('/uploads', express_1.default.static(path_1.default.join(process.cwd(), 'storage', 'uploads')));
// 3. Rate Limiting
const apiLimiter = (0, express_rate_limit_1.rateLimit)({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 200, // Limit each IP to 200 requests per windowMs
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
        success: false,
        message: 'Too many requests from this IP, please try again after 15 minutes.',
    },
});
app.use('/api/', apiLimiter);
// 4. API Routes
app.use('/api/auth', auth_routes_1.default);
app.use('/api/whatsapp', whatsapp_routes_1.default);
app.use('/api/patients', patients_routes_1.default);
app.use('/api/chats', chats_routes_1.default);
app.use('/api/appointments', appointments_routes_1.default);
app.use('/api/kb', knowledge_routes_1.default);
app.use('/api/settings', settings_routes_1.default);
app.use('/api/notifications', notifications_routes_1.default);
app.use('/api/analytics', analytics_routes_1.default);
// Base route health check
app.get('/health', (req, res) => {
    res.status(200).json({ success: true, status: 'healthy', timestamp: new Date() });
});
// 5. Global Error Handler
app.use(error_1.default);
// 6. Socket.io Initialization
socket_service_1.SocketService.initialize(server);
// 7. Start Server & Restore WhatsApp Sessions
server.listen(PORT, async () => {
    console.log(`====================================================`);
    console.log(` PhysioBot Backend running on: http://localhost:${PORT}`);
    console.log(` Socket.io server initialized securely`);
    console.log(`====================================================`);
    // Restore active sessions on startup
    await whatsapp_service_1.WhatsappService.restoreSessions();
});
