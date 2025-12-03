import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.NEXT_PUBLIC_GEMINI_API_KEY!);

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

  /**
   * Initialize or update chat with meeting context
   * @param transcriptHistory - Array of all transcript messages
   */
  async initializeChatWithContext(transcriptHistory: Array<{
    speaker: string;
    text: string;
    timestamp: string;
    confidence?: number;
  }>) {
    // Build the meeting context from transcript
    const meetingContext = this.buildMeetingContext(transcriptHistory);
    
    // System instruction for the bot
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

    // Create chat session with history
    this.chat = model.startChat({
      history: [
        {
          role: "user",
          parts: [{ text: systemInstruction }]
        },
        {
          role: "model",
          parts: [{ text: "I understand. I'm your meeting assistant and I have access to the full transcript. I'll help you with summaries, answer questions, and track important information from the meeting. How can I help you?" }]
        }
      ],
    });

    return this.chat;
  }

  /**
   * Build formatted meeting context from transcript
   */
  private buildMeetingContext(transcriptHistory: Array<{
    speaker: string;
    text: string;
    timestamp: string;
    confidence?: number;
  }>): string {
    if (!transcriptHistory || transcriptHistory.length === 0) {
      return "No transcript available yet.";
    }

    return transcriptHistory
      .map(msg => `[${msg.timestamp}] ${msg.speaker}: ${msg.text}`)
      .join('\n');
  }

  /**
   * Generate response to user query
   * @param userMessage - The user's question or command
   * @param transcriptHistory - Full meeting transcript for context
   */
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
      // Always reinitialize with latest transcript before responding
      await this.initializeChatWithContext(transcriptHistory);

      // Extract the actual question (remove "Hello, bot" prefix if present)
      const cleanedMessage = userMessage
        .replace(/^(hello|hey|hi),?\s*bot[.,]?\s*/i, '')
        .trim();

      const actualQuestion = cleanedMessage || "Hello! How can I help you?";

      // Send message and get response
      const result = await this.chat.sendMessage(actualQuestion);
      const response = result.response;
      return response.text();
      
    } catch (error) {
      console.error('Error generating Gemini response:', error);
      throw error;
    }
  }

  /**
   * Generate meeting summary
   */
  async summarizeMeeting(transcriptHistory: Array<{
    speaker: string;
    text: string;
    timestamp: string;
    confidence?: number;
  }>): Promise<string> {
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
      console.error('Error generating summary:', error);
      throw error;
    }
  }
}

export default new GeminiService();
