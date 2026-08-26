import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { protect } from '../middleware/auth';
import {
  getExercises,
  createExercise,
  uploadExerciseMedia,
  deleteExercise,
} from '../controllers/exercises.controller';

const router = Router();

// Configure Multer for Exercise Photos & Videos
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const isVideo = file.mimetype.startsWith('video/');
    const subFolder = isVideo ? 'video' : 'images';
    const uploadPath = path.join(process.cwd(), 'storage', 'uploads', subFolder);
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname).toLowerCase();
    const prefix = file.mimetype.startsWith('video/') ? 'ex-vid' : 'ex-img';
    cb(null, `${prefix}-${uniqueSuffix}${ext}`);
  },
});

const fileFilter = (req: any, file: any, cb: any) => {
  const allowedImageExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
  const allowedVideoExts = ['.mp4', '.webm', '.mov', '.avi', '.mkv'];
  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedImageExts.includes(ext) || allowedVideoExts.includes(ext)) {
    cb(null, true);
  } else {
    cb(
      new Error('Unsupported file type. Only JPG, PNG, WEBP, MP4, WEBM, and MOV are allowed.'),
      false
    );
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max file size
});

router.use(protect);

router.get('/', getExercises);
router.post('/', createExercise);
router.post('/upload-media', upload.single('file'), uploadExerciseMedia);
router.delete('/:id', deleteExercise);

export default router;
