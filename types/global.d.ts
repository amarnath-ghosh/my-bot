// types/global.d.ts
import { ElectronAPI } from '../lib/types';

declare global {
  interface Window {
    // API for the main UI (app/page.tsx)
    electronAPI?: ElectronAPI;

    // API for the meeting window (electron/contentScript.ts)
    meetingAPI?: {
      onBotSpeak: (callback: (pcmData: Float32Array) => void) => () => void;
      sendAudio: (audioData: Uint8Array) => void;
    };
  }
}

// Important so this file is treated as a module
export { };
