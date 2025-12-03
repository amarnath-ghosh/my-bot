// Define a minimal interface to avoid importing the 'electron' package
export interface DesktopCapturerSource {
  id: string;
  name: string;
  thumbnail: string; // This is a string (data URL) not an object
  displayId?: string;
}

export interface ParticipantData {
  userId: string;
  userName: string;
  joinTimestamp: number;
  leaveTimestamp: number | null;
  transcript: TranscriptSegment[];
  totalTimeAttended: number;
  totalTimeSpoken: number;
  sentiment: SentimentScore;
}

export interface TranscriptSegment {
  speaker: string;
  speakerIndex: number;
  text: string;
  startTime: number;
  endTime: number;
  confidence: number;
  words?: WordSegment[];
  isFinal?: boolean; // Added this property
}

export interface WordSegment {
  word: string;
  startTime: number;
  endTime: number;
  confidence: number;
  speaker?: number;
}

export interface SentimentScore {
  overall: 'positive' | 'neutral' | 'negative';
  score: number;
  emotions: {
    joy: number;
    sadness: number;
    anger: number;
    fear: number;
  };
}

export interface MeetingSession {
  id: string;
  url: string;
  startTime: number;
  endTime: number | null;
  participants: ParticipantData[];
  totalTranscript: TranscriptSegment[];
}

export interface DeepgramResponse {
  channel: {
    alternatives: Array<{
      transcript: string;
      confidence: number;
      words: Array<{
        word: string;
        start: number;
        end: number;
        confidence: number;
        speaker?: number;
      }>;
    }>;
  };
  metadata: {
    request_id: string;
    model_info: {
      name: string;
      version: string;
    };
  };
  is_final: boolean;
  speech_final: boolean;
}

// Replaced the old BotResponse with one for chat
export interface BotResponse {
  speaker: 'Bot' | 'User';
  text: string;
  timestamp: number;
}

export interface AudioCaptureSettings {
  sampleRate: number;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export interface BotStatus {
  id: string;
  url: string;
  timestamp: number;
}

export interface ElectronAPI {
  joinMeeting: (url: string) => Promise<{ success: boolean; webContentsId?: number }>;
  getSources: () => Promise<DesktopCapturerSource[]>; // <-- Uses our new interface
  closeMeeting: (meetingId?: string) => Promise<{ success: boolean }>;
  onTranscriptUpdate: (callback: (data: TranscriptSegment) => void) => void;
  removeTranscriptListener: () => void;
  sendBotAudio: (pcmData: Float32Array) => void;
  onBotJoined: (callback: (data: BotStatus) => void) => void;
  onBotLeft: (callback: (meetingId: string) => void) => void;
  getActiveBots: () => Promise<BotStatus[]>;
}

export interface AppState {
  meetingUrl: string;
  isInMeeting: boolean;
  isRecording: boolean;
  currentSession: MeetingSession | null;
  status: string;
  error: string | null;
}