import { app, BrowserWindow, ipcMain, desktopCapturer, session } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

// --- ROBUST ENV LOADING ---
// 1. Try loading from the current working directory (Root)
const rootEnvPath = path.join(process.cwd(), '.env');
// 2. Try loading relative to the compiled file (dist/electron/...)
const relativeEnvPath = path.join(__dirname, '../../../.env');

// Check which one exists
const envPath = fs.existsSync(rootEnvPath) ? rootEnvPath : relativeEnvPath;

// Load it with debug turned on
const envResult = dotenv.config({ path: envPath, debug: true });

if (envResult.error) {
  console.error('[Main] ❌ Dotenv Error:', envResult.error);
} else {
  console.log(`[Main] ✅ Loaded .env from: ${envPath}`);
  console.log(`[Main] Parsed variables: ${Object.keys(envResult.parsed || {}).join(', ')}`);
}
// --------------------------

import { WindowManager, BotStatus } from './types';
import { BBBMonitor } from '../lib/bbb-monitor';

// Safety: Limits concurrent bots to 5 to save CPU
const MAX_CONCURRENT_MEETINGS = 5; 

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
    
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      const allowedPermissions = ['media', 'display-capture', 'audioCapture'];
      callback(allowedPermissions.includes(permission));
    });

    this.createMainWindow();
    this.setupIpcHandlers();
    
    // Start the Watcher
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
    if (this.windows.meetingWindows.has(meetingId)) return; // Already exists

    if (this.windows.meetingWindows.size >= MAX_CONCURRENT_MEETINGS) {
      console.warn(`[Main] Max capacity reached. Ignoring meeting ${meetingId}`);
      return;
    }

    console.log(`[Main] 🚀 Joining Meeting: ${meetingId}`);

    const win = new BrowserWindow({
      width: 1024, height: 768,
      show: false, // Run in background
      webPreferences: {
        nodeIntegration: false, contextIsolation: true,
        preload: path.join(__dirname, 'meetingPreload.js'),
        backgroundThrottling: false, // CRITICAL: Keeps bot awake
      },
    });

    this.windows.meetingWindows.set(meetingId, win);
    
    // Sync with UI
    const botStatus: BotStatus = { id: meetingId, url: meetingUrl, timestamp: Date.now() };
    this.activeBotDetails.set(meetingId, botStatus);
    this.windows.mainWindow?.webContents.send('bot-joined', botStatus);

    try {
      await win.loadURL(meetingUrl);

      // Inject the Bot Logic (Audio/AI)
      win.webContents.on('did-finish-load', () => {
        const scriptPath = path.join(__dirname, 'contentScript.js');
        fs.readFile(scriptPath, 'utf-8', (err, script) => {
          if (!err) win.webContents.executeJavaScript(script).catch(e => console.error(e));
        });
      });

      win.on('closed', () => {
        console.log(`[Main] Left Meeting: ${meetingId}`);
        this.windows.meetingWindows.delete(meetingId);
        this.activeBotDetails.delete(meetingId);
        this.windows.mainWindow?.webContents.send('bot-left', meetingId);
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
      const manualId = `manual_${Date.now()}`;
      await this.createMeetingWindow(url, manualId);
      return { success: true };
    });

    ipcMain.handle('close-meeting', async (event, meetingId) => {
      if (meetingId && this.windows.meetingWindows.has(meetingId)) {
        this.windows.meetingWindows.get(meetingId)?.close();
      } else {
        this.windows.meetingWindows.forEach(win => win.close());
      }
      return { success: true };
    });
    
    ipcMain.handle('get-active-bots', async () => {
      return Array.from(this.activeBotDetails.values());
    });

    ipcMain.handle('get-sources', async () => {
        return await desktopCapturer.getSources({ types: ['window', 'screen'] });
    });
  }
}

new ElectronApp();