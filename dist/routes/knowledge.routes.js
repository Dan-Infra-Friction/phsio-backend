"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const auth_1 = require("../middleware/auth");
const knowledge_controller_1 = require("../controllers/knowledge.controller");
const router = (0, express_1.Router)();
// Configure Multer storage
const storage = multer_1.default.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = path_1.default.join(process.cwd(), 'storage', 'uploads', 'documents');
        if (!fs_1.default.existsSync(uploadPath)) {
            fs_1.default.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
        const ext = path_1.default.extname(file.originalname);
        cb(null, `doc-${uniqueSuffix}${ext}`);
    },
});
// Configure File Filter
const fileFilter = (req, file, cb) => {
    const allowedExts = ['.pdf', '.txt', '.docx'];
    const ext = path_1.default.extname(file.originalname).toLowerCase();
    if (allowedExts.includes(ext)) {
        cb(null, true);
    }
    else {
        cb(new Error('Unsupported file type. Only PDF, TXT, and DOCX are allowed.'), false);
    }
};
const upload = (0, multer_1.default)({
    storage,
    fileFilter,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});
router.use(auth_1.protect);
router.get('/', knowledge_controller_1.getDocuments);
router.post('/', upload.single('file'), knowledge_controller_1.uploadDocument);
router.delete('/:id', knowledge_controller_1.deleteDocument);
router.post('/test', knowledge_controller_1.testRagQuery);
exports.default = router;
