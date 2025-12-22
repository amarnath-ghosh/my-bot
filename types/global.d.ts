// types/global.d.ts
import type { MeetingStatus } from '../lib/MeetingManager';

/**
 * API exposed by the main window preload (electron/preload.ts)
 * Used by the control UI (app/page.tsx)
 */
export interface BotApi {
  onMeetingsUpdate(callback: (meetings: MeetingStatus[]) => void): () => void;
  onTranscript(callback: (data: any) => void): () => void;
  getSnapshot(): Promise<MeetingStatus[]>;
  join(id: string): Promise<void>;
  leave(id: string): Promise<void>;
  restart(id: string): Promise<void>;
  setAutoManage(enabled: boolean): Promise<void>;
  simulateHello(id: string): Promise<void>;

  /**
   * Sends Float32 PCM audio data to the main process,
   * which relays it to the meeting window for injection.
   */
  sendBotAudio?(pcmData: Float32Array): void;
}

/**
 * API exposed by the meeting window preload (electron/meetingPreload.ts)
 * Used by the content script (electron/contentScript.ts)
 */
export interface MeetingAPI {
  /**
   * Listens for bot audio data from the main process.
   * The callback receives Float32Array PCM data at 24kHz.
   * Returns a cleanup function to remove the listener.
   */
  onBotSpeak: (callback: (pcmData: Float32Array) => void) => () => void;

  /**
   * Sends audio data (Uint8Array) to the main process for transcription.
   */
  sendAudio: (audioData: Uint8Array) => void;

  /**
   * Optional logging function for debugging.
   */
  log?: (message: string) => void;
}

declare global {
  interface Window {
    // API for the main UI (app/page.tsx) - exposed via electron/preload.ts
    botApi?: BotApi;

    // API for the meeting window (electron/contentScript.ts) - exposed via electron/meetingPreload.ts
    meetingAPI?: MeetingAPI;
  }
}

// Important so this file is treated as a module
export { };
