// lib/aiService.ts
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import path from "path";

// 1) Ensure .env is loaded in THIS process (Electron main)
// Adjust path if needed – this assumes .env is in project root
dotenv.config({
  path: path.resolve(__dirname, "..", "..", "..", ".env"),
});
console.log("Gemini key in Electron process:", !!process.env.NEXT_PUBLIC_GEMINI_API_KEY);

// 2) Read the API key from env
const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;

if (!apiKey) {
  // This will fail fast and clearly instead of silently passing undefined
  throw new Error(
    "NEXT_PUBLIC_GEMINI_API_KEY is not set. Check your .env and Electron env loading."
  );
}

// 3) Create the client with the real key
const genAI = new GoogleGenerativeAI(apiKey);

const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: {
    temperature: 0.7,
    topK: 40,
    topP: 0.95,
    maxOutputTokens: 2048,
  },
});

export class GeminiService {
  private chat: any = null;

  async initializeChatWithContext(
    transcriptHistory: Array<{
      speaker: string;
      text: string;
      timestamp: string;
      confidence?: number;
    }>
  ) {
    const meetingContext = this.buildMeetingContext(transcriptHistory);

    const systemInstruction = `You are an AI meeting assistant bot. Your role is to:
- Answer questions about the meeting based on the real-time transcript
- Summarize discussions when asked
- Track action items and decisions
- Provide context-aware responses

IMPORTANT: You have access to the full meeting transcript below. Use it to answer questions accurately.

Current Meeting Transcript:
${meetingContext}

When someone says "Hello, bot" or mentions you, respond helpfully based on the meeting content.
If asked to summarize, provide a concise summary of what has been discussed.
If asked about specific topics, search the transcript and provide relevant information.`;

    this.chat = model.startChat({
      history: [
        {
          role: "user",
          parts: [{ text: systemInstruction }],
        },
        {
          role: "model",
          parts: [
            {
              text:
                "I understand. I'm your meeting assistant and I have access to the full transcript. " +
                "I'll help you with summaries, answer questions, and track important information from the meeting. " +
                "How can I help you?",
            },
          ],
        },
      ],
    });

    return this.chat;
  }

  private buildMeetingContext(
    transcriptHistory: Array<{
      speaker: string;
      text: string;
      timestamp: string;
      confidence?: number;
    }>
  ): string {
    if (!transcriptHistory || transcriptHistory.length === 0) {
      return "No transcript available yet.";
    }

    return transcriptHistory
      .map((msg) => `[${msg.timestamp}] ${msg.speaker}: ${msg.text}`)
      .join("\n");
  }

  async generateResponse(
    userMessage: string,
    transcriptHistory: Array<{
      speaker: string;
      text: string;
      timestamp: string;
      confidence?: number;
    }>
  ): Promise<string> {
    try {
      await this.initializeChatWithContext(transcriptHistory);

      const cleanedMessage = userMessage
        .replace(/^(hello|hey|hi),?\s*bot[.,]?\s*/i, "")
        .trim();

      const actualQuestion =
        cleanedMessage || "Hello! How can I help you during this meeting?";

      const result = await this.chat.sendMessage(actualQuestion);
      return result.response.text();
    } catch (error) {
      console.error("Error generating Gemini response:", error);
      return "I'm sorry, I encountered an error extracting that information.";
    }
  }

  async summarizeMeeting(
    transcriptHistory: Array<{
      speaker: string;
      text: string;
      timestamp: string;
      confidence?: number;
    }>
  ): Promise<string> {
    try {
      const meetingContext = this.buildMeetingContext(transcriptHistory);

      if (meetingContext === "No transcript available yet.") {
        return "There is no meeting content to summarize yet. The meeting transcript is empty.";
      }

      const summaryPrompt = `Based on the following meeting transcript, provide a concise summary:

${meetingContext}

Please summarize:
1. Main topics discussed
2. Key points made by participants
3. Any questions or action items mentioned`;

      const result = await model.generateContent(summaryPrompt);
      return result.response.text();
    } catch (error) {
      console.error("Error generating summary:", error);
      return "I'm sorry, I couldn't generate a summary for this meeting.";
    }
  }
}