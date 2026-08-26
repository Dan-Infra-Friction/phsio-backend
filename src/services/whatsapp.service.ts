import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  WASocket,
  proto,
  isJidBroadcast,
  isJidGroup,
  jidNormalizedUser,
  Browsers,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import qrcode from 'qrcode';
import prisma from '../config/db';
import { SocketService } from './socket.service';
import { AiService } from './ai.service';
import { RagService } from './rag.service';
import { AppointmentService } from './appointment.service';

export class WhatsappService {
  private static clients: Map<string, WASocket> = new Map();
  private static pairingRequests: Map<string, string> = new Map();

  /**
   * Restores all WhatsApp sessions that were previously active.
   */
  public static async restoreSessions() {
    try {
      const sessions = await prisma.whatsappSession.findMany({
        where: { status: 'CONNECTED' },
      });
      console.log(`[WhatsApp Baileys] Found ${sessions.length} active sessions in database. Restoring...`);

      for (const session of sessions) {
        this.initializeClient(session.userId).catch((err) => {
          console.error(`[WhatsApp Baileys] Failed to restore session for user ${session.userId}:`, err);
        });
      }
    } catch (err) {
      console.error('[WhatsApp Baileys] Error restoring sessions:', err);
    }
  }

  /**
   * Initializes a Baileys WhatsApp client for a specific user.
   */
  public static async initializeClient(userId: string, pairingPhone?: string): Promise<WASocket> {
    if (this.clients.has(userId)) {
      const existingSock = this.clients.get(userId)!;
      if (pairingPhone && !existingSock.authState.creds.registered) {
        await this.triggerPairingCode(userId, existingSock, pairingPhone);
      }
      return existingSock;
    }

    console.log(`[WhatsApp Baileys] Initializing socket for user: ${userId}`);

    const sessionPath = path.join(process.cwd(), 'storage', 'sessions', `session-${userId}`);
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: true,
    });

    this.clients.set(userId, sock);

    sock.ev.on('creds.update', saveCreds);

    await prisma.whatsappSession.upsert({
      where: { userId },
      update: { status: 'CONNECTING', qrCode: null },
      create: { userId, status: 'CONNECTING' },
    });

    SocketService.sendToUser(userId, 'whatsapp_status', { status: 'CONNECTING' });

    // Connection updates handler
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log(`[WhatsApp Baileys] QR Code generated for user: ${userId}`);
        try {
          const qrImageBase64 = await qrcode.toDataURL(qr);
          await prisma.whatsappSession.update({
            where: { userId },
            data: { qrCode: qrImageBase64, status: 'DISCONNECTED' },
          });

          SocketService.sendToUser(userId, 'whatsapp_status', {
            status: 'DISCONNECTED',
            qr: qrImageBase64,
          });
        } catch (err) {
          console.error('[WhatsApp Baileys] QR generation error:', err);
        }
      }

      if (connection === 'connecting') {
        console.log(`[WhatsApp Baileys] Connecting for user ${userId}...`);
        await prisma.whatsappSession.update({
          where: { userId },
          data: { status: 'CONNECTING' },
        }).catch(() => {});
        SocketService.sendToUser(userId, 'whatsapp_status', { status: 'CONNECTING' });
      }

      if (connection === 'open') {
        console.log(`[WhatsApp Baileys] Connection established successfully for user: ${userId}`);
        const rawJid = sock.user?.id || '';
        const phone = rawJid.split(':')[0].split('@')[0];
        const profileName = sock.user?.name || 'Clinic WhatsApp';

        let profilePicUrl: string | null = null;
        try {
          const normJid = jidNormalizedUser(rawJid);
          const url = await sock.profilePictureUrl(normJid, 'image');
          profilePicUrl = url || null;
        } catch {
          profilePicUrl = null;
        }

        await prisma.whatsappSession.update({
          where: { userId },
          data: {
            status: 'CONNECTED',
            phone,
            profileName,
            profilePicUrl: profilePicUrl || null,
            lastSync: new Date(),
            qrCode: null,
          },
        });

        SocketService.sendToUser(userId, 'whatsapp_status', {
          status: 'CONNECTED',
          phone,
          profileName,
          profilePicUrl,
        });

        await prisma.notification.create({
          data: {
            userId,
            type: 'NEW_CHAT',
            title: 'WhatsApp Connected',
            message: `WhatsApp account ${profileName} (${phone}) connected successfully via Baileys.`,
          },
        }).catch(() => {});
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`[WhatsApp Baileys] Connection closed for user ${userId}. Reason: ${statusCode}, shouldReconnect: ${shouldReconnect}`);

        this.clients.delete(userId);

        if (shouldReconnect) {
          console.log(`[WhatsApp Baileys] Auto-reconnecting for user ${userId}...`);
          setTimeout(() => {
            this.initializeClient(userId).catch((err) => {
              console.error('[WhatsApp Baileys] Reconnect error:', err);
            });
          }, 3000);
        } else {
          console.log(`[WhatsApp Baileys] Session logged out for user ${userId}. Wiping local tokens...`);
          if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
          }
          await prisma.whatsappSession.update({
            where: { userId },
            data: { status: 'DISCONNECTED', qrCode: null, phone: null, profileName: null, profilePicUrl: null },
          }).catch(() => {});

          SocketService.sendToUser(userId, 'whatsapp_status', { status: 'DISCONNECTED' });
        }
      }
    });

    // Incoming messages handler
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message) continue;
        const remoteJid = msg.key.remoteJid || '';

        // Ignore status updates, broadcasts, group chats
        if (isJidGroup(remoteJid) || isJidBroadcast(remoteJid) || remoteJid.endsWith('@broadcast')) {
          continue;
        }

        try {
          await this.handleIncomingMessage(userId, sock, msg);
        } catch (err) {
          console.error('[WhatsApp Baileys] Error handling message:', err);
        }
      }
    });

    return sock;
  }

  /**
   * Triggers a phone number pairing code via Baileys
   */
  private static async triggerPairingCode(userId: string, sock: WASocket, phone: string): Promise<string> {
    try {
      let cleanPhone = phone.replace(/[^\d]/g, '');
      if (cleanPhone.startsWith('0')) {
        cleanPhone = cleanPhone.substring(1);
      }
      if (cleanPhone.length === 10) {
        cleanPhone = `91${cleanPhone}`;
      }

      // Wait up to 6 seconds for WebSocket connection to open if still establishing
      let attempts = 0;
      while ((!sock.ws || (sock.ws as any).readyState !== 1) && attempts < 12) {
        await new Promise((res) => setTimeout(res, 500));
        attempts++;
      }

      console.log(`[WhatsApp Baileys] Requesting pairing code for user ${userId} with phone ${cleanPhone} (WS ready attempts: ${attempts})`);
      const rawCode = await sock.requestPairingCode(cleanPhone);
      const formattedCode = rawCode.match(/.{1,4}/g)?.join('-') || rawCode;
      
      console.log(`[WhatsApp Baileys] Pairing Code generated: ${formattedCode}`);

      SocketService.sendToUser(userId, 'whatsapp_pairing_code', {
        code: formattedCode,
        phone: cleanPhone,
      });

      return formattedCode;
    } catch (err: any) {
      console.error('[WhatsApp Baileys] Failed to generate pairing code:', err);
      SocketService.sendToUser(userId, 'whatsapp_pairing_code_error', {
        message: err.message || 'Failed to generate pairing code. Please check phone number format.',
      });
      throw err;
    }
  }

  /**
   * Requests a pairing code for a user given their phone number
   */
  public static async requestPairingCode(userId: string, phoneNumber: string): Promise<string> {
    let sock = this.clients.get(userId);
    if (sock && (sock as any).ws?.readyState === 3) {
      this.clients.delete(userId);
      sock = undefined;
    }
    if (!sock) {
      sock = await this.initializeClient(userId);
    }
    return await this.triggerPairingCode(userId, sock, phoneNumber);
  }

  public static async disconnectClient(userId: string): Promise<boolean> {
    const sock = this.clients.get(userId);

    try {
      console.log(`[WhatsApp Baileys] Disconnecting client for user: ${userId}`);
      if (sock) {
        sock.ev.removeAllListeners('connection.update');
        sock.ev.removeAllListeners('messages.upsert');
        try {
          sock.end(new Error('User requested disconnect'));
        } catch {}
        this.clients.delete(userId);
      }

      const sessionFolder = path.join(process.cwd(), 'storage', 'sessions', `session-${userId}`);
      if (fs.existsSync(sessionFolder)) {
        fs.rmSync(sessionFolder, { recursive: true, force: true });
      }

      await prisma.whatsappSession.update({
        where: { userId },
        data: { status: 'DISCONNECTED', qrCode: null, phone: null, profileName: null, profilePicUrl: null },
      });

      SocketService.sendToUser(userId, 'whatsapp_status', { status: 'DISCONNECTED' });
      return true;
    } catch (err) {
      console.error('[WhatsApp Baileys] Error disconnecting client:', err);
      return false;
    }
  }

  /**
   * Adapter for existing controllers expecting a client object with sendMessage and getFormattedNumber
   */
  public static getClient(userId: string) {
    const sock = this.clients.get(userId);
    if (!sock) return undefined;

    return {
      sendMessage: async (targetPhone: string, content: string | any) => {
        let jid = targetPhone.replace('@c.us', '@s.whatsapp.net');
        if (!jid.includes('@')) {
          jid = `${targetPhone.replace(/[^\d]/g, '')}@s.whatsapp.net`;
        }
        if (typeof content === 'string') {
          return await sock.sendMessage(jid, { text: content });
        } else {
          return await sock.sendMessage(jid, content);
        }
      },
      getFormattedNumber: async (phone: string) => {
        const digits = phone.replace(/[^\d]/g, '');
        return `+${digits}`;
      },
      sock,
    };
  }

  /**
   * Direct send message helper
   */
  public static async sendMessage(userId: string, targetPhone: string, text: string) {
    const sock = this.clients.get(userId);
    if (!sock) throw new Error('WhatsApp client is not active.');
    let jid = targetPhone;
    if (targetPhone.endsWith('@c.us')) {
      jid = targetPhone.replace('@c.us', '@s.whatsapp.net');
    } else if (!targetPhone.includes('@')) {
      jid = `${targetPhone.replace(/[^\d]/g, '')}@s.whatsapp.net`;
    }
    console.log(`[WhatsApp Baileys Outgoing] Sending message to ${jid}: "${text.substring(0, 60)}..."`);
    await sock.sendMessage(jid, { text });
  }

  /**
   * Direct send media helper (images/videos)
   */
  public static async sendMedia(userId: string, targetPhone: string, mediaUrl: string, type: 'image' | 'video', caption?: string) {
    const sock = this.clients.get(userId);
    if (!sock) throw new Error('WhatsApp client is not active.');
    let jid = targetPhone;
    if (targetPhone.endsWith('@c.us')) {
      jid = targetPhone.replace('@c.us', '@s.whatsapp.net');
    } else if (!targetPhone.includes('@')) {
      jid = `${targetPhone.replace(/[^\d]/g, '')}@s.whatsapp.net`;
    }
    console.log(`[WhatsApp Baileys Outgoing Media] Sending ${type} to ${jid}: ${mediaUrl}`);
    if (type === 'video') {
      await sock.sendMessage(jid, { video: { url: mediaUrl }, caption });
    } else {
      await sock.sendMessage(jid, { image: { url: mediaUrl }, caption });
    }
  }

  /**
   * Marks a WhatsApp chat as read (sends seen receipt).
   */
  public static async markChatAsRead(userId: string, patientPhone: string) {
    const sock = this.clients.get(userId);
    if (!sock) return;
    try {
      let jid = patientPhone.replace('@c.us', '@s.whatsapp.net');
      if (!jid.includes('@')) jid = `${patientPhone.replace(/[^\d]/g, '')}@s.whatsapp.net`;
      await sock.readMessages([{ remoteJid: jid, id: '', fromMe: false }]);
      console.log(`[WhatsApp Baileys] Sent read receipt to ${jid}`);
    } catch (err: any) {
      console.error(`[WhatsApp Baileys] Failed to mark chat ${patientPhone} as read: ${err.message || err}`);
    }
  }

  /**
   * Clears and deletes a WhatsApp chat history.
   */
  public static async clearChatHistory(userId: string, patientPhone: string) {
    const sock = this.clients.get(userId);
    if (!sock) return;
    try {
      let jid = patientPhone.replace('@c.us', '@s.whatsapp.net');
      if (!jid.includes('@')) jid = `${patientPhone.replace(/[^\d]/g, '')}@s.whatsapp.net`;
      await sock.chatModify({ delete: true, lastMessages: [] }, jid);
      console.log(`[WhatsApp Baileys] Cleared chat history for ${jid}`);
    } catch (err: any) {
      console.error(`[WhatsApp Baileys] Failed to clear chat ${patientPhone}: ${err.message || err}`);
    }
  }

  /**
   * Handles incoming Baileys messages.
   */
  private static async handleIncomingMessage(
    userId: string,
    sock: WASocket,
    msg: proto.IWebMessageInfo
  ) {
    if (!msg.key) return;
    const remoteJid = msg.key.remoteJid || '';
    const fromMe = msg.key.fromMe || false;

    // Prefer participant JID if remoteJid is a companion LID (@lid)
    const participantJid = msg.key.participant || (msg as any).participant || '';
    let phoneJid = remoteJid;
    if (remoteJid.endsWith('@lid') && participantJid && !participantJid.endsWith('@lid')) {
      phoneJid = participantJid;
    } else if (participantJid && !participantJid.endsWith('@lid')) {
      phoneJid = participantJid;
    }

    let rawNumber = phoneJid.split('@')[0].split(':')[0].replace(/[^\d]/g, '');

    // Extract text content from message object
    const incomingText =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      msg.message?.documentMessage?.caption ||
      '';

    // Format rawNumber to real phone number string (e.g. +91 85020 49163)
    let formattedRealPhone = '';
    if (rawNumber.startsWith('91') && rawNumber.length === 12) {
      formattedRealPhone = `+91 ${rawNumber.substring(2)}`;
    } else if (rawNumber.length === 10) {
      formattedRealPhone = `+91 ${rawNumber}`;
    } else if (rawNumber && !rawNumber.startsWith('1894')) {
      formattedRealPhone = `+${rawNumber}`;
    }

    // Auto-detect any 10-digit Indian mobile number in incoming text if LID JID was received
    const indianPhoneMatch = incomingText.match(/(?:\+91[\s-]?)?([6-9]\d{9})/);
    if (indianPhoneMatch && (!formattedRealPhone || rawNumber.startsWith('1894') || rawNumber.length > 13)) {
      formattedRealPhone = `+91 ${indianPhoneMatch[1]}`;
    }

    const patientPhone = `${rawNumber}@c.us`;

    console.log(`\n======================================================`);
    console.log(`[WhatsApp Baileys] NEW INCOMING MESSAGE CAPTURED!`);
    console.log(`From JID: ${remoteJid} | Phone: ${patientPhone} | RealPhone: ${formattedRealPhone}`);
    console.log(`Text: "${incomingText || '[Media/Attachment]'}"`);
    console.log(`======================================================\n`);

    // --- THERAPIST COMMAND INTERCEPTOR ---
    const therapistJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : '';
    if (fromMe || (therapistJid && remoteJid === therapistJid)) {
      const text = incomingText.trim();
      const approveRegex = /^\s*APPROVE\s+(\+?\d[\d\s-]*\d)/i;
      const match = text.match(approveRegex);

      if (match) {
        const rawPhone = match[1].replace(/[+\s-]/g, '');
        console.log(`[Therapist Action] Intercepted APPROVE command for patient phone: ${rawPhone}`);

        try {
          const patient = await prisma.patient.findFirst({
            where: {
              userId,
              phone: { contains: rawPhone },
            },
          });

          if (patient) {
            let answers: Record<string, string> = {};
            try {
              answers = JSON.parse(patient.onboardingAnswers || '{}');
            } catch {
              answers = {};
            }

            const requestedSlot = answers['appointmentSlot'];
            const patientLanguage = answers['language'] || 'English';

            if (requestedSlot) {
              let parsedDate = new Date();
              parsedDate.setDate(parsedDate.getDate() + 1);
              parsedDate.setHours(10, 0, 0, 0);

              try {
                const parsePrompt = `You are a scheduling assistant. Convert the following text describing an appointment time into an ISO 8601 date string. 
The current local time is ${new Date().toLocaleString()}. The current year is 2026.
Return ONLY the ISO 8601 date string (e.g., "2026-06-27T10:00:00"), with absolutely no extra text.

TEXT TO PARSE:
"${requestedSlot}"`;

                const isoStr = await AiService.generateResponse(userId, parsePrompt, "Parse appointment date.", []);
                const parsedTemp = new Date(isoStr.trim());
                if (!isNaN(parsedTemp.getTime())) {
                  parsedDate = parsedTemp;
                }
              } catch (parseErr) {
                console.error('[Therapist Action] Failed to parse date via AI:', parseErr);
              }

              await prisma.appointment.create({
                data: {
                  userId,
                  patientId: patient.id,
                  title: 'Physiotherapy Session',
                  dateTime: parsedDate,
                  status: 'UPCOMING',
                  notes: `Auto-booked via WhatsApp onboarding. Slot requested: ${requestedSlot}`,
                },
              });

              const dateObj = new Date(parsedDate);
              const dtStr = dateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
              const timeStr = dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
              const formattedSlot = `${dtStr} at ${timeStr}`;

              const confirmationTemplate = `Hello ${patient.name}! Your appointment request has been approved and successfully booked for:\n📅 *${formattedSlot}*\n\nWe look forward to seeing you!`;
              const translatedConfirmation = await this.translateText(userId, confirmationTemplate, patientLanguage);

              await this.sendMessage(userId, patient.phone, translatedConfirmation);

              let conversation = await prisma.conversation.findUnique({
                where: { userId_patientId: { userId, patientId: patient.id } },
              });
              if (conversation) {
                await prisma.message.create({
                  data: {
                    conversationId: conversation.id,
                    sender: 'AI',
                    body: translatedConfirmation,
                    type: 'text',
                    timestamp: new Date(),
                  },
                });
              }

              const successMsg = `✅ SUCCESS: Appointment booked for ${patient.name} on ${requestedSlot} (${parsedDate.toLocaleString()}). Patient has been notified.`;
              if (therapistJid) {
                await sock.sendMessage(therapistJid, { text: successMsg });
              }

              SocketService.sendToUser(userId, 'patient_update', { patientId: patient.id });
            } else {
              if (therapistJid) {
                await sock.sendMessage(therapistJid, { text: `❌ ERROR: No requested appointment slot found for patient ${patient.name}.` });
              }
            }
          }
        } catch (err: any) {
          console.error('[Therapist Action] Error in remote approval:', err);
        }
        return;
      }
      if (fromMe) return; // Ignore standard self-sent messages
    }

    // 1. Get or Create Patient (search by remoteJid or legacy patientPhone)
    let patient = await prisma.patient.findFirst({
      where: {
        userId,
        OR: [
          { phone: remoteJid },
          { phone: patientPhone },
        ],
      },
    });

    let isNewPatient = false;
    if (!patient) {
      isNewPatient = true;
      console.log(`[WhatsApp Baileys] Patient ${remoteJid} not found in database. Registering new patient...`);
      const pushName = msg.pushName || rawNumber;

      let profilePhoto: string | null = null;
      try {
        const url = await sock.profilePictureUrl(remoteJid, 'image');
        profilePhoto = url || null;
      } catch {
        profilePhoto = null;
      }

      // Generate unique short receipt number
      const digitsStr = '0123456789';
      let randCodeStr = '';
      for (let i = 0; i < 5; i++) {
        randCodeStr += digitsStr[Math.floor(Math.random() * 10)];
      }
      const receiptNumber = `RC-${randCodeStr}`;

      patient = await prisma.patient.create({
        data: {
          userId,
          phone: remoteJid,
          realPhone: formattedRealPhone || (rawNumber ? `+${rawNumber}` : remoteJid),
          name: pushName,
          profilePhoto,
          status: 'ACTIVE',
          receiptNumber,
        },
      });

      await prisma.notification.create({
        data: {
          userId,
          type: 'NEW_PATIENT',
          title: 'New Patient Registered',
          message: `${pushName} (${formattedRealPhone || rawNumber}) sent their first message.`,
        },
      }).catch((e) => console.error(e));

      SocketService.sendToUser(userId, 'notification', {
        type: 'NEW_PATIENT',
        title: 'New Patient Registered',
        message: `${pushName} (${formattedRealPhone || rawNumber}) sent their first message.`,
      });
    } else {
      const updateData: any = {};
      if (patient.phone !== remoteJid) {
        updateData.phone = remoteJid;
      }
      if (formattedRealPhone && (!patient.realPhone || patient.realPhone.includes('1894') || patient.realPhone.includes('@lid'))) {
        updateData.realPhone = formattedRealPhone;
      }
      if (Object.keys(updateData).length > 0) {
        patient = await prisma.patient.update({
          where: { id: patient.id },
          data: updateData,
        });
      }
    }

    // 2. Get or Create Conversation
    let conversation = await prisma.conversation.findUnique({
      where: {
        userId_patientId: {
          userId,
          patientId: patient.id,
        },
      },
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          userId,
          patientId: patient.id,
        },
      });
    }

    // 3. Process attachments/media if present
    let mediaUrl: string | null = null;
    let messageType = 'text';

    const hasMedia = !!(
      msg.message?.imageMessage ||
      msg.message?.videoMessage ||
      msg.message?.documentMessage ||
      msg.message?.audioMessage
    );

    if (hasMedia) {
      try {
        const buffer = await downloadMediaMessage(msg as any, 'buffer', {});
        const mime =
          msg.message?.imageMessage?.mimetype ||
          msg.message?.videoMessage?.mimetype ||
          msg.message?.documentMessage?.mimetype ||
          msg.message?.audioMessage?.mimetype ||
          'application/octet-stream';

        const ext = mime.split('/')[1]?.split(';')[0] || 'bin';
        const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}.${ext}`;

        let folder = 'documents';
        if (mime.includes('image')) {
          folder = 'images';
          messageType = 'image';
        } else if (mime.includes('video')) {
          folder = 'video';
          messageType = 'video';
        } else if (mime.includes('audio')) {
          folder = 'audio';
          messageType = 'audio';
        } else if (mime.includes('pdf')) {
          folder = 'pdf';
          messageType = 'pdf';
        }

        const targetDir = path.join(process.cwd(), 'storage', 'uploads', folder);
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }

        const localFilePath = path.join(targetDir, filename);
        fs.writeFileSync(localFilePath, buffer as Buffer);

        mediaUrl = `/uploads/${folder}/${filename}`;
        console.log(`[WhatsApp Baileys] Saved media attachment locally: ${mediaUrl}`);
      } catch (err) {
        console.error('[WhatsApp Baileys] Failed to download media attachment:', err);
      }
    }

    // 4. Save Patient Message to Database
    const savedIncomingMsg = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        sender: 'PATIENT',
        body: incomingText || (hasMedia ? `Sent a media attachment (${messageType})` : ''),
        type: messageType,
        mediaUrl,
        timestamp: new Date(),
      },
    });

    // Auto-extract any 10-digit mobile number sent in incomingText
    let extractedPhone = '';
    const phoneMatch = (incomingText || '').match(/(?:\+91[\s-]?)?([6-9]\d{9})/);
    if (phoneMatch) {
      extractedPhone = `+91 ${phoneMatch[1]}`;
    }

    await prisma.patient.update({
      where: { id: patient.id },
      data: {
        lastSeen: new Date(),
        lastMessage: incomingText || `[${messageType.toUpperCase()}]`,
        ...(extractedPhone ? { realPhone: extractedPhone } : {}),
      },
    });

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() },
    });

    SocketService.sendToUser(userId, 'new_message', {
      conversationId: conversation.id,
      message: savedIncomingMsg,
    });

    // TREATMENT PLAN PROGRESS REPLY INTERCEPTOR
    // Only intercepts when:
    //   1. Patient's lastMessage shows a reminder was sent ([TREATMENT REMINDER SENT])
    //   2. OR patient is in "awaiting structured reply" state ([TREATMENT AWAITING REPLY])
    const lastMsg = patient.lastMessage || '';
    const reminderWasSent = lastMsg.includes('[TREATMENT REMINDER SENT');
    const awaitingReply = lastMsg.includes('[TREATMENT AWAITING REPLY');

    if (reminderWasSent || awaitingReply) {
      try {
        const { TreatmentReminderService } = await import('./treatment-reminder.service');

        if (reminderWasSent) {
          // Step 1: Patient just replied after seeing reminder — show them how to structure their progress reply
          const replyGuide =
            `✅ *Great! Please send your progress update in this format:*\n\n` +
            `*1.* Did you complete today's exercises? *(Yes / No / Partial)*\n` +
            `*2.* Your pain level today *(1–10)*\n` +
            `*3.* Any discomfort or issues?\n\n` +
            `_Example:_ Yes, pain 4, mild stiffness in knee\n\n` +
            `Your physiotherapist will review your progress! 🏥`;

          await this.sendMessage(userId, remoteJid, replyGuide);

          // Mark patient as now awaiting structured reply
          await prisma.patient.update({
            where: { id: patient.id },
            data: { lastMessage: `[TREATMENT AWAITING REPLY - ${lastMsg.replace('[TREATMENT REMINDER SENT - ', '').replace(']', '')}]` },
          });

          const conv = conversation;
          if (conv) {
            await prisma.message.create({
              data: {
                conversationId: conv.id,
                sender: 'AI',
                body: replyGuide,
                type: 'text',
                timestamp: new Date(),
              },
            });
          }

          SocketService.sendToUser(userId, 'new_message', { conversationId: conversation.id });
          return;
        }

        if (awaitingReply) {
          // Step 2: Patient sent their actual structured progress — save it and reply with AI advice
          const aiAdvice = await TreatmentReminderService.handleProgressReply(
            userId,
            patient.id,
            patient.name,
            incomingText
          );

          if (aiAdvice) {
            await this.sendMessage(userId, remoteJid, aiAdvice);

            // Reset patient state back to normal
            await prisma.patient.update({
              where: { id: patient.id },
              data: { lastMessage: incomingText },
            });

            const conv = conversation;
            if (conv) {
              await prisma.message.create({
                data: {
                  conversationId: conv.id,
                  sender: 'AI',
                  body: aiAdvice,
                  type: 'text',
                  timestamp: new Date(),
                },
              });
            }

            SocketService.sendToUser(userId, 'new_message', { conversationId: conversation.id });
            return;
          }
        }
      } catch (tErr: any) {
        console.error('[Treatment Reminder] Progress reply handler error:', tErr.message);
      }
    }

    // ONBOARDING PIPELINE: Automated dynamic intake questionnaire with multi-language & booking
    const settings = await prisma.setting.findUnique({ where: { userId } });
    
    const defaultQuestions = [
      "What is your full name?",
      "What is your 10-digit WhatsApp mobile number?",
      "What is your date of birth?",
      "What main symptoms or pain are you experiencing?",
      "On a scale of 1-10, how severe is your pain?",
      "How long have you had this issue?",
      "What makes the pain better or worse?",
      "Have you had any previous treatments or surgeries for this?",
      "Are you currently taking any medications?",
      "What are your primary goals for physical therapy?",
      "What are your preferred days and times for appointments?"
    ];

    let onboardingQuestions: string[] = defaultQuestions;
    if (settings?.onboardingQuestions) {
      try {
        const parsed = JSON.parse(settings.onboardingQuestions);
        if (Array.isArray(parsed) && parsed.length > 0) {
          onboardingQuestions = parsed;
        }
      } catch {}
    }

    // Reset onboarding if patient requests it via keyword
    const cleanCmd = incomingText.trim().toLowerCase();
    if (['intake', 'restart', 'start', 'register', 'start intake'].includes(cleanCmd)) {
      patient = await prisma.patient.update({
        where: { id: patient.id },
        data: { onboardingStep: 0, onboardingAnswers: '{}' },
      });
      console.log(`[Onboarding Pipeline] Keyword trigger: Reset onboarding step to 0 for ${patient.name}`);
    }

    const N = onboardingQuestions.length;

    if (N > 0 && (patient.onboardingStep <= N + 2 || patient.onboardingStep === 101)) {
      console.log(`[Onboarding Pipeline] ACTIVE: Patient ${patient.name} (${patientPhone}) is in intake flow. Step: ${patient.onboardingStep} of ${N + 2}`);

      try {
        let answers: Record<string, string> = {};
        try {
          answers = JSON.parse(patient.onboardingAnswers || '{}');
        } catch {
          answers = {};
        }
        const patientLanguage = answers['language'] || 'English';

        // --- STEP 0: Send Language Selection Menu ---
        if (patient.onboardingStep === 0) {
          const clinicName = settings?.clinicName || "Our Clinic";
          const clinicPhone = settings?.phone || "";
          const clinicAddress = settings?.clinicAddress || "";
          const clinicWebsite = settings?.website || "";

          let greeting = `👋 Hello! Welcome to *${clinicName}*!\n\n`;
          greeting += `🤖 *AI Assistant Disclaimer*:\n`;
          greeting += `I am DR. ASAD AI, your automated clinical assistant. I am here to help you get registered and guide you through your rehabilitation intake. Please note that while I can answer clinic questions and gather details, I do not provide medical diagnosis or replace human practitioners.\n\n`;
          
          if (clinicAddress || clinicPhone || clinicWebsite) {
            greeting += `📍 *Clinic Details*:\n`;
            if (clinicAddress) greeting += `• Address: ${clinicAddress}\n`;
            if (clinicPhone) greeting += `• Phone: ${clinicPhone}\n`;
            if (clinicWebsite) greeting += `• Website: ${clinicWebsite}\n`;
            greeting += `\n`;
          }

          const languageMenu = `Please select your preferred language by typing the number:
कृपया अपनी पसंदीदा भाषा चुनने के लिए नंबर लिखकर उत्तर दें:

1. English
2. Hindi (हिंदी)
3. Hinglish (Hinglish)
4. Telugu (తెలుగు)
5. Marathi (మరాठी)`;

          const fullGreeting = `${greeting}${languageMenu}`;

          await this.sendMessage(userId, remoteJid, fullGreeting);

          const savedMsg = await prisma.message.create({
            data: {
              conversationId: conversation.id,
              sender: 'AI',
              body: fullGreeting,
              type: 'text',
              timestamp: new Date(),
            },
          });

          await prisma.patient.update({
            where: { id: patient.id },
            data: {
              onboardingStep: 1,
              lastMessage: fullGreeting,
            },
          });

          SocketService.sendToUser(userId, 'new_message', {
            conversationId: conversation.id,
            message: savedMsg,
          });

          return;
        }

        // --- STEP 1: Process Language, translate questions, send Q1 ---
        if (patient.onboardingStep === 1) {
          const selectedLanguage = this.parseLanguageChoice(incomingText);
          answers['language'] = selectedLanguage;

          let translatedQuestions: string[] = [...onboardingQuestions];
          let translatedAppointmentMenu = '';

          if (selectedLanguage.toLowerCase() !== 'english') {
            try {
              let allStatic = true;
              const parsed: string[] = [];
              for (const q of onboardingQuestions) {
                const staticTrans = this.getStaticTranslation(q, selectedLanguage);
                if (staticTrans) {
                  parsed.push(staticTrans);
                } else {
                  allStatic = false;
                  break;
                }
              }

              if (allStatic) {
                translatedQuestions = parsed;
              } else {
                const allQuestionsText = onboardingQuestions
                  .map((q, i) => `Q${i + 1}: ${q}`)
                  .join('\n');

                const systemPrompt = this.buildTranslatorSystemPrompt(selectedLanguage);
                const userMsg = `Translate each of the following questions into ${selectedLanguage}. Return ONLY the translated questions, one per line, in the exact same numbered format (Q1:, Q2:, etc.). Do not add any extra text.\n\n${allQuestionsText}`;

                const raw = await AiService.generateResponse(userId, systemPrompt, userMsg, []);
                const lines = raw.split('\n').filter((l) => l.trim());
                const parsedAI: string[] = [];
                for (const line of lines) {
                  const cleaned = line.replace(/^Q\d+:\s*/i, '').trim();
                  if (cleaned) parsedAI.push(cleaned);
                }
                if (parsedAI.length === N) {
                  translatedQuestions = parsedAI;
                } else {
                  translatedQuestions = await Promise.all(
                    onboardingQuestions.map((q) => this.translateText(userId, q, selectedLanguage))
                  );
                }
              }

              const slots = await this.getPredefinedSlots(userId);
              const apptMenuEnglish = `Would you like to request a physiotherapy appointment? Please select one of our available slots by typing the number (e.g. 1):\n\n1. 📅 ${slots.slot1}\n2. 📅 ${slots.slot2}\n3. 📅 ${slots.slot3}\n4. 📅 ${slots.slot4}\n5. ✍️ Other (Specify your own date and time)\n6. ❌ Skip appointment booking`;
              translatedAppointmentMenu = this.getStaticTranslation(apptMenuEnglish, selectedLanguage) || await this.translateText(userId, apptMenuEnglish, selectedLanguage);
            } catch (translErr) {
              translatedQuestions = onboardingQuestions.map((q) =>
                this.getStaticTranslation(q, selectedLanguage) || q
              );
              const slots = await this.getPredefinedSlots(userId);
              const apptMenuEnglish = `Would you like to request a physiotherapy appointment? Please select one of our available slots by typing the number (e.g. 1):\n\n1. 📅 ${slots.slot1}\n2. 📅 ${slots.slot2}\n3. 📅 ${slots.slot3}\n4. 📅 ${slots.slot4}\n5. ✍️ Other (Specify your own date and time)\n6. ❌ Skip appointment booking`;
              translatedAppointmentMenu = this.getStaticTranslation(apptMenuEnglish, selectedLanguage) || this.getStaticAppointmentMenu(slots, selectedLanguage);
            }
          }

          answers['_translatedQuestions'] = JSON.stringify(translatedQuestions);
          answers['_translatedAppointmentMenu'] = translatedAppointmentMenu;

          // Send consultation verification question instead of Q1
          const consultationQuestion = "Did you take any consultation from us before or is this your first time? If you visited before, then share your receipt number, or if this is your first time, then type hello.";
          let translatedConsultation = consultationQuestion;
          if (selectedLanguage.toLowerCase() !== 'english') {
            translatedConsultation = this.getCustomConsultationTranslation(consultationQuestion, selectedLanguage);
          }

          await this.sendMessage(userId, remoteJid, translatedConsultation);

          const savedMsg = await prisma.message.create({
            data: {
              conversationId: conversation.id,
              sender: 'AI',
              body: translatedConsultation,
              type: 'text',
              timestamp: new Date(),
            },
          });

          await prisma.patient.update({
            where: { id: patient.id },
            data: {
              onboardingStep: 101,
              onboardingAnswers: JSON.stringify(answers),
              lastMessage: translatedConsultation,
            },
          });

          SocketService.sendToUser(userId, 'new_message', {
            conversationId: conversation.id,
            message: savedMsg,
          });

          return;
        }

        // --- STEP 101: Process Consultation verification (Receipt vs Hello) ---
        if (patient.onboardingStep === 101) {
          const cleanText = incomingText.trim().toLowerCase();
          const isFirstTime = 
            cleanText === 'hello' || 
            cleanText.includes('hello') || 
            cleanText.includes('hi') || 
            cleanText.includes('hey') || 
            cleanText.includes('first') || 
            cleanText.includes('new') ||
            cleanText.includes('no');
          
          if (isFirstTime) {
            // User selected "first time" -> Start the intake questionnaire flow
            let cachedTranslatedQuestions: string[] = onboardingQuestions;
            try {
              const cached = JSON.parse(answers['_translatedQuestions'] || 'null');
              if (Array.isArray(cached) && cached.length === N) {
                cachedTranslatedQuestions = cached;
              }
            } catch {}

            const translatedQ1 = cachedTranslatedQuestions[0] || onboardingQuestions[0];
            await this.sendMessage(userId, remoteJid, translatedQ1);

            const savedMsg = await prisma.message.create({
              data: {
                conversationId: conversation.id,
                sender: 'AI',
                body: translatedQ1,
                type: 'text',
                timestamp: new Date(),
              },
            });

            await prisma.patient.update({
              where: { id: patient.id },
              data: {
                onboardingStep: 2, // Resume intake flow at Step 2
                lastMessage: translatedQ1,
              },
            });

            SocketService.sendToUser(userId, 'new_message', {
              conversationId: conversation.id,
              message: savedMsg,
            });

            return;
          } else {
            // User sent a receipt number -> Lookup patient
            const receiptNumber = incomingText.trim();
            let foundPatient = null;
            
            // Search for patient by receipt number (e.g. RC-12345)
            const cleanReceipt = receiptNumber.trim().toUpperCase();
            foundPatient = await prisma.patient.findFirst({
              where: {
                receiptNumber: cleanReceipt,
              },
            });

            if (foundPatient) {
              // Send the details and ask how they are feeling
              let details = `✅ *Record Found*:\n`;
              details += `• Name: ${foundPatient.name}\n`;
              if (foundPatient.condition) details += `• Condition: ${foundPatient.condition}\n`;
              if (foundPatient.doctor) details += `• Doctor: ${foundPatient.doctor}\n`;

              const feelingQuestion = "How are you feeling now?";
              let translatedFeeling = feelingQuestion;
              if (patientLanguage.toLowerCase() !== 'english') {
                translatedFeeling = this.getCustomConsultationTranslation(feelingQuestion, patientLanguage);
              }

              const fullResponse = `${details}\n${translatedFeeling}`;
              await this.sendMessage(userId, remoteJid, fullResponse);

              const savedMsg = await prisma.message.create({
                data: {
                  conversationId: conversation.id,
                  sender: 'AI',
                  body: fullResponse,
                  type: 'text',
                  timestamp: new Date(),
                },
              });

              // Since they are an existing patient and we showed details, we complete the onboarding flow
              await prisma.patient.update({
                where: { id: patient.id },
                data: {
                  onboardingStep: N + 3, // Skip onboarding entirely, set to complete state
                  lastMessage: fullResponse,
                },
              });

              SocketService.sendToUser(userId, 'new_message', {
                conversationId: conversation.id,
                message: savedMsg,
              });

              return;
            } else {
              // Patient not found by receipt number
              const notFoundText = "We could not find any record with that receipt number. If this is your first time, please type 'hello'. Otherwise, please verify your receipt number and send it again.";
              let translatedNotFound = notFoundText;
              if (patientLanguage.toLowerCase() !== 'english') {
                translatedNotFound = this.getCustomConsultationTranslation(notFoundText, patientLanguage);
              }

              await this.sendMessage(userId, remoteJid, translatedNotFound);

              const savedMsg = await prisma.message.create({
                data: {
                  conversationId: conversation.id,
                  sender: 'AI',
                  body: translatedNotFound,
                  type: 'text',
                  timestamp: new Date(),
                },
              });

              await prisma.patient.update({
                where: { id: patient.id },
                data: {
                  lastMessage: translatedNotFound,
                },
              });

              SocketService.sendToUser(userId, 'new_message', {
                conversationId: conversation.id,
                message: savedMsg,
              });

              return;
            }
          }
        }

        // --- STEPS 2 to N: Process Intake Q&A ---
        if (patient.onboardingStep >= 2 && patient.onboardingStep <= N) {
          const currentStep = patient.onboardingStep;
          const qIndex = currentStep - 2;

          let cachedTranslatedQuestions: string[] = onboardingQuestions;
          try {
            const cached = JSON.parse(answers['_translatedQuestions'] || 'null');
            if (Array.isArray(cached) && cached.length === N) {
              cachedTranslatedQuestions = cached;
            }
          } catch {}

          const englishQuestion = onboardingQuestions[qIndex];
          const currentQuestionTranslated = cachedTranslatedQuestions[qIndex] || englishQuestion;
          const isValid = await this.validateAnswer(userId, englishQuestion, incomingText);

          if (!isValid) {
            const retryMsg = this.getRetryMessage(patientLanguage);
            const fullRetry = `${retryMsg}\n\n${currentQuestionTranslated}`;

            await this.sendMessage(userId, remoteJid, fullRetry);

            const savedRetry = await prisma.message.create({
              data: {
                conversationId: conversation.id,
                sender: 'AI',
                body: fullRetry,
                type: 'text',
                timestamp: new Date(),
              },
            });
            await prisma.patient.update({
              where: { id: patient.id },
              data: { lastMessage: fullRetry },
            });
            SocketService.sendToUser(userId, 'new_message', {
              conversationId: conversation.id,
              message: savedRetry,
            });
            return;
          }

          answers[String(qIndex + 1)] = incomingText || '[Media/Attachment]';
          const nextQuestion = cachedTranslatedQuestions[currentStep - 1] || onboardingQuestions[currentStep - 1];

          await this.sendMessage(userId, remoteJid, nextQuestion);

          const savedMsg = await prisma.message.create({
            data: {
              conversationId: conversation.id,
              sender: 'AI',
              body: nextQuestion,
              type: 'text',
              timestamp: new Date(),
            },
          });

          await prisma.patient.update({
            where: { id: patient.id },
            data: {
              onboardingStep: currentStep + 1,
              onboardingAnswers: JSON.stringify(answers),
              lastMessage: nextQuestion,
            },
          });

          SocketService.sendToUser(userId, 'new_message', {
            conversationId: conversation.id,
            message: savedMsg,
          });

          return;
        }

        // --- STEP N + 1: Process Last Question & Send Appointment Menu ---
        if (patient.onboardingStep === N + 1) {
          const lastEnglishQuestion = onboardingQuestions[N - 1];
          let cachedQsForLastStep: string[] = onboardingQuestions;
          try {
            const cached = JSON.parse(answers['_translatedQuestions'] || 'null');
            if (Array.isArray(cached) && cached.length === N) cachedQsForLastStep = cached;
          } catch {}
          const lastQuestionTranslated = cachedQsForLastStep[N - 1] || lastEnglishQuestion;

          const isLastValid = await this.validateAnswer(userId, lastEnglishQuestion, incomingText);

          if (!isLastValid) {
            const retryMsg = this.getRetryMessage(patientLanguage);
            const fullRetry = `${retryMsg}\n\n${lastQuestionTranslated}`;

            await this.sendMessage(userId, remoteJid, fullRetry);
            const savedRetry = await prisma.message.create({
              data: {
                conversationId: conversation.id,
                sender: 'AI',
                body: fullRetry,
                type: 'text',
                timestamp: new Date(),
              },
            });
            await prisma.patient.update({
              where: { id: patient.id },
              data: { lastMessage: fullRetry },
            });
            SocketService.sendToUser(userId, 'new_message', {
              conversationId: conversation.id,
              message: savedRetry,
            });
            return;
          }

          answers[String(N)] = incomingText || '[Media/Attachment]';

          let translatedMenu = answers['_translatedAppointmentMenu'] || '';
          if (!translatedMenu) {
            const slots = await this.getPredefinedSlots(userId);
            const apptMenuEnglish = `Would you like to request a physiotherapy appointment? Please select one of our available slots by typing the number (e.g. 1):\n\n1. 📅 ${slots.slot1}\n2. 📅 ${slots.slot2}\n3. 📅 ${slots.slot3}\n4. 📅 ${slots.slot4}\n5. ✍️ Other (Specify your own date and time)\n6. ❌ Skip appointment booking`;
            translatedMenu = await this.translateText(userId, apptMenuEnglish, patientLanguage);
          }

          await this.sendMessage(userId, remoteJid, translatedMenu);

          const savedMsg = await prisma.message.create({
            data: {
              conversationId: conversation.id,
              sender: 'AI',
              body: translatedMenu,
              type: 'text',
              timestamp: new Date(),
            },
          });

          await prisma.patient.update({
            where: { id: patient.id },
            data: {
              onboardingStep: N + 2,
              onboardingAnswers: JSON.stringify(answers),
              lastMessage: translatedMenu,
            },
          });

          SocketService.sendToUser(userId, 'new_message', {
            conversationId: conversation.id,
            message: savedMsg,
          });

          return;
        }

        // --- STEP N + 2: Appointment Selection & Complete Onboarding ---
        if (patient.onboardingStep === N + 2) {
          const choice = incomingText.trim();
          let selectedSlotText = '';
          const slots = await this.getPredefinedSlots(userId);

          if (choice === '1') selectedSlotText = slots.slot1;
          else if (choice === '2') selectedSlotText = slots.slot2;
          else if (choice === '3') selectedSlotText = slots.slot3;
          else if (choice === '4') selectedSlotText = slots.slot4;
          else if (choice === '5' || (!['1','2','3','4','6'].includes(choice) && choice.length > 3 && !choice.toLowerCase().includes('skip'))) {
            selectedSlotText = choice === '5' ? 'Custom slot to be specified' : choice;
          } else {
            selectedSlotText = 'Skipped';
          }

          answers['appointmentSlot'] = selectedSlotText;

          // Auto-create Appointment record in database if patient selected a slot
          if (selectedSlotText !== 'Skipped') {
            try {
              const parsedDate = this.parseRequestedSlot(selectedSlotText);

              await prisma.appointment.create({
                data: {
                  userId,
                  patientId: patient.id,
                  title: `Physiotherapy Intake Appointment (${patient.condition || 'General Rehab'})`,
                  dateTime: parsedDate,
                  status: 'UPCOMING',
                  notes: `Booked via WhatsApp Intake Bot. Slot requested: ${selectedSlotText}`,
                },
              });
              console.log(`[WhatsApp Service] Auto-created Appointment record in DB for ${patient.name}`);
              SocketService.sendToUser(userId, 'notification', {
                type: 'APPOINTMENT',
                title: 'New WhatsApp Appointment Booked',
                message: `${patient.name} requested appointment slot: ${selectedSlotText}`,
              });
            } catch (apptErr) {
              console.error('[WhatsApp Service] Error auto-creating appointment:', apptErr);
            }
          }

          const therapistJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : '';
          if (selectedSlotText !== 'Skipped' && therapistJid) {
            const cleanPhone = patientPhone.replace(/[^\d]/g, '');
            const alertMsg = `🚨 [NEW APPOINTMENT REQUEST] 🚨\n\nPatient: ${patient.name}\nPhone: +${cleanPhone}\nLanguage: ${patientLanguage}\nRequested Slot: ${selectedSlotText}\n\nTo approve and book this appointment, reply with:\nAPPROVE ${cleanPhone}`;
            await sock.sendMessage(therapistJid, { text: alertMsg });
          }

          let patientCompletionMsg = '';
          if (selectedSlotText !== 'Skipped') {
            patientCompletionMsg = `Thank you! Your appointment request for *${selectedSlotText}* has been submitted. 📅\n\nA therapist will review your answers shortly to confirm your booking.\n\n*How can I help you now?* 👋`;
          } else {
            patientCompletionMsg = `Thank you for completing our intake questionnaire! 👋\n\nA physiotherapist will review your details shortly.\n\n*How can I help you now?*`;
          }

          const translatedCompletion = await this.translateText(userId, patientCompletionMsg, patientLanguage);
          await this.sendMessage(userId, remoteJid, translatedCompletion);

          const savedMsg = await prisma.message.create({
            data: {
              conversationId: conversation.id,
              sender: 'AI',
              body: translatedCompletion,
              type: 'text',
              timestamp: new Date(),
            },
          });

          // Send the consultation receipt image to the patient
          if (selectedSlotText !== 'Skipped') {
            const receiptPath = path.join(process.cwd(), 'storage', 'uploads', 'consultation_receipt.png');
            if (fs.existsSync(receiptPath)) {
              const receiptCaption = `Please show this consultation receipt to us when you come for your appointment! 🏥`;
              const translatedCaption = await this.translateText(userId, receiptCaption, patientLanguage);
              try {
                await this.sendMedia(userId, remoteJid, receiptPath, 'image', translatedCaption);
                
                // Log media message to conversation history
                await prisma.message.create({
                  data: {
                    conversationId: conversation.id,
                    sender: 'AI',
                    body: `[Media/Image] ${translatedCaption}`,
                    type: 'image',
                    timestamp: new Date(),
                  },
                });
              } catch (mediaErr) {
                console.error('[WhatsApp Service] Error sending receipt media message:', mediaErr);
              }
            }
          }

          let summaryNotes = `=== CLINICAL INTAKE DETAILS ===\nCompleted: ${new Date().toLocaleString()}\nLanguage: ${patientLanguage}\n`;
          summaryNotes += `Requested Appointment: ${selectedSlotText}\n\n`;

          let qaText = `Language: ${patientLanguage}\n`;
          for (let i = 0; i < N; i++) {
            const qNum = i + 1;
            const qText = onboardingQuestions[i];
            const aText = answers[String(qNum)] || 'No answer';
            summaryNotes += `Q${qNum}: ${qText}\nA: ${aText}\n\n`;
            qaText += `Q: ${qText}\nA: ${aText}\n\n`;
          }

          const summaryPrompt = `You are a clinical intake assistant. Summarize the following patient's intake questions and answers into a single, cohesive, professional paragraph. Focus on their name, date of birth, symptoms, pain severity (1-10), duration, triggers, medical history, medications, rehab goals, and scheduling preferences. Return ONLY the summarized paragraph, nothing else.\n\nINTAKE DETAILS:\n${qaText}`;

          let onboardingSummary = '';
          try {
            onboardingSummary = await AiService.generateResponse(userId, summaryPrompt, "Generate one-paragraph patient intake summary.", []);
          } catch {
            onboardingSummary = `Patient completed intake in ${patientLanguage}. Name: ${answers['1'] || patient.name}, DOB: ${answers['2'] || 'Not specified'}, Symptoms: ${answers['3'] || 'Not specified'}.`;
          }

          const existingNotes = patient.notes ? `${patient.notes}\n\n` : '';
          await prisma.patient.update({
            where: { id: patient.id },
            data: {
              onboardingStep: N + 3,
              onboardingAnswers: JSON.stringify(answers),
              onboardingSummary,
              notes: `${existingNotes}${summaryNotes}`,
              lastMessage: translatedCompletion,
            },
          });

          // Automatically generate a Treatment Plan for this patient upon completing intake Q&A
          try {
            const existingPlan = await prisma.treatmentPlan.findFirst({
              where: { userId, patientId: patient.id },
            });
            if (!existingPlan) {
              const detectedCondition = answers['3'] || 'Physiotherapy Rehabilitation Protocol';
              await prisma.treatmentPlan.create({
                data: {
                  userId,
                  patientId: patient.id,
                  condition: detectedCondition,
                  doctor: 'Dr. Sarah Jenkins',
                  startDate: new Date().toISOString().split('T')[0],
                  durationWeeks: 8,
                  currentPhase: 1,
                  totalPhases: 4,
                  compliancePct: 100,
                  status: 'Active',
                  notes: onboardingSummary || 'Auto-generated from WhatsApp intake Q&A.',
                },
              });
              console.log(`[WhatsApp Service] Auto-created TreatmentPlan for patient: ${patient.name}`);
            }
          } catch (planErr) {
            console.error('[WhatsApp Service] Error auto-creating TreatmentPlan:', planErr);
          }

          SocketService.sendToUser(userId, 'new_message', {
            conversationId: conversation.id,
            message: savedMsg,
          });

          SocketService.sendToUser(userId, 'patient_update', { patientId: patient.id });
          return;
        }
      } catch (onbErr) {
        console.error('[Onboarding Pipeline Error] Failed to run onboarding step:', onbErr);
      }
    }

    // 5. AI Auto-Reply Pipeline
    // Ensure we do NOT trigger AI outgoing messages while onboarding is in progress
    const isOnboardingActive = N > 0 && (patient.onboardingStep <= N + 2 || patient.onboardingStep === 101);
    const isAiActive = !isOnboardingActive && conversation.isAiEnabled && settings?.autoReplyEnabled;

    if (isAiActive) {
      SocketService.sendToUser(userId, 'typing', { patientId: patient.id, isTyping: true });

      try {
        let finalResponseText = '';

        const historyMessages = await prisma.message.findMany({
          where: { conversationId: conversation.id },
          orderBy: { timestamp: 'asc' },
          take: 15,
        });

        const matchedChunks = await RagService.searchKnowledgeBase(userId, incomingText, 3);
        const contextString = matchedChunks.length > 0
          ? `Use the following clinic information to answer the patient's questions if relevant:\n---\n${matchedChunks.join('\n\n')}\n---\n`
          : '';

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
          `- **CRITICAL CONTRAINDICATION**: NEVER diagnose a disease, prescribe a medicine, or claim to be a licensed doctor.\n` +
          `- **APPOINTMENTS**: If booking/rescheduling, append [APPOINTMENT_ACTION: ...] tag. The current year is 2026. The current time is ${new Date().toLocaleString()}.`;

        const formattedHistory = historyMessages.map((m) => ({
          sender: m.sender,
          body: m.body,
        }));

        const rawAiResponse = await AiService.generateResponse(
          userId,
          systemPrompt,
          incomingText,
          formattedHistory
        );

        const { cleanResponse } = await AppointmentService.parseAiAction(
          userId,
          patient.id,
          rawAiResponse
        );

        finalResponseText = cleanResponse;

        await this.sendMessage(userId, remoteJid, finalResponseText);

        const savedAiMsg = await prisma.message.create({
          data: {
            conversationId: conversation.id,
            sender: 'AI',
            body: finalResponseText,
            type: 'text',
            timestamp: new Date(),
          },
        });

        await prisma.patient.update({
          where: { id: patient.id },
          data: { lastMessage: finalResponseText },
        });

        SocketService.sendToUser(userId, 'new_message', {
          conversationId: conversation.id,
          message: savedAiMsg,
        });

        await this.incrementAnalytics(userId, 'aiReplies');

      } catch (aiErr: any) {
        console.error('[WhatsApp AI Error] Failure during AI reply generation:', aiErr);
        const defaultReply = "Hello! 👋 How can I assist you today?";

        try {
          await this.sendMessage(userId, patientPhone, defaultReply);

          const savedAiMsg = await prisma.message.create({
            data: {
              conversationId: conversation.id,
              sender: 'AI',
              body: defaultReply,
              type: 'text',
              timestamp: new Date(),
            },
          });

          await prisma.patient.update({
            where: { id: patient.id },
            data: { lastMessage: defaultReply },
          });

          SocketService.sendToUser(userId, 'new_message', {
            conversationId: conversation.id,
            message: savedAiMsg,
          });

          await this.incrementAnalytics(userId, 'aiReplies');
        } catch (sendErr) {
          console.error('[WhatsApp Fallback Error] Failed to send default reply:', sendErr);
        }

        await prisma.notification.create({
          data: {
            userId,
            type: 'FAILED_AI',
            title: 'AI Auto-reply Failed (Fallback Sent)',
            message: `Could not generate AI reply for ${patient.name}. Sent default reply instead.`,
          },
        }).catch((e) => console.error(e));
      } finally {
        SocketService.sendToUser(userId, 'typing', { patientId: patient.id, isTyping: false });
      }
    } else {
      SocketService.sendToUser(userId, 'notification', {
        type: 'NEW_CHAT',
        title: `New Message from ${patient.name}`,
        message: incomingText.substring(0, 60) || 'Sent an attachment',
      });
    }

    await this.incrementAnalytics(userId, 'messages');
    if (isNewPatient) {
      await this.incrementAnalytics(userId, 'patients');
    }
  }

  private static buildTranslatorSystemPrompt(targetLanguage: string): string {
    let languageInstruction = '';
    if (targetLanguage.toLowerCase() === 'hinglish') {
      languageInstruction = `You MUST write in Hinglish — a natural mix of Hindi and English using ONLY the Latin/Roman alphabet (NO Devanagari script ever).`;
    } else if (targetLanguage.toLowerCase() === 'hindi') {
      languageInstruction = 'Write in proper Hindi using Devanagari script only.';
    } else if (targetLanguage.toLowerCase() === 'telugu') {
      languageInstruction = 'Write in proper Telugu script only.';
    } else if (targetLanguage.toLowerCase() === 'marathi') {
      languageInstruction = 'Write in proper Marathi using Devanagari script only.';
    }
    return `You are a medical translator for a physiotherapy clinic. Translate into ${targetLanguage}.\n${languageInstruction}\nReturn ONLY translated text.`;
  }

  private static async translateText(userId: string, text: string, targetLanguage: string): Promise<string> {
    if (!targetLanguage || targetLanguage.toLowerCase() === 'english') return text;
    const staticTrans = this.getStaticTranslation(text, targetLanguage);
    if (staticTrans) return staticTrans;
    try {
      const prompt = this.buildTranslatorSystemPrompt(targetLanguage);
      const translated = await AiService.generateResponse(userId, prompt, text, []);
      return translated.trim();
    } catch {
      return text;
    }
  }

  private static parseLanguageChoice(text: string): string {
    const clean = text.trim();
    if (clean === '1' || clean.toLowerCase().includes('english')) return 'English';
    if (clean === '2' || clean.toLowerCase().includes('hindi')) return 'Hindi';
    if (clean === '3' || clean.toLowerCase().includes('hinglish')) return 'Hinglish';
    if (clean === '4' || clean.toLowerCase().includes('telugu')) return 'Telugu';
    if (clean === '5' || clean.toLowerCase().includes('marathi')) return 'Marathi';
    return 'English';
  }

  private static async getPredefinedSlots(userId: string) {
    const settings = await prisma.setting.findFirst({
      where: { userId }
    });

    if (settings?.onboardingSlots) {
      try {
        const parsed = JSON.parse(settings.onboardingSlots);
        if (Array.isArray(parsed) && parsed.length >= 4) {
          return {
            slot1: parsed[0] || 'Monday at 10:00 AM',
            slot2: parsed[1] || 'Tuesday at 2:00 PM',
            slot3: parsed[2] || 'Wednesday at 11:00 AM',
            slot4: parsed[3] || 'Thursday at 4:00 PM',
          };
        }
      } catch {}
    }

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dayAfter = new Date();
    dayAfter.setDate(dayAfter.getDate() + 2);

    const formatDate = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

    return {
      slot1: `${formatDate(tomorrow)} at 10:00 AM`,
      slot2: `${formatDate(tomorrow)} at 2:00 PM`,
      slot3: `${formatDate(dayAfter)} at 11:00 AM`,
      slot4: `${formatDate(dayAfter)} at 4:00 PM`,
    };
  }

  private static async incrementAnalytics(userId: string, field: 'patients' | 'messages' | 'aiReplies') {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const analytics = await prisma.analytics.findFirst({
        where: { userId, date: today },
      });

      const incrementData: any = {};
      if (field === 'patients') incrementData.patientsCount = { increment: 1 };
      if (field === 'messages') incrementData.messagesCount = { increment: 1 };
      if (field === 'aiReplies') incrementData.aiRepliesCount = { increment: 1 };

      if (analytics) {
        await prisma.analytics.update({ where: { id: analytics.id }, data: incrementData });
      } else {
        await prisma.analytics.create({
          data: {
            userId,
            date: today,
            patientsCount: field === 'patients' ? 1 : 0,
            messagesCount: field === 'messages' ? 1 : 0,
            aiRepliesCount: field === 'aiReplies' ? 1 : 0,
          },
        });
      }
    } catch (err) {
      console.error('[Analytics Update Error]:', err);
    }
  }

  private static async validateAnswer(userId: string, englishQuestion: string, answer: string): Promise<boolean> {
    return true;
  }

  private static getRetryMessage(language: string): string {
    switch (language.toLowerCase()) {
      case 'hinglish': return 'Samajh nahi aaya 😅 Kripya apna jawab dobara dijiye:';
      case 'hindi': return 'समझ नहीं आया 😅 कृपया अपना उत्तर फिर से दें:';
      case 'telugu': return 'అర్థం కాలేదు 😅 దయచేసి మళ్ళీ జవాబు ఇవ్వండి:';
      case 'marathi': return 'समजले नाही 😅 कृपया पुन्हा उत्तर द्या:';
      default: return "I didn't quite understand your answer 😅 Could you please answer this question again:";
    }
  }

  private static getStaticTranslation(englishText: string, language: string): string | null {
    const translations: Record<string, Record<string, string>> = {
      'hinglish': {
        'What is your full name?': 'Apka poora naam kya hai?',
        'What is your 10-digit WhatsApp mobile number?': 'Apka 10-digit ka WhatsApp number kya hai?',
        'What is your date of birth?': 'Apki date of birth kya hai?',
        'What main symptoms or pain are you experiencing?': 'Apko kya main symptoms ya dard ho raha hai?',
        'On a scale of 1-10, how severe is your pain?': '1 se 10 ke scale pe apka dard kitna hai?',
        'How long have you had this issue?': 'Ye problem apko kab se hai?',
        'What makes the pain better or worse?': 'Dard kis cheez se badhta ya kam hota hai?',
        'Have you had any previous treatments or surgeries for this?': 'Kya iske liye pehle koi treatment ya surgery hui hai?',
        'Are you currently taking any medications?': 'Kya aap abhi koi dawa le rahe hain?',
        'What are your primary goals for physical therapy?': 'Physiotherapy ke liye apka main goal kya hai?',
        'What are your preferred days and times for appointments?': 'Appointment ke liye apka preferred din aur time kya hai?',
      },
      'hindi': {
        'What is your full name?': 'आपका पूरा नाम क्या है?',
        'What is your 10-digit WhatsApp mobile number?': 'आपका 10 अंकों का व्हाट्सएप मोबाइल नंबर क्या है?',
        'What is your date of birth?': 'आपकी जन्म तिथि क्या है?',
        'What main symptoms or pain are you experiencing?': 'आपको कौन से मुख्य लक्षण या दर्द हो रहा है?',
        'On a scale of 1-10, how severe is your pain?': '1 से 10 के पैमाने पर आपका दर्द कितना गंभीर है?',
        'How long have you had this issue?': 'यह समस्या आपको कब से है?',
        'What makes the pain better or worse?': 'किस चीज से आपका दर्द कम या ज्यादा होता है?',
        'Have you had any previous treatments or surgeries for this?': 'क्या इसके लिए पहले आपका कोई इलाज या सर्जरी हुई है?',
        'Are you currently taking any medications?': 'क्या आप वर्तमान में कोई दवाएं ले रहे हैं?',
        'What are your primary goals for physical therapy?': 'शारीरिक थेरेपी के लिए आपके मुख्य लक्ष्य क्या हैं?',
        'What are your preferred days and times for appointments?': 'अपॉइंटमेंट के लिए आपके पसंदीदा दिन और समय क्या हैं?',
      },
    };
    return translations[language.toLowerCase()]?.[englishText] || null;
  }

  private static getStaticAppointmentMenu(slots: { slot1: string; slot2: string; slot3: string; slot4: string }, language: string): string {
    switch (language.toLowerCase()) {
      case 'hinglish':
        return `Kya aap appointment lena chahenge? Choose one (type 1):\n1. 📅 ${slots.slot1}\n2. 📅 ${slots.slot2}\n3. 📅 ${slots.slot3}\n4. 📅 ${slots.slot4}\n5. ✍️ Other\n6. ❌ Skip`;
      default:
        return `Would you like to request an appointment?\n1. 📅 ${slots.slot1}\n2. 📅 ${slots.slot2}\n3. 📅 ${slots.slot3}\n4. 📅 ${slots.slot4}\n5. ✍️ Other\n6. ❌ Skip`;
    }
  }

  private static getCustomConsultationTranslation(englishText: string, language: string): string {
    const lang = language.toLowerCase();
    if (englishText.includes("Did you take any consultation")) {
      switch (lang) {
        case 'hindi': return 'क्या आपने पहले हमसे कोई परामर्श (consultation) लिया है या यह आपकी पहली बार है? यदि आप पहले आ चुके हैं, तो कृपया रसीद संख्या (receipt number) साझा करें, या यदि यह आपकी पहली बार है, तो hello टाइप करें।';
        case 'hinglish': return 'Kya apne pehle humse koi consultation liya hai ya ye apka first time hai? Agar aap pehle aa chuke hain, toh receipt number share karein, ya agar ye apka first time hai, toh hello type karein.';
        case 'telugu': return 'మీరు ఇంతకు ముందు మా వద్ద సంप्रదింపులు (consultation) తీసుకున్నారా లేదా ఇది మీ మొదటి సారా? మీరు ఇంతకు ముందు వచ్చినట్లయితే, దయచేసి రశీదు సంఖ్యను (receipt number) షేर చేయండి, లేదా ఇది మీ మొదటి సారి అయితే, hello అని టైప్ చేయండి.';
        case 'marathi': return 'तुम्ही आधी आमच्याकडून कोणताही सल्ला (consultation) घेतला आहे का की ही तुमची पहिली वेळ आहे? आपण आधी भेट दिली असल्यास, कृपया पावती क्रमांक (receipt number) शेअर करा, किंवा ही तुमची पहिली वेळ असल्यास, hello टाईप करा.';
        default: return englishText;
      }
    }
    if (englishText.includes("How are you feeling now?")) {
      switch (lang) {
        case 'hindi': return 'आप अब कैसा महसूस कर रहे हैं?';
        case 'hinglish': return 'Aap ab kaisa feel kar rahe hain?';
        case 'telugu': return 'మీరు ఇప్పుడు ఎలా భావిస్తున్నారు?';
        case 'marathi': return 'तुम्हाला आता कसे वाटत आहे?';
        default: return englishText;
      }
    }
    if (englishText.includes("We could not find any record")) {
      switch (lang) {
        case 'hindi': return 'हमें उस रसीद संख्या के साथ कोई रिकॉर्ड नहीं मिला। यदि यह आपका पहला समय है, तो कृपया \'hello\' टाइप करें। अन्यथा, कृपया अपनी रसीद संख्या सत्यापित करें और इसे फिर से भेजें।';
        case 'hinglish': return 'Humein us receipt number ke sath koi record nahi mila. Agar ye aapka first time hai, toh please \'hello\' type karein. Warna, please apna receipt number check karke dobara bhejein.';
        case 'telugu': return 'ఆ రశీదు సంఖ్యతో మాకు ఎటువంటి రికార్డు లభించలేదు. ఇది మీ మొదటి సారి అయితే, దयచేసి \'hello\' అని టైప్ చేయండి. లేదంటే, దయచేసి మీ రశీదు సంఖ్యను ధృవీకరించి, మళ్ली పంపండి.';
        case 'marathi': return 'आम्हाला त्या पावती क्रमांकासह कोणताही रेकॉर्ड सापडला नाही. ही तुमची पहिली वेळ असल्यास, कृपया \'hello\' टाईप करा. अन्यथा, कृपया तुमचा पावती क्रमांक तपासा आणि तो पुन्हा पाठवा.';
        default: return englishText;
      }
    }
    return englishText;
  }

  private static parseRequestedSlot(slotText: string): Date {
    const now = new Date();
    let targetDate = new Date();
    
    // Default fallback to tomorrow at 10 AM
    targetDate.setDate(now.getDate() + 1);
    targetDate.setHours(10, 0, 0, 0);

    try {
      const text = slotText.toLowerCase();
      
      // 1. Parse Day of the Week (Monday, Tuesday, etc.)
      const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      let foundDayIdx = -1;
      for (let i = 0; i < weekdays.length; i++) {
        if (text.includes(weekdays[i])) {
          foundDayIdx = i;
          break;
        }
      }

      if (foundDayIdx !== -1) {
        const currentDayIdx = now.getDay();
        let daysToAdd = foundDayIdx - currentDayIdx;
        if (daysToAdd <= 0) {
          daysToAdd += 7;
        }
        targetDate = new Date();
        targetDate.setDate(now.getDate() + daysToAdd);
      } else {
        const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        let foundMonthIdx = -1;
        for (let i = 0; i < months.length; i++) {
          if (text.includes(months[i])) {
            foundMonthIdx = i;
            break;
          }
        }
        if (foundMonthIdx !== -1) {
          const matchDay = text.match(/\b\d{1,2}\b/);
          if (matchDay) {
            const dayNum = parseInt(matchDay[0]);
            targetDate = new Date(now.getFullYear(), foundMonthIdx, dayNum);
            if (targetDate < now) {
              targetDate.setFullYear(now.getFullYear() + 1);
            }
          }
        }
      }

      // 2. Parse Time (e.g. 10:00 am, 2:00 pm, 4 pm)
      const timeMatch = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
      if (timeMatch) {
        let hour = parseInt(timeMatch[1]);
        const minute = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
        const ampm = timeMatch[3].toLowerCase();

        if (ampm === 'pm' && hour < 12) {
          hour += 12;
        } else if (ampm === 'am' && hour === 12) {
          hour = 0;
        }
        targetDate.setHours(hour, minute, 0, 0);
      }
    } catch (e) {
      console.error('[Slot Parser] Error parsing slot text:', slotText, e);
    }

    return targetDate;
  }
}
