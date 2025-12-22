import { app, BrowserWindow, ipcMain } from "electron";
import { MeetingManager } from "../lib/MeetingManager";
import * as dotenv from "dotenv";
import * as path from "path";

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, "../../../.env") });

// Allow autoplay without user interaction
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');


let mainWindow: BrowserWindow | null = null;
const manager = new MeetingManager();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // Open DevTools for debugging
  mainWindow.webContents.openDevTools();

  const isDev = process.env.NODE_ENV === 'development';

  if (isDev) {
    const appUrl = process.env.APP_URL || "http://localhost:3000";
    console.log("[Main] Loading URL (Dev):", appUrl);
    console.log("[Main] Preload path:", path.join(__dirname, "preload.js"));

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
      console.error(`[Main] Failed to load ${url} after ${retries} attempts`);
    };

    loadUrlWithRetry(appUrl);
  } else {
    // Production: Load from file system
    // Path: dist/electron/electron/main.js -> ../../../out/index.html
    const indexPath = path.join(__dirname, "../../../out/index.html");
    console.log("[Main] Loading File (Prod):", indexPath);
    mainWindow.loadFile(indexPath).catch(e => {
      console.error("[Main] Failed to load file:", e);
    });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  manager.start();

  // Push updates to renderer
  // Push updates to renderer
  manager.onUpdate((meetings) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      console.log(`[Main] Sending meeting update: ${meetings.length} meetings`);
      mainWindow.webContents.send("meetings:update", meetings);
    }
  });

  manager.onTranscript((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      console.log(`[Main] forwarding transcript: ${data.text.substring(0, 30)}...`);
      mainWindow.webContents.send("bot:transcript", data);
    } else {
      console.warn("[Main] MainWindow not available to send transcript");
    }
  });

  // Handle manual commands
  ipcMain.handle("bot:join", (_e, meetingID: string) =>
    manager.manualJoin(meetingID)
  );
  ipcMain.handle("bot:leave", (_e, meetingID: string) =>
    manager.manualLeave(meetingID)
  );
  ipcMain.handle("bot:restart", (_e, meetingID: string) =>
    manager.manualRestart(meetingID)
  );
  ipcMain.handle("bot:getSnapshot", () => {
    console.log("[Main] Handling bot:getSnapshot request");
    return manager.getSnapshot();
  });
  ipcMain.handle("bot:setAutoManage", (_e, enabled: boolean) =>
    manager.setAutoManage(enabled)
  );
  ipcMain.handle("bot:simulate-hello", (_e, id: string) =>
    manager.simulateHello(id)
  );

  // Handle audio data from content script
  ipcMain.on("bot:audio", (event, audioData) => {
    // Forward to manager to route to the correct transcription service
    manager.processAudioChunk(event.sender.id, audioData);
  });

  // Relay bot audio from main window to meeting windows
  // This is used when UI wants to send TTS audio to a meeting
  ipcMain.on('bot-speak-data', (event, pcmData: Float32Array) => {
    // Verify sender is the main/control window
    if (event.sender === mainWindow?.webContents) {
      console.log(`[Main] Received bot-speak-data from main window (${pcmData.length} samples)`);

      // Forward to all active meeting windows via manager
      manager.sendBotAudioToMeetings(pcmData);
    }
  });
});
