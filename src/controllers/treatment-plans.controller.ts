import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import prisma from '../config/db';
import { WhatsappService } from '../services/whatsapp.service';
import path from 'path';

export const getTreatmentPlans = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { status, search } = req.query;

    const whereClause: any = { userId };
    if (status && status !== 'All') whereClause.status = String(status);

    let plans = await prisma.treatmentPlan.findMany({
      where: whereClause,
      include: { patient: true },
      orderBy: { updatedAt: 'desc' },
    });

    if (search) {
      const searchStr = String(search).toLowerCase();
      plans = plans.filter((p) =>
        p.patient.name.toLowerCase().includes(searchStr) ||
        p.condition.toLowerCase().includes(searchStr) ||
        p.doctor.toLowerCase().includes(searchStr)
      );
    }

    const formattedPlans = plans.map((p) => {
      let exercises = [];
      let reminderDays = [];
      let progressLog = [];
      try { exercises = JSON.parse((p as any).exercises || '[]'); } catch {}
      try { reminderDays = JSON.parse((p as any).reminderDays || '[]'); } catch {}
      try { progressLog = JSON.parse((p as any).progressLog || '[]'); } catch {}

      return {
        id: p.id,
        patientId: p.patientId,
        patientName: p.patient.name,
        patientPhone: p.patient.realPhone || p.patient.phone,
        patientPhoto: p.patient.profilePhoto,
        onboardingSummary: p.patient.onboardingSummary,
        onboardingAnswers: p.patient.onboardingAnswers,
        onboardingStep: p.patient.onboardingStep,
        painLevel: p.patient.painLevel,
        riskLevel: p.patient.riskLevel,
        condition: p.condition || p.patient.condition || 'General Rehab',
        doctor: p.doctor || p.patient.doctor || 'Dr. Sarah Jenkins',
        startDate: p.startDate || new Date(p.createdAt).toISOString().split('T')[0],
        endDate: (p as any).endDate || '',
        durationWeeks: p.durationWeeks ?? 8,
        currentPhase: p.currentPhase ?? 1,
        totalPhases: p.totalPhases ?? 4,
        compliancePct: p.compliancePct ?? 100,
        status: p.status || 'Active',
        notes: p.notes || '',
        exercises,
        reminderDays,
        reminderTime: (p as any).reminderTime || '09:00',
        progressLog,
        lastRemindedAt: (p as any).lastRemindedAt || null,
      };
    });

    return res.status(200).json({ success: true, count: formattedPlans.length, data: formattedPlans });
  } catch (error) {
    next(error);
  }
};

export const createTreatmentPlan = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const {
      patientId, condition, doctor, startDate, endDate,
      durationWeeks, currentPhase, totalPhases, compliancePct,
      status, notes, exercises, reminderDays, reminderTime,
    } = req.body;

    if (!patientId) {
      return res.status(400).json({ success: false, message: 'Patient ID is required.' });
    }

    const patient = await prisma.patient.findFirst({ where: { id: patientId, userId } });
    if (!patient) {
      return res.status(404).json({ success: false, message: 'Patient not found.' });
    }

    const treatmentPlan = await prisma.treatmentPlan.create({
      data: {
        userId,
        patientId,
        condition: condition || patient.condition || 'General Physiotherapy',
        doctor: doctor || patient.doctor || 'Dr. Sarah Jenkins',
        startDate: startDate || new Date().toISOString().split('T')[0],
        endDate: endDate || '',
        durationWeeks: durationWeeks ? parseInt(String(durationWeeks), 10) : 8,
        currentPhase: currentPhase ? parseInt(String(currentPhase), 10) : 1,
        totalPhases: totalPhases ? parseInt(String(totalPhases), 10) : 4,
        compliancePct: compliancePct ? parseInt(String(compliancePct), 10) : 100,
        status: status || 'Active',
        notes: notes || '',
        exercises: Array.isArray(exercises) ? JSON.stringify(exercises) : '[]',
        reminderDays: Array.isArray(reminderDays) ? JSON.stringify(reminderDays) : '["daily"]',
        reminderTime: reminderTime || '09:00',
        progressLog: '[]',
      } as any,
      include: { patient: true },
    });

    return res.status(201).json({
      success: true,
      message: 'Treatment plan created successfully.',
      data: treatmentPlan,
    });
  } catch (error) {
    next(error);
  }
};

