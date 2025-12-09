import { GoogleGenerativeAI, ChatSession, GenerativeModel } from "@google/generative-ai";

export class GeminiService {
  private model: GenerativeModel;
  private chat: ChatSession | null = null;

  constructor() {
    const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
    if (!apiKey) throw new Error("NEXT_PUBLIC_GEMINI_API_KEY is not set");

    const genAI = new GoogleGenerativeAI(apiKey);
    this.model = genAI.getGenerativeModel({ 
      model: "gemini-2.5-flash",
      generationConfig: {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 2048,
      },
    });
  }

  async initializeChatWithContext(transcriptHistory: Array<{
    speaker: string;
    text: string;
    timestamp: string;
  }>) {
    const meetingContext = this.buildMeetingContext(transcriptHistory);
    
    const systemInstruction = `You are an AI meeting assistant. 
Current Meeting Transcript:
${meetingContext}
Answer questions based on this.`;

    this.chat = this.model.startChat({
      history: [
        { role: "user", parts: [{ text: systemInstruction }] },
        { role: "model", parts: [{ text: "Ready." }] }
      ],
    });

    return this.chat;
  }

  private buildMeetingContext(transcriptHistory: Array<any>): string {
    if (!transcriptHistory || transcriptHistory.length === 0) return "No transcript available.";
    return transcriptHistory
      .map(msg => `[${msg.timestamp}] ${msg.speaker}: ${msg.text}`)
      .join('\n');
  }

  async generateResponse(userMessage: string, transcriptHistory: any[]): Promise<string> {
    await this.initializeChatWithContext(transcriptHistory);
    const result = await this.chat?.sendMessage(userMessage);
    return result?.response.text() || "I couldn't generate a response.";
  }

  async summarizeMeeting(transcriptHistory: any[]): Promise<string> {
    const context = this.buildMeetingContext(transcriptHistory);
    const result = await this.model.generateContent(`Summarize this meeting:\n${context}`);
    return result.response.text();
  }
}