import { app, BrowserWindow, ipcMain, desktopCapturer, session } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

// --- CRITICAL FIX: Allow Bot to Speak Without User Interaction ---
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-site-isolation-trials');

// --- ROBUST ENV LOADING ---
const rootEnvPath = path.join(process.cwd(), '.env');
const relativeEnvPath = path.join(__dirname, '../../../.env');
const envPath = fs.existsSync(rootEnvPath) ? rootEnvPath : relativeEnvPath;
const envResult = dotenv.config({ path: envPath, debug: true });

if (envResult.error) {
  console.error('[Main] ❌ Dotenv Error:', envResult.error);
} else {
  console.log(`[Main] ✅ Loaded .env from: ${envPath}`);
}

const MAX_CONCURRENT_MEETINGS = 5; 

interface BotStatus {
  id: string;
  url: string;
  timestamp: number;
}

interface WindowManager {
  mainWindow: BrowserWindow | null;
  meetingWindows: Map<string, BrowserWindow>; 
}

import { BBBMonitor } from '../lib/bbb-monitor';

class ElectronApp {
  private windows: WindowManager = {
    mainWindow: null,
    meetingWindows: new Map(), 
  };
  private monitor: BBBMonitor | null = null;
  private activeBotDetails: Map<string, BotStatus> = new Map();

  constructor() {
    this.initialize();
  }

  private async initialize() {
    await app.whenReady();
    
    // Grant permissions for audio/video capture
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      const allowedPermissions = ['media', 'display-capture', 'audioCapture', 'mediaKeySystem'];
      callback(allowedPermissions.includes(permission));
    });

    this.createMainWindow();
    this.setupIpcHandlers();
    this.startMeetingMonitor(); 
  }

  private createMainWindow() {
    this.windows.mainWindow = new BrowserWindow({
      width: 1400, height: 900,
      webPreferences: {
        nodeIntegration: false, contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
      },
    });

    const startUrl = process.env.NODE_ENV === 'development' 
      ? 'http://localhost:3000' 
      : `file://${path.join(__dirname, '../../../out/index.html')}`;
      
    this.windows.mainWindow.loadURL(startUrl);
  }

  private async createMeetingWindow(meetingUrl: string, meetingId: string): Promise<void> {
    if (this.windows.meetingWindows.has(meetingId)) return;

    if (this.windows.meetingWindows.size >= MAX_CONCURRENT_MEETINGS) {
      console.warn(`[Main] Max capacity reached. Ignoring meeting ${meetingId}`);
      return;
    }

    console.log(`[Main] 🚀 Joining Meeting: ${meetingId}`);

    const win = new BrowserWindow({
      width: 1280, height: 800,
      show: true, // Keep true for debugging
      title: `Bot: ${meetingId}`,
      webPreferences: {
        nodeIntegration: false, 
        contextIsolation: true,
        preload: path.join(__dirname, 'meetingPreload.js'),
        backgroundThrottling: false, 
      },
    });

    this.windows.meetingWindows.set(meetingId, win);
    
    const botStatus: BotStatus = { id: meetingId, url: meetingUrl, timestamp: Date.now() };
    this.activeBotDetails.set(meetingId, botStatus);
    this.windows.mainWindow?.webContents.send('bot-joined', botStatus);

    try {
      await win.loadURL(meetingUrl);

      win.webContents.on('did-finish-load', () => {
        const scriptPath = path.join(__dirname, 'contentScript.js');
        fs.readFile(scriptPath, 'utf-8', (err, script) => {
          if (!err) {
            console.log(`[Main] Injecting content script into ${meetingId}`);
            win.webContents.executeJavaScript(script).catch(e => console.error(e));
          } else {
            console.error('[Main] Failed to read contentScript.js', err);
          }
        });
      });

      win.on('closed', () => {
        console.log(`[Main] Left Meeting: ${meetingId}`);
        this.windows.meetingWindows.delete(meetingId);
        this.activeBotDetails.delete(meetingId);
        if (this.windows.mainWindow && !this.windows.mainWindow.isDestroyed()) {
            this.windows.mainWindow.webContents.send('bot-left', meetingId);
        }
      });

    } catch (error) {
      console.error(`[Main] Failed to join ${meetingId}:`, error);
      this.windows.meetingWindows.delete(meetingId);
      this.activeBotDetails.delete(meetingId);
      win.close();
    }
  }

  private startMeetingMonitor() {
    this.monitor = new BBBMonitor((joinUrl, meetingId) => {
      this.createMeetingWindow(joinUrl, meetingId);
    });
    this.monitor.start();
  }

  private setupIpcHandlers() {
    ipcMain.handle('join-meeting', async (event, url) => {
      const urlObj = new URL(url);
      const meetingId = urlObj.searchParams.get('meetingID') || `manual_${Date.now()}`;
      await this.createMeetingWindow(url, meetingId);
      return { success: true };
    });

    ipcMain.handle('close-meeting', async (event, meetingId) => {
      if (meetingId && this.windows.meetingWindows.has(meetingId)) {
        const win = this.windows.meetingWindows.get(meetingId);
        if (win && !win.isDestroyed()) win.close();
      } else {
        this.windows.meetingWindows.forEach((win) => {
            if (!win.isDestroyed()) win.close();
        });
      }
      return { success: true };
    });
    
    ipcMain.handle('get-active-bots', async () => {
      return Array.from(this.activeBotDetails.values());
    });

    ipcMain.handle('get-sources', async () => {
        return await desktopCapturer.getSources({ types: ['window', 'screen'] });
    });

    ipcMain.on('bot-speak-data', (event, pcmData) => {
      console.log(`[Main] 🗣️ Received audio (${pcmData.length} samples). Forwarding to meeting windows...`);
      this.windows.meetingWindows.forEach((win, id) => {
        if (!win.isDestroyed()) {
          win.webContents.send('bot-speak', pcmData);
        }
      });
    });
  }
}

new ElectronApp();