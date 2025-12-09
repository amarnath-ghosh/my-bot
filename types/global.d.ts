import { ElectronAPI } from '../lib/types'; 

declare global {
  interface Window {
    // API for the main UI (app/page.tsx)
    electronAPI?: ElectronAPI & {
      onActiveSpeakerChange: (callback: (name: string) => void) => void;
    };

    // API for the meeting window (electron/contentScript.ts)
    meetingAPI?: {
      onBotSpeak: (callback: (pcmData: Float32Array) => void) => () => void;
      // Added this to fix the TS error in contentScript
      sendActiveSpeaker: (name: string) => void;
    };
  }
}

export {};