export const updateTreatmentPlan = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const {
      currentPhase, compliancePct, status, notes,
      exercises, reminderDays, reminderTime, endDate, progressLog,
    } = req.body;

    const plan = await prisma.treatmentPlan.findFirst({ where: { id, userId } });
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Treatment plan not found.' });
    }

    const updateData: any = {};
    if (currentPhase !== undefined) updateData.currentPhase = parseInt(String(currentPhase), 10);
    if (compliancePct !== undefined) updateData.compliancePct = parseInt(String(compliancePct), 10);
    if (status !== undefined) updateData.status = status;
    if (notes !== undefined) updateData.notes = notes;
    if (endDate !== undefined) updateData.endDate = endDate;
    if (exercises !== undefined) updateData.exercises = Array.isArray(exercises) ? JSON.stringify(exercises) : exercises;
    if (reminderDays !== undefined) updateData.reminderDays = Array.isArray(reminderDays) ? JSON.stringify(reminderDays) : reminderDays;
    if (reminderTime !== undefined) updateData.reminderTime = reminderTime;
    if (progressLog !== undefined) updateData.progressLog = Array.isArray(progressLog) ? JSON.stringify(progressLog) : progressLog;

    const updatedPlan = await prisma.treatmentPlan.update({
      where: { id },
      data: updateData,
      include: { patient: true },
    });

    return res.status(200).json({ success: true, message: 'Treatment plan updated.', data: updatedPlan });
  } catch (error) {
    next(error);
  }
};

export const deleteTreatmentPlan = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const plan = await prisma.treatmentPlan.findFirst({ where: { id, userId } });
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Treatment plan not found.' });
    }

    await prisma.treatmentPlan.delete({ where: { id } });
    return res.status(200).json({ success: true, message: 'Treatment plan deleted successfully.' });
  } catch (error) {
    next(error);
  }
};

export const sendTreatmentPlanReminder = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const plan = await prisma.treatmentPlan.findFirst({
      where: { id, userId },
      include: { patient: true },
    });

    if (!plan) {
      return res.status(404).json({ success: false, message: 'Treatment plan not found.' });
    }

    let exercises: any[] = [];
    try { exercises = JSON.parse((plan as any).exercises || '[]'); } catch {}

    // Build exercise list message dynamically and resolve media attachments
    const exerciseLines = [];
    for (let i = 0; i < exercises.length; i++) {
      const ex = exercises[i];
      const libEx = await prisma.exercise.findFirst({
        where: {
          userId,
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
    await WhatsappService.sendMessage(userId, patientPhone, reminderMsg);

    // Send media files for each exercise
    for (const ex of exercises) {
      const libEx = await prisma.exercise.findFirst({
        where: {
          userId,
          title: ex.name,
        },
      });

      if (libEx) {
        // Send images (if any)
        if (libEx.imageUrl) {
          let images: string[] = [];
          if (libEx.imageUrl.startsWith('[')) {
            try { images = JSON.parse(libEx.imageUrl); } catch { images = [libEx.imageUrl]; }
          } else {
            images = [libEx.imageUrl];
          }

          for (const img of images) {
            let imgPath = img;
            if (!img.startsWith('http')) {
              imgPath = path.join(process.cwd(), 'storage', img.replace(/^\//, ''));
            }
            try {
              await WhatsappService.sendMedia(
                userId,
                patientPhone,
                imgPath,
                'image',
                `📷 Guide for *${ex.name}*`
              );
            } catch (err: any) {
              console.error(`[Manual Reminder] Error sending photo for ${ex.name}:`, err.message);
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
              userId,
              patientPhone,
              vidPath,
              'video',
              `📹 Video Demo for *${ex.name}*`
            );
          } catch (err: any) {
            console.error(`[Manual Reminder] Error sending video for ${ex.name}:`, err.message);
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
    await prisma.treatmentPlan.update({
      where: { id: plan.id },
      data: { lastRemindedAt: new Date() },
    });

    // Store reminder in conversation
    const conversation = await prisma.conversation.findUnique({
      where: { userId_patientId: { userId, patientId: plan.patientId } },
    });
    if (conversation) {
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          sender: 'AI',
          body: reminderMsg,
          type: 'text',
          timestamp: new Date(),
        },
      });
    }

    return res.status(200).json({ success: true, message: 'WhatsApp reminder sent successfully.' });
  } catch (error) {
    next(error);
  }
};
