import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import prisma from '../config/db';
import { v2 as cloudinary } from 'cloudinary';
import fs from 'fs';

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export const getExercises = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { region, search } = req.query;

    const whereClause: any = {
      userId,
    };

    if (region && region !== 'All') {
      whereClause.region = String(region);
    }

    let exercises = await prisma.exercise.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
    });

    if (search) {
      const searchStr = String(search).toLowerCase();
      exercises = exercises.filter((ex) => {
        return (
          ex.title.toLowerCase().includes(searchStr) ||
          ex.targetMuscle.toLowerCase().includes(searchStr) ||
          ex.category.toLowerCase().includes(searchStr)
        );
      });
    }

    const formattedExercises = exercises.map((ex) => {
      let instructionsArray: string[] = [];
      try {
        instructionsArray = ex.instructions ? JSON.parse(ex.instructions) : [];
      } catch {
        instructionsArray = [ex.instructions || ''];
      }

      return {
        id: ex.id,
        title: ex.title,
        category: ex.category || 'General Rehab',
        region: ex.region || 'Spine',
        difficulty: ex.difficulty || 'Beginner',
        setsReps: ex.setsReps || '3 Sets × 10 Reps',
        duration: ex.duration || '5 Mins',
        targetMuscle: ex.targetMuscle || 'Target Muscle Group',
        description: ex.description || '',
        instructions: instructionsArray,
        imageUrl: ex.imageUrl || null,
        videoUrl: ex.videoUrl || null,
      };
    });

    return res.status(200).json({
      success: true,
      count: formattedExercises.length,
      data: formattedExercises,
    });
  } catch (error) {
    next(error);
  }
};

export const createExercise = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const {
      title,
      category,
      region,
      difficulty,
      setsReps,
      duration,
      targetMuscle,
      description,
      instructions,
      imageUrl,
      videoUrl,
    } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Exercise title is required.',
      });
    }

    let instructionsStr = '[]';
    if (Array.isArray(instructions)) {
      instructionsStr = JSON.stringify(instructions.map((s: string) => s.trim()).filter(Boolean));
    } else if (typeof instructions === 'string') {
      const steps = instructions.split('\n').map((s: string) => s.trim()).filter(Boolean);
      instructionsStr = JSON.stringify(steps);
    }

    const exercise = await prisma.exercise.create({
      data: {
        userId,
        title: title.trim(),
        category: category || 'General Rehab',
        region: region || 'Spine',
        difficulty: difficulty || 'Beginner',
        setsReps: setsReps || '3 Sets × 10 Reps',
        duration: duration || '5 Mins',
        targetMuscle: targetMuscle || 'Target Muscle Group',
        description: description || '',
        instructions: instructionsStr,
        imageUrl: imageUrl || null,
        videoUrl: videoUrl || null,
      },
    });

    return res.status(201).json({
      success: true,
      message: 'Exercise added to library successfully.',
      data: exercise,
    });
  } catch (error) {
    next(error);
  }
};

export const uploadExerciseMedia = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded.',
      });
    }

    const isVideo = req.file.mimetype.startsWith('video/');

    // Check if Cloudinary is configured
    const isCloudinaryConfigured =
      process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_CLOUD_NAME !== 'your_cloud_name' &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_KEY !== 'your_api_key' &&
      process.env.CLOUDINARY_API_SECRET &&
      process.env.CLOUDINARY_API_SECRET !== 'your_api_secret';

    if (isCloudinaryConfigured) {
      try {
        console.log(`[Cloudinary Upload] Uploading ${isVideo ? 'video' : 'image'} from path: ${req.file.path}`);
        const result = await cloudinary.uploader.upload(req.file.path, {
          resource_type: isVideo ? 'video' : 'image',
          folder: isVideo ? 'physiobot/videos' : 'physiobot/images',
        });

        // Delete local temporary file
        try {
          fs.unlinkSync(req.file.path);
        } catch (err) {
          console.error('[Cloudinary Upload] Failed to delete local temp file:', err);
        }

        return res.status(200).json({
          success: true,
          message: `${isVideo ? 'Video' : 'Photo'} uploaded to Cloudinary successfully.`,
          url: result.secure_url,
          fileType: isVideo ? 'video' : 'image',
        });
      } catch (cloudinaryErr: any) {
        console.error('[Cloudinary Upload] Error uploading to Cloudinary:', cloudinaryErr);
        // Fallback to local storage if Cloudinary upload fails
      }
    }

    // Local fallback
    const fileCategory = isVideo ? 'video' : 'images';
    const relativeUrl = `/uploads/${fileCategory}/${req.file.filename}`;

    return res.status(200).json({
      success: true,
      message: `${isVideo ? 'Video' : 'Photo'} uploaded to local storage successfully.`,
      url: relativeUrl,
      fileType: isVideo ? 'video' : 'image',
    });
  } catch (error) {
    next(error);
  }
};

export const deleteExercise = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const exercise = await prisma.exercise.findFirst({
      where: { id, userId },
    });

    if (!exercise) {
      return res.status(404).json({
        success: false,
        message: 'Exercise not found.',
      });
    }

    await prisma.exercise.delete({
      where: { id },
    });

    return res.status(200).json({
      success: true,
      message: 'Exercise deleted successfully.',
    });
  } catch (error) {
    next(error);
  }
};
