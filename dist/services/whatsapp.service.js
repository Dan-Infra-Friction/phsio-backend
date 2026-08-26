"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WhatsappService = void 0;
const whatsapp_web_js_1 = require("whatsapp-web.js");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const qrcode_1 = __importDefault(require("qrcode"));
const db_1 = __importDefault(require("../config/db"));
const socket_service_1 = require("./socket.service");
const ai_service_1 = require("./ai.service");
const rag_service_1 = require("./rag.service");
const appointment_service_1 = require("./appointment.service");
class WhatsappService {
    /**
     * Restores all WhatsApp sessions that were previously active.
     */
    static async restoreSessions() {
        try {
            const sessions = await db_1.default.whatsappSession.findMany();
            console.log(`[WhatsApp] Found ${sessions.length} sessions in database. Restoring...`);
            for (const session of sessions) {
                // We attempt to initialize the client to restore the connection
                this.initializeClient(session.userId).catch((err) => {
                    console.error(`[WhatsApp] Failed to restore session for user ${session.userId}:`, err);
                });
            }
        }
        catch (err) {
            console.error('[WhatsApp] Error restoring sessions:', err);
        }
    }
    /**
     * Initializes a WhatsApp client for a specific user.
     */
    static async initializeClient(userId) {
        // If client already exists, return it
        if (this.clients.has(userId)) {
            const existingClient = this.clients.get(userId);
            return existingClient;
        }
        console.log(`[WhatsApp] Initializing client for user: ${userId}`);
        // Create session directory if it doesn't exist
        const sessionPath = path_1.default.join(process.cwd(), 'storage', 'sessions');
        if (!fs_1.default.existsSync(sessionPath)) {
            fs_1.default.mkdirSync(sessionPath, { recursive: true });
        }
        // Clean up stale lock files to prevent Chromium initialization hangs on Windows restarts
        const sessionFolder = path_1.default.join(sessionPath, `session-${userId}`);
        const lockPath = path_1.default.join(sessionFolder, 'Default', 'LOCK');
        const activePortPath = path_1.default.join(sessionFolder, 'DevToolsActivePort');
        if (fs_1.default.existsSync(lockPath)) {
            try {
                fs_1.default.unlinkSync(lockPath);
                console.log(`[WhatsApp] Cleaned stale session LOCK file for user ${userId}`);
            }
            catch (err) {
                console.warn(`[WhatsApp] Could not delete stale LOCK file (might be locked by active process): ${err.message || err}`);
            }
        }
        if (fs_1.default.existsSync(activePortPath)) {
            try {
                fs_1.default.unlinkSync(activePortPath);
                console.log(`[WhatsApp] Cleaned stale session DevToolsActivePort file for user ${userId}`);
            }
            catch (err) {
                console.warn(`[WhatsApp] Could not delete stale DevToolsActivePort file: ${err.message || err}`);
            }
        }
        // Locate system Google Chrome path on Windows to speed up launch and avoid Puppeteer download issues
        let chromePath = undefined;
        if (process.platform === 'win32') {
            const paths = [
                'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
            ];
            for (const p of paths) {
                if (fs_1.default.existsSync(p)) {
                    chromePath = p;
                    break;
                }
            }
        }
        // Create a new Whatsapp Web Client
        const client = new whatsapp_web_js_1.Client({
            authStrategy: new whatsapp_web_js_1.LocalAuth({
                clientId: userId,
                dataPath: sessionPath,
            }),
            puppeteer: {
                headless: true,
                executablePath: chromePath,
                protocolTimeout: 180000, // 3 minutes timeout to prevent Page.navigate timeouts on slow connections
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu',
                    '--window-size=1920,1080',
                    '--disable-blink-features=AutomationControlled',
                    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                ],
            },
            webVersionCache: {
                type: 'remote',
                remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
            },
        });
        this.clients.set(userId, client);
        // Set initial database status to CONNECTING
        await db_1.default.whatsappSession.upsert({
            where: { userId },
            update: { status: 'CONNECTING', qrCode: null },
            create: { userId, status: 'CONNECTING' },
        });
        socket_service_1.SocketService.sendToUser(userId, 'whatsapp_status', { status: 'CONNECTING' });
        // Set a timeout of 45 seconds to prevent permanent hanging in CONNECTING state
        const connectionTimeout = setTimeout(async () => {
            const currentSession = await db_1.default.whatsappSession.findUnique({ where: { userId } });
            if (currentSession && currentSession.status === 'CONNECTING') {
                console.warn(`[WhatsApp] Connection initialization timed out for user ${userId}. Cleaning up...`);
                try {
                    await client.destroy();
                }
                catch (destroyErr) {
                    console.error('[WhatsApp] Error destroying client on timeout:', destroyErr.message || destroyErr);
                }
                this.clients.delete(userId);
                await db_1.default.whatsappSession.update({
                    where: { userId },
                    data: { status: 'DISCONNECTED', qrCode: null },
                });
                socket_service_1.SocketService.sendToUser(userId, 'whatsapp_status', { status: 'DISCONNECTED' });
            }
        }, 45000);
        // Event: QR Code
        client.on('qr', async (qr) => {
            clearTimeout(connectionTimeout);
            console.log(`[WhatsApp] QR Code generated for user: ${userId}`);
            try {
                const qrImageBase64 = await qrcode_1.default.toDataURL(qr);
                await db_1.default.whatsappSession.update({
                    where: { userId },
                    data: { qrCode: qrImageBase64, status: 'DISCONNECTED' },
                });
                socket_service_1.SocketService.sendToUser(userId, 'whatsapp_status', {
                    status: 'DISCONNECTED',
                    qr: qrImageBase64,
                });
            }
            catch (err) {
                console.error('[WhatsApp] QR generation error:', err);
            }
        });
        // Event: Authenticated
        client.on('authenticated', () => {
            console.log(`[WhatsApp] Client authenticated for user: ${userId}`);
        });
        // Event: Auth Failure
        client.on('auth_failure', async (msg) => {
            clearTimeout(connectionTimeout);
            console.error(`[WhatsApp] Auth failure for user ${userId}:`, msg);
            await db_1.default.whatsappSession.update({
                where: { userId },
                data: { status: 'DISCONNECTED', qrCode: null },
            });
            socket_service_1.SocketService.sendToUser(userId, 'whatsapp_status', { status: 'DISCONNECTED' });
        });
        // Event: Ready
        client.on('ready', async () => {
            clearTimeout(connectionTimeout);
            const phone = client.info.wid.user;
            const profileName = client.info.pushname || 'Clinic WhatsApp';
            console.log(`[WhatsApp] Client is ready for user: ${userId} (Phone: ${phone})`);
            // Fetch own profile picture
            let profilePicUrl = null;
            try {
                profilePicUrl = await client.getProfilePicUrl(client.info.wid._serialized);
            }
            catch (picErr) {
                // Log a clean warning since this is a known whatsapp-web.js issue with recent WhatsApp Web updates
                console.warn(`[WhatsApp] Could not fetch own profile picture (library bug or privacy settings): ${picErr.message || picErr}`);
            }
            await db_1.default.whatsappSession.update({
                where: { userId },
                data: {
                    status: 'CONNECTED',
                    phone,
                    profileName,
                    profilePicUrl,
                    lastSync: new Date(),
                    qrCode: null,
                },
            });
            // Notify therapist via Socket and system notification
            socket_service_1.SocketService.sendToUser(userId, 'whatsapp_status', {
                status: 'CONNECTED',
                phone,
                profileName,
                profilePicUrl,
            });
            await db_1.default.notification.create({
                data: {
                    userId,
                    type: 'NEW_CHAT',
                    title: 'WhatsApp Connected',
                    message: `WhatsApp account ${profileName} (${phone}) has been connected successfully.`,
                },
            }).catch((e) => console.error(e));
        });
        // Event: Disconnected
        client.on('disconnected', async (reason) => {
            console.log(`[WhatsApp] Client disconnected for user: ${userId}. Reason: ${reason}`);
            await db_1.default.whatsappSession.update({
                where: { userId },
                data: { status: 'DISCONNECTED', qrCode: null },
            });
            socket_service_1.SocketService.sendToUser(userId, 'whatsapp_status', { status: 'DISCONNECTED' });
            // Write notification
            await db_1.default.notification.create({
                data: {
                    userId,
                    type: 'WHATSAPP_DISCONNECT',
                    title: 'WhatsApp Disconnected',
                    message: 'Your WhatsApp connection has been lost. Please scan the QR code to reconnect.',
                },
            }).catch((e) => console.error(e));
        });
        // Event: Message Received
        client.on('message', async (message) => {
            console.log(`\n======================================================`);
            console.log(`[WhatsApp Event] NEW INCOMING MESSAGE CAPTURED!`);
            console.log(`From: ${message.from}`);
            console.log(`Type: ${message.type}`);
            console.log(`Body: "${message.body || '[Media/Attachment]'}"`);
            console.log(`======================================================\n`);
            try {
                await this.handleIncomingMessage(userId, client, message);
            }
            catch (err) {
                console.error('[WhatsApp] Error handling incoming message:', err);
            }
        });
        // Disable navigator.webdriver bot detection property
        client.on('puppeteer_page', async (page) => {
            try {
                await page.evaluateOnNewDocument(() => {
                    // @ts-ignore
                    Object.defineProperty(navigator, 'webdriver', { get: () => false });
                });
            }
            catch (err) {
                console.error('[WhatsApp] Error disabling webdriver property:', err.message || err);
            }
        });
        // Initialize Puppeteer
        client.initialize().catch((err) => {
            clearTimeout(connectionTimeout);
            console.error(`[WhatsApp] Client initialization failed for user ${userId}:`, err);
            db_1.default.whatsappSession.update({
                where: { userId },
                data: { status: 'DISCONNECTED' },
            }).catch(() => { });
        });
        return client;
    }
    /**
     * Disconnects and destroys a WhatsApp client.
     */
    static async disconnectClient(userId) {
        const client = this.clients.get(userId);
        if (!client)
            return false;
        try {
            console.log(`[WhatsApp] Disconnecting client for user: ${userId}`);
            await client.destroy();
            this.clients.delete(userId);
            // Clean session folder to force a new QR scan
            const sessionFolder = path_1.default.join(process.cwd(), 'storage', 'sessions', `session-${userId}`);
            if (fs_1.default.existsSync(sessionFolder)) {
                fs_1.default.rmSync(sessionFolder, { recursive: true, force: true });
            }
            await db_1.default.whatsappSession.update({
                where: { userId },
                data: { status: 'DISCONNECTED', qrCode: null, phone: null, profileName: null, profilePicUrl: null },
            });
            socket_service_1.SocketService.sendToUser(userId, 'whatsapp_status', { status: 'DISCONNECTED' });
            return true;
        }
        catch (err) {
            console.error('[WhatsApp] Error disconnecting client:', err);
            return false;
        }
    }
    /**
     * Gets the active WhatsApp client for a user.
     */
    static getClient(userId) {
        return this.clients.get(userId);
    }
    /**
     * Marks a WhatsApp chat as read (sends seen receipt).
     */
    static async markChatAsRead(userId, patientPhone) {
        const client = this.getClient(userId);
        if (!client)
            return;
        if (patientPhone.endsWith('@lid')) {
            console.log(`[WhatsApp] Skipping seen receipt for @lid contact: ${patientPhone}`);
            return;
        }
        try {
            const chat = await client.getChatById(patientPhone);
            await chat.sendSeen();
            console.log(`[WhatsApp] Sent seen receipt to ${patientPhone}`);
        }
        catch (err) {
            console.error(`[WhatsApp] Failed to mark chat ${patientPhone} as read: ${err.message || err}`);
        }
    }
    /**
     * Clears and deletes a WhatsApp chat history.
     */
    static async clearChatHistory(userId, patientPhone) {
        const client = this.getClient(userId);
        if (!client)
            return;
        if (patientPhone.endsWith('@lid')) {
            console.log(`[WhatsApp] Skipping clear history for @lid contact: ${patientPhone}`);
            return;
        }
        try {
            const chat = await client.getChatById(patientPhone);
            await chat.clearMessages();
            await chat.delete();
            console.log(`[WhatsApp] Cleared and deleted chat history for ${patientPhone}`);
        }
        catch (err) {
            console.error(`[WhatsApp] Failed to clear chat ${patientPhone}: ${err.message || err}`);
        }
    }
    /**
     * Handles incoming WhatsApp messages.
     */
    static async handleIncomingMessage(userId, client, wMsg) {
        // Only handle direct messages (ignore group chats, newsletters, broadcasts)
        if (!wMsg.from.endsWith('@c.us') && !wMsg.from.endsWith('@lid')) {
            console.log(`[WhatsApp] Ignoring message from ${wMsg.from} (not a direct chat, e.g. group, channel, or broadcast)`);
            return;
        }
        const patientPhone = wMsg.from;
        const incomingText = wMsg.body || '';
        console.log(`[WhatsApp] Processing message from ${patientPhone}: "${incomingText}"`);
        // --- THERAPIST COMMAND INTERCEPTOR ---
        const therapistJid = client.info?.wid?._serialized;
        if (therapistJid && wMsg.from === therapistJid) {
            const text = incomingText.trim();
            const approveRegex = /^\s*APPROVE\s+(\+?\d[\d\s-]*\d)(?:@c\.us)?/i;
            const match = text.match(approveRegex);
            if (match) {
                const rawPhone = match[1].replace(/[+\s-]/g, '');
                console.log(`[Therapist Action] Intercepted APPROVE command for patient phone: ${rawPhone}`);
                try {
                    const patient = await db_1.default.patient.findFirst({
                        where: {
                            userId,
                            phone: {
                                contains: rawPhone
                            }
                        }
                    });
                    if (patient) {
                        let answers = {};
                        try {
                            answers = JSON.parse(patient.onboardingAnswers || '{}');
                        }
                        catch {
                            answers = {};
                        }
                        const requestedSlot = answers['appointmentSlot'];
                        const patientLanguage = answers['language'] || 'English';
                        if (requestedSlot) {
                            console.log(`[Therapist Action] Parsing requested slot "${requestedSlot}" into ISO Date...`);
                            let parsedDate = new Date();
                            parsedDate.setDate(parsedDate.getDate() + 1);
                            parsedDate.setHours(10, 0, 0, 0);
                            try {
                                const parsePrompt = `You are a scheduling assistant. Convert the following text describing an appointment time into an ISO 8601 date string. 
                The current local time is ${new Date().toLocaleString()}. The current year is 2026.
                Return ONLY the ISO 8601 date string (e.g., "2026-06-27T10:00:00"), with absolutely no extra text. If the text does not contain a clear date or time, return tomorrow's date at 10:00 AM.
                
                TEXT TO PARSE:
                "${requestedSlot}"`;
                                const isoStr = await ai_service_1.AiService.generateResponse(userId, parsePrompt, "Parse appointment date.", []);
                                const parsedTemp = new Date(isoStr.trim());
                                if (!isNaN(parsedTemp.getTime())) {
                                    parsedDate = parsedTemp;
                                }
                            }
                            catch (parseErr) {
                                console.error('[Therapist Action] Failed to parse date via AI, using default:', parseErr);
                            }
                            await db_1.default.appointment.create({
                                data: {
                                    userId,
                                    patientId: patient.id,
                                    title: 'Physiotherapy Session',
                                    dateTime: parsedDate,
                                    status: 'UPCOMING',
                                    notes: `Auto-booked via WhatsApp onboarding. Slot requested: ${requestedSlot}`,
                                }
                            });
                            const confirmationTemplate = `Hello ${patient.name}! Your appointment request has been approved and successfully booked for:\n📅 *${requestedSlot}*\n\nWe look forward to seeing you!`;
                            const translatedConfirmation = await this.translateText(userId, confirmationTemplate, patientLanguage);
                            await client.sendMessage(patient.phone, translatedConfirmation);
                            let conversation = await db_1.default.conversation.findUnique({
                                where: { userId_patientId: { userId, patientId: patient.id } }
                            });
                            if (conversation) {
                                await db_1.default.message.create({
                                    data: {
                                        conversationId: conversation.id,
                                        sender: 'AI',
                                        body: translatedConfirmation,
                                        type: 'text',
                                        timestamp: new Date(),
                                    }
                                });
                            }
                            const successMsg = `✅ SUCCESS: Appointment booked for ${patient.name} on ${requestedSlot} (${parsedDate.toLocaleString()}). Patient has been notified.`;
                            await client.sendMessage(therapistJid, successMsg);
                            socket_service_1.SocketService.sendToUser(userId, 'patient_update', { patientId: patient.id });
                        }
                        else {
                            await client.sendMessage(therapistJid, `❌ ERROR: No requested appointment slot found for patient ${patient.name}.`);
                        }
                    }
                    else {
                        await client.sendMessage(therapistJid, `❌ ERROR: Patient with phone containing "${rawPhone}" not found.`);
                    }
                }
                catch (err) {
                    console.error('[Therapist Action] Error in remote approval:', err);
                    await client.sendMessage(therapistJid, `❌ ERROR: Remote approval failed: ${err.message || err}`);
                }
                return;
            }
        }
        // 1. Get or Create Patient
        let patient = await db_1.default.patient.findUnique({
            where: {
                userId_phone: {
                    userId,
                    phone: patientPhone,
                },
            },
        });
        let isNewPatient = false;
        if (!patient) {
            isNewPatient = true;
            console.log(`[WhatsApp] Patient ${patientPhone} not found in database. Registering new patient...`);
            const contact = await wMsg.getContact();
            const patientName = contact.pushname || contact.name || patientPhone.split('@')[0];
            let profilePhoto = null;
            try {
                profilePhoto = await contact.getProfilePicUrl();
            }
            catch (picErr) {
                console.warn(`[WhatsApp] Could not fetch contact profile picture for ${patientPhone} (library bug or privacy settings): ${picErr.message || picErr}`);
            }
            patient = await db_1.default.patient.create({
                data: {
                    userId,
                    phone: patientPhone,
                    name: patientName,
                    profilePhoto,
                    status: 'ACTIVE',
                },
            });
            // Write a notification for new patient
            await db_1.default.notification.create({
                data: {
                    userId,
                    type: 'NEW_PATIENT',
                    title: 'New Patient Registered',
                    message: `${patientName} (${patientPhone.split('@')[0]}) sent their first message.`,
                },
            }).catch((e) => console.error(e));
            socket_service_1.SocketService.sendToUser(userId, 'notification', {
                type: 'NEW_PATIENT',
                title: 'New Patient Registered',
                message: `${patientName} (${patientPhone.split('@')[0]}) sent their first message.`,
            });
        }
        else if (!patient.profilePhoto) {
            // Update patient profile photo if missing
            try {
                const contact = await wMsg.getContact();
                const profilePhoto = await contact.getProfilePicUrl();
                if (profilePhoto) {
                    patient = await db_1.default.patient.update({
                        where: { id: patient.id },
                        data: { profilePhoto },
                    });
                }
            }
            catch (picErr) {
                console.warn(`[WhatsApp] Could not update contact profile picture for ${patient.phone} (library bug or privacy settings): ${picErr.message || picErr}`);
            }
        }
        // 2. Get or Create Conversation
        let conversation = await db_1.default.conversation.findUnique({
            where: {
                userId_patientId: {
                    userId,
                    patientId: patient.id,
                },
            },
        });
        if (!conversation) {
            conversation = await db_1.default.conversation.create({
                data: {
                    userId,
                    patientId: patient.id,
                },
            });
        }
        // 3. Process attachments/media if any
        let mediaUrl = null;
        let messageType = 'text';
        if (wMsg.hasMedia) {
            try {
                const media = await wMsg.downloadMedia();
                if (media) {
                    const extension = media.mimetype.split('/')[1]?.split(';')[0] || 'bin';
                    const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}.${extension}`;
                    let folder = 'images';
                    if (media.mimetype.includes('pdf')) {
                        folder = 'pdf';
                        messageType = 'pdf';
                    }
                    else if (media.mimetype.includes('image')) {
                        folder = 'images';
                        messageType = 'image';
                    }
                    else if (media.mimetype.includes('audio')) {
                        folder = 'audio';
                        messageType = 'audio';
                    }
                    else if (media.mimetype.includes('video')) {
                        folder = 'video';
                        messageType = 'video';
                    }
                    else {
                        folder = 'documents';
                        messageType = 'document';
                    }
                    const targetDir = path_1.default.join(process.cwd(), 'storage', 'uploads', folder);
                    if (!fs_1.default.existsSync(targetDir)) {
                        fs_1.default.mkdirSync(targetDir, { recursive: true });
                    }
                    const localFilePath = path_1.default.join(targetDir, filename);
                    fs_1.default.writeFileSync(localFilePath, Buffer.from(media.data, 'base64'));
                    // Expose file via static express server under /uploads/folder/filename
                    mediaUrl = `/uploads/${folder}/${filename}`;
                    console.log(`[WhatsApp] Saved media attachment locally: ${mediaUrl}`);
                }
            }
            catch (err) {
                console.error('[WhatsApp] Failed to download/save incoming media:', err);
            }
        }
        // 4. Save Patient Message to Database
        const savedIncomingMsg = await db_1.default.message.create({
            data: {
                conversationId: conversation.id,
                sender: 'PATIENT',
                body: incomingText || (wMsg.hasMedia ? `Sent a media attachment (${messageType})` : ''),
                type: messageType,
                mediaUrl,
                timestamp: new Date(),
            },
        });
        // Update patient lastMessage and lastSeen
        await db_1.default.patient.update({
            where: { id: patient.id },
            data: {
                lastSeen: new Date(),
                lastMessage: incomingText || `[${messageType.toUpperCase()}]`,
            },
        });
        // Update conversation lastMessageAt
        await db_1.default.conversation.update({
            where: { id: conversation.id },
            data: { lastMessageAt: new Date() },
        });
        // Emit live message to frontend
        socket_service_1.SocketService.sendToUser(userId, 'new_message', {
            conversationId: conversation.id,
            message: savedIncomingMsg,
        });
        // ONBOARDING PIPELINE: Automated dynamic intake questionnaire with multi-language & booking
        const settings = await db_1.default.setting.findUnique({ where: { userId } });
        const questionsListStr = settings?.onboardingQuestions || '[]';
        let onboardingQuestions = [];
        try {
            onboardingQuestions = JSON.parse(questionsListStr);
        }
        catch {
            onboardingQuestions = [];
        }
        const N = onboardingQuestions.length;
        // Only run if onboarding questions are configured and the patient has not fully completed onboarding yet
        // Step N + 3 is the completion step (i.e. onboarding is finished and we bypass the intercept)
        if (N > 0 && patient.onboardingStep <= N + 2) {
            console.log(`[Onboarding Pipeline] Patient ${patient.name} is in onboarding flow. Step: ${patient.onboardingStep} of ${N + 2}`);
            try {
                // Retrieve current answers and language
                let answers = {};
                try {
                    answers = JSON.parse(patient.onboardingAnswers || '{}');
                }
                catch {
                    answers = {};
                }
                const patientLanguage = answers['language'] || 'English';
                // --- STEP 0: Send Language Selection Menu ---
                if (patient.onboardingStep === 0) {
                    const languageMenu = `Please select your preferred language by typing the number:
कृपया अपनी पसंदीदा भाषा चुनने के लिए नंबर लिखकर उत्तर दें:

1. English
2. Hindi (हिंदी)
3. Hinglish (Hinglish)
4. Telugu (తెలుగు)
5. Marathi (मराठी)`;
                    console.log(`[Onboarding Pipeline] Sending Language Menu to ${patientPhone}`);
                    await client.sendMessage(patientPhone, languageMenu);
                    const savedMsg = await db_1.default.message.create({
                        data: {
                            conversationId: conversation.id,
                            sender: 'AI',
                            body: languageMenu,
                            type: 'text',
                            timestamp: new Date(),
                        },
                    });
                    await db_1.default.patient.update({
                        where: { id: patient.id },
                        data: {
                            onboardingStep: 1,
                            lastMessage: languageMenu,
                        },
                    });
                    socket_service_1.SocketService.sendToUser(userId, 'new_message', {
                        conversationId: conversation.id,
                        message: savedMsg,
                    });
                    return; // HALT normal AI autopilot
                }
                // --- STEP 1: Process Language, translate ALL questions at once, send Q1 ---
                if (patient.onboardingStep === 1) {
                    const selectedLanguage = this.parseLanguageChoice(incomingText);
                    console.log(`[Onboarding Pipeline] Patient selected language: ${selectedLanguage}`);
                    answers['language'] = selectedLanguage;
                    // Translate ALL questions + appointment menu in one batch and cache them
                    // This avoids per-step AI translation calls that can fail silently
                    let translatedQuestions = [...onboardingQuestions];
                    let translatedAppointmentMenu = '';
                    if (selectedLanguage.toLowerCase() !== 'english') {
                        console.log(`[Onboarding Pipeline] Pre-translating all ${N} questions to ${selectedLanguage}...`);
                        try {
                            const allQuestionsText = onboardingQuestions
                                .map((q, i) => `Q${i + 1}: ${q}`)
                                .join('\n');
                            const systemPrompt = this.buildTranslatorSystemPrompt(selectedLanguage);
                            const userMsg = `Translate each of the following questions into ${selectedLanguage}. Return ONLY the translated questions, one per line, in the exact same numbered format (Q1:, Q2:, etc.). Do not add any extra text.\n\n${allQuestionsText}`;
                            const raw = await ai_service_1.AiService.generateResponse(userId, systemPrompt, userMsg, []);
                            console.log(`[Onboarding Pipeline] Raw translated questions:\n${raw}`);
                            // Parse translated lines back into array
                            const lines = raw.split('\n').filter((l) => l.trim());
                            const parsed = [];
                            for (const line of lines) {
                                // Strip leading "Q1: ", "Q2: " prefix if present
                                const cleaned = line.replace(/^Q\d+:\s*/i, '').trim();
                                if (cleaned)
                                    parsed.push(cleaned);
                            }
                            if (parsed.length === N) {
                                translatedQuestions = parsed;
                                console.log(`[Onboarding Pipeline] Successfully cached ${N} translated questions.`);
                            }
                            else {
                                console.warn(`[Onboarding Pipeline] Translation returned ${parsed.length} lines, expected ${N}. Falling back to per-question translation.`);
                                // Fall back: translate one by one
                                translatedQuestions = await Promise.all(onboardingQuestions.map((q) => this.translateText(userId, q, selectedLanguage)));
                            }
                            // Pre-translate appointment menu too
                            const slots = this.getPredefinedSlots();
                            const apptMenuEnglish = `Would you like to request a physiotherapy appointment? Please select one of our available slots by typing the number (e.g. 1):\n\n1. 📅 ${slots.slot1}\n2. 📅 ${slots.slot2}\n3. 📅 ${slots.slot3}\n4. 📅 ${slots.slot4}\n5. ✍️ Other (Specify your own date and time)\n6. ❌ Skip appointment booking`;
                            translatedAppointmentMenu = await this.translateText(userId, apptMenuEnglish, selectedLanguage);
                        }
                        catch (translErr) {
                            console.error(`[Onboarding Pipeline] Batch translation failed, falling back to static translations:`, translErr);
                            // Use hardcoded static translations instead of English originals
                            translatedQuestions = onboardingQuestions.map((q) => this.getStaticTranslation(q, selectedLanguage) || q);
                            // Static appointment menu fallback
                            const slots = this.getPredefinedSlots();
                            const apptMenuEnglish = `Would you like to request a physiotherapy appointment? Please select one of our available slots by typing the number (e.g. 1):\n\n1. 📅 ${slots.slot1}\n2. 📅 ${slots.slot2}\n3. 📅 ${slots.slot3}\n4. 📅 ${slots.slot4}\n5. ✍️ Other (Specify your own date and time)\n6. ❌ Skip appointment booking`;
                            translatedAppointmentMenu = this.getStaticTranslation(apptMenuEnglish, selectedLanguage) || this.getStaticAppointmentMenu(slots, selectedLanguage);
                        }
                    }
                    // Cache translated questions and appointment menu in answers
                    answers['_translatedQuestions'] = JSON.stringify(translatedQuestions);
                    answers['_translatedAppointmentMenu'] = translatedAppointmentMenu;
                    // Send Q1
                    const translatedQ1 = translatedQuestions[0] || onboardingQuestions[0];
                    console.log(`[Onboarding Pipeline] Sending translated Q1: "${translatedQ1}"`);
                    await client.sendMessage(patientPhone, translatedQ1);
                    const savedMsg = await db_1.default.message.create({
                        data: {
                            conversationId: conversation.id,
                            sender: 'AI',
                            body: translatedQ1,
                            type: 'text',
                            timestamp: new Date(),
                        },
                    });
                    await db_1.default.patient.update({
                        where: { id: patient.id },
                        data: {
                            onboardingStep: 2,
                            onboardingAnswers: JSON.stringify(answers),
                            lastMessage: translatedQ1,
                        },
                    });
                    socket_service_1.SocketService.sendToUser(userId, 'new_message', {
                        conversationId: conversation.id,
                        message: savedMsg,
                    });
                    return; // HALT normal AI autopilot
                }
                // --- STEPS 2 to N: Process Intake Q&A ---
                if (patient.onboardingStep >= 2 && patient.onboardingStep <= N) {
                    const currentStep = patient.onboardingStep; // step 2 = answering Q1, step N = answering Q(N-1)
                    const qIndex = currentStep - 2;
                    // Read from pre-translated cache (set in step 1)
                    let cachedTranslatedQuestions = onboardingQuestions;
                    try {
                        const cached = JSON.parse(answers['_translatedQuestions'] || 'null');
                        if (Array.isArray(cached) && cached.length === N) {
                            cachedTranslatedQuestions = cached;
                        }
                    }
                    catch { /* use originals */ }
                    // --- VALIDATE ANSWER ---
                    const englishQuestion = onboardingQuestions[qIndex];
                    const currentQuestionTranslated = cachedTranslatedQuestions[qIndex] || englishQuestion;
                    console.log(`[Onboarding Pipeline] Validating answer for Q${qIndex + 1}: "${incomingText}"`);
                    const isValid = await this.validateAnswer(userId, englishQuestion, incomingText);
                    if (!isValid) {
                        // Answer not suitable — re-ask same question in patient's language
                        console.log(`[Onboarding Pipeline] Answer rejected for Q${qIndex + 1}. Re-asking in ${patientLanguage}.`);
                        const retryMsg = this.getRetryMessage(patientLanguage);
                        const fullRetry = `${retryMsg}\n\n${currentQuestionTranslated}`;
                        await client.sendMessage(patientPhone, fullRetry);
                        const savedRetry = await db_1.default.message.create({
                            data: {
                                conversationId: conversation.id,
                                sender: 'AI',
                                body: fullRetry,
                                type: 'text',
                                timestamp: new Date(),
                            },
                        });
                        await db_1.default.patient.update({
                            where: { id: patient.id },
                            data: { lastMessage: fullRetry },
                        });
                        socket_service_1.SocketService.sendToUser(userId, 'new_message', {
                            conversationId: conversation.id,
                            message: savedRetry,
                        });
                        return; // HALT — do NOT advance step
                    }
                    // Answer accepted — save and send next question
                    console.log(`[Onboarding Pipeline] Answer accepted for Q${qIndex + 1}: "${incomingText}"`);
                    answers[String(qIndex + 1)] = incomingText || '[Media/Attachment]';
                    // Next question to send (index = currentStep - 1)
                    const nextQuestion = cachedTranslatedQuestions[currentStep - 1] || onboardingQuestions[currentStep - 1];
                    console.log(`[Onboarding Pipeline] Sending cached Q${currentStep} in ${patientLanguage}: "${nextQuestion}"`);
                    await client.sendMessage(patientPhone, nextQuestion);
                    const savedMsg = await db_1.default.message.create({
                        data: {
                            conversationId: conversation.id,
                            sender: 'AI',
                            body: nextQuestion,
                            type: 'text',
                            timestamp: new Date(),
                        },
                    });
                    await db_1.default.patient.update({
                        where: { id: patient.id },
                        data: {
                            onboardingStep: currentStep + 1,
                            onboardingAnswers: JSON.stringify(answers),
                            lastMessage: nextQuestion,
                        },
                    });
                    socket_service_1.SocketService.sendToUser(userId, 'new_message', {
                        conversationId: conversation.id,
                        message: savedMsg,
                    });
                    return; // HALT normal AI autopilot
                }
                // --- STEP N + 1: Process Last Intake Question & Send Appointment Menu ---
                if (patient.onboardingStep === N + 1) {
                    // Validate the last answer before proceeding
                    const lastEnglishQuestion = onboardingQuestions[N - 1];
                    let cachedQsForLastStep = onboardingQuestions;
                    try {
                        const cached = JSON.parse(answers['_translatedQuestions'] || 'null');
                        if (Array.isArray(cached) && cached.length === N)
                            cachedQsForLastStep = cached;
                    }
                    catch { /* use originals */ }
                    const lastQuestionTranslated = cachedQsForLastStep[N - 1] || lastEnglishQuestion;
                    console.log(`[Onboarding Pipeline] Validating last answer for Q${N}: "${incomingText}"`);
                    const isLastValid = await this.validateAnswer(userId, lastEnglishQuestion, incomingText);
                    if (!isLastValid) {
                        console.log(`[Onboarding Pipeline] Last answer rejected. Re-asking Q${N} in ${patientLanguage}.`);
                        const retryMsg = this.getRetryMessage(patientLanguage);
                        const fullRetry = `${retryMsg}\n\n${lastQuestionTranslated}`;
                        await client.sendMessage(patientPhone, fullRetry);
                        const savedRetry = await db_1.default.message.create({
                            data: {
                                conversationId: conversation.id,
                                sender: 'AI',
                                body: fullRetry,
                                type: 'text',
                                timestamp: new Date(),
                            },
                        });
                        await db_1.default.patient.update({
                            where: { id: patient.id },
                            data: { lastMessage: fullRetry },
                        });
                        socket_service_1.SocketService.sendToUser(userId, 'new_message', {
                            conversationId: conversation.id,
                            message: savedRetry,
                        });
                        return; // HALT — do NOT advance step
                    }
                    console.log(`[Onboarding Pipeline] Last answer accepted. Saving Q${N}: "${incomingText}"`);
                    answers[String(N)] = incomingText || '[Media/Attachment]';
                    // Read pre-translated appointment menu from cache (set in step 1)
                    let translatedMenu = answers['_translatedAppointmentMenu'] || '';
                    if (!translatedMenu) {
                        // Fallback: generate and translate now
                        const slots = this.getPredefinedSlots();
                        const apptMenuEnglish = `Would you like to request a physiotherapy appointment? Please select one of our available slots by typing the number (e.g. 1):\n\n1. 📅 ${slots.slot1}\n2. 📅 ${slots.slot2}\n3. 📅 ${slots.slot3}\n4. 📅 ${slots.slot4}\n5. ✍️ Other (Specify your own date and time)\n6. ❌ Skip appointment booking`;
                        translatedMenu = await this.translateText(userId, apptMenuEnglish, patientLanguage);
                    }
                    console.log(`[Onboarding Pipeline] Sending appointment menu in ${patientLanguage}`);
                    await client.sendMessage(patientPhone, translatedMenu);
                    const savedMsg = await db_1.default.message.create({
                        data: {
                            conversationId: conversation.id,
                            sender: 'AI',
                            body: translatedMenu,
                            type: 'text',
                            timestamp: new Date(),
                        },
                    });
                    await db_1.default.patient.update({
                        where: { id: patient.id },
                        data: {
                            onboardingStep: N + 2,
                            onboardingAnswers: JSON.stringify(answers),
                            lastMessage: translatedMenu,
                        },
                    });
                    socket_service_1.SocketService.sendToUser(userId, 'new_message', {
                        conversationId: conversation.id,
                        message: savedMsg,
                    });
                    return; // HALT normal AI autopilot
                }
                // --- STEP N + 2: Process Appointment Selection & Complete Onboarding ---
                if (patient.onboardingStep === N + 2) {
                    console.log(`[Onboarding Pipeline] Processing appointment selection: "${incomingText}"`);
                    const choice = incomingText.trim();
                    let selectedSlotText = '';
                    const slots = this.getPredefinedSlots();
                    if (choice === '1')
                        selectedSlotText = slots.slot1;
                    else if (choice === '2')
                        selectedSlotText = slots.slot2;
                    else if (choice === '3')
                        selectedSlotText = slots.slot3;
                    else if (choice === '4')
                        selectedSlotText = slots.slot4;
                    else if (choice === '5' || (!['1', '2', '3', '4', '6'].includes(choice) && choice.length > 3 && !choice.toLowerCase().includes('skip'))) {
                        selectedSlotText = choice === '5' ? 'Custom slot to be specified' : choice;
                    }
                    else {
                        selectedSlotText = 'Skipped';
                    }
                    answers['appointmentSlot'] = selectedSlotText;
                    console.log(`[Onboarding Pipeline] Selected slot: ${selectedSlotText}`);
                    // Send therapist own-device alert if slot was requested
                    const therapistJid = client.info.wid?._serialized;
                    if (selectedSlotText !== 'Skipped' && therapistJid) {
                        const cleanPhone = patientPhone.replace(/[^\d]/g, '');
                        const alertMsg = `🚨 [NEW APPOINTMENT REQUEST] 🚨

Patient: ${patient.name}
Phone: +${cleanPhone}
Language: ${patientLanguage}
Requested Slot: ${selectedSlotText}

To approve and book this appointment, reply to this message with:
APPROVE ${cleanPhone}

Example:
APPROVE ${cleanPhone}`;
                        console.log(`[Onboarding Pipeline] Sending Appointment Alert to therapist self-chat JID: ${therapistJid}`);
                        await client.sendMessage(therapistJid, alertMsg);
                    }
                    // Send completion message to patient
                    let patientCompletionMsg = '';
                    if (selectedSlotText !== 'Skipped') {
                        patientCompletionMsg = `Thank you! Your appointment request for *${selectedSlotText}* has been submitted. 📅

A therapist will review your answers shortly to confirm your booking. Feel free to ask any other questions here in the meantime! 👋`;
                    }
                    else {
                        patientCompletionMsg = `Thank you for completing our intake questionnaire! 👋 

A physiotherapist will review your details shortly. In the meantime, feel free to ask any questions or discuss your symptoms here!`;
                    }
                    const translatedCompletion = await this.translateText(userId, patientCompletionMsg, patientLanguage);
                    await client.sendMessage(patientPhone, translatedCompletion);
                    const savedMsg = await db_1.default.message.create({
                        data: {
                            conversationId: conversation.id,
                            sender: 'AI',
                            body: translatedCompletion,
                            type: 'text',
                            timestamp: new Date(),
                        },
                    });
                    // Compile summary notes
                    let summaryNotes = `=== CLINICAL INTAKE DETAILS ===\nCompleted: ${new Date().toLocaleString()}\nLanguage: ${patientLanguage}\n`;
                    if (selectedSlotText !== 'Skipped') {
                        summaryNotes += `Requested Appointment: ${selectedSlotText}\n\n`;
                    }
                    else {
                        summaryNotes += `Requested Appointment: Skipped\n\n`;
                    }
                    let qaText = `Language: ${patientLanguage}\n`;
                    for (let i = 0; i < N; i++) {
                        const qNum = i + 1;
                        const qText = onboardingQuestions[i];
                        const aText = answers[String(qNum)] || 'No answer';
                        summaryNotes += `Q${qNum}: ${qText}\nA: ${aText}\n\n`;
                        qaText += `Q: ${qText}\nA: ${aText}\n\n`;
                    }
                    // Generate AI intake paragraph summary
                    const summaryPrompt = `You are a clinical intake assistant. Summarize the following patient's intake questions and answers into a single, cohesive, professional paragraph. Focus on their name, date of birth, symptoms, pain severity (1-10), duration, triggers, medical history, medications, rehab goals, and scheduling preferences (Requested slot: ${selectedSlotText}). Keep it strictly to one professional paragraph, written in third-person. Do not include any bullet points or lists. Return ONLY the summarized paragraph, nothing else.\n\nINTAKE DETAILS:\n${qaText}`;
                    console.log(`[Onboarding Pipeline] Synthesizing one-paragraph clinical summary using AI service...`);
                    let onboardingSummary = '';
                    try {
                        onboardingSummary = await ai_service_1.AiService.generateResponse(userId, summaryPrompt, "Generate one-paragraph patient intake summary.", []);
                        console.log(`[Onboarding Pipeline] AI successfully generated summary.`);
                    }
                    catch (aiErr) {
                        console.error('[Onboarding Pipeline] AI summary generation failed, using template fallback:', aiErr);
                        onboardingSummary = `Patient completed intake in ${patientLanguage}. Name: ${answers['1'] || patient.name}, DOB: ${answers['2'] || 'Not specified'}, Symptoms: ${answers['3'] || 'Not specified'}, Pain level: ${answers['4'] || 'N/A'}/10, Goals: ${answers['9'] || 'Not specified'}. Requested Appointment: ${selectedSlotText}.`;
                    }
                    // Save in database
                    const existingNotes = patient.notes ? `${patient.notes}\n\n` : '';
                    await db_1.default.patient.update({
                        where: { id: patient.id },
                        data: {
                            onboardingStep: N + 3, // Complete!
                            onboardingAnswers: JSON.stringify(answers),
                            onboardingSummary,
                            notes: `${existingNotes}${summaryNotes}`,
                            lastMessage: translatedCompletion,
                        },
                    });
                    socket_service_1.SocketService.sendToUser(userId, 'new_message', {
                        conversationId: conversation.id,
                        message: savedMsg,
                    });
                    // Trigger details refresh in frontend
                    socket_service_1.SocketService.sendToUser(userId, 'patient_update', { patientId: patient.id });
                    console.log(`[Onboarding Pipeline] Onboarding pipeline fully completed for ${patient.name}`);
                    return; // HALT normal AI autopilot
                }
            }
            catch (onbErr) {
                console.error('[Onboarding Pipeline Error] Failed to run onboarding step:', onbErr);
            }
        }
        // 5. AI Auto-Reply Pipeline (Trigger only if AI is enabled and not paused)
        const isAiActive = conversation.isAiEnabled && settings?.autoReplyEnabled;
        console.log(`[WhatsApp Pipeline] Checking AI reply conditions:`);
        console.log(`- Global Auto-Reply (Settings): ${settings?.autoReplyEnabled ? 'ENABLED' : 'DISABLED'}`);
        console.log(`- Conversation AI Override: ${conversation.isAiEnabled ? 'ENABLED' : 'DISABLED'}`);
        console.log(`- Final Auto-Reply Status: ${isAiActive ? 'ACTIVE' : 'INACTIVE'}`);
        if (isAiActive) {
            console.log(`[WhatsApp Pipeline] AI Auto-Reply is ACTIVE. Initiating reply generation...`);
            // Emit typing status to dashboard (therapist)
            socket_service_1.SocketService.sendToUser(userId, 'typing', { patientId: patient.id, isTyping: true });
            // Simulate typing indicator on WhatsApp for the patient
            const chat = await wMsg.getChat();
            console.log(`[WhatsApp Pipeline] Sending typing indicator to patient phone...`);
            chat.sendStateTyping().catch((e) => console.error(e));
            try {
                // If it's a new patient, we can optionally send a welcome message first
                let finalResponseText = '';
                // Get past messages in this conversation for context
                const historyMessages = await db_1.default.message.findMany({
                    where: { conversationId: conversation.id },
                    orderBy: { timestamp: 'asc' },
                    take: 15,
                });
                // Search Knowledge Base (RAG)
                const matchedChunks = await rag_service_1.RagService.searchKnowledgeBase(userId, incomingText, 3);
                const contextString = matchedChunks.length > 0
                    ? `Use the following clinic information to answer the patient's questions if relevant:\n---\n${matchedChunks.join('\n\n')}\n---\n`
                    : '';
                // Construct the AI prompt details
                const systemPrompt = `${settings.aiPersonality}\n\n` +
                    `CLINIC INFO / WORKING HOURS / RULES:\n` +
                    `Clinic Name: ${settings.clinicName}\n` +
                    `Clinic Address: ${settings.clinicAddress || 'Not specified'}\n` +
                    `Clinic Phone: ${settings.phone || 'Not specified'}\n` +
                    `Clinic Website: ${settings.website || 'Not specified'}\n` +
                    `Working Hours: ${settings.workingHours}\n\n` +
                    `RAG KNOWLEDGE RETRIEVED:\n${contextString}\n` +
                    `RULES FOR REPLIES:\n` +
                    `- Answer physiotherapy and rehab questions.\n` +
                    `- Suggest stretches or posture corrections, but state they are educational.\n` +
                    `- Reply in Hindi or English depending on the patient's language.\n` +
                    `- **CRITICAL CONTRAINDICATION**: NEVER diagnose a disease, prescribe a medicine, or claim to be a licensed doctor. Always recommend booking a physical appointment or seeking medical care for serious pain or symptoms.\n` +
                    `- **APPOINTMENTS**: If the patient wants to book, reschedule, or cancel, discuss their preferences. Once you agree on a specific date and time (confirming clinic hours: ${settings.workingHours}), append the following hidden tag at the very end of your response so the system can book it automatically:\n` +
                    `  [APPOINTMENT_ACTION: {"action": "BOOK", "dateTime": "YYYY-MM-DDTHH:MM:00", "title": "Physiotherapy Session"}]\n` +
                    `  For cancellation, append: [APPOINTMENT_ACTION: {"action": "CANCEL"}]\n` +
                    `  For rescheduling: [APPOINTMENT_ACTION: {"action": "RESCHEDULE", "dateTime": "YYYY-MM-DDTHH:MM:00"}]\n` +
                    `  Example: "Great, I've noted Monday at 10 AM." followed by the tag with that Monday's ISO date. The current year is 2026. The current local time is ${new Date().toLocaleString()}. Ensure the date and time format is exactly ISO 8601 (YYYY-MM-DDTHH:MM:00).`;
                // Format history for AI service
                const formattedHistory = historyMessages.map((m) => ({
                    sender: m.sender,
                    body: m.body,
                }));
                console.log(`[WhatsApp Pipeline] Querying AI service (Provider: ${settings.aiProvider}, Model: ${settings.aiModel})...`);
                // Generate response from AI
                const rawAiResponse = await ai_service_1.AiService.generateResponse(userId, systemPrompt, incomingText, formattedHistory);
                console.log(`[WhatsApp Pipeline] AI raw response received: "${rawAiResponse.substring(0, 150)}..."`);
                // Process appointment actions and strip tags
                const { cleanResponse, actionResult } = await appointment_service_1.AppointmentService.parseAiAction(userId, patient.id, rawAiResponse);
                finalResponseText = cleanResponse;
                console.log(`[WhatsApp Pipeline] Sending AI response via WhatsApp...`);
                // Send AI message back to patient
                await client.sendMessage(patientPhone, finalResponseText);
                console.log(`[WhatsApp Pipeline] Response successfully sent!`);
                // Save AI reply to database
                const savedAiMsg = await db_1.default.message.create({
                    data: {
                        conversationId: conversation.id,
                        sender: 'AI',
                        body: finalResponseText,
                        type: 'text',
                        timestamp: new Date(),
                    },
                });
                // Update last message in patient
                await db_1.default.patient.update({
                    where: { id: patient.id },
                    data: { lastMessage: finalResponseText },
                });
                // Emit AI message to frontend
                socket_service_1.SocketService.sendToUser(userId, 'new_message', {
                    conversationId: conversation.id,
                    message: savedAiMsg,
                });
                // Update Analytics
                await this.incrementAnalytics(userId, 'aiReplies');
            }
            catch (aiErr) {
                console.error('[WhatsApp AI Error] Failure during AI reply generation:', aiErr);
                // Fallback to default automatic reply: "Hello! 👋 How can I assist you today?"
                const defaultReply = "Hello! 👋 How can I assist you today?";
                try {
                    console.log(`[WhatsApp Pipeline] AI failed. Sending default fallback reply to ${patientPhone}...`);
                    // Send default welcome reply back to patient
                    await client.sendMessage(patientPhone, defaultReply);
                    console.log(`[WhatsApp Pipeline] Fallback reply successfully sent!`);
                    // Save default reply to database
                    const savedAiMsg = await db_1.default.message.create({
                        data: {
                            conversationId: conversation.id,
                            sender: 'AI',
                            body: defaultReply,
                            type: 'text',
                            timestamp: new Date(),
                        },
                    });
                    // Update last message in patient
                    await db_1.default.patient.update({
                        where: { id: patient.id },
                        data: { lastMessage: defaultReply },
                    });
                    // Emit AI message to frontend
                    socket_service_1.SocketService.sendToUser(userId, 'new_message', {
                        conversationId: conversation.id,
                        message: savedAiMsg,
                    });
                    // Update Analytics
                    await this.incrementAnalytics(userId, 'aiReplies');
                }
                catch (sendErr) {
                    console.error('[WhatsApp Fallback Error] Failed to send default reply:', sendErr);
                }
                // If AI fails, we notify the therapist
                await db_1.default.notification.create({
                    data: {
                        userId,
                        type: 'FAILED_AI',
                        title: 'AI Auto-reply Failed (Fallback Sent)',
                        message: `Could not generate AI reply for ${patient.name} (${patientPhone}). Sent default welcome reply instead. Error: ${aiErr.message || 'AI timeout'}`,
                    },
                }).catch((e) => console.error(e));
                socket_service_1.SocketService.sendToUser(userId, 'notification', {
                    type: 'FAILED_AI',
                    title: 'AI Auto-reply Failed (Fallback Sent)',
                    message: `Could not generate AI reply for ${patient.name}. Sent default reply instead.`,
                });
            }
            finally {
                chat.clearState().catch((e) => console.error(e));
                // Emit typing status cleared to dashboard
                socket_service_1.SocketService.sendToUser(userId, 'typing', { patientId: patient.id, isTyping: false });
                console.log(`[WhatsApp Pipeline] Processing finished for patient ${patient.name}.`);
            }
        }
        else {
            // Human Takeover Mode - notify therapist of new unread chat
            console.log(`[WhatsApp Pipeline] AI Auto-Reply is INACTIVE (Human Takeover). Skipping automatic response.`);
            socket_service_1.SocketService.sendToUser(userId, 'notification', {
                type: 'NEW_CHAT',
                title: `New Message from ${patient.name}`,
                message: incomingText.substring(0, 60) || 'Sent an attachment',
            });
        }
        // Always increment message analytics
        await this.incrementAnalytics(userId, 'messages');
        if (isNewPatient) {
            await this.incrementAnalytics(userId, 'patients');
        }
    }
    /**
     * Builds a strong translator system prompt for a given target language.
     * Used by both batch translation (step 1) and per-text translation.
     */
    static buildTranslatorSystemPrompt(targetLanguage) {
        let languageInstruction = '';
        if (targetLanguage.toLowerCase() === 'hinglish') {
            languageInstruction = `You MUST write in Hinglish — a natural mix of Hindi and English using ONLY the Latin/Roman alphabet (NO Devanagari script ever).
Examples of correct Hinglish output:
- "Apka naam kya hai?" (NOT "What is your name?")
- "Apki umar kitni hai?" (NOT "What is your age?")
- "Aapko kab se dard ho raha hai?" (NOT "Since when are you in pain?")
- "Apni problem batayein" (NOT "Please describe your problem")
Every single sentence MUST be Hinglish. If you return English, you have failed.`;
        }
        else if (targetLanguage.toLowerCase() === 'hindi') {
            languageInstruction = 'Write in proper Hindi using Devanagari script only (e.g., "आपका नाम क्या है?"). Do NOT return English.';
        }
        else if (targetLanguage.toLowerCase() === 'telugu') {
            languageInstruction = 'Write in proper Telugu script only. Do NOT return English.';
        }
        else if (targetLanguage.toLowerCase() === 'marathi') {
            languageInstruction = 'Write in proper Marathi using Devanagari script only. Do NOT return English.';
        }
        return `You are a professional medical translator for a physiotherapy clinic.
Your ONLY job is to translate text into ${targetLanguage}.
${languageInstruction}
Rules:
- Return ONLY the translated text. No explanations, no notes, no greetings.
- Preserve list numbers (Q1:, Q2:, 1., 2., etc.) and emojis exactly as-is.
- Do NOT translate proper nouns, phone numbers, or time slots (dates/times).
- Keep the exact same paragraph and line structure as the original.`;
    }
    /**
     * Helper to translate text using the active AI service.
     */
    static async translateText(userId, text, targetLanguage) {
        if (!targetLanguage || targetLanguage.toLowerCase() === 'english') {
            return text;
        }
        const systemPrompt = this.buildTranslatorSystemPrompt(targetLanguage);
        try {
            const translated = await ai_service_1.AiService.generateResponse(userId, systemPrompt, text, []);
            return translated.trim();
        }
        catch (err) {
            console.error(`[WhatsApp Translation] Failed to translate to ${targetLanguage}, falling back to English:`, err);
            return text;
        }
    }
    /**
     * Helper to parse the language choice from patient input.
     */
    static parseLanguageChoice(text) {
        const clean = text.trim();
        if (clean === '1' || clean.toLowerCase().includes('english'))
            return 'English';
        if (clean === '2' || clean.toLowerCase().includes('hindi'))
            return 'Hindi';
        if (clean === '3' || clean.toLowerCase().includes('hinglish'))
            return 'Hinglish';
        if (clean === '4' || clean.toLowerCase().includes('telugu') || clean.toLowerCase().includes('telgue'))
            return 'Telugu';
        if (clean === '5' || clean.toLowerCase().includes('marathi'))
            return 'Marathi';
        return 'English';
    }
    /**
     * Helper to generate predefined time slots.
     */
    static getPredefinedSlots() {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const dayAfter = new Date();
        dayAfter.setDate(dayAfter.getDate() + 2);
        const formatDate = (date) => {
            return date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        };
        return {
            slot1: `${formatDate(tomorrow)} at 10:00 AM`,
            slot2: `${formatDate(tomorrow)} at 2:00 PM`,
            slot3: `${formatDate(dayAfter)} at 11:00 AM`,
            slot4: `${formatDate(dayAfter)} at 4:00 PM`,
        };
    }
    /**
     * Helper to increment daily analytics.
     */
    static async incrementAnalytics(userId, field) {
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const analytics = await db_1.default.analytics.findFirst({
                where: {
                    userId,
                    date: today,
                },
            });
            const incrementData = {};
            if (field === 'patients')
                incrementData.patientsCount = { increment: 1 };
            if (field === 'messages')
                incrementData.messagesCount = { increment: 1 };
            if (field === 'aiReplies')
                incrementData.aiRepliesCount = { increment: 1 };
            if (analytics) {
                await db_1.default.analytics.update({
                    where: { id: analytics.id },
                    data: incrementData,
                });
            }
            else {
                // Create new daily record
                const initData = {
                    userId,
                    date: today,
                    patientsCount: field === 'patients' ? 1 : 0,
                    messagesCount: field === 'messages' ? 1 : 0,
                    aiRepliesCount: field === 'aiReplies' ? 1 : 0,
                };
                await db_1.default.analytics.create({
                    data: initData,
                });
            }
        }
        catch (err) {
            console.error('[Analytics Update Error]:', err);
        }
    }
    /**
     * Validates whether a patient's answer is appropriate for the given intake question.
     * Uses AI to check relevance. On any error, always accepts the answer to avoid blocking.
     */
    static async validateAnswer(userId, englishQuestion, answer) {
        // Always accept media attachments or empty answers
        if (!answer || answer === '[Media/Attachment]')
            return true;
        // Always accept very short numeric answers (e.g. "25" for age, "7" for pain scale)
        if (/^\d+$/.test(answer.trim()) && answer.trim().length <= 3)
            return true;
        // Always accept common polite refusals
        const lower = answer.trim().toLowerCase();
        if (['no', 'none', 'na', 'n/a', 'nil', 'nahi', 'nhi', 'nhi hai', 'pata nhi', 'dont know', "don't know", 'skip'].some(w => lower.includes(w)))
            return true;
        const systemPrompt = `You are a medical intake form validator for a physiotherapy clinic.
Your ONLY job is to decide if a patient's answer is relevant to the question asked.

Be LENIENT. Accept any answer that is even a reasonable attempt to answer the question, including:
- Short answers like a name, a number, a date, a body part
- Sentences describing pain, symptoms, or history
- "I don't know", "None", "No issues", "Normal"
- Answers in any language (Hindi, Hinglish, Telugu, Marathi, English)

Only REJECT answers that are:
- Pure gibberish with no meaning (e.g. "asdfgh", "xyz abc 123", "kkkkk")
- Completely off-topic (e.g. asked for name but replied with "I want food")
- A single random character like "a", "z", "x" (unless it's a valid yes/no response)

Return ONLY one word: YES (accept) or NO (reject). No explanation.`;
        const userMsg = `Question: "${englishQuestion}"\nPatient's Answer: "${answer}"\n\nShould this answer be accepted? Reply YES or NO only.`;
        try {
            const result = await ai_service_1.AiService.generateResponse(userId, systemPrompt, userMsg, []);
            const verdict = result.trim().toUpperCase();
            console.log(`[Answer Validation] Q: "${englishQuestion}" | A: "${answer}" | Verdict: ${verdict}`);
            return !verdict.startsWith('NO');
        }
        catch (err) {
            console.error('[Answer Validation] AI check failed, accepting answer by default:', err);
            return true; // Never block a patient due to AI failure
        }
    }
    /**
     * Returns a hardcoded "didn't understand, please answer again" message
     * in the patient's chosen language. No AI call needed.
     */
    static getRetryMessage(language) {
        switch (language.toLowerCase()) {
            case 'hinglish':
                return 'Samajh nahi aaya 😅 Kripya apna jawab dobara dijiye:';
            case 'hindi':
                return 'समझ नहीं आया 😅 कृपया अपना उत्तर फिर से दें:';
            case 'telugu':
                return 'అర్థం కాలేదు 😅 దయచేసి మళ్ళీ జవాబు ఇవ్వండి:';
            case 'marathi':
                return 'समजले नाही 😅 कृपया पुन्हा उत्तर द्या:';
            default:
                return "I didn't quite understand your answer 😅 Could you please answer this question again:";
        }
    }
    /**
     * Returns a hardcoded static translation for common onboarding questions.
     * Used as fallback when ALL AI providers are down.
     */
    static getStaticTranslation(englishText, language) {
        const translations = {
            'hinglish': {
                'What is your full name?': 'Apka poora naam kya hai?',
                'What is your date of birth?': 'Apki date of birth kya hai?',
                'What main symptoms or pain are you experiencing?': 'Apko kya main symptoms ya dard ho raha hai?',
                'On a scale of 1-10, how severe is your pain?': '1 se 10 ke scale pe apka dard kitna hai?',
                'How long have you had this issue?': 'Ye problem apko kab se hai?',
                'What makes the pain better or worse?': 'Kya cheez se dard badhta ya kam hota hai?',
                'Have you had any previous treatments or surgeries for this?': 'Kya apne iske liye pehle koi treatment ya surgery karai hai?',
                'Are you currently taking any medications?': 'Kya aap abhi koi medicine le rahe hain?',
                'What are your primary goals for physical therapy?': 'Physical therapy se apka kya goal hai?',
                'What are your preferred days and times for appointments?': 'Appointment ke liye apko kaun sa din aur time suit karta hai?',
            },
            'hindi': {
                'What is your full name?': 'आपका पूरा नाम क्या है?',
                'What is your date of birth?': 'आपकी जन्म तिथि क्या है?',
                'What main symptoms or pain are you experiencing?': 'आपको कौन से मुख्य लक्षण या दर्द हो रहा है?',
                'On a scale of 1-10, how severe is your pain?': '1 से 10 के पैमाने पर आपका दर्द कितना गंभीर है?',
                'How long have you had this issue?': 'यह समस्या आपको कब से है?',
                'What makes the pain better or worse?': 'किस चीज़ से दर्द बढ़ता या कम होता है?',
                'Have you had any previous treatments or surgeries for this?': 'क्या आपने इसके लिए पहले कोई उपचार या सर्जरी कराई है?',
                'Are you currently taking any medications?': 'क्या आप वर्तमान में कोई दवाई ले रहे हैं?',
                'What are your primary goals for physical therapy?': 'फिजिकल थेरेपी से आपका मुख्य लक्ष्य क्या है?',
                'What are your preferred days and times for appointments?': 'अपॉइंटमेंट के लिए आपको कौन सा दिन और समय सुविधाजनक है?',
            },
            'telugu': {
                'What is your full name?': 'మీ పూర్తి పేరు ఏమిటి?',
                'What is your date of birth?': 'మీ పుట్టిన తేదీ ఏమిటి?',
                'What main symptoms or pain are you experiencing?': 'మీకు ఏ ముఖ్యమైన లక్షణాలు లేదా నొప్పి ఉంది?',
                'On a scale of 1-10, how severe is your pain?': '1 నుండి 10 స్కేల్‌లో మీ నొప్పి ఎంత తీవ్రంగా ఉంది?',
                'How long have you had this issue?': 'ఈ సమస్య మీకు ఎంతకాలంగా ఉంది?',
                'What makes the pain better or worse?': 'ఏ విషయం నొప్పిని తగ్గిస్తుంది లేదా పెంచుతుంది?',
                'Have you had any previous treatments or surgeries for this?': 'దీని కోసం మీరు ఇంతకు ముందు ఏదైనా చికిత్స లేదా సర్జరీ చేయించుకున్నారా?',
                'Are you currently taking any medications?': 'మీరు ప్రస్తుతం ఏదైనా మందులు తీసుకుంటున్నారా?',
                'What are your primary goals for physical therapy?': 'ఫిజికల్ థెరపీ నుండి మీ ముఖ్యమైన లక్ష్యాలు ఏమిటి?',
                'What are your preferred days and times for appointments?': 'అపాయింట్‌మెంట్ కోసం మీకు ఏ రోజులు మరియు సమయాలు అనుకూలం?',
            },
            'marathi': {
                'What is your full name?': 'तुमचे पूर्ण नाव काय आहे?',
                'What is your date of birth?': 'तुमची जन्मतारीख काय आहे?',
                'What main symptoms or pain are you experiencing?': 'तुम्हाला कोणती मुख्य लक्षणे किंवा वेदना जाणवत आहेत?',
                'On a scale of 1-10, how severe is your pain?': '1 ते 10 च्या स्केलवर तुमची वेदना किती तीव्र आहे?',
                'How long have you had this issue?': 'ही समस्या तुम्हाला किती काळापासून आहे?',
                'What makes the pain better or worse?': 'कोणत्या गोष्टीमुळे वेदना वाढतात किंवा कमी होतात?',
                'Have you had any previous treatments or surgeries for this?': 'यासाठी तुम्ही यापूर्वी कोणते उपचार किंवा शस्त्रक्रिया केली आहे का?',
                'Are you currently taking any medications?': 'तुम्ही सध्या कोणती औषधे घेत आहात का?',
                'What are your primary goals for physical therapy?': 'फिजिकल थेरपीपासून तुमचे मुख्य ध्येय काय आहे?',
                'What are your preferred days and times for appointments?': 'अपॉइंटमेंटसाठी तुम्हाला कोणता दिवस आणि वेळ सोयीचा आहे?',
            },
        };
        const langKey = language.toLowerCase();
        return translations[langKey]?.[englishText] || null;
    }
    /**
     * Returns a hardcoded appointment menu in the patient's language.
     * Used as fallback when AI translation fails.
     */
    static getStaticAppointmentMenu(slots, language) {
        switch (language.toLowerCase()) {
            case 'hinglish':
                return `Kya aap physiotherapy appointment lena chahenge? Neeche diye gaye slots mein se ek choose karein (number type karein, jaise 1):\n\n1. 📅 ${slots.slot1}\n2. 📅 ${slots.slot2}\n3. 📅 ${slots.slot3}\n4. 📅 ${slots.slot4}\n5. ✍️ Koi aur (Apna din aur time batayein)\n6. ❌ Appointment nahi chahiye`;
            case 'hindi':
                return `क्या आप फिजियोथेरेपी अपॉइंटमेंट लेना चाहेंगे? नीचे दिए गए स्लॉट में से एक चुनें (नंबर टाइप करें, जैसे 1):\n\n1. 📅 ${slots.slot1}\n2. 📅 ${slots.slot2}\n3. 📅 ${slots.slot3}\n4. 📅 ${slots.slot4}\n5. ✍️ अन्य (अपना दिन और समय बताएं)\n6. ❌ अपॉइंटमेंट नहीं चाहिए`;
            case 'telugu':
                return `మీరు ఫిజియోథెరపీ అపాయింట్‌మెంట్ తీసుకోవాలనుకుంటున్నారా? కింద ఉన్న స్లాట్‌లలో ఒకటి ఎంచుకోండి (నంబర్ టైప్ చేయండి, ఉదా 1):\n\n1. 📅 ${slots.slot1}\n2. 📅 ${slots.slot2}\n3. 📅 ${slots.slot3}\n4. 📅 ${slots.slot4}\n5. ✍️ ఇతరం (మీ రోజు మరియు సమయం చెప్పండి)\n6. ❌ అపాయింట్‌మెంట్ వద్దు`;
            case 'marathi':
                return `तुम्हाला फिजिओथेरपी अपॉइंटमेंट घ्यायची आहे का? खालील स्लॉटमधून एक निवडा (नंबर टाइप करा, जसे 1):\n\n1. 📅 ${slots.slot1}\n2. 📅 ${slots.slot2}\n3. 📅 ${slots.slot3}\n4. 📅 ${slots.slot4}\n5. ✍️ इतर (तुमचा दिवस आणि वेळ सांगा)\n6. ❌ अपॉइंटमेंट नको`;
            default:
                return `Would you like to request a physiotherapy appointment? Please select one of our available slots by typing the number (e.g. 1):\n\n1. 📅 ${slots.slot1}\n2. 📅 ${slots.slot2}\n3. 📅 ${slots.slot3}\n4. 📅 ${slots.slot4}\n5. ✍️ Other (Specify your own date and time)\n6. ❌ Skip appointment booking`;
        }
    }
}
exports.WhatsappService = WhatsappService;
WhatsappService.clients = new Map();
