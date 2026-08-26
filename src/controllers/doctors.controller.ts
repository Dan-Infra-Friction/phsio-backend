import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import prisma from '../config/db';

function getInitials(name: string): string {
  const parts = name.replace(/^Dr\.\s*/i, '').trim().split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export const getDoctors = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { search, specialty } = req.query;

    const doctors = await prisma.doctor.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });

    // Apply optional memory filters if query params provided
    let filtered = doctors;
    if (specialty && specialty !== 'All') {
      filtered = filtered.filter((doc) =>
        doc.specialty.toLowerCase().includes(String(specialty).toLowerCase())
      );
    }

    if (search) {
      const q = String(search).toLowerCase();
      filtered = filtered.filter(
        (doc) =>
          doc.name.toLowerCase().includes(q) ||
          doc.specialty.toLowerCase().includes(q) ||
          doc.role.toLowerCase().includes(q)
      );
    }

    return res.status(200).json({
      success: true,
      count: filtered.length,
      data: filtered,
    });
  } catch (error) {
    next(error);
  }
};

export const createDoctor = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const {
      name,
      role,
      specialty,
      email,
      phone,
      activePatients,
      rating,
      experienceYears,
      availability,
    } = req.body;

    if (!name || !specialty || !email || !phone) {
      return res.status(400).json({
        success: false,
        message: 'Name, specialty, email, and phone are required.',
      });
    }

    const avatarInitials = getInitials(name);

    const doctor = await prisma.doctor.create({
      data: {
        userId,
        name,
        role: role || 'Physiotherapy Specialist',
        specialty,
        email,
        phone,
        activePatients: Number(activePatients) || 0,
        rating: Number(rating) || 4.9,
        experienceYears: Number(experienceYears) || 1,
        availability: availability || 'Available Today',
        avatarInitials,
      },
    });

    return res.status(201).json({
      success: true,
      message: 'Doctor / Staff member onboarded successfully.',
      data: doctor,
    });
  } catch (error) {
    next(error);
  }
};

export const updateDoctor = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const {
      name,
      role,
      specialty,
      email,
      phone,
      activePatients,
      rating,
      experienceYears,
      availability,
    } = req.body;

    const existing = await prisma.doctor.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Doctor record not found.',
      });
    }

    const updatedData: any = {};
    if (name) {
      updatedData.name = name;
      updatedData.avatarInitials = getInitials(name);
    }
    if (role !== undefined) updatedData.role = role;
    if (specialty !== undefined) updatedData.specialty = specialty;
    if (email !== undefined) updatedData.email = email;
    if (phone !== undefined) updatedData.phone = phone;
    if (activePatients !== undefined) updatedData.activePatients = Number(activePatients);
    if (rating !== undefined) updatedData.rating = Number(rating);
    if (experienceYears !== undefined) updatedData.experienceYears = Number(experienceYears);
    if (availability !== undefined) updatedData.availability = availability;

    const doctor = await prisma.doctor.update({
      where: { id },
      data: updatedData,
    });

    return res.status(200).json({
      success: true,
      message: 'Doctor record updated successfully.',
      data: doctor,
    });
  } catch (error) {
    next(error);
  }
};

export const deleteDoctor = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const existing = await prisma.doctor.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Doctor record not found.',
      });
    }

    await prisma.doctor.delete({
      where: { id },
    });

    return res.status(200).json({
      success: true,
      message: 'Doctor record deleted successfully.',
    });
  } catch (error) {
    next(error);
  }
};
