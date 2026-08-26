import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import prisma from '../config/db';
import { WhatsappService } from '../services/whatsapp.service';

export const getPatients = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { search, tag, status } = req.query;

    const whereClause: any = {
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

    let rawPatients = await prisma.patient.findMany({
      where: whereClause,
      orderBy: { updatedAt: 'desc' },
    });

    // Format tags and structure for frontend
    let patients = rawPatients.map((p) => {
      let parsedTags: string[] = [];
      try {
        parsedTags = typeof p.tags === 'string' ? JSON.parse(p.tags) : (p.tags || []);
      } catch {
        parsedTags = [];
      }

      let displayRealPhone = p.realPhone || p.phone.split('@')[0];

      // If displayRealPhone is a synthetic LID (1894...), check all onboarding answers & clinical notes for patient's real phone
      if (!displayRealPhone || displayRealPhone.includes('1894') || displayRealPhone.includes('@lid') || displayRealPhone.length > 13) {
        displayRealPhone = '';
        try {
          const answers = JSON.parse(p.onboardingAnswers || '{}');
          for (const val of Object.values(answers)) {
            if (typeof val === 'string') {
              const match = val.match(/(?:\+91[\s-]?)?([6-9]\d{9})/);
              if (match) {
                displayRealPhone = `+91 ${match[1]}`;
                break;
              }
            }
          }
        } catch {}

        if (!displayRealPhone && p.notes) {
          const match = p.notes.match(/(?:\+91[\s-]?)?([6-9]\d{9})/);
          if (match) {
            displayRealPhone = `+91 ${match[1]}`;
          }
        }
      }

      // Format Indian phone numbers (+91 XXXXX XXXXX)
      const digitsOnly = displayRealPhone.replace(/[^\d]/g, '');
      if (digitsOnly.length === 10) {
        displayRealPhone = `+91 ${digitsOnly}`;
      } else if (digitsOnly.length === 12 && digitsOnly.startsWith('91')) {
        displayRealPhone = `+91 ${digitsOnly.substring(2)}`;
      } else if (digitsOnly && !displayRealPhone.startsWith('+') && !displayRealPhone.includes('1894')) {
        displayRealPhone = `+${digitsOnly}`;
      } else if (!displayRealPhone || displayRealPhone.includes('1894')) {
        displayRealPhone = 'WhatsApp Connected';
      }

      return {
        ...p,
        phone: p.phone,
        realPhone: displayRealPhone,
        tags: parsedTags,
        condition: p.condition || 'General Physiotherapy',
        doctor: p.doctor || 'Dr. Sarah Jenkins',
        painLevel: p.painLevel ?? 5,
        riskLevel: p.riskLevel || 'Stable',
        compliancePct: p.compliancePct ?? 100,
        lastVisit: p.updatedAt ? new Date(p.updatedAt).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
        nextAppt: p.nextAppt || 'To be scheduled',
        notes: p.notes || '',
      };
    });

    // Filter by tag in memory since SQLite stores tags as a JSON string
    if (tag) {
      const filterTag = String(tag).toLowerCase();
      patients = patients.filter((p) => {
        return p.tags.some((t: string) => t.toLowerCase() === filterTag);
      });
    }

    return res.status(200).json({
      success: true,
      count: patients.length,
      data: patients,
    });
  } catch (error) {
    next(error);
  }
};

export const getPatientById = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const patient = await prisma.patient.findFirst({
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

    let parsedTags: string[] = [];
    try {
      parsedTags = typeof patient.tags === 'string' ? JSON.parse(patient.tags) : (patient.tags || []);
    } catch {
      parsedTags = [];
    }

    const formattedPatient = {
      ...patient,
      phone: patient.realPhone || patient.phone.replace('@c.us', ''),
      tags: parsedTags,
      condition: patient.condition || 'General Physiotherapy',
      doctor: patient.doctor || 'Dr. Sarah Jenkins',
      painLevel: patient.painLevel ?? 5,
      riskLevel: patient.riskLevel || 'Stable',
      compliancePct: patient.compliancePct ?? 100,
      lastVisit: patient.updatedAt ? new Date(patient.updatedAt).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
      nextAppt: patient.nextAppt || 'To be scheduled',
      notes: patient.notes || '',
    };

    return res.status(200).json({
      success: true,
      data: formattedPatient,
    });
  } catch (error) {
    next(error);
  }
};

