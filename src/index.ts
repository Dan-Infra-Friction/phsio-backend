import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import { rateLimit } from 'express-rate-limit';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

import authRoutes from './routes/auth.routes';
import whatsappRoutes from './routes/whatsapp.routes';
import patientsRoutes from './routes/patients.routes';
import chatsRoutes from './routes/chats.routes';
import appointmentsRoutes from './routes/appointments.routes';
import knowledgeRoutes from './routes/knowledge.routes';
import settingsRoutes from './routes/settings.routes';
import notificationsRoutes from './routes/notifications.routes';
import analyticsRoutes from './routes/analytics.routes';
import treatmentPlansRoutes from './routes/treatment-plans.routes';
import exercisesRoutes from './routes/exercises.routes';
import doctorsRoutes from './routes/doctors.routes';
import regionsRoutes from './routes/regions.routes';

import errorHandler from './middleware/error';
import { SocketService } from './services/socket.service';
import { WhatsappService } from './services/whatsapp.service';
import { TreatmentReminderService } from './services/treatment-reminder.service';

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 5000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// 1. Core Security Middlewares
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allows loading local media in frontend
    contentSecurityPolicy: false, // Disable strict CSP to prevent extension and local script blocks
  })
);

app.use(
  cors({
    origin: FRONTEND_URL,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 2. Local Storage Directories Setup
const storageDirs = [
  path.join(process.cwd(), 'storage'),
  path.join(process.cwd(), 'storage', 'sessions'),
  path.join(process.cwd(), 'storage', 'uploads'),
  path.join(process.cwd(), 'storage', 'uploads', 'pdf'),
  path.join(process.cwd(), 'storage', 'uploads', 'images'),
  path.join(process.cwd(), 'storage', 'uploads', 'audio'),
  path.join(process.cwd(), 'storage', 'uploads', 'video'),
  path.join(process.cwd(), 'storage', 'uploads', 'documents'),
  path.join(process.cwd(), 'storage', 'uploads', 'avatars'),
  path.join(process.cwd(), 'storage', 'backups'),
];

storageDirs.forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[Storage] Created directory: ${dir}`);
  }
});

// Serve uploaded files statically
app.use('/uploads', express.static(path.join(process.cwd(), 'storage', 'uploads')));

// 3. Rate Limiting
const apiLimiter = rateLimit({
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
app.use('/api/auth', authRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/patients', patientsRoutes);
app.use('/api/chats', chatsRoutes);
app.use('/api/appointments', appointmentsRoutes);
app.use('/api/kb', knowledgeRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/treatment-plans', treatmentPlansRoutes);
app.use('/api/exercises', exercisesRoutes);
app.use('/api/doctors', doctorsRoutes);
app.use('/api/regions', regionsRoutes);

// Base route health check
app.get('/health', (req, res) => {
  res.status(200).json({ success: true, status: 'healthy', timestamp: new Date() });
});

// 5. Global Error Handler
app.use(errorHandler);

// 6. Socket.io Initialization
SocketService.initialize(server);

// 7. Start Server & Restore WhatsApp Sessions
server.listen(PORT, async () => {
  console.log(`====================================================`);
  console.log(` PhysioBot Backend running on: http://localhost:${PORT}`);
  console.log(` Socket.io server initialized securely`);
  console.log(`====================================================`);

  // Restore active sessions on startup
  await WhatsappService.restoreSessions();

  // 8. Treatment Plan Reminder Cron — runs every 60 seconds
  setInterval(async () => {
    await TreatmentReminderService.runReminders();
  }, 60 * 1000);
  console.log('[Treatment Reminders] ✅ Scheduler started — checking every minute');
});
