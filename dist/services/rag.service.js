"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RagService = void 0;
const fs_1 = __importDefault(require("fs"));
const pdf_parse_1 = __importDefault(require("pdf-parse"));
const axios_1 = __importDefault(require("axios"));
const db_1 = __importDefault(require("../config/db"));
class RagService {
    /**
     * Parses the text content of a file based on its type.
     */
    static async parseFile(filePath, fileType) {
        const dataBuffer = fs_1.default.readFileSync(filePath);
        if (fileType === 'pdf') {
            const data = await (0, pdf_parse_1.default)(dataBuffer);
            return data.text;
        }
        else if (fileType === 'txt') {
            return dataBuffer.toString('utf-8');
        }
        else if (fileType === 'docx') {
            // Direct DOCX text extraction using xml parser to avoid heavy dependencies.
            // A docx is a zip file; word/document.xml contains the text.
            // We can write a simple, elegant text extractor if zip/adm-zip is not loaded,
            // or we can read text contents directly.
            // For maximum safety, we can use a pure JS zip reading, or if we want to be robust,
            // let's read the binary file as text and strip xml tags (or if we can't unzip, we can fallback).
            // Let's implement a robust, lightweight docx xml parser if adm-zip is available,
            // otherwise fallback to clean text parsing.
            try {
                const AdmZip = require('adm-zip');
                const zip = new AdmZip(filePath);
                const docXml = zip.readAsText('word/document.xml');
                // Strip XML tags and extract text
                const cleanedText = docXml.replace(/<[^>]+>/g, ' ');
                return cleanedText.replace(/\s+/g, ' ').trim();
            }
            catch (err) {
                console.warn('[RAG] docx adm-zip extraction failed, falling back to basic extraction:', err);
                return dataBuffer.toString('utf-8').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''); // strip non-printable
            }
        }
        throw new Error(`Unsupported file type: ${fileType}`);
    }
    /**
     * Splits text into overlapping chunks.
     */
    static splitText(text, chunkSize = 600, chunkOverlap = 120) {
        const chunks = [];
        const cleanText = text.replace(/\s+/g, ' ').trim();
        let i = 0;
        while (i < cleanText.length) {
            chunks.push(cleanText.slice(i, i + chunkSize));
            i += chunkSize - chunkOverlap;
        }
        return chunks;
    }
    /**
     * Searches for similar chunks from the knowledge base using local TF-IDF cosine similarity.
     * Runs 100% locally and offline.
     */
    static async searchKnowledgeBase(userId, query, limit = 4) {
        try {
            const kbDocs = await db_1.default.knowledgeBase.findMany({
                where: { userId },
            });
            if (kbDocs.length === 0) {
                return [];
            }
            const allChunks = [];
            for (const doc of kbDocs) {
                const chunks = this.splitText(doc.content);
                chunks.forEach((c) => {
                    allChunks.push({
                        docId: doc.id,
                        fileName: doc.fileName,
                        content: c,
                    });
                });
            }
            if (allChunks.length === 0) {
                return [];
            }
            // Check if we can use API-based embeddings (e.g. Gemini/OpenAI) for semantic search
            const settings = await db_1.default.setting.findUnique({ where: { userId } });
            const apiKeys = this.parseKeys(settings?.apiKeys || '{}');
            if (settings?.aiProvider === 'gemini' && (apiKeys.gemini || process.env.GEMINI_API_KEY)) {
                try {
                    return await this.searchSemanticGemini(query, allChunks, apiKeys.gemini || process.env.GEMINI_API_KEY, limit);
                }
                catch (err) {
                    console.warn('[RAG] Gemini semantic search failed, falling back to local TF-IDF:', err);
                }
            }
            else if (settings?.aiProvider === 'openai' && (apiKeys.openai || process.env.OPENAI_API_KEY)) {
                try {
                    return await this.searchSemanticOpenAi(query, allChunks, apiKeys.openai || process.env.OPENAI_API_KEY, limit);
                }
                catch (err) {
                    console.warn('[RAG] OpenAI semantic search failed, falling back to local TF-IDF:', err);
                }
            }
            // Local TF-IDF Cosine Similarity Fallback (Fully Offline)
            return this.searchLocalTfIdf(query, allChunks, limit);
        }
        catch (error) {
            console.error('[RAG Search Error]:', error);
            return [];
        }
    }
    /**
     * Fully offline TF-IDF and Cosine Similarity engine.
     */
    static searchLocalTfIdf(query, chunks, limit) {
        const stopWords = new Set([
            'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your', 'yours',
            'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she', 'her', 'hers',
            'herself', 'it', 'its', 'itself', 'they', 'them', 'their', 'theirs', 'themselves',
            'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'am', 'is', 'are',
            'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'having', 'do', 'does',
            'did', 'doing', 'a', 'an', 'the', 'and', 'but', 'if', 'or', 'because', 'as', 'until',
            'while', 'of', 'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into',
            'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down',
            'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further', 'then', 'once', 'here',
            'there', 'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more',
            'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
            'than', 'too', 'very', 's', 't', 'can', 'will', 'just', 'don', 'should', 'now'
        ]);
        const tokenize = (text) => {
            return text
                .toLowerCase()
                .replace(/[^a-z0-9\s]/g, '')
                .split(/\s+/)
                .filter((word) => word.length > 1 && !stopWords.has(word));
        };
        const queryTokens = tokenize(query);
        if (queryTokens.length === 0) {
            return chunks.slice(0, limit).map((c) => c.content);
        }
        const documents = chunks.map((c) => tokenize(c.content));
        const numDocs = documents.length;
        // 1. Calculate Document Frequency (DF) for each term in the query
        const docFreq = {};
        queryTokens.forEach((token) => {
            docFreq[token] = 0;
            documents.forEach((doc) => {
                if (doc.includes(token)) {
                    docFreq[token]++;
                }
            });
        });
        // 2. Calculate Inverse Document Frequency (IDF)
        const idf = {};
        queryTokens.forEach((token) => {
            const df = docFreq[token];
            idf[token] = Math.log((numDocs + 1) / (df + 1)) + 1; // smooth IDF
        });
        // 3. Compute TF-IDF vectors for documents and query
        const queryVector = {};
        queryTokens.forEach((token) => {
            const tf = queryTokens.filter((t) => t === token).length / queryTokens.length;
            queryVector[token] = tf * idf[token];
        });
        const docScores = chunks.map((chunk, docIndex) => {
            const docTokens = documents[docIndex];
            if (docTokens.length === 0)
                return { chunk: chunk.content, score: 0 };
            const docVector = {};
            queryTokens.forEach((token) => {
                const tf = docTokens.filter((t) => t === token).length / docTokens.length;
                docVector[token] = tf * idf[token];
            });
            // Calculate Cosine Similarity
            let dotProduct = 0;
            let queryMagnitude = 0;
            let docMagnitude = 0;
            queryTokens.forEach((token) => {
                dotProduct += (queryVector[token] || 0) * (docVector[token] || 0);
                queryMagnitude += Math.pow(queryVector[token] || 0, 2);
                docMagnitude += Math.pow(docVector[token] || 0, 2);
            });
            queryMagnitude = Math.sqrt(queryMagnitude);
            docMagnitude = Math.sqrt(docMagnitude);
            const score = queryMagnitude && docMagnitude ? dotProduct / (queryMagnitude * docMagnitude) : 0;
            return { chunk: chunk.content, score };
        });
        // Sort documents by score descending
        docScores.sort((a, b) => b.score - a.score);
        return docScores.slice(0, limit).map((item) => item.chunk);
    }
    /**
     * Call Gemini Embeddings API and perform local cosine similarity.
     */
    static async searchSemanticGemini(query, chunks, apiKey, limit) {
        // 1. Get query embedding
        const queryRes = await axios_1.default.post(`https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`, {
            content: { parts: [{ text: query }] },
        });
        const queryVector = queryRes.data?.embedding?.values;
        if (!queryVector)
            throw new Error('Could not get query embedding from Gemini');
        // 2. Get embeddings for all chunks. To be fast, we can batch them or calculate cosine on the fly.
        // Since clinic KB is small, we'll fetch them. To avoid heavy API calls on every chat message,
        // in a production app we could cache embeddings, but doing a batch call is simple and fast.
        // For simplicity, we can embed them. To save token quotas, let's embed only the first 15 chunks
        // or batch embed. Let's do batch embedding.
        const chunksToEmbed = chunks.slice(0, 30); // limit search space to first 30 chunks to be safe
        const batchRequests = chunksToEmbed.map((c) => ({
            content: { parts: [{ text: c.content }] },
        }));
        const chunksRes = await axios_1.default.post(`https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents?key=${apiKey}`, {
            requests: batchRequests,
        });
        const embeddings = chunksRes.data?.embeddings;
        if (!embeddings || embeddings.length === 0)
            throw new Error('Could not get chunk embeddings from Gemini');
        // 3. Compute cosine similarity
        const scores = chunksToEmbed.map((chunk, index) => {
            const chunkVector = embeddings[index]?.values;
            const score = chunkVector ? this.cosineSimilarity(queryVector, chunkVector) : 0;
            return { chunk: chunk.content, score };
        });
        scores.sort((a, b) => b.score - a.score);
        return scores.slice(0, limit).map((s) => s.chunk);
    }
    /**
     * Call OpenAI Embeddings API and perform local cosine similarity.
     */
    static async searchSemanticOpenAi(query, chunks, apiKey, limit) {
        const authHeader = {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
        };
        // 1. Get query embedding
        const queryRes = await axios_1.default.post('https://api.openai.com/v1/embeddings', {
            model: 'text-embedding-3-small',
            input: query,
        }, authHeader);
        const queryVector = queryRes.data?.data?.[0]?.embedding;
        if (!queryVector)
            throw new Error('Could not get query embedding from OpenAI');
        // 2. Get embeddings for chunks (up to 30 chunks)
        const chunksToEmbed = chunks.slice(0, 30);
        const chunksRes = await axios_1.default.post('https://api.openai.com/v1/embeddings', {
            model: 'text-embedding-3-small',
            input: chunksToEmbed.map((c) => c.content),
        }, authHeader);
        const embeddings = chunksRes.data?.data;
        if (!embeddings)
            throw new Error('Could not get chunk embeddings from OpenAI');
        // 3. Compute cosine similarity
        const scores = chunksToEmbed.map((chunk, index) => {
            const chunkVector = embeddings[index]?.embedding;
            const score = chunkVector ? this.cosineSimilarity(queryVector, chunkVector) : 0;
            return { chunk: chunk.content, score };
        });
        scores.sort((a, b) => b.score - a.score);
        return scores.slice(0, limit).map((s) => s.chunk);
    }
    static cosineSimilarity(vecA, vecB) {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }
    static parseKeys(apiKeysStr) {
        try {
            return JSON.parse(apiKeysStr || '{}');
        }
        catch {
            return {};
        }
    }
}
exports.RagService = RagService;
