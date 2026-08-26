import OpenAI from 'openai';
import axios from 'axios';
import prisma from '../config/db';
import Groq from 'groq-sdk';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export class AiService {
  /**
   * Generates a response using the primary provider and falls back to others on failure.
   */
  public static async generateResponse(
    userId: string,
    promptContext: string, // Custom system prompt + RAG context
    userMessage: string,
    history: { sender: string; body: string }[]
  ): Promise<string> {
    const primaryModel = process.env.PRIMARY_MODEL || 'gemini-1.5-flash';
    const secondaryModel = process.env.SECONDARY_MODEL || 'gemini-2.0-flash';
    const fallbackModel = process.env.FALLBACK_MODEL || 'llama-3.1-8b-instant';

    const fallbackChain = [
      { provider: 'openrouter', model: 'nvidia/nemotron-3.5-lightning:free' },
      { provider: 'openrouter', model: 'openrouter/free' },
      { provider: 'gemini', model: primaryModel },
      { provider: 'gemini', model: secondaryModel },
      { provider: 'groq', model: fallbackModel },
      { provider: 'openai', model: 'gpt-4o-mini' },
    ];

    let lastError: any = null;

    for (const option of fallbackChain) {
      try {
        console.log(`[AI] Attempting response generation using: ${option.provider} / ${option.model}`);
        const response = await this.callProvider(
          option.provider,
          option.model,
          promptContext,
          userMessage,
          history
        );
        if (response) {
          return response;
        }
      } catch (err: any) {
        console.error(`[AI Error] ${option.provider} / ${option.model} failed:`, err.message || err);
        lastError = err;
        // Log notification to user that an AI provider failed
        await prisma.notification.create({
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

  private static async callProvider(
    provider: string,
    modelName: string,
    systemPrompt: string,
    userMessage: string,
    history: { sender: string; body: string }[]
  ): Promise<string> {
    const chatHistory: ChatMessage[] = [];

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
        if (!apiKey) throw new Error('Gemini API key is not configured.');

        // Format history for Gemini: Gemini uses 'user' and 'model' roles.
        const contents = chatHistory
          .filter((h) => h.role !== 'system')
          .map((h) => ({
            role: h.role === 'user' ? 'user' : 'model',
            parts: [{ text: h.content }],
          }));

        const response = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
          {
            contents,
            systemInstruction: {
              parts: [{ text: systemPrompt }],
            },
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 800,
            },
          }
        );

        const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error('Empty response from Gemini.');
        return text.trim();
      }

      case 'groq': {
        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) throw new Error('Groq API key is not configured.');

        const groq = new Groq({ apiKey });

        const completion = await groq.chat.completions.create({
          model: modelName,
          messages: chatHistory as any,
          temperature: 0.7,
          max_tokens: 800,
        });

        const text = completion.choices[0]?.message?.content;
        if (!text) throw new Error('Empty response from Groq.');
        return text.trim();
      }

      case 'openai': {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) throw new Error('OpenAI API key is not configured.');

        const openai = new OpenAI({ apiKey });

        const completion = await openai.chat.completions.create({
          model: modelName,
          messages: chatHistory as any,
          temperature: 0.7,
          max_tokens: 800,
        });

        const text = completion.choices[0]?.message?.content;
        if (!text) throw new Error('Empty response from OpenAI.');
        return text.trim();
      }

      case 'openrouter': {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) throw new Error('OpenRouter API key is not configured.');

        const openai = new OpenAI({
          baseURL: "https://openrouter.ai/api/v1",
          apiKey: apiKey,
          defaultHeaders: {
            "HTTP-Referer": "http://localhost:3000",
            "X-Title": "PhysioBot",
          }
        });

        const completion = await openai.chat.completions.create({
          model: modelName,
          messages: chatHistory as any,
          temperature: 0.7,
          max_tokens: 800,
        });

        const text = completion.choices[0]?.message?.content;
        if (!text) throw new Error('Empty response from OpenRouter.');
        return text.trim();
      }

      default:
        throw new Error(`Unsupported AI provider: ${provider}`);
    }
  }
}
