import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { ElectronAPI, BotStatus } from '../lib/types';

// Define the API that will be exposed to the renderer
const electronAPI: ElectronAPI = {
  joinMeeting: (url: string) => ipcRenderer.invoke('join-meeting', url),
  
  getSources: () => ipcRenderer.invoke('get-sources'),
  
  closeMeeting: () => ipcRenderer.invoke('close-meeting'),
  
  onTranscriptUpdate: (callback: (data: any) => void) => {
    const subscription = (event: IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('transcript-update', subscription);
  },
  
  removeTranscriptListener: () => {
    ipcRenderer.removeAllListeners('transcript-update');
  },

  sendBotAudio: (pcmData: Float32Array) => {
    ipcRenderer.send('bot-speak-data', pcmData);
  },

  // --- NEW: Bridge the Bot Status Events ---
  onBotJoined: (callback: (data: BotStatus) => void) => {
    const subscription = (event: IpcRendererEvent, data: BotStatus) => callback(data);
    ipcRenderer.on('bot-joined', subscription);
  },

  onBotLeft: (callback: (meetingId: string) => void) => {
    const subscription = (event: IpcRendererEvent, id: string) => callback(id);
    ipcRenderer.on('bot-left', subscription);
  },

  getActiveBots: () => ipcRenderer.invoke('get-active-bots')
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', electronAPI);