import { BrowserWindow, DesktopCapturerSource } from 'electron';

export interface ElectronMainAPI {
  createMeetingWindow: (url: string) => Promise<number>;
  getDesktopSources: () => Promise<DesktopCapturerSource[]>;
  closeMeetingWindow: () => Promise<void>;
}

export interface WindowManager {
  mainWindow: BrowserWindow | null;
  // CHANGED: Use a Map to store multiple meeting windows, keyed by Meeting ID
  meetingWindows: Map<string, BrowserWindow>;
}

export interface BotStatus {
  id: string;
  url: string;
  timestamp: number;
}

export interface IPCHandlers {
  'join-meeting': (url: string) => Promise<{ success: boolean; webContentsId?: number }>;
  'get-sources': () => Promise<DesktopCapturerSource[]>;
  'close-meeting': (meetingId?: string) => Promise<{ success: boolean }>;
  'send-transcript': (data: any) => void;
  'get-active-bots': () => Promise<BotStatus[]>;
}
