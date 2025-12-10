import { app, BrowserWindow, ipcMain } from "electron";
import { MeetingManager } from "../lib/MeetingManager";
import * as dotenv from "dotenv";
import * as path from "path";

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, "../../../.env") });

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

  const appUrl = process.env.APP_URL || "http://localhost:3000";
  console.log("[Main] Loading URL:", appUrl);
  console.log("[Main] Preload path:", path.join(__dirname, "preload.js"));
  mainWindow.loadURL(appUrl);
}

app.whenReady().then(() => {
  createWindow();
  manager.start();

  // Push updates to renderer
  manager.onUpdate((meetings) => {
    mainWindow?.webContents.send("meetings:update", meetings);
  });

  manager.onTranscript((data) => {
    mainWindow?.webContents.send("bot:transcript", data);
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
  ipcMain.handle("bot:getSnapshot", () => manager.getSnapshot());
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
});