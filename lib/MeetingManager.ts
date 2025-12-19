import { BrowserWindow } from "electron";
import { BbbClient } from "./bbbClient";
import { TranscriptionService } from "./transcription";
import { GeminiService } from "./aiService";
import { SpeechService } from "./speech";
import * as path from "path";

export interface MeetingStatus {
  meetingID: string;
  meetingName: string;
  participantCount?: number;
  isRunning: boolean;
  botState: "idle" | "joining" | "connected" | "error";
  lastError?: string;
  startTime?: number;
  joinUrl?: string;
}

type Listener = (meetings: MeetingStatus[]) => void;

export class MeetingManager {
  private client: BbbClient;
  private meetings: Map<string, MeetingStatus> = new Map();
  private listeners: Listener[] = [];
  private transcriptListeners: ((data: any) => void)[] = [];
  private botWindows: Map<string, BrowserWindow> = new Map();
  private transcriptionServices: Map<string, TranscriptionService> = new Map();
  private aiService: GeminiService;
  private speechService: SpeechService;
  private transcriptHistories: Map<string, {
    speaker: string;
    speakerIndex?: number;
    text: string;
    timestamp: string;
    startTime?: number;
    endTime?: number;
    confidence?: number;
    words?: any[];
  }[]> = new Map();

  private intervalMs = 10000;
  private timer: NodeJS.Timeout | null = null;
  private autoManage = true;

  constructor() {
    this.client = new BbbClient();
    this.aiService = new GeminiService();
    this.speechService = new SpeechService();
  }

  onUpdate(listener: Listener) {
    this.listeners.push(listener);
  }

  onTranscript(listener: (data: any) => void) {
    this.transcriptListeners.push(listener);
  }

  private emit() {
    const snapshot = Array.from(this.meetings.values());
    this.listeners.forEach((fn) => fn(snapshot));
  }

  private emitTranscript(data: any) {
    this.transcriptListeners.forEach((fn) => fn(data));
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.scan(), this.intervalMs);
    this.scan(); // immediate
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  setAutoManage(enabled: boolean) {
    this.autoManage = enabled;
    console.log(`[MeetingManager] Auto-manage set to ${enabled}`);
  }

  async getSnapshot(): Promise<MeetingStatus[]> {
    return Array.from(this.meetings.values());
  }

  async manualJoin(meetingID: string) {
    console.log(`[MeetingManager] Manual join requested for ${meetingID}`);
    const m = this.meetings.get(meetingID);
    if (!m) {
      console.error(`[MeetingManager] Meeting ${meetingID} not found`);
      return;
    }
    await this.joinMeeting(m);
  }

  async manualLeave(meetingID: string) {
    console.log(`[MeetingManager] Manual leave requested for ${meetingID}`);
    await this.leaveMeeting(meetingID);
  }

  async manualRestart(meetingID: string) {
    console.log(`[MeetingManager] Manual restart requested for ${meetingID}`);
    await this.leaveMeeting(meetingID);
    const m = this.meetings.get(meetingID);
    if (m) await this.joinMeeting(m);
  }

  private async scan() {
    try {
      const liveMeetings = await this.client.getMeetings();
      const liveIds = new Set(liveMeetings.map((m) => m.meetingID));

      // Update existing or add new
      for (const raw of liveMeetings) {
        const existing = this.meetings.get(raw.meetingID);
        if (existing) {
          existing.participantCount = raw.participantCount;
          existing.isRunning = raw.isRunning ?? false;
          // botState remains whatever it was
        } else {
          this.meetings.set(raw.meetingID, {
            meetingID: raw.meetingID,
            meetingName: raw.meetingName,
            participantCount: raw.participantCount,
            isRunning: raw.isRunning ?? false,
            botState: "idle",
          });
        }
      }

      // Mark missing as not running
      for (const [id, m] of this.meetings) {
        if (!liveIds.has(id)) {
          m.isRunning = false;
          if (m.botState === "connected") {
            this.leaveMeeting(id);
          }
        }
      }

      // Auto-join logic
      if (this.autoManage) {
        for (const m of this.meetings.values()) {
          if (m.isRunning && m.botState === "idle") {
            this.joinMeeting(m);
          }
        }
      }

      this.emit();
    } catch (err) {
      console.error("[MeetingManager] Scan error:", err);
    }
  }

