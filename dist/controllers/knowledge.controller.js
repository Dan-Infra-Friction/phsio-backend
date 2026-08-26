"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.testRagQuery = exports.deleteDocument = exports.uploadDocument = exports.getDocuments = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const rag_service_1 = require("../services/rag.service");
const db_1 = __importDefault(require("../config/db"));
const getDocuments = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const documents = await db_1.default.knowledgeBase.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                fileName: true,
                fileType: true,
                filePath: true,
                createdAt: true,
                updatedAt: true,
                // Omit raw text content to keep response payload lightweight
            },
        });
        return res.status(200).json({
            success: true,
            data: documents,
        });
    }
    catch (error) {
        next(error);
    }
};
exports.getDocuments = getDocuments;
const uploadDocument = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const file = req.file;
        if (!file) {
            return res.status(400).json({
                success: false,
                message: 'No file uploaded. Supported types are PDF, TXT, and DOCX.',
            });
        }
        const fileName = file.originalname;
        const filePath = `/uploads/documents/${file.filename}`;
        const localPath = file.path;
        // Determine file type from extension
        const ext = path_1.default.extname(fileName).toLowerCase().substring(1); // 'pdf', 'txt', 'docx'
        try {
            console.log(`[RAG] Parsing uploaded file: ${fileName} (${ext})`);
            // Parse file text
            const extractedText = await rag_service_1.RagService.parseFile(localPath, ext);
            if (!extractedText || extractedText.trim().length === 0) {
                // Clean up uploaded file
                if (fs_1.default.existsSync(localPath))
                    fs_1.default.unlinkSync(localPath);
                return res.status(400).json({
                    success: false,
                    message: 'The uploaded file appears to be empty or unparseable.',
                });
            }
            // Save document to SQLite
            const document = await db_1.default.knowledgeBase.create({
                data: {
                    userId,
                    fileName,
                    fileType: ext,
                    filePath,
                    content: extractedText,
                },
            });
            // Update analytics document count
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const analytics = await db_1.default.analytics.findFirst({ where: { userId, date: today } });
            if (analytics) {
                await db_1.default.analytics.update({
                    where: { id: analytics.id },
                    data: { kbDocsCount: { increment: 1 } },
                });
            }
            else {
                await db_1.default.analytics.create({
                    data: { userId, date: today, kbDocsCount: 1 },
                });
            }
            return res.status(201).json({
                success: true,
                message: 'Document uploaded and indexed successfully for RAG.',
                data: {
                    id: document.id,
                    fileName: document.fileName,
                    fileType: document.fileType,
                    filePath: document.filePath,
                    createdAt: document.createdAt,
                },
            });
        }
        catch (err) {
            console.error('[RAG Indexing Error]:', err);
            // Clean up file if parsing failed
            if (fs_1.default.existsSync(localPath))
                fs_1.default.unlinkSync(localPath);
            return res.status(500).json({
                success: false,
                message: `Failed to index document: ${err.message || 'Parsing error'}`,
            });
        }
    }
    catch (error) {
        next(error);
    }
};
exports.uploadDocument = uploadDocument;
const deleteDocument = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;
        const document = await db_1.default.knowledgeBase.findFirst({
            where: { id, userId },
        });
        if (!document) {
            return res.status(404).json({
                success: false,
                message: 'Document not found.',
            });
        }
        // Delete local file
        const localFilePath = path_1.default.join(process.cwd(), 'storage', document.filePath);
        if (fs_1.default.existsSync(localFilePath)) {
            fs_1.default.unlinkSync(localFilePath);
        }
        // Delete database record
        await db_1.default.knowledgeBase.delete({
            where: { id },
        });
        return res.status(200).json({
            success: true,
            message: 'Document removed and deleted from knowledge base index.',
        });
    }
    catch (error) {
        next(error);
    }
};
exports.deleteDocument = deleteDocument;
const testRagQuery = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const { query } = req.body;
        if (!query) {
            return res.status(400).json({
                success: false,
                message: 'Query string is required.',
            });
        }
        console.log(`[RAG Testing] Running query for user ${userId}: "${query}"`);
        const matchedChunks = await rag_service_1.RagService.searchKnowledgeBase(userId, query, 4);
        return res.status(200).json({
            success: true,
            query,
            resultsCount: matchedChunks.length,
            data: matchedChunks,
        });
    }
    catch (error) {
        next(error);
    }
};
exports.testRagQuery = testRagQuery;
