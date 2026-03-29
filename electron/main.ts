import "./env";
import { app, BrowserWindow, ipcMain } from "electron";
import { MeetingManager } from "../lib/MeetingManager";
import * as path from "path";
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

// Allow autoplay without user interaction
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow: BrowserWindow | null = null;
const manager = new MeetingManager();

// --- SETUP WEBSOCKET SERVER FOR FRONTEND CLIENTS (WEB AND DESKTOP) ---
const webApp = express();
webApp.use(cors());
const server = http.createServer(webApp);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

manager.onUpdate((meetings) => {
  io.emit("meetings:update", meetings);
});

manager.onTranscript((data) => {
  io.emit("bot:transcript", data);
});

io.on('connection', (socket) => {
  console.log(`[Server] Client connected: ${socket.id}`);

  socket.on("bot:join", async (meetingID: string, callback) => {
    try {
      await manager.manualJoin(meetingID);
      callback?.({ success: true });
    } catch (e: any) { callback?.({ error: e.message }); }
  });

  socket.on("bot:leave", async (meetingID: string, callback) => {
    try {
      await manager.manualLeave(meetingID);
      callback?.({ success: true });
    } catch (e: any) { callback?.({ error: e.message }); }
  });

  socket.on("bot:restart", async (meetingID: string, callback) => {
    try {
      await manager.manualRestart(meetingID);
      callback?.({ success: true });
    } catch (e: any) { callback?.({ error: e.message }); }
  });

  socket.on("bot:getSnapshot", async (callback) => {
    try {
      const snapshot = await manager.getSnapshot();
      callback?.(snapshot);
    } catch (e: any) { callback?.([]); }
  });

  socket.on("bot:setAutoManage", async (enabled: boolean, callback) => {
    try {
      await manager.setAutoManage(enabled);
      callback?.({ success: true });
    } catch (e: any) { callback?.({ error: e.message }); }
  });

  socket.on("bot:simulate-hello", async (id: string, callback) => {
    try {
      await manager.simulateHello(id);
      callback?.({ success: true });
    } catch (e: any) { callback?.({ error: e.message }); }
  });

  socket.on('bot-speak-data', (pcmData) => {
    const floatData = new Float32Array(pcmData);
    manager.sendBotAudioToMeetings(floatData);
  });

  socket.on('disconnect', () => {
    console.log(`[Server] Client disconnected: ${socket.id}`);
  });
});

server.listen(3001, () => {
  console.log(`[Server] WebSocket Backend listening on http://localhost:3001`);
});
// --------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Preload js is kept only for the content script audio IPC, frontend UI uses WebSockets directly
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.webContents.openDevTools();

  const isDev = process.env.NODE_ENV === 'development';

  if (isDev) {
    const appUrl = process.env.APP_URL || "http://localhost:3000";
    console.log("[Main] Loading URL (Dev):", appUrl);

    const loadUrlWithRetry = async (url: string, retries = 10) => {
      for (let i = 0; i < retries; i++) {
        try {
          await mainWindow?.loadURL(url);
          console.log(`[Main] Successfully loaded ${url}`);
          return;
        } catch (e: any) {
          if (e.code === 'ERR_CONNECTION_REFUSED') {
            console.log(`[Main] Connection refused, retrying in 1s... (${i + 1}/${retries})`);
            await new Promise(r => setTimeout(r, 1000));
          } else {
            console.error(`[Main] Failed to load URL:`, e);
            break;
          }
        }
      }
    };
    loadUrlWithRetry(appUrl);
  } else {
    const indexPath = path.join(__dirname, "../../../out/index.html");
    mainWindow.loadFile(indexPath).catch(e => console.error("[Main] Failed to load file:", e));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  manager.start();
  
  // NOTE: MeetingManager still intercepts native IPC from the Chromium headless bot browsers
  // when reading from the Meeting pages. 
  ipcMain.on("bot:audio", (event, audioData) => {
    manager.processAudioChunk(event.sender.id, audioData);
  });
});