  private async joinMeeting(m: MeetingStatus) {
    if (m.botState === "joining" || m.botState === "connected") return;

    m.botState = "joining";
    this.emit();

    try {
      const joinUrl = this.client.buildJoinUrl({
        meetingID: m.meetingID,
        fullName: "Meeting Bot",
        password: process.env.NEXT_PUBLIC_BBB_EMPLOYABILITY_PASSWORD!
      });

      console.log(`[MeetingManager] Launching browser for meeting ${m.meetingID}`);
      m.startTime = Date.now();
      m.joinUrl = joinUrl;
      await this.launchBotBrowser(m.meetingID, joinUrl);

      m.botState = "connected";
      m.lastError = undefined;
    } catch (e: any) {
      console.error(`[MeetingManager] Join failed for ${m.meetingID}:`, e);
      m.botState = "error";
      m.lastError = e.message;
    }
    this.emit();
  }

  private async leaveMeeting(meetingID: string) {
    const m = this.meetings.get(meetingID);
    if (m) {
      m.botState = "idle";
      this.emit();
    }
    await this.closeBotBrowser(meetingID);
  }

  // --- Electron Browser Logic ---

  private async launchBotBrowser(meetingID: string, joinUrl: string) {
    // 1. Create hidden window
    const win = new BrowserWindow({
      width: 1280,
      height: 720,
      show: true, // Visible for debugging
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true, // Required for contextBridge in preload
        preload: path.join(__dirname, "../../electron/electron/meetingPreload.js"), // Adjust path as needed
      },
    });

    this.botWindows.set(meetingID, win);

