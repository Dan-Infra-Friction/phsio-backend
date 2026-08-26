/**
 * TreatmentReminderService
 * Runs every minute via cron. For each active treatment plan whose reminder time matches
 * the current time and day, it sends a WhatsApp reminder to the patient asking for their
 * daily exercise progress. It then waits for the patient to reply and gives AI-generated advice.
 */
import prisma from '../config/db';
import { WhatsappService } from './whatsapp.service';
import { AiService } from './ai.service';
import path from 'path';

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export class TreatmentReminderService {
  /**
   * Called every minute from index.ts setInterval
   */
  public static async runReminders() {
    try {
      const now = new Date();
      const currentDay = DAY_NAMES[now.getDay()];
      const currentHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

      // Find all active plans
      const plans = await (prisma.treatmentPlan as any).findMany({
        where: { status: 'Active' },
        include: { patient: true, user: true },
      });

      for (const plan of plans) {
        try {
          // Parse reminder settings
          let reminderDays: string[] = [];
          let exercises: any[] = [];
          let progressLog: any[] = [];

          try { reminderDays = JSON.parse(plan.reminderDays || '[]'); } catch {}
          try { exercises = JSON.parse(plan.exercises || '[]'); } catch {}
          try { progressLog = JSON.parse(plan.progressLog || '[]'); } catch {}

          const reminderTime: string = plan.reminderTime || '09:00';

          // Check if reminder should fire now
          if (reminderTime !== currentHHMM) continue;
          const isReminderDay =
            reminderDays.includes('daily') ||
            reminderDays.includes(currentDay);
          if (!isReminderDay) continue;

          // Avoid sending duplicate reminder within the same minute
          if (plan.lastRemindedAt) {
            const lastMin = new Date(plan.lastRemindedAt);
            if (
              lastMin.getDate() === now.getDate() &&
              lastMin.getMonth() === now.getMonth() &&
              lastMin.getFullYear() === now.getFullYear() &&
              lastMin.getHours() === now.getHours() &&
              lastMin.getMinutes() === now.getMinutes()
            ) continue;
          }

          // Build exercise list message dynamically and resolve media attachments
          const exerciseLines = [];
          
          for (let i = 0; i < exercises.length; i++) {
            const ex = exercises[i];
            
            // Look up exercise from library to check if media exists
            const libEx = await prisma.exercise.findFirst({
              where: {
                userId: plan.userId,
                title: ex.name,
              },
            });
            
            let mediaNote = '';
            if (libEx) {
              if (libEx.imageUrl) mediaNote += '📷 Photo Guide attached';
              if (libEx.videoUrl) mediaNote += (mediaNote ? ' & ' : '') + '📹 Video Demo attached';
            }
            
            const line = `${i + 1}. *${ex.name}* — ${ex.sets || '3'} sets × ${ex.reps || '10'} reps${ex.instructions ? `\n   📌 ${ex.instructions}` : ''}${mediaNote ? `\n   ℹ️ ${mediaNote}` : ''}`;
            exerciseLines.push(line);
          }

          const reminderMsg =
            `🏥 *Daily Physiotherapy Reminder*\n\n` +
            `Hello ${plan.patient.name}! 👋\n\n` +
            `Today's exercise plan for *${plan.condition}*:\n\n` +
            `${exerciseLines.length > 0 ? exerciseLines.join('\n\n') : 'Follow your prescribed home exercise program.'}\n\n` +
            `📊 *Please reply with your progress:*\n` +
            `• Did you complete today's exercises? (Yes/No/Partial)\n` +
            `• Rate your pain today (1–10)\n` +
            `• Any issues or discomfort?\n\n` +
            `Your physiotherapist *${plan.doctor}* is monitoring your progress! 💪`;

          // Send reminder text via WhatsApp
          const patientPhone = plan.patient.phone;
          await WhatsappService.sendMessage(plan.userId, patientPhone, reminderMsg);

          // Loop and send media for each exercise
          for (const ex of exercises) {
            const libEx = await prisma.exercise.findFirst({
              where: {
                userId: plan.userId,
                title: ex.name,
              },
            });

            if (libEx) {
              // Send images (if any)
              if (libEx.imageUrl) {
                let images: string[] = [];
                if (libEx.imageUrl.startsWith('[')) {
                  try {
                    images = JSON.parse(libEx.imageUrl);
                  } catch {
                    images = [libEx.imageUrl];
                  }
                } else {
                  images = [libEx.imageUrl];
                }

                for (const img of images) {
                  let imgPath = img;
                  if (!img.startsWith('http')) {
                    // For local files, resolve the full path
                    imgPath = path.join(process.cwd(), 'storage', img.replace(/^\//, ''));
                  }
                  try {
                    await WhatsappService.sendMedia(
                      plan.userId,
                      patientPhone,
                      imgPath,
                      'image',
                      `📷 Guide for *${ex.name}*`
                    );
                  } catch (err: any) {
                    console.error(`[Treatment Reminder] Error sending photo for ${ex.name}:`, err.message);
                  }
                }
              }

              // Send video demo (if any)
              if (libEx.videoUrl) {
                let vidPath = libEx.videoUrl;
                if (!libEx.videoUrl.startsWith('http')) {
                  vidPath = path.join(process.cwd(), 'storage', libEx.videoUrl.replace(/^\//, ''));
                }
                try {
                  await WhatsappService.sendMedia(
                    plan.userId,
                    patientPhone,
                    vidPath,
                    'video',
                    `📹 Video Demo for *${ex.name}*`
                  );
                } catch (err: any) {
                  console.error(`[Treatment Reminder] Error sending video for ${ex.name}:`, err.message);
                }
              }
            }
          }

          // Mark patient as awaiting progress reply
          await prisma.patient.update({
            where: { id: plan.patientId },
            data: {
              lastMessage: `[TREATMENT REMINDER SENT - ${plan.condition}]`,
            },
          });

          // Update lastRemindedAt
          await (prisma.treatmentPlan as any).update({
            where: { id: plan.id },
            data: { lastRemindedAt: now },
          });

          // Store reminder in conversation
          const conversation = await prisma.conversation.findUnique({
            where: { userId_patientId: { userId: plan.userId, patientId: plan.patientId } },
          });
          if (conversation) {
            await prisma.message.create({
              data: {
                conversationId: conversation.id,
                sender: 'AI',
                body: reminderMsg,
                type: 'text',
                timestamp: now,
              },
            });
          }

          console.log(`[Treatment Reminder] ✅ Sent reminder to ${plan.patient.name} for plan: ${plan.condition}`);
        } catch (planErr: any) {
          console.error(`[Treatment Reminder] ❌ Error for plan ${plan.id}:`, planErr.message);
        }
      }
    } catch (err: any) {
      console.error('[Treatment Reminder] Service error:', err.message);
    }
  }

  /**
   * Called when a patient replies to a treatment reminder.
   * Checks if patient has an active treatment plan, generates AI advice, logs progress.
   */
  public static async handleProgressReply(
    userId: string,
    patientId: string,
    patientName: string,
    replyText: string
  ): Promise<string | null> {
    try {
      const plan = await (prisma.treatmentPlan as any).findFirst({
        where: { userId, patientId, status: 'Active' },
        include: { patient: true },
        orderBy: { updatedAt: 'desc' },
      });

      if (!plan) return null;

      let exercises: any[] = [];
      let progressLog: any[] = [];
      try { exercises = JSON.parse(plan.exercises || '[]'); } catch {}
      try { progressLog = JSON.parse(plan.progressLog || '[]'); } catch {}

      // Build AI prompt for personalized advice
      const exerciseList = exercises.map((e: any) => e.name).join(', ') || 'general physiotherapy exercises';
      const aiPrompt = `You are ${plan.doctor}, a professional physiotherapist. 
Your patient ${patientName} is on a treatment plan for "${plan.condition}".
Their prescribed exercises are: ${exerciseList}.

The patient just sent this progress update:
"${replyText}"

Based on their progress report:
1. Acknowledge their effort warmly
2. Give specific, actionable physiotherapy advice for their condition
3. If they report pain increase (7+), advise to rest and consult the clinic
4. If they completed exercises, give positive reinforcement and a tip to improve
5. If partial completion, give motivation and suggest modification
6. End with encouragement and reminder of their next session

Keep response under 200 words. Be warm, professional, and encouraging. Write in simple English.`;

      let aiAdvice = '';
      try {
        aiAdvice = await AiService.generateResponse(userId, aiPrompt, `Progress reply from ${patientName}`, []);
      } catch {
        aiAdvice = `Thank you for your update, ${patientName}! Keep up the great work with your physiotherapy exercises. Consistency is key to your recovery. If you experience any increased pain, please don't hesitate to contact the clinic. See you at your next session! 💪`;
      }

      // Log progress entry
      const progressEntry = {
        date: new Date().toISOString(),
        reply: replyText,
        aiAdvice,
        condition: plan.condition,
      };
      progressLog.push(progressEntry);

      // Update plan progress log and compliance
      const completedToday = /yes|done|completed|finished/i.test(replyText);
      const newCompliance = completedToday
        ? Math.min(100, (plan.compliancePct || 100))
        : Math.max(0, (plan.compliancePct || 100) - 5);

      await (prisma.treatmentPlan as any).update({
        where: { id: plan.id },
        data: {
          progressLog: JSON.stringify(progressLog),
          compliancePct: newCompliance,
        },
      });

      console.log(`[Treatment Reminder] 📊 Progress logged for ${patientName}: "${replyText.substring(0, 50)}"`);
      return aiAdvice;
    } catch (err: any) {
      console.error('[Treatment Reminder] handleProgressReply error:', err.message);
      return null;
    }
  }
}
