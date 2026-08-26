"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiService = void 0;
const axios_1 = __importDefault(require("axios"));
const db_1 = __importDefault(require("../config/db"));
const groq_sdk_1 = __importDefault(require("groq-sdk"));
class AiService {
    /**
     * Generates a response using the primary provider and falls back to others on failure.
     */
    static async generateResponse(userId, promptContext, // Custom system prompt + RAG context
    userMessage, history) {
        const primaryModel = process.env.PRIMARY_MODEL || 'gemini-2.5-flash';
        const secondaryModel = process.env.SECONDARY_MODEL || 'gemini-2.5-flash-lite';
        const fallbackModel = process.env.FALLBACK_MODEL || 'llama-4-scout';
        const fallbackChain = [
            { provider: 'gemini', model: primaryModel },
            { provider: 'gemini', model: secondaryModel },
            { provider: 'groq', model: fallbackModel },
        ];
        let lastError = null;
        for (const option of fallbackChain) {
            try {
                console.log(`[AI] Attempting response generation using: ${option.provider} / ${option.model}`);
                const response = await this.callProvider(option.provider, option.model, promptContext, userMessage, history);
                if (response) {
                    return response;
                }
            }
            catch (err) {
                console.error(`[AI Error] ${option.provider} / ${option.model} failed:`, err.message || err);
                lastError = err;
                // Log notification to user that an AI provider failed
                await db_1.default.notification.create({
                    data: {
                        userId,
                        type: 'FAILED_AI',
                        title: `AI Provider Failed: ${option.provider.toUpperCase()} (${option.model})`,
                        message: `Attempted to use ${option.provider} (${option.model}) but it failed: ${err.message || 'Unknown error'}. Trying fallback...`,
                    },
                }).catch((e) => console.error('Failed to write notification:', e));
            }
        }
        throw new Error(`All AI providers failed. Last error: ${lastError?.message || 'Unknown'}`);
    }
    static async callProvider(provider, modelName, systemPrompt, userMessage, history) {
        const chatHistory = [];
        // Add system prompt first
        chatHistory.push({ role: 'system', content: systemPrompt });
        // Format and append recent history (limit to last 10 messages for context window efficiency)
        const recentHistory = history.slice(-10);
        for (const msg of recentHistory) {
            chatHistory.push({
                role: msg.sender === 'PATIENT' ? 'user' : 'assistant',
                content: msg.body,
            });
        }
        // Append current message
        chatHistory.push({ role: 'user', content: userMessage });
        switch (provider) {
            case 'gemini': {
                const apiKey = process.env.GEMINI_API_KEY;
                if (!apiKey)
                    throw new Error('Gemini API key is not configured.');
                // Format history for Gemini: Gemini uses 'user' and 'model' roles.
                const contents = chatHistory
                    .filter((h) => h.role !== 'system')
                    .map((h) => ({
                    role: h.role === 'user' ? 'user' : 'model',
                    parts: [{ text: h.content }],
                }));
                const response = await axios_1.default.post(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`, {
                    contents,
                    systemInstruction: {
                        parts: [{ text: systemPrompt }],
                    },
                    generationConfig: {
                        temperature: 0.7,
                        maxOutputTokens: 800,
                    },
                });
                const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (!text)
                    throw new Error('Empty response from Gemini.');
                return text.trim();
            }
            case 'groq': {
                const apiKey = process.env.GROQ_API_KEY;
                if (!apiKey)
                    throw new Error('Groq API key is not configured.');
                const groq = new groq_sdk_1.default({ apiKey });
                const completion = await groq.chat.completions.create({
                    model: modelName,
                    messages: chatHistory,
                    temperature: 0.7,
                    max_tokens: 800,
                });
                const text = completion.choices[0]?.message?.content;
                if (!text)
                    throw new Error('Empty response from Groq.');
                return text.trim();
            }
            default:
                throw new Error(`Unsupported AI provider: ${provider}`);
        }
    }
}
exports.AiService = AiService;