    // 2. Grant permissions
    win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
      if (permission === 'media') {
        callback(true);
      } else {
        callback(false);
      }
    });

    win.webContents.session.setPermissionCheckHandler((webContents, permission) => {
      return permission === 'media';
    });

    // 3. Setup Transcription Service
    const transcription = new TranscriptionService({
      apiKey: process.env.NEXT_PUBLIC_DEEPGRAM_API_KEY!
    });

    // Connect with callback
    await transcription.connect(async (segment) => {
      await this.handleTranscript(meetingID, { ...segment, isFinal: segment.isFinal ?? false }, win);
    }, (error) => {
      console.error(`[MeetingManager] Transcription error for ${meetingID}:`, error);
    });

    this.transcriptionServices.set(meetingID, transcription);


    // 4. Prepare Content Script
    const fs = await import("fs");
    // Log paths for debugging
    console.log(`[MeetingManager] __dirname: ${__dirname}`);
    const scriptPath = path.join(__dirname, "../../electron/electron/contentScript.js");
    console.log(`[MeetingManager] Script Path: ${scriptPath}`);

    let scriptContent = "";
    try {
      scriptContent = fs.readFileSync(scriptPath, "utf-8");
    } catch (e) {
      console.error(`[MeetingManager] Failed to read content script:`, e);
    }

    // 5. Attach Listeners (BEFORE loading URL)
    // Log navigation events
    win.webContents.on("did-start-navigation", (event, url) => {
      console.log(`[MeetingManager] Navigating to: ${url}`);
    });

    win.webContents.on("did-redirect-navigation", (event, url) => {
      console.log(`[MeetingManager] Redirecting to: ${url}`);
    });

    win.webContents.on("dom-ready", async () => {
      console.log(`[MeetingManager] DOM Ready, injecting content script...`);
      try {
        await win.webContents.executeJavaScript(scriptContent);
        console.log(`[MeetingManager] Content script injected successfully.`);
      } catch (e) {
        console.error(`[MeetingManager] Failed to inject content script:`, e);
      }
    });

    win.webContents.on("did-fail-load", (event, errorCode, errorDescription) => {
      console.error(`[MeetingManager] Page failed to load: ${errorCode} - ${errorDescription}`);
    });

    win.webContents.on("crashed", () => {
      console.error(`[MeetingManager] Window crashed!`);
    });

    win.webContents.on("unresponsive", () => {
      console.error(`[MeetingManager] Window unresponsive!`);
    });

    // 6. Load the URL
    console.log(`[MeetingManager] Loading URL: ${joinUrl}`);
    try {
      await win.loadURL(joinUrl);
    } catch (e) {
      console.error(`[MeetingManager] Failed to load URL:`, e);
    }

    // Handle window close
    win.on("closed", () => {
      this.botWindows.delete(meetingID);
      this.transcriptionServices.get(meetingID)?.disconnect();
      this.transcriptionServices.delete(meetingID);

      const m = this.meetings.get(meetingID);
      if (m && m.botState !== "idle") {
        m.botState = "idle";
        this.emit();
      }
    });
  }

  private async saveMeetingLog(meetingID: string) {
    const m = this.meetings.get(meetingID);
    const history = this.transcriptHistories.get(meetingID);

    if (!m || !history || history.length === 0) {
      console.log(`[MeetingManager] No data to save for ${meetingID}`);
      return;
    }

    const logData = {
      session: {
        id: `session_${m.startTime || Date.now()}`,
        url: m.joinUrl || "unknown",
        startTime: m.startTime || Date.now(),
        endTime: Date.now(),
        participants: history.reduce((acc: any[], curr) => {
          // Simple extraction of unique speakers
          if (!acc.includes(curr.speaker)) acc.push(curr.speaker);
          return acc;
        }, [])
      },
      transcription: history
    };

    try {
      const fs = await import("fs");
      const logDir = path.join(process.cwd(), "logs");
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      const filename = `meeting_${meetingID}_${Date.now()}.json`;
      const filePath = path.join(logDir, filename);
      fs.writeFileSync(filePath, JSON.stringify(logData, null, 2));
      console.log(`[MeetingManager] Saved meeting log to ${filePath}`);
    } catch (e) {
      console.error(`[MeetingManager] Failed to save meeting log:`, e);
    }
  }

  private async closeBotBrowser(meetingID: string) {
    const win = this.botWindows.get(meetingID);
    if (win) {
      await this.saveMeetingLog(meetingID); // Save before closing
      win.close();
      this.botWindows.delete(meetingID);
    }
    const service = this.transcriptionServices.get(meetingID);
    if (service) {
      service.disconnect();
      this.transcriptionServices.delete(meetingID);
    }
  }

  processAudioChunk(senderId: number, audioData: Uint8Array) {
    // Find which meeting this sender belongs to
    for (const [meetingID, win] of this.botWindows.entries()) {
      if (win.webContents.id === senderId) {
        const service = this.transcriptionServices.get(meetingID);
        if (service) {
          service.sendAudio(audioData.buffer as ArrayBuffer);
        }
        break;
      }
    }
  }

  // Extracted logic for reusability (Simulation)
  private async handleTranscript(meetingID: string, segment: { text: string; isFinal: boolean }, win?: BrowserWindow) {
    if (!win) {
      win = this.botWindows.get(meetingID);
      if (!win) return;
    }

    const entry = {
      speaker: (segment as any).speaker || (segment.isFinal ? "Final" : "Interim"),
      // If we have precise speaker info, rely on that, otherwise fallback
      speakerIndex: (segment as any).speakerIndex,
      text: segment.text,
      timestamp: new Date().toISOString(),
      startTime: (segment as any).startTime,
      endTime: (segment as any).endTime,
      confidence: (segment as any).confidence,
      words: (segment as any).words
    };

    const history = this.transcriptHistories.get(meetingID) || [];
    history.push(entry);
    this.transcriptHistories.set(meetingID, history);

    this.emitTranscript({ meetingID, ...entry });

    // Only trigger on FINAL results to prevent multiple responses for the same sentence
    if (segment.isFinal && (segment.text.toLowerCase().includes("bot") || segment.text.toLowerCase().includes("assistant"))) {
      console.log(`[MeetingManager] Bot mentioned! Generating response...`);
      const response = await this.aiService.generateResponse(segment.text, history);
      if (response) {
        console.log(`[MeetingManager] AI Response: ${response}`);
        const audioData = await this.speechService.createAudioData(response);
        if (audioData) {
          console.log(`[MeetingManager] Sending audio to window...`);
          win.webContents.send('bot:speak', audioData);
        }
      }
    }
  }

  async simulateHello(meetingID: string) {
    console.log(`[MeetingManager] Simulating 'Hello Bot' for ${meetingID}`);
    await this.handleTranscript(meetingID, { text: "Hello Bot, are you there?", isFinal: true });
  }
}
