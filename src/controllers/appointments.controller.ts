import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { AppointmentService } from '../services/appointment.service';
import { WhatsappService } from '../services/whatsapp.service';
import prisma from '../config/db';

export const getAppointments = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { start, end, status } = req.query;

    const whereClause: any = {
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

    const appointments = await prisma.appointment.findMany({
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
  } catch (error) {
    next(error);
  }
};

export const createAppointment = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { patientId, dateTime, dateTimes, title, notes } = req.body;

    if (!patientId) {
      return res.status(400).json({
        success: false,
        message: 'Patient ID is required.',
      });
    }

    // If an array of multiple dateTimes is sent
    if (Array.isArray(dateTimes) && dateTimes.length > 0) {
      const createdAppts = [];
      const slotsFormatted: string[] = [];

      const patient = await prisma.patient.findFirst({
        where: { id: patientId, userId },
      });

      if (!patient) {
        return res.status(404).json({ success: false, message: 'Patient not found.' });
      }

      for (let i = 0; i < dateTimes.length; i++) {
        const slotDT = new Date(dateTimes[i]);
        if (isNaN(slotDT.getTime())) continue;

        const result = await AppointmentService.bookAppointment(
          userId,
          patientId,
          slotDT,
          title || 'Physiotherapy Session',
          notes || 'Proposed slot option'
        );

        if (result.success && result.appointment) {
          createdAppts.push(result.appointment);
          
          const dtStr = slotDT.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
          const timeStr = slotDT.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
          slotsFormatted.push(`*${dtStr} at ${timeStr}*`);
        }
      }

      if (createdAppts.length === 0) {
        return res.status(400).json({ success: false, message: 'Failed to book any of the proposed slots.' });
      }

      const doctorName = notes?.split('| Doctor: ')[1]?.split('|')[0]?.trim() || 'Dr. Sarah Jenkins';
      const slotsText = slotsFormatted.map((line, idx) => `${idx + 1}️⃣ ${line}`).join('\n');
      
      const whatsappMsg = 
        `🏥 *Clinical Appointment Options* 👋\n\n` +
        `Hello ${patient.name}! \n\n` +
        `Your physiotherapist *${doctorName}* has proposed the following appointment slots:\n\n` +
        `${slotsText}\n\n` +
        `Please reply with the number of your preferred slot (e.g. 1, 2, or 3) to confirm your booking!`;

      try {
        await WhatsappService.sendMessage(userId, patient.phone, whatsappMsg);
      } catch (err: any) {
        console.error('[WhatsApp Propose Slots] Error sending WhatsApp message:', err.message);
      }

      return res.status(201).json({
        success: true,
        message: 'Proposed appointments scheduled and sent via WhatsApp.',
        data: createdAppts,
      });
    }

    // Default: Single date/time booking
    if (!dateTime) {
      return res.status(400).json({
        success: false,
        message: 'Appointment date/time is required.',
      });
    }

    const date = new Date(dateTime);
    if (isNaN(date.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date/time format.',
      });
    }

    const result = await AppointmentService.bookAppointment(
      userId,
      patientId,
      date,
      title || 'Physiotherapy Session',
      notes || 'Booked manually from dashboard'
    );

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.message,
      });
    }

    // Send single slot WhatsApp
    try {
      const patient = await prisma.patient.findFirst({ where: { id: patientId, userId } });
      if (patient) {
        const dtStr = date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        const doctorName = notes?.split('| Doctor: ')[1]?.split('|')[0]?.trim() || 'Dr. Sarah Jenkins';
        const singleMsg = 
          `🏥 *Appointment Booked* 👋\n\n` +
          `Hello ${patient.name}!\n\n` +
          `Your appointment with *${doctorName}* has been scheduled for:\n` +
          `📅 *${dtStr} at ${timeStr}*\n\n` +
          `Looking forward to seeing you! 💪`;
        await WhatsappService.sendMessage(userId, patient.phone, singleMsg);
      }
    } catch (err) {
      console.error('[WhatsApp Single Booking] Error:', err);
    }

    return res.status(201).json({
      success: true,
      message: 'Appointment booked successfully.',
      data: result.appointment,
    });
  } catch (error) {
    next(error);
  }
};

