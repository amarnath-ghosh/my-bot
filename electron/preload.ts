// electron/preload.ts
import { contextBridge, ipcRenderer } from "electron";
import type { MeetingStatus } from "../lib/MeetingManager";

console.log("[Preload] Script loaded");
contextBridge.exposeInMainWorld("botApi", {
  onMeetingsUpdate(callback: (meetings: MeetingStatus[]) => void) {
    const subscription = (_event: any, meetings: any) => {
      console.log("[Preload] Received meetings update:", meetings);
      callback(meetings);
    };
    ipcRenderer.on("meetings:update", subscription);
    return () => ipcRenderer.removeListener("meetings:update", subscription);
  },
  onTranscript(callback: (data: any) => void) {
    const subscription = (_event: any, data: any) => callback(data);
    ipcRenderer.on("bot:transcript", subscription);
    return () => ipcRenderer.removeListener("bot:transcript", subscription);
  },
  getSnapshot: () => ipcRenderer.invoke("bot:getSnapshot"),
  join: (meetingID: string) => ipcRenderer.invoke("bot:join", meetingID),
  leave: (meetingID: string) => ipcRenderer.invoke("bot:leave", meetingID),
  restart: (meetingID: string) =>
    ipcRenderer.invoke("bot:restart", meetingID),
  setAutoManage: (enabled: boolean) =>
    ipcRenderer.invoke("bot:setAutoManage", enabled),
  simulateHello: (id: string) => ipcRenderer.invoke("bot:simulate-hello", id),
});

declare global {
  interface Window {
    botApi: {
      onMeetingsUpdate(
        cb: (meetings: MeetingStatus[]) => void
      ): () => void;
      onTranscript(cb: (data: any) => void): () => void;
      getSnapshot(): Promise<MeetingStatus[]>;
      join(id: string): Promise<void>;
      leave(id: string): Promise<void>;
      restart(id: string): Promise<void>;
      setAutoManage(enabled: boolean): Promise<void>;
      simulateHello(id: string): Promise<void>;
    };
  }
}