export const createPatient = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const {
      name,
      phone,
      email,
      tags,
      notes,
      condition,
      doctor,
      painLevel,
      riskLevel,
      compliancePct,
      nextAppt,
    } = req.body;

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

    // Try to get formatted phone number from WhatsApp if client is connected
    let realPhone: string | null = null;
    try {
      const client = WhatsappService.getClient(userId);
      if (client) {
        realPhone = await client.getFormattedNumber(formattedPhone);
      }
    } catch (err) {
      console.warn(`[Patients Controller] Could not fetch formatted number from active client: ${err}`);
    }

    // Fallback if client not active or failed
    if (!realPhone) {
      const digits = phone.replace(/[^\d]/g, '');
      realPhone = phone.trim().startsWith('+') ? `+${digits}` : `+${digits}`;
    }

    // Check if patient already exists
    const existingPatient = await prisma.patient.findUnique({
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

    // Generate unique short receipt number
    const digits = '0123456789';
    let randCode = '';
    for (let i = 0; i < 5; i++) {
      randCode += digits[Math.floor(Math.random() * 10)];
    }
    const receiptNumber = `RC-${randCode}`;

    // Format tags as a JSON string
    const formattedTags = Array.isArray(tags) ? JSON.stringify(tags) : '[]';

    const patient = await prisma.patient.create({
      data: {
        userId,
        name,
        phone: formattedPhone,
        realPhone,
        email: email || null,
        tags: formattedTags,
        notes: notes || '',
        status: 'ACTIVE',
        condition: condition || 'General Physiotherapy',
        doctor: doctor || 'Dr. Sarah Jenkins',
        painLevel: painLevel ? parseInt(String(painLevel), 10) : 5,
        riskLevel: riskLevel || 'Stable',
        compliancePct: compliancePct ? parseInt(String(compliancePct), 10) : 100,
        nextAppt: nextAppt || 'To be scheduled',
        receiptNumber,
      },
    });

    // Automatically create a blank conversation
    await prisma.conversation.create({
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
  } catch (error) {
    next(error);
  }
};

export const updatePatient = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { name, email, phone, realPhone, tags, notes, status, profilePhoto, condition, doctor, painLevel, riskLevel, compliancePct, nextAppt } = req.body;

    const patient = await prisma.patient.findFirst({
      where: { id, userId },
    });

    if (!patient) {
      return res.status(404).json({
        success: false,
        message: 'Patient not found.',
      });
    }

    const formattedTags = Array.isArray(tags) ? JSON.stringify(tags) : undefined;

    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (email !== undefined) updateData.email = email;
    if (phone !== undefined) updateData.phone = phone;
    if (realPhone !== undefined) updateData.realPhone = realPhone;
    if (formattedTags !== undefined) updateData.tags = formattedTags;
    if (notes !== undefined) updateData.notes = notes;
    if (status !== undefined) updateData.status = status;
    if (profilePhoto !== undefined) updateData.profilePhoto = profilePhoto;
    if (condition !== undefined) updateData.condition = condition;
    if (doctor !== undefined) updateData.doctor = doctor;
    if (painLevel !== undefined) updateData.painLevel = parseInt(String(painLevel), 10);
    if (riskLevel !== undefined) updateData.riskLevel = riskLevel;
    if (compliancePct !== undefined) updateData.compliancePct = parseInt(String(compliancePct), 10);
    if (nextAppt !== undefined) updateData.nextAppt = nextAppt;

    const updatedPatient = await prisma.patient.update({
      where: { id },
      data: updateData,
    });

    return res.status(200).json({
      success: true,
      message: 'Patient updated successfully.',
      data: updatedPatient,
    });
  } catch (error) {
    next(error);
  }
};

export const deletePatient = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const patient = await prisma.patient.findFirst({
      where: { id, userId },
    });

    if (!patient) {
      return res.status(404).json({
        success: false,
        message: 'Patient not found.',
      });
    }

    // Delete dependent records first to ensure clean cascade without foreign key errors
    await prisma.message.deleteMany({
      where: { conversation: { patientId: id } },
    }).catch(() => {});

    await prisma.conversation.deleteMany({
      where: { patientId: id },
    }).catch(() => {});

    await prisma.appointment.deleteMany({
      where: { patientId: id },
    }).catch(() => {});

    await prisma.treatmentPlan.deleteMany({
      where: { patientId: id },
    }).catch(() => {});

    await prisma.patient.delete({
      where: { id },
    });

    return res.status(200).json({
      success: true,
      message: 'Patient and all associated records deleted successfully.',
    });
  } catch (error) {
    next(error);
  }
};
