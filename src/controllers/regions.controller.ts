import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import prisma from '../config/db';

const DEFAULT_REGIONS = ['Spine', 'Knee', 'Shoulder', 'Neck', 'Hip', 'Ankle'];

export const getRegions = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;

    // Fetch existing regions
    let regions = await prisma.region.findMany({
      where: { userId },
      orderBy: { name: 'asc' },
    });

    // Seed default regions if none exist
    if (regions.length === 0) {
      for (const name of DEFAULT_REGIONS) {
        try {
          await prisma.region.create({
            data: { userId, name },
          });
        } catch {}
      }

      regions = await prisma.region.findMany({
        where: { userId },
        orderBy: { name: 'asc' },
      });
    }

    return res.status(200).json({
      success: true,
      data: regions,
    });
  } catch (error) {
    next(error);
  }
};

export const createRegion = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Region name is required.',
      });
    }

    const trimmedName = name.trim();

    // Check duplicate
    const existing = await prisma.region.findFirst({
      where: {
        userId,
        name: {
          equals: trimmedName,
        },
      },
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'This region already exists.',
      });
    }

    const region = await prisma.region.create({
      data: {
        userId,
        name: trimmedName,
      },
    });

    return res.status(201).json({
      success: true,
      data: region,
    });
  } catch (error) {
    next(error);
  }
};

export const updateRegion = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Region name is required.',
      });
    }

    const trimmedName = name.trim();

    const region = await prisma.region.findFirst({
      where: { id, userId },
    });

    if (!region) {
      return res.status(404).json({
        success: false,
        message: 'Region not found.',
      });
    }

    // Check duplicate of other region
    const duplicate = await prisma.region.findFirst({
      where: {
        userId,
        name: trimmedName,
        id: { not: id },
      },
    });

    if (duplicate) {
      return res.status(400).json({
        success: false,
        message: 'Another region with this name already exists.',
      });
    }

    const updated = await prisma.region.update({
      where: { id },
      data: { name: trimmedName },
    });

    return res.status(200).json({
      success: true,
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

export const deleteRegion = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const region = await prisma.region.findFirst({
      where: { id, userId },
    });

    if (!region) {
      return res.status(404).json({
        success: false,
        message: 'Region not found.',
      });
    }

    await prisma.region.delete({
      where: { id },
    });

    return res.status(200).json({
      success: true,
      message: 'Region deleted successfully.',
    });
  } catch (error) {
    next(error);
  }
};
