import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { protect } from '../middleware/auth';
import { getSettings, updateSettings, uploadPollPdf } from '../controllers/settings.controller';

const uploadDir = path.join(process.cwd(), 'storage', 'uploads', 'documents');
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.pdf';
    const uniqueName = `pdf_${Date.now()}_${Math.round(Math.random() * 1e4)}${ext}`;
    cb(null, uniqueName);
  },
});
const upload = multer({ storage });

const router = Router();

router.use(protect);

router.get('/', getSettings);
router.put('/', updateSettings);
router.post('/upload-pdf', upload.single('pdf'), uploadPollPdf);

export default router;