export const updateAppointment = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { dateTime, status, title, notes } = req.body;

    // Check if appointment exists and belongs to the user
    const appointment = await prisma.appointment.findFirst({
      where: { id, userId },
    });

    if (!appointment) {
      return res.status(404).json({
        success: false,
        message: 'Appointment not found.',
      });
    }

    const updateData: any = {};
    if (status) updateData.status = status;
    if (title) updateData.title = title;
    if (notes !== undefined) updateData.notes = notes;

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
        const isAvailable = await AppointmentService.checkAvailability(userId, newDate);
        if (!isAvailable) {
          return res.status(400).json({
            success: false,
            message: 'Selected slot is already booked. Please choose another time.',
          });
        }
        updateData.dateTime = newDate;
      }
    }

    const updatedAppointment = await prisma.appointment.update({
      where: { id },
      data: updateData,
      include: { patient: true },
    });

    // Automatically send WhatsApp message to patient if therapist approves or rejects appointment
    if (status && status !== appointment.status) {
      try {
        const patient = updatedAppointment.patient;
          const targetJid = patient.phone || patient.realPhone;
          if (targetJid) {
            let answers: Record<string, string> = {};
            try { answers = JSON.parse(patient.onboardingAnswers || '{}'); } catch {}
            const patientLanguage = answers['language'] || 'English';
            const dateObj = new Date(updatedAppointment.dateTime);
            const dtStr = dateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
            const timeStr = dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            const formattedSlot = `${dtStr} at ${timeStr}`;

            if (status === 'CONFIRMED' || status === 'APPROVED' || status === 'UPCOMING') {
              const approveTemplate = `Hello ${patient.name}! 👋 Your physiotherapy appointment request has been APPROVED and confirmed by Dr. Sarah Jenkins. 📅\n\n🗓️ Scheduled for: *${formattedSlot}*\n\nWe look forward to seeing you at our clinic!`;
              WhatsappService.sendMessage(userId, targetJid, approveTemplate).catch((err: any) => console.error('[WhatsApp] Approve message error:', err));
            } else if (status === 'CANCELLED' || status === 'REJECTED') {
              const rejectTemplate = `Hello ${patient.name}. ❌ Regrettably, your appointment request for *${formattedSlot}* could not be confirmed for this time. Please reply here or call our desk to reschedule an alternative time!`;
              WhatsappService.sendMessage(userId, targetJid, rejectTemplate).catch((err: any) => console.error('[WhatsApp] Reject message error:', err));
            }
          }
      } catch (waErr) {
        console.error('[WhatsApp Service] Error sending appointment status notification:', waErr);
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Appointment updated successfully.',
      data: updatedAppointment,
    });
  } catch (error) {
    next(error);
  }
};

export const deleteAppointment = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const appointment = await prisma.appointment.findFirst({
      where: { id, userId },
    });

    if (!appointment) {
      return res.status(404).json({
        success: false,
        message: 'Appointment not found.',
      });
    }

    await prisma.appointment.delete({
      where: { id },
    });

    return res.status(200).json({
      success: true,
      message: 'Appointment deleted successfully.',
    });
  } catch (error) {
    next(error);
  }
};

export const sendAvailability = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { patientId, text } = req.body;

    if (!patientId || !text) {
      return res.status(400).json({
        success: false,
        message: 'Patient ID and message text are required.',
      });
    }

    const patient = await prisma.patient.findFirst({
      where: { id: patientId, userId },
    });

    if (!patient) {
      return res.status(404).json({
        success: false,
        message: 'Patient not found.',
      });
    }

    await WhatsappService.sendMessage(userId, patient.phone, text);

    // Save message to conversation log
    const conversation = await prisma.conversation.findUnique({
      where: { userId_patientId: { userId, patientId } },
    });
    if (conversation) {
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          sender: 'AI',
          body: text,
          type: 'text',
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Availability sent to patient via WhatsApp.',
    });
  } catch (error) {
    next(error);
  }
};